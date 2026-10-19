/**
 * Compares two benchmark result directories (or single files) metric by metric.
 *
 *   bun scripts/bench/compare.ts <before-dir> <after-dir> [--json out.json]
 *
 * Classification is deliberately conservative: a change counts only when the
 * medians differ by more than both 5% and the larger run's spread (stddev and
 * p50→p95 distance); otherwise it is "inconclusive". No threshold fails a run —
 * regressions are reported, never enforced here.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchReport, Metric } from "./lib.js";

type Verdict = "improved" | "regressed" | "inconclusive" | "new" | "removed";

/** Loads every metric from a report directory (all .json files) or a single file. */
function loadReportMetrics(path: string): Map<string, { suite: string; metric: Metric }> {
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(path, name))
    : [path];

  const metrics = new Map<string, { suite: string; metric: Metric }>();
  for (const file of files) {
    const report = JSON.parse(readFileSync(file, "utf8")) as BenchReport;
    if (!Array.isArray(report.metrics)) continue;
    for (const entry of report.metrics) metrics.set(entry.id, { suite: report.suite, metric: entry });
  }
  return metrics;
}

/** Conservative verdict for one metric based on medians, spread and direction. */
function classify(before: Metric, after: Metric): { verdict: Verdict; changePct: number } {
  const a = before.stats;
  const b = after.stats;
  const changePct = a.p50 === 0 ? (b.p50 === 0 ? 0 : 100) : ((b.p50 - a.p50) / Math.abs(a.p50)) * 100;
  // Noise budget: the larger of either run's stddev or its p50→p95 distance.
  const noise = Math.max(a.stddev, b.stddev, a.p95 - a.p50, b.p95 - b.p50);
  const delta = b.p50 - a.p50;
  if (Math.abs(changePct) < 5 || Math.abs(delta) <= noise) return { verdict: "inconclusive", changePct };
  const better = before.lowerIsBetter ? delta < 0 : delta > 0;
  return { verdict: better ? "improved" : "regressed", changePct };
}

/** Extracts <before> <after> and the optional --json target from argv. */
function parseArguments(argv: string[]) {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const beforePath = positional[0];
  const afterPath = positional[1];
  if (!beforePath || !afterPath || !existsSync(beforePath) || !existsSync(afterPath)) {
    console.error("usage: bun scripts/bench/compare.ts <before> <after> [--json out.json]");
    process.exit(2);
  }
  const jsonIndex = argv.indexOf("--json");
  return { beforePath, afterPath, jsonOut: jsonIndex >= 0 ? argv[jsonIndex + 1] : undefined };
}

function printRow(row: Record<string, unknown>) {
  if (row.verdict === "new" || row.verdict === "removed") {
    console.log(`${String(row.id).padEnd(58)} ${row.verdict}`);
    return;
  }
  console.log(
    `${String(row.id).padEnd(58)} ${String(row.beforeP50).padStart(12)} → ${String(row.afterP50).padEnd(
      12,
    )} ${`${row.changePct}%`.padStart(9)}  ${row.verdict}  (${row.unit})`,
  );
}

const { beforePath, afterPath, jsonOut } = parseArguments(process.argv);
const before = loadReportMetrics(beforePath);
const after = loadReportMetrics(afterPath);

const rows: Array<Record<string, unknown>> = [];
for (const id of new Set([...before.keys(), ...after.keys()])) {
  const a = before.get(id);
  const b = after.get(id);
  if (!a || !b) {
    rows.push({ id, verdict: a ? "removed" : "new" });
    continue;
  }
  const { verdict, changePct } = classify(a.metric, b.metric);
  rows.push({
    id,
    unit: a.metric.unit,
    beforeP50: a.metric.stats.p50,
    afterP50: b.metric.stats.p50,
    beforeP95: a.metric.stats.p95,
    afterP95: b.metric.stats.p95,
    changePct: Number(changePct.toFixed(1)),
    verdict,
  });
}

for (const row of rows) printRow(row);

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(rows, null, 2)}\n`);
