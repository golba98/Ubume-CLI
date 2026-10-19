/**
 * Shared helpers for the offline benchmark suite. Every benchmark runs in an
 * isolated temporary home with provider executables pointing at missing paths,
 * so no real provider, credential, or user session can be reached.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../../src/test/environment.js";
import {
  assertProviderFreePath,
  createProviderFreePath,
  REFUSING_PROXY,
} from "../../src/test/offlineSandbox.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface SampleStats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  /** Coefficient of variation (stddev / mean). */
  cv: number;
}

export interface Metric {
  /** Stable identifier used by the comparison script. */
  id: string;
  unit: "ms" | "bytes" | "KiB" | "count" | "MB/s";
  /** Whether smaller values are improvements. */
  lowerIsBetter: boolean;
  stats: SampleStats;
  note?: string;
}

export interface BenchReport {
  suite: string;
  createdAt: string;
  environment: ReturnType<typeof environmentInfo>;
  method: string;
  metrics: Metric[];
  details?: unknown;
}

const round = (value: number) => Number(value.toFixed(3));

export function stats(samples: readonly number[]): SampleStats {
  if (samples.length === 0) throw new Error("stats() needs at least one sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, sorted.length - 1);
  const stddev = Math.sqrt(variance);
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    min: round(sorted[0]!),
    max: round(sorted.at(-1)!),
    mean: round(mean),
    stddev: round(stddev),
    cv: mean === 0 ? 0 : round(stddev / mean),
  };
}

export function metric(
  id: string,
  unit: Metric["unit"],
  samples: readonly number[],
  options: { lowerIsBetter?: boolean; note?: string } = {},
): Metric {
  return {
    id,
    unit,
    lowerIsBetter: options.lowerIsBetter ?? true,
    stats: stats(samples),
    ...(options.note ? { note: options.note } : {}),
  };
}

function gitValue(args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function environmentInfo() {
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  return {
    bun: Bun.version,
    node: node.status === 0 ? node.stdout.trim() : null,
    platform: process.platform,
    arch: process.arch,
    kernel: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCores: cpus().length,
    totalMemoryBytes: totalmem(),
    commit: gitValue(["rev-parse", "HEAD"]),
    dirty: (gitValue(["status", "--porcelain"]) ?? "").length > 0,
    fileCache: "warm/unspecified (not controlled)",
  };
}

/** CLI flags shared by every suite: `--out <dir>`, `--iterations <n>`, `--large`. */
export function parseBenchArgs(argv = process.argv.slice(2)) {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    outDir: resolve(value("--out") ?? join(REPO_ROOT, "docs", "_reports", "performance", "bench-results")),
    iterations: Number(value("--iterations") ?? 0) || undefined,
    large: argv.includes("--large"),
    quiet: argv.includes("--quiet"),
  };
}

export function writeReport(report: BenchReport, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${report.suite}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export function printSummary(report: BenchReport): void {
  const rows = report.metrics.map((entry) => {
    const s = entry.stats;
    return `${entry.id.padEnd(52)} ${String(s.p50).padStart(12)} ${String(s.p95).padStart(12)} ${String(
      s.min,
    ).padStart(12)} ${String(s.max).padStart(12)} ${String(s.cv).padStart(7)} ${entry.unit}  n=${s.n}`;
  });
  console.log(`\n== ${report.suite} ==`);
  console.log(
    `${"metric".padEnd(52)} ${"p50".padStart(12)} ${"p95".padStart(12)} ${"min".padStart(
      12,
    )} ${"max".padStart(12)} ${"cv".padStart(7)}  (p99 in JSON)`,
  );
  for (const row of rows) console.log(row);
}

export function finishSuite(report: BenchReport, outDir: string, quiet = false): void {
  const path = writeReport(report, outDir);
  if (!quiet) printSummary(report);
  console.log(`wrote ${path}`);
}

/**
 * PATH isolation is shared with the test suite (`src/test/offlineSandbox.ts`): only trusted
 * runtime tools plus system directories, and construction fails if a provider CLI resolves.
 */
export { assertProviderFreePath as assertProviderFree, PROVIDER_COMMANDS } from "../../src/test/offlineSandbox.js";

/**
 * Disk-backed scratch base inside the (gitignored) results directory. `/tmp` is
 * often tmpfs, where fsync and directory traversal cost nothing like a real disk.
 */
export const ON_DISK_BASE = join(REPO_ROOT, "docs", "_reports", "performance", "bench-results", "tmp");

/** Creates a disposable root and an isolated, provider-free environment beneath it. */
export function createIsolatedRoot(
  prefix: string,
  overrides: NodeJS.ProcessEnv = {},
  options: { onDisk?: boolean } = {},
) {
  const base = options.onDisk ? ON_DISK_BASE : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, `ubume-bench-${prefix}-`));
  mkdirSync(join(root, "data"), { recursive: true });
  const env = createTestEnvironment(root, {
    PATH: createProviderFreePath(join(root, "bin")),
    HTTP_PROXY: REFUSING_PROXY,
    HTTPS_PROXY: REFUSING_PROXY,
    NO_PROXY: "127.0.0.1,localhost,::1",
    ...overrides,
  });
  assertProviderFreePath(env.PATH ?? "");
  return {
    root,
    env,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface ProcessSample {
  wallMs: number;
  userMs: number;
  systemMs: number;
  maxRssKiB: number;
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs one fresh process under GNU time when available. Wall time includes
 * process creation and the `time` wrapper; CPU and max RSS come from rusage of
 * the waited process tree (max RSS is the largest single process, not a sum).
 */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): ProcessSample {
  const timeFile = join(options.env.HOME ?? tmpdir(), `.bench-time-${process.pid}`);
  const useTime = process.platform === "linux" && spawnSync("test", ["-x", "/usr/bin/time"]).status === 0;
  const executable = useTime ? "/usr/bin/time" : command;
  const argv = useTime ? ["-f", "%U %S %M", "-o", timeFile, command, ...args] : args;
  const start = performance.now();
  const result = spawnSync(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const wallMs = performance.now() - start;
  let userMs = Number.NaN;
  let systemMs = Number.NaN;
  let maxRssKiB = Number.NaN;
  if (useTime) {
    const fields = readFileSync(timeFile, "utf8").trim().split(/\s+/).slice(-3);
    userMs = Number(fields[0]) * 1000;
    systemMs = Number(fields[1]) * 1000;
    maxRssKiB = Number(fields[2]);
    rmSync(timeFile, { force: true });
  }
  return {
    wallMs,
    userMs,
    systemMs,
    maxRssKiB,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Samples main-thread scheduling delay with a 5ms timer. Bun's
 * `monitorEventLoopDelay` does not report blocking reliably, so delay is the
 * observed lateness of each timer tick.
 */
export function startEventLoopProbe(intervalMs = 5) {
  const delays: number[] = [];
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - expected));
    expected = now + intervalMs;
  }, intervalMs);
  return {
    stop(): number[] {
      clearInterval(timer);
      return delays.length > 0 ? delays : [0];
    },
  };
}

/** Reads `/proc/<pid>/smaps_rollup` PSS (KiB) for a pid and all descendants (Linux only). */
export function processTreePssKiB(rootPid: number): number | null {
  if (process.platform !== "linux") return null;
  const children = new Map<number, number[]>();
  for (const entry of spawnSync("ps", ["-e", "-o", "pid=,ppid="], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")) {
    const [pid, ppid] = entry.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  let total = 0;
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    try {
      const match = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
      total += Number(match?.[1] ?? 0);
    } catch {
      // The process exited between listing and reading.
    }
    pending.push(...(children.get(pid) ?? []));
  }
  return total;
}

export const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
