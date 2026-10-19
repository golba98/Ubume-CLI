/**
 * Offline startup benchmark: fresh processes for launcher, help, version and
 * headless bootstrap paths, plus module-load attribution. Run with Bun.
 *
 * Commands never submit a prompt: `config --json` and `status --json` only read
 * isolated configuration in a temporary workspace.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type BenchReport,
  createIsolatedRoot,
  environmentInfo,
  finishSuite,
  metric,
  type Metric,
  parseBenchArgs,
  REPO_ROOT,
  runProcess,
} from "./lib.js";

const args = parseBenchArgs();
const iterations = args.iterations ?? 30;
const warmup = 3;
const isolated = createIsolatedRoot("startup");
const workspace = join(isolated.root, "project");
mkdirSync(workspace, { recursive: true });
const launcher = join(REPO_ROOT, "bin/ubume.js");
const bun = process.execPath;

interface Case {
  id: string;
  command: string;
  args: string[];
  /** Exit status the case must produce; anything else invalidates the run. */
  expectStatus: number;
}

const cases: Case[] = [
  { id: "floor.node_empty", command: "node", args: ["-e", ""], expectStatus: 0 },
  { id: "floor.bun_empty", command: bun, args: ["-e", ""], expectStatus: 0 },
  { id: "launcher.version", command: "node", args: [launcher, "--version"], expectStatus: 0 },
  { id: "launcher.help", command: "node", args: [launcher, "--help"], expectStatus: 0 },
  { id: "launcher.exec_help", command: "node", args: [launcher, "exec", "--help"], expectStatus: 0 },
  {
    id: "direct_bun.exec_help",
    command: bun,
    args: ["run", "--silent", join(REPO_ROOT, "src/cli.ts"), "exec", "--help"],
    expectStatus: 0,
  },
  {
    id: "launcher.headless_config_json",
    command: "node",
    args: [launcher, "config", "--json"],
    expectStatus: 0,
  },
  {
    id: "launcher.headless_status_json",
    command: "node",
    args: [launcher, "status", "--json"],
    expectStatus: 0,
  },
];

/** Each module is imported in a fresh Bun process; the import time is printed by the child. */
const modules = [
  "src/headless/commands.ts",
  "src/headless/inspectCommands.ts",
  "src/headless/execCommand.ts",
  "src/core/providerRuntime/registry.ts",
  "src/core/providerRuntime/localHarness/runtime.ts",
  "src/core/process/commandRunner.ts",
  "src/app/App.tsx",
  "ink",
  "react",
];

const metrics: Metric[] = [];
const details: Record<string, unknown> = {};

for (const entry of cases) {
  const wall: number[] = [];
  const cpu: number[] = [];
  const rss: number[] = [];
  for (let i = 0; i < warmup + iterations; i += 1) {
    const sample = runProcess(entry.command, entry.args, { cwd: workspace, env: isolated.env });
    if (sample.status !== entry.expectStatus) {
      throw new Error(
        `${entry.id} exited ${sample.status}: ${sample.stderr.slice(0, 400) || sample.stdout.slice(0, 400)}`,
      );
    }
    if (i < warmup) continue;
    wall.push(sample.wallMs);
    cpu.push(sample.userMs + sample.systemMs);
    rss.push(sample.maxRssKiB);
  }
  metrics.push(metric(`${entry.id}.wall`, "ms", wall));
  if (cpu.every(Number.isFinite)) metrics.push(metric(`${entry.id}.cpu`, "ms", cpu));
  if (rss.every(Number.isFinite)) metrics.push(metric(`${entry.id}.max_rss`, "KiB", rss));
}

for (const specifier of modules) {
  const target = specifier.startsWith("src/") ? join(REPO_ROOT, specifier) : specifier;
  const script = `const t=performance.now();await import(${JSON.stringify(target)});console.log(performance.now()-t)`;
  const samples: number[] = [];
  for (let i = 0; i < warmup + Math.min(iterations, 20); i += 1) {
    const sample = runProcess(bun, ["-e", script], { cwd: REPO_ROOT, env: isolated.env });
    if (sample.status !== 0) {
      throw new Error(`import ${specifier} failed: ${sample.stderr.slice(0, 400)}`);
    }
    if (i >= warmup) samples.push(Number(sample.stdout.trim().split("\n").at(-1)));
  }
  metrics.push(metric(`import.${specifier.replace(/^src\//, "").replace(/\W+/g, "_")}`, "ms", samples));
}

const report: BenchReport = {
  suite: "startup",
  createdAt: new Date().toISOString(),
  environment: environmentInfo(),
  method:
    `${warmup} warmup + ${iterations} measured fresh processes per command under /usr/bin/time ` +
    "(wall includes process creation and the wrapper; max_rss is the largest single process " +
    "in the waited tree, not a sum). Isolated HOME/data roots, provider executables missing, " +
    "warm/unspecified file cache. Import timings run each module in a fresh Bun process and " +
    "measure only the dynamic import inside that process.",
  metrics,
  details,
};
try {
  finishSuite(report, args.outDir, args.quiet);
} finally {
  isolated.dispose();
}
