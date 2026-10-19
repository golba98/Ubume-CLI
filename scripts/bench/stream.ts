/**
 * Offline streaming and subprocess-retention benchmark. Each case runs in a
 * fresh Bun child (`--case NAME`) so retained memory from one case cannot
 * contaminate the next. Producers are `fakeProducer.mjs`; no provider is used.
 */
import { fullGC, heapStats } from "bun:jsc";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BenchReport,
  createIsolatedRoot,
  environmentInfo,
  finishSuite,
  type Metric,
  metric,
  parseBenchArgs,
  REPO_ROOT,
  sleep,
} from "./lib.js";

const MiB = 1024 * 1024;
const PRODUCER = join(REPO_ROOT, "scripts/bench/fakeProducer.mjs");
const UTF8_SAMPLE = "é漢字👩🏽‍💻ñ€";

interface CaseResult {
  wallMs: number;
  peakRssBytes: number;
  retainedHeapBytes: number;
  bytesObserved: number;
  replacementChars?: number;
  latenciesMs?: number[];
  ok: boolean;
  detail?: string;
}

/** Polls RSS while a case runs; Bun has no per-allocation high-water API. */
function rssSampler() {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(peak, process.memoryUsage().rss);
    },
  };
}

async function retainedHeap(): Promise<number> {
  await sleep(0);
  fullGC();
  await sleep(0);
  fullGC();
  return heapStats().heapSize;
}

function countReplacement(text: string): number {
  let count = 0;
  for (const char of text) if (char === "�") count += 1;
  return count;
}

async function runnerCase(mode: string, bytes: number): Promise<CaseResult> {
  const { runCommand } = await import("../../src/core/process/commandRunner.js");
  const sampler = rssSampler();
  const start = performance.now();
  let observed = 0;
  let streamed = "";
  const latencies: number[] = [];
  const run = runCommand(
    {
      executable: "node",
      args: [PRODUCER],
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        BENCH_MODE: mode,
        BENCH_BYTES: String(bytes),
        BENCH_RECORDS: "400",
        BENCH_INTERVAL_MS: "5",
      },
    },
    {
      onStdout: (text) => {
        observed += text.length;
        if (mode === "utf8") streamed += text;
        if (mode === "paced") {
          const receivedAt = performance.timeOrigin + performance.now();
          for (const line of text.split("\n")) {
            if (line.startsWith("T ")) latencies.push(receivedAt - Number(line.slice(2)));
          }
        }
      },
    },
  );
  const result = await run.result;
  const wallMs = performance.now() - start;
  const peakRssBytes = sampler.stop();
  // Measure while the caller still holds the result, as real callers do.
  const retainedHeapBytes = await retainedHeap();
  const expectedUtf8 = UTF8_SAMPLE.repeat(400);
  return {
    wallMs,
    peakRssBytes,
    retainedHeapBytes,
    bytesObserved: observed,
    ...(mode === "utf8"
      ? { replacementChars: countReplacement(streamed) + countReplacement(result.stdout) }
      : {}),
    ...(mode === "paced" ? { latenciesMs: latencies.slice(20) } : {}),
    ok:
      result.status === "completed" &&
      (mode !== "utf8" || (streamed === expectedUtf8 && result.stdout === expectedUtf8)),
    detail: `${result.status}; result.stdout ${result.stdout.length} chars`,
  };
}

async function codexCase(mode: "codex" | "answer", bytes: number, root: string): Promise<CaseResult> {
  const { codexSubprocessProvider } = await import("../../src/core/providers/codexSubprocess.js");
  const { createTestRuntime } = await import("../../src/test/runtimeTestUtils.js");
  const executable = join(root, "codex");
  copyFileSync(PRODUCER, executable);
  chmodSync(executable, 0o700);
  // The run inherits this process environment (already provider-free, see
  // runInChild). The executable travels both as codexCommandPath and as the
  // CODEX_EXECUTABLE override (kept for parity with the Phase 1 fixture, which
  // predates the Phase 1.1 runtime-normalizer fix), and resolution is checked below.
  process.env.CODEX_EXECUTABLE = executable;
  process.env.BENCH_MODE = mode;
  process.env.BENCH_BYTES = String(bytes);
  const { resolveCodexExecutable } = await import("../../src/core/executables/codexExecutable.js");
  const resolved = await resolveCodexExecutable({ configuredPath: executable });
  if (resolved !== executable) throw new Error(`codex resolved to ${resolved}, not the fake`);
  const sampler = rssSampler();
  const start = performance.now();
  let observed = 0;
  let toolOutput = 0;
  const outcome = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    codexSubprocessProvider.run!(
      "bench",
      {
        runtime: { ...createTestRuntime(), codexCommandPath: executable },
        workspaceRoot: root,
        promptPolicy: "raw",
      },
      {
        onResponse: (response) => resolve({ ok: true, detail: `response ${response.length} chars` }),
        onError: (message) => resolve({ ok: false, detail: message }),
        onAssistantDelta: (chunk) => {
          observed += chunk.length;
        },
        onToolActivity: (activity) => {
          toolOutput += activity.output?.length ?? 0;
        },
      },
    );
  });
  const wallMs = performance.now() - start;
  const peakRssBytes = sampler.stop();
  const retainedHeapBytes = await retainedHeap();
  return {
    wallMs,
    peakRssBytes,
    retainedHeapBytes,
    bytesObserved: observed + toolOutput,
    ok: outcome.ok,
    detail: outcome.detail,
  };
}

/** Launcher → Bun → fake codex; stdout drained by a fast or deliberately slow reader. */
async function headlessCase(consumer: "fast" | "slow", bytes: number, root: string) {
  const executable = join(root, "codex");
  copyFileSync(PRODUCER, executable);
  chmodSync(executable, 0o700);
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const { createTestEnvironment } = await import("../../src/test/environment.js");
  const env = createTestEnvironment(root, {
    CODEX_EXECUTABLE: executable,
    BENCH_MODE: "answer",
    BENCH_BYTES: String(bytes),
  });
  const timeFile = join(root, "time.txt");
  const start = performance.now();
  const child = Bun.spawn(
    [
      "/usr/bin/time",
      "-f",
      "%M",
      "-o",
      timeFile,
      "node",
      join(REPO_ROOT, "bin/ubume.js"),
      "exec",
      "--provider",
      "openai",
      "--no-save",
      "--skip-git-repo-check",
      "--",
      "bench",
    ],
    { cwd: project, env, stdout: "pipe", stderr: "ignore" },
  );
  let received = 0;
  let firstByteMs = 0;
  const reader = child.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received === 0) firstByteMs = performance.now() - start;
    received += value.length;
    // Throttled to ~4 MiB/s: not reading lets the pipe fill, so the writer sees
    // real backpressure.
    if (consumer === "slow") await sleep((value.length / (4 * MiB)) * 1000);
  }
  const status = await child.exited;
  const wallMs = performance.now() - start;
  const maxRssKiB = Number(readFileSync(timeFile, "utf8").trim().split(/\s+/).at(-1));
  // Every 64 KiB message is streamed; the last one is then printed again after a
  // newline because the final answer does not extend the concatenated stream.
  const messages = Math.ceil(bytes / (64 * 1024));
  const expected = messages * 64 * 1024 + 1 + (64 * 1024 - 1) + 1;
  return { wallMs, firstByteMs, maxRssKiB, received, expected, ok: status === 0 && received === expected };
}

async function runCase(name: string): Promise<unknown> {
  const isolated = createIsolatedRoot("stream-case");
  try {
    switch (name) {
      case "runner-lines-10mb":
        return await runnerCase("lines", 10 * MiB);
      case "runner-lines-100mb":
        return await runnerCase("lines", 100 * MiB);
      case "runner-utf8":
        return await runnerCase("utf8", 0);
      case "runner-paced":
        return await runnerCase("paced", 0);
      case "codex-tools-10mb":
        return await codexCase("codex", 10 * MiB, isolated.root);
      case "codex-tools-100mb":
        return await codexCase("codex", 100 * MiB, isolated.root);
      case "headless-fast-20mb":
        return await headlessCase("fast", 20 * MiB, isolated.root);
      case "headless-slow-20mb":
        return await headlessCase("slow", 20 * MiB, isolated.root);
      default:
        throw new Error(`unknown case ${name}`);
    }
  } finally {
    isolated.dispose();
  }
}

async function runInChild(name: string): Promise<Record<string, unknown>> {
  // Each case process gets its own isolated home and a PATH without provider CLIs.
  const isolated = createIsolatedRoot("stream-runner");
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "--case", name], {
      stdout: "pipe",
      stderr: "inherit",
      env: isolated.env,
    });
    const text = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(`case ${name} failed`);
    return JSON.parse(text.trim().split("\n").at(-1)!);
  } finally {
    isolated.dispose();
  }
}

async function main() {
  const caseIndex = process.argv.indexOf("--case");
  if (caseIndex >= 0) {
    console.log(JSON.stringify(await runCase(process.argv[caseIndex + 1]!)));
    return;
  }
  const args = parseBenchArgs();
  const repeats = args.iterations ?? 3;
  const metrics: Metric[] = [];
  const details: Record<string, unknown[]> = {};
  let failedCases = false;
  const cases = [
    "runner-lines-10mb",
    "runner-utf8",
    "runner-paced",
    "codex-tools-10mb",
    "headless-fast-20mb",
    "headless-slow-20mb",
    ...(args.large ? ["runner-lines-100mb", "codex-tools-100mb"] : []),
  ];
  for (const name of cases) {
    const runs: Record<string, unknown>[] = [];
    for (let i = 0; i < repeats; i += 1) runs.push(await runInChild(name));
    details[name] = runs.map(({ latenciesMs: _latencies, ...rest }) => rest);
    const failed = runs.find((run) => run.ok !== true);
    const values = (key: string) => runs.map((run) => Number(run[key]));
    metrics.push(metric(`${name}.wall`, "ms", values("wallMs")));
    if (name.startsWith("headless")) {
      metrics.push(metric(`${name}.max_rss`, "KiB", values("maxRssKiB")));
      metrics.push(metric(`${name}.first_byte`, "ms", values("firstByteMs")));
    } else {
      metrics.push(metric(`${name}.peak_rss`, "bytes", values("peakRssBytes")));
      metrics.push(metric(`${name}.retained_heap`, "bytes", values("retainedHeapBytes")));
    }
    if (name === "runner-utf8") {
      metrics.push(
        metric(`${name}.replacement_chars`, "count", values("replacementChars"), {
          note: "U+FFFD introduced by chunk decoding; correct output has none",
        }),
      );
    }
    if (name === "runner-paced") {
      metrics.push(
        metric(
          `${name}.emit_to_callback`,
          "ms",
          runs.flatMap((run) => run.latenciesMs as number[]),
          { note: "producer timestamp to onStdout, cross-process clock" },
        ),
      );
    }
    if (failed) {
      failedCases = true;
      console.error(`FAILED ${name}: ${JSON.stringify(failed)}`);
    }
  }
  const report: BenchReport = {
    suite: "stream",
    createdAt: new Date().toISOString(),
    environment: environmentInfo(),
    method:
      `${repeats} fresh Bun processes per case. runner-* drive runCommand on a node producer; ` +
      "codex-* drive codexSubprocessProvider against a fake codex; headless-* run the real " +
      "launcher (exec --no-save) with a fake codex streaming 64 KiB assistant messages, stdout " +
      "read by a fast reader or one throttled to ~4 MiB/s. peak_rss is polled every 5ms; " +
      "retained_heap is JSC live heap after full GC while the result is still referenced.",
    metrics,
    details,
  };
  finishSuite(report, args.outDir, args.quiet);
  if (failedCases) process.exitCode = 1;
}

await main();
