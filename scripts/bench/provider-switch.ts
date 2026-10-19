/**
 * Offline provider-switching stress benchmark. Each scenario runs
 * `fixtures/providerSwitchApp.tsx` in a fresh sandboxed Bun process (provider-free PATH,
 * temporary home/data, loopback-only network) and reports memory stability, cleanup and
 * switch latency. `--iterations N` (default 100) or `--stress` (500) sets the cycle count.
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

const SCENARIOS = [
  "cycle",
  "same",
  "alternate",
  "local-to-external",
  "after-failure",
  "missing-model",
  "during-discovery",
  "stale",
  "rapid",
  "abort",
];

interface Checkpoint {
  label: string;
  liveHeap: number;
  objects: number;
  rss: number;
  activeTimers: number;
  childProcesses: number;
  catalogListeners: number | null;
  catalogEntries: number | null;
  stdinListeners: number;
  stdoutListeners: number;
}

interface FixtureResult {
  scenario: string;
  ok: boolean;
  error?: string;
  totalMs?: number;
  checkpoints?: Checkpoint[];
  switchTimesMs?: number[];
  peakRss?: number;
  counters?: Record<string, number>;
}

const args = parseBenchArgs();
const iterations = process.argv.includes("--stress") ? 500 : (args.iterations ?? 100);
const only = process.argv.includes("--scenario")
  ? process.argv[process.argv.indexOf("--scenario") + 1]
  : undefined;
const metrics: Metric[] = [];
const details: Record<string, unknown> = {};
let failures = 0;

for (const scenario of SCENARIOS.filter((name) => !only || name === only)) {
  const isolated = createIsolatedRoot(`switch-${scenario}`);
  try {
    const project = join(isolated.root, "project");
    Bun.spawnSync(["mkdir", "-p", project]);
    const child = Bun.spawnSync(
      [process.execPath, join(REPO_ROOT, "scripts/bench/fixtures/providerSwitchApp.tsx"), scenario, String(iterations)],
      { cwd: project, env: { ...isolated.env, TERM: "dumb" }, stdout: "pipe", stderr: "pipe" },
    );
    const line = child.stdout.toString().trim().split("\n").at(-1) ?? "{}";
    const result = JSON.parse(line) as FixtureResult;
    if (!result.ok || !result.checkpoints) {
      failures += 1;
      details[scenario] = { ok: false, error: result.error?.slice(0, 1500) };
      console.warn(`FAILED ${scenario}: ${result.error?.slice(0, 300)}`);
      continue;
    }
    const start = result.checkpoints[0]!;
    const settled = result.checkpoints.at(-1)!;
    const growth = result.checkpoints.slice(1, -1).map((point) => point.liveHeap - start.liveHeap);
    const switches = result.switchTimesMs ?? [];
    metrics.push(metric(`switch.${scenario}.switch_time`, "ms", switches.length ? switches : [0]));
    metrics.push(
      metric(`switch.${scenario}.retained_heap_after_settle`, "bytes", [settled.liveHeap - start.liveHeap], {
        note: "live heap (after full GC) at the end minus after the first switch",
      }),
    );
    metrics.push(
      metric(`switch.${scenario}.heap_growth_checkpoints`, "bytes", growth.length ? growth : [0], {
        note: "live heap at each quarter of the run minus the starting checkpoint",
      }),
    );
    metrics.push(metric(`switch.${scenario}.peak_rss`, "bytes", [result.peakRss ?? 0]));
    details[scenario] = {
      ok: true,
      iterations,
      totalMs: result.totalMs,
      counters: result.counters,
      discoverCallsPerSwitch: switches.length ? (result.counters?.discover ?? 0) / switches.length : null,
      settled: {
        activeTimers: settled.activeTimers,
        childProcesses: settled.childProcesses,
        catalogListeners: settled.catalogListeners,
        catalogEntries: settled.catalogEntries,
        stdinListeners: settled.stdinListeners,
        stdoutListeners: settled.stdoutListeners,
      },
      start: {
        activeTimers: start.activeTimers,
        stdinListeners: start.stdinListeners,
        stdoutListeners: start.stdoutListeners,
      },
      liveHeapByCheckpoint: result.checkpoints.map((point) => [point.label, point.liveHeap]),
      objectsByCheckpoint: result.checkpoints.map((point) => [point.label, point.objects]),
    };
  } finally {
    isolated.dispose();
  }
}

const report: BenchReport = {
  suite: "provider-switch",
  createdAt: new Date().toISOString(),
  environment: environmentInfo(),
  method:
    `${iterations} iterations per scenario in a fresh sandboxed process: the real App and ` +
    "routing in Ink's in-memory terminal with every provider runtime replaced by a local fake " +
    "(synthetic catalogs, scripted failures, a loopback LM Studio stand-in). Each switch opens " +
    "/providers, moves to the target by reading the picker frame, confirms, and waits until the " +
    "saved route changes; it fails on any cross-provider model in the route. Live heap is JSC " +
    "heapSize after two full GCs; timers count active setTimeout/setInterval handles.",
  metrics,
  details,
};
finishSuite(report, args.outDir, args.quiet);
if (failures > 0) process.exitCode = 1;
