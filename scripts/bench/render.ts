/**
 * Offline rendering benchmark: repeats the existing provider-free markdown probe
 * (`scripts/bench/markdown-render-probe.ts`) in fresh processes and aggregates
 * its per-run medians, so JIT and cache warmup are not shared across samples.
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

interface ProbeResult {
  results: Array<{
    fixture: string;
    coldMs: number;
    warmMedianMs: number;
    appendMedianMs: number;
    appendP95Ms: number;
  }>;
  memory: { heapAtStart: { liveHeapSize: number }; heapAfterEach150Turns: Array<{ liveHeapSize: number }>; heapAfterClear: { liveHeapSize: number } };
  pacedSharedResponseRows: { medianMs: number; p95Ms: number; cpuMs: number };
}

const args = parseBenchArgs();
const runs = args.iterations ?? 7;
const isolated = createIsolatedRoot("render");
const probes: ProbeResult[] = [];
try {
  for (let i = 0; i < runs; i += 1) {
    const child = Bun.spawnSync(
      [process.execPath, join(REPO_ROOT, "scripts/bench/markdown-render-probe.ts")],
      { cwd: REPO_ROOT, env: isolated.env, stdout: "pipe", stderr: "inherit" },
    );
    if (child.exitCode !== 0) throw new Error("markdown probe failed");
    probes.push(JSON.parse(child.stdout.toString()));
  }
} finally {
  isolated.dispose();
}

const metrics: Metric[] = [];
for (const fixture of probes[0]!.results.map((result) => result.fixture)) {
  const rows = probes.map((probe) => probe.results.find((result) => result.fixture === fixture)!);
  metrics.push(metric(`render.${fixture}.cold`, "ms", rows.map((row) => row.coldMs)));
  metrics.push(metric(`render.${fixture}.warm_median`, "ms", rows.map((row) => row.warmMedianMs)));
  metrics.push(metric(`render.${fixture}.append_median`, "ms", rows.map((row) => row.appendMedianMs)));
  metrics.push(metric(`render.${fixture}.append_p95`, "ms", rows.map((row) => row.appendP95Ms)));
}
metrics.push(
  metric(
    "render.paced_response_rows.median",
    "ms",
    probes.map((probe) => probe.pacedSharedResponseRows.medianMs),
  ),
);
metrics.push(
  metric("render.paced_response_rows.p95", "ms", probes.map((probe) => probe.pacedSharedResponseRows.p95Ms)),
);
metrics.push(
  metric(
    "render.transcript_600_tables.live_heap_growth",
    "bytes",
    probes.map((probe) => probe.memory.heapAfterEach150Turns.at(-1)!.liveHeapSize - probe.memory.heapAtStart.liveHeapSize),
    { note: "live heap after 600 unique tables minus start (presentation caches are bounded)" },
  ),
);
metrics.push(
  metric(
    "render.transcript_after_clear.retained_heap_delta",
    "bytes",
    probes.map((probe) => probe.memory.heapAfterClear.liveHeapSize - probe.memory.heapAtStart.liveHeapSize),
    { lowerIsBetter: true, note: "live heap after cache clear minus start" },
  ),
);

const report: BenchReport = {
  suite: "render",
  createdAt: new Date().toISOString(),
  environment: environmentInfo(),
  method:
    `${runs} fresh runs of scripts/bench/markdown-render-probe.ts (80 columns; each run's ` +
    "medians are one sample here). Measures markdown parse + row layout and paced streaming " +
    "response rows; excludes Ink reconciliation and terminal writes.",
  metrics,
};
finishSuite(report, args.outDir, args.quiet);
