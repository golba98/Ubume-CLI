/**
 * Offline `!shell` output benchmark: runs `fixtures/shellApp.tsx` (real App, in-memory
 * terminal) per output size in a fresh sandboxed process. `--large` adds 100 MB.
 */
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
} from "./lib.js";

const args = parseBenchArgs();
const repeats = args.iterations ?? 3;
const timeoutIndex = process.argv.indexOf("--timeout-ms");
const timeoutMs = timeoutIndex < 0 ? 120_000 : Number(process.argv[timeoutIndex + 1]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive integer milliseconds");
let failedCases = false;
const KiB = 1024;
const sizes: Array<[string, number]> = [
  ["1kb", KiB],
  ["1mb", 1024 * KiB],
  ["10mb", 10 * 1024 * KiB],
  ...(args.large ? ([["100mb", 100 * 1024 * KiB]] as Array<[string, number]>) : []),
];
const metrics: Metric[] = [];
const details: Record<string, unknown[]> = {};
for (const [label, bytes] of sizes) {
  const runs: Array<Record<string, number | boolean | string>> = [];
  for (let i = 0; i < repeats; i += 1) {
    const isolated = createIsolatedRoot(`shell-${label}`);
    try {
      Bun.spawnSync(["mkdir", "-p", join(isolated.root, "project")]);
      const child = Bun.spawnSync(
        [process.execPath, join(REPO_ROOT, "scripts/bench/fixtures/shellApp.tsx")],
        {
          cwd: join(isolated.root, "project"),
          env: { ...isolated.env, TERM: "dumb", BENCH_SHELL_BYTES: String(bytes), BENCH_SHELL_TIMEOUT_MS: String(timeoutMs) },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const result = JSON.parse(child.stdout.toString().trim().split("\n").at(-1) ?? "{}");
      runs.push({ ...result, ok: child.exitCode === 0 && result.ok === true });
      if (child.exitCode !== 0 || result.ok !== true) { failedCases = true; break; }
    } finally {
      isolated.dispose();
    }
  }
  details[label] = runs;
  const ok = runs.filter((run) => run.ok === true);
  if (ok.length !== runs.length) {
    const firstFailure = runs.find((run) => run.ok !== true);
    console.error(`FAILED shell ${label}: ${JSON.stringify(firstFailure)}`);
  }
  if (failedCases) break;
  if (!ok.length) continue;
  metrics.push(metric(`shell.${label}.wall`, "ms", ok.map((run) => Number(run.wallMs))));
  metrics.push(metric(`shell.${label}.peak_rss`, "bytes", ok.map((run) => Number(run.peakRss))));
  metrics.push(metric(`shell.${label}.retained_heap`, "bytes", ok.map((run) => Number(run.retainedHeap)), {
    note: "live heap after full GC once the shell event completed, minus before the command",
  }));
}
const report: BenchReport = {
  suite: "shell-output",
  createdAt: new Date().toISOString(),
  environment: environmentInfo(),
  method:
    `${repeats} fresh sandboxed processes per size (deadline ${timeoutMs}ms per shell): the real App in Ink's in-memory terminal runs ` +
    "`!node -e` writing 100-byte lines with backpressure; completion is the 'Produced N lines' " +
    "summary, which must match the written line count. peak_rss polled every 10 ms.",
  metrics,
  details,
};
finishSuite(report, args.outDir, args.quiet);
if (failedCases) process.exitCode = 1;
