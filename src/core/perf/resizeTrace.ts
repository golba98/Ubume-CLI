/** Opt-in monotonic resize profiling. No content, filesystem work or timers when disabled. */
import { appendFileSync } from "node:fs";

const file = process.env.UBUME_RESIZE_TRACE?.trim();
export const resizeTraceEnabled = Boolean(file);
let generation = 0;
export function getResizeGeneration(): number {
  return generation;
}
let pending: string[] = [];
let installed = false;
let expected = 0;
export function flushResizeTrace(): void {
  if (!file || !pending.length) return;
  const lines = pending;
  pending = [];
  try {
    appendFileSync(file, lines.join(""));
  } catch {
    /* Diagnostics never own execution. */
  }
}
export function traceResize(stage: string, fields: Record<string, unknown> = {}): void {
  if (!file) return;
  if (!installed) {
    installed = true;
    expected = performance.now() + 10;
    setInterval(() => {
      const now = performance.now();
      traceResize("sample", {
        delayMs: Math.max(0, now - expected),
        cpu: process.cpuUsage(),
        rss: process.memoryUsage().rss,
      });
      expected = now + 10;
    }, 10).unref();
    setInterval(flushResizeTrace, 100).unref();
    process.once("exit", flushResizeTrace);
  }
  if (stage === "notification") generation++;
  pending.push(
    `${JSON.stringify({ pid: process.pid, generation, monoNs: process.hrtime.bigint().toString(), stage, ...fields })}\n`,
  );
  if (pending.length > 20000) pending.splice(0, pending.length - 20000);
}

/** Instrument the existing Yoga callback only while a benchmark is recording. */
export function instrumentResizeLayout(instance: unknown): () => void {
  if (!resizeTraceEnabled) return () => {};
  const root = (instance as { rootNode?: { onComputeLayout?: () => void } } | null)?.rootNode;
  const original = root?.onComputeLayout;
  if (!root || !original) return () => {};
  const wrapped = () => {
    const start = performance.now();
    try {
      original();
    } finally {
      traceResize("yogaLayout", { durationMs: performance.now() - start });
    }
  };
  root.onComputeLayout = wrapped;
  return () => {
    if (root.onComputeLayout === wrapped) root.onComputeLayout = original;
  };
}
