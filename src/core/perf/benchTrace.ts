/**
 * Benchmark-only tracing channels, each enabled by naming an output file:
 *
 * - `UBUME_STARTUP_TRACE`: startup stage marks (`startupMark`).
 * - `UBUME_BENCH_TRACE`: streaming stage marks for sequence tokens `⟦n⟧` emitted by
 *   offline benchmark providers (`streamMark`, `traceFrameTokens`).
 * - `UBUME_BENCH_MEMORY`: on SIGUSR2, a memory/heap report (`installMemoryReporter`).
 *
 * Unset channels cost one boolean check per call. Records are buffered in memory and
 * flushed on a timer and at exit, so tracing adds no synchronous I/O to hot paths.
 * Timestamps are epoch milliseconds from `performance.timeOrigin + performance.now()`
 * (monotonic within the process), comparable with a PTY reader's wall clock.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const startupFile = process.env.UBUME_STARTUP_TRACE?.trim() || null;
const streamFile = process.env.UBUME_BENCH_TRACE?.trim() || null;

const pending = new Map<string, string[]>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

let streamRun = 0;
const now = () => performance.timeOrigin + performance.now();

function flush(): void {
  for (const [file, lines] of pending) {
    if (lines.length === 0) continue;
    try {
      appendFileSync(file, lines.join(""));
    } catch {
      // Tracing must never affect the application.
    }
    lines.length = 0;
  }
}

function pendingFor(file: string): string[] {
  let lines = pending.get(file);
  if (!lines) {
    lines = [];
    pending.set(file, lines);
  }
  return lines;
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flush, 250);
  flushTimer.unref?.();
  process.once("exit", flush);
}

function record(file: string, entry: Record<string, unknown>): void {
  pendingFor(file).push(
    `${JSON.stringify({ run: `${process.env.UBUME_BENCH_RUN_ID ?? "default"}:${streamRun}`, t: now(), monoNs: process.hrtime.bigint().toString(), pid: process.pid, ...entry })}\n`,
  );
  ensureFlushTimer();
}

/** Records a startup stage (every call). */
export function startupMark(stage: string, detail?: Record<string, unknown>): void {
  if (!startupFile) return;
  record(startupFile, { stage, ...detail });
}

const markedOnce = new Set<string>();

/** Records a startup stage only the first time it is reached in this process. */
export function startupMarkOnce(stage: string, detail?: Record<string, unknown>): void {
  if (!startupFile || markedOnce.has(stage)) return;
  markedOnce.add(stage);
  record(startupFile, { stage, ...detail });
}

/** Records the process start (performance.timeOrigin) once, for runtime-startup attribution. */
export function startupMarkProcessStart(): void {
  if (!startupFile || markedOnce.has("bun-process-start")) return;
  markedOnce.add("bun-process-start");
  pendingFor(startupFile).push(
    `${JSON.stringify({ t: performance.timeOrigin, pid: process.pid, stage: "bun-process-start" })}\n`,
  );
  ensureFlushTimer();
}

/** Whether streaming stage tracing is enabled (lets callers skip token scans). */
export const streamTraceEnabled = streamFile !== null;

const TOKEN = /⟦(\d+)⟧/g;
const pendingInkSeqs = new Set<number>();

/** Records `stage` for every benchmark sequence token found in `text`. */
export function streamMark(stage: string, text: string | undefined): void {
  if (!streamFile || !text || !text.includes("⟦")) return;
  for (const match of text.matchAll(TOKEN)) {
    const seq = Number(match[1]);
    record(streamFile, { stage, seq });
    if (stage === "reduce") pendingInkSeqs.add(seq);
  }
}

const visibleFrameSeqs = new Set<number>();

/** One run owns sequence numbers; start a new identity before emitting synthetic events. */
export function beginStreamTrace(): void {
  streamRun++;
  visibleFrameSeqs.clear();
  pendingInkSeqs.clear();
}

/** Ink calls this after generating output, before writing it to the terminal. */
export function traceInkOutputGenerated(): void {
  if (!streamFile) return;
  for (const seq of pendingInkSeqs) record(streamFile, { stage: "ink", seq });
  pendingInkSeqs.clear();
}

/**
 * Records the frame write and the tokens that became visible in it for the first time.
 * Frames are whole-screen strings, so only newly appearing tokens are reported.
 */
export function traceFrameTokens(frame: string): void {
  if (!streamFile) return;
  const seqs = new Set<number>();
  if (frame.includes("⟦")) for (const match of frame.matchAll(TOKEN)) seqs.add(Number(match[1]));
  const fresh = [...seqs].filter((seq) => !visibleFrameSeqs.has(seq));
  record(streamFile, { stage: "frame", bytes: Buffer.byteLength(frame), fresh });
  for (const seq of fresh) visibleFrameSeqs.add(seq);
}

/**
 * Installs a SIGUSR2 handler that writes a memory report to `UBUME_BENCH_MEMORY` (one JSON
 * document per signal, appended). `UBUME_BENCH_MEMORY_GC=1` runs a full GC first, so live-heap
 * numbers mean retained objects; production never forces GC. `UBUME_BENCH_HEAP_SNAPSHOT=<dir>`
 * also writes a heap snapshot per signal for retention analysis.
 */
export function installMemoryReporter(sizes: () => Record<string, number> = () => ({})): void {
  const file = process.env.UBUME_BENCH_MEMORY?.trim();
  if (!file) return;
  let sequence = 0;
  process.on("SIGUSR2", () => {
    void (async () => {
      // Non-literal specifier: `bun:jsc` exists only at runtime (no type package here).
      const jscModule = "bun:jsc";
      const jsc = (await import(jscModule)) as {
        fullGC(): void;
        heapStats(): {
          heapSize: number;
          heapCapacity: number;
          extraMemorySize: number;
          objectCount: number;
          protectedObjectCount: number;
          globalObjectCount: number;
          objectTypeCounts: Record<string, number>;
        };
      };
      if (process.env.UBUME_BENCH_MEMORY_GC === "1") jsc.fullGC();
      const stats = jsc.heapStats();
      const report = {
        t: now(),
        sequence: ++sequence,
        memoryUsage: process.memoryUsage(),
        heap: {
          heapSize: stats.heapSize,
          heapCapacity: stats.heapCapacity,
          extraMemorySize: stats.extraMemorySize,
          objectCount: stats.objectCount,
          protectedObjectCount: stats.protectedObjectCount,
          globalObjectCount: stats.globalObjectCount,
          topTypes: Object.entries(stats.objectTypeCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25),
        },
        sizes: sizes(),
      };
      appendFileSync(file, `${JSON.stringify(report)}\n`);
      const snapshotDir = process.env.UBUME_BENCH_HEAP_SNAPSHOT?.trim();
      if (snapshotDir) {
        const snapshot = (
          globalThis as { Bun?: { generateHeapSnapshot(): unknown } }
        ).Bun?.generateHeapSnapshot();
        if (snapshot)
          writeFileSync(`${snapshotDir}/heap-${sequence}.json`, JSON.stringify(snapshot));
      }
    })().catch(() => undefined);
  });
}
