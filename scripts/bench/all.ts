/**
 * Runs every offline benchmark suite in sequence with shared flags
 * (`--out DIR`, `--iterations N`, `--large`). Each suite writes `<suite>.json`
 * to the shared results directory (default `docs/_reports/performance/bench-results/`).
 *
 * Safety: every listed suite is offline by construction (isolated temporary
 * HOME/data roots, provider-free PATH, loopback-only network). This runner
 * adds nothing on its own — it only spawns the suites and forwards flags.
 */
import { join } from "node:path";
import { REPO_ROOT } from "./lib.js";

const forwarded = process.argv.slice(2);

const bun = (script: string) => [process.execPath, join(REPO_ROOT, "scripts/bench", script)];
const python = (script: string) => ["python3", join(REPO_ROOT, "scripts/bench", script)];

const suites: string[][] = [
  bun("startup.ts"),
  python("interactive-startup.py"),
  python("startup-timeline.py"),
  python("update-startup.py"),
  python("idle-memory.py"),
  bun("stream.ts"),
  python("stream-e2e.py"),
  bun("shell-output.ts"),
  bun("provider-switch.ts"),
  bun("workspace.ts"),
  bun("render.ts"),
];

/**
 * Python PTY suites keep their own default sample counts, so `--iterations` and
 * `--large` are held back from them; every other flag passes through unchanged.
 */
function flagsFor(command: string[]): string[] {
  if (command[0] !== "python3") return forwarded;
  return forwarded.filter(
    (flag, index, all) =>
      flag !== "--large"
      && flag !== "--iterations"
      && all[index - 1] !== "--iterations",
  );
}

const failed: string[] = [];
for (const command of suites) {
  const child = Bun.spawnSync([...command, ...flagsFor(command)], { stdout: "inherit", stderr: "inherit" });
  if (child.exitCode !== 0) failed.push(command.at(-1)!);
}

if (failed.length > 0) {
  console.error(`suites failed: ${failed.join(", ")}`);
  process.exit(1);
}
