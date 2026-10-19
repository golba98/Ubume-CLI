/**
 * Offline stream-to-screen fixture: the production `startApp` path (frame lock, Ink frame
 * throttle, clear-frame boundary) with an in-process fake provider. Each provider event
 * carries sequence tokens `⟦n⟧`; `UBUME_BENCH_TRACE` records when each token is emitted,
 * handled, flushed, reduced and written, and the PTY driver records when it becomes visible.
 *
 * Environment: BENCH_WORKLOAD (short|large|rapid|slow|table|code|tools|mixed|history),
 * BENCH_SUMMARY_FILE (JSON written when the measured turn completes).
 */
import { writeFileSync } from "node:fs";
import * as benchTrace from "../../../src/core/perf/benchTrace.js";
import type { BackendProvider, BackendRunHandlers } from "../../../src/core/providers/types.js";
import { startApp } from "../../../src/index.js";

const workload = process.env.BENCH_WORKLOAD ?? "short";
const summaryFile = process.env.BENCH_SUMMARY_FILE;

type Event = { kind: "text"; chunk: string } | { kind: "tool"; command: string; id: string };

interface Step {
  delayMs: number;
  build: (seq: number) => Event;
}

const text =
  (body: (seq: number) => string) =>
  (seq: number): Event => ({ kind: "text", chunk: body(seq) });
const tool = (seq: number): Event => ({ kind: "tool", command: `run step ⟦${seq}⟧`, id: `tool-${seq}` });

function dispatch(handlers: BackendRunHandlers, event: Event): void {
  if (event.kind === "text") handlers.onAssistantDelta?.(event.chunk);
  else
    handlers.onToolActivity?.({
      id: event.id,
      command: event.command,
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      summary: "ok",
    });
}

function plan(): { steps: Step[]; header?: string } {
  const repeat = (count: number, delayMs: number, build: Step["build"]) =>
    Array.from({ length: count }, () => ({ delayMs, build }));
  switch (workload) {
    case "short":
      return { steps: repeat(20, 15, text((seq) => `word ⟦${seq}⟧ `)) };
    case "large":
      return { steps: repeat(600, 2, text((seq) => `Paragraph line with some prose ⟦${seq}⟧.\n`)) };
    case "rapid":
      return { steps: repeat(400, 0, text((seq) => `t⟦${seq}⟧ `)) };
    case "slow":
      return { steps: repeat(30, 60, text((seq) => `slow ⟦${seq}⟧ `)) };
    case "table":
      return {
        header: "| Row | Value | Note |\n|---|---|---|\n",
        steps: repeat(150, 4, text((seq) => `| r${seq} | ⟦${seq}⟧ | 漢字 emoji 👩🏽‍💻 |\n`)),
      };
    case "code":
      return {
        header: "```typescript\n",
        steps: repeat(300, 2, text((seq) => `const value${seq} = "⟦${seq}⟧";\n`)),
      };
    case "tools":
      return { steps: repeat(40, 20, tool) };
    case "mixed":
      return {
        steps: Array.from({ length: 120 }, (_, index) => ({
          delayMs: 5,
          build: index % 6 === 5 ? tool : text((seq) => `mixed ⟦${seq}⟧ `),
        })),
      };
    case "history":
      return { steps: repeat(60, 10, text((seq) => `after history ⟦${seq}⟧ `)) };
    default:
      throw new Error(`unknown workload ${workload}`);
  }
}

/** Large earlier answers so the measured turn streams below a long transcript. */
const HISTORY_TURNS = workload === "history" ? 20 : 0;
const historyAnswer = Array.from({ length: 200 }, (_, line) => `History line ${line} **bold** and \`code\`.`).join("\n");

let runs = 0;
const provider: BackendProvider = {
  id: "codex-subprocess",
  label: "Bench provider",
  description: "Offline stream benchmark provider",
  authState: "delegated",
  authLabel: "offline",
  statusMessage: "offline",
  supportsModels: () => true,
  run: (_prompt, _options, handlers) => {
    runs += 1;
    let cancelled = false;
    if (runs <= HISTORY_TURNS) {
      queueMicrotask(() => {
        handlers.onAssistantDelta?.(historyAnswer);
        handlers.onResponse(historyAnswer);
      });
      return () => undefined;
    }
    const { steps, header } = plan();
    const lag: number[] = [];
    let expected = performance.now() + 5;
    const lagProbe = setInterval(() => {
      const nowMs = performance.now();
      lag.push(Math.max(0, nowMs - expected));
      expected = nowMs + 5;
    }, 5);
    const cpuStart = process.cpuUsage();
    let peakRss = process.memoryUsage().rss;
    const started = performance.now();
    let full = header ?? "";
    if (header) handlers.onAssistantDelta?.(header);
    let seq = 0;
    const emittedTextTokens: number[] = [];
    const emittedToolTokens: number[] = [];
    const next = () => {
      if (cancelled) return;
      const step = steps[seq];
      if (!step) {
        if (workload === "code") {
          full += "```\n";
          handlers.onAssistantDelta?.("```\n");
        }
        handlers.onResponse(full);
        clearInterval(lagProbe);
        const cpu = process.cpuUsage(cpuStart);
        if (summaryFile) {
          writeFileSync(
            summaryFile,
            JSON.stringify({
              workload,
              tokens: steps.length,
              emittedTextTokens,
              emittedToolTokens,
              durationMs: performance.now() - started,
              cpuMs: (cpu.user + cpu.system) / 1000,
              peakRss,
              lagMs: lag,
            }),
          );
        }
        return;
      }
      seq += 1;
      const event = step.build(seq);
      (event.kind === "text" ? emittedTextTokens : emittedToolTokens).push(seq);
      // Marked before dispatch, so "emit" always precedes the handler's mark.
      benchTrace.streamMark("emit", event.kind === "text" ? event.chunk : event.command);
      dispatch(handlers, event);
      if (event.kind === "text") full += event.chunk;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (step.delayMs === 0) queueMicrotask(next);
      else setTimeout(next, step.delayMs);
    };
    setTimeout(next, 0);
    return () => {
      cancelled = true;
      clearInterval(lagProbe);
    };
  },
};

const result = startApp({ providerOverride: provider });
if (!result.started) process.exitCode = result.exitCode;
