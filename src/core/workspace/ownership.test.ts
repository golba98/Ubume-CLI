/**
 * Workspace execution leases across real processes: separate workspaces never contend, a second
 * instance in the same workspace is refused with an actionable message, and only provably dead
 * owners (exited, or a PID reused by another process) are reclaimed.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUbumeWorkspaceDataDir } from "./appData.js";
import { acquireOwnership, inspectOwnership } from "./ownership.js";

const ownershipModule = join(dirname(fileURLToPath(import.meta.url)), "ownership.ts");

const CHILD = `
const { acquireOwnership } = await import(${JSON.stringify(ownershipModule)});
const [workspace, mode] = process.argv.slice(2);
try {
  const lease = acquireOwnership(workspace, "execution");
  process.stdout.write("acquired " + process.pid + "\\n");
  if (mode === "crash") process.exit(0);
  process.stdin.resume();
  process.stdin.on("end", () => { lease.release(); process.exit(0); });
} catch (error) {
  process.stdout.write("busy " + error.message + "\\n");
  process.exit(3);
}
`;

let root: string;
let script: string;
let savedDataDir: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ubume ownership "));
  script = join(root, "child.ts");
  writeFileSync(script, CHILD);
  savedDataDir = process.env.UBUME_DATA_DIR;
  process.env.UBUME_DATA_DIR = join(root, "data");
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  if (savedDataDir === undefined) delete process.env.UBUME_DATA_DIR;
  else process.env.UBUME_DATA_DIR = savedDataDir;
  rmSync(root, { recursive: true, force: true });
});

function workspace(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Starts a child that takes the lease; resolves with its first stdout line. */
function startChild(
  target: string,
  mode: "hold" | "crash",
): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, [script, target, mode], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve({ child, line: output.slice(0, newline) });
    });
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  return child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

test("instances in different workspaces hold execution leases at the same time", async () => {
  const [alpha, beta] = await Promise.all([
    startChild(workspace("alpha"), "hold"),
    startChild(workspace("beta"), "hold"),
  ]);
  expect(alpha.line).toStartWith("acquired ");
  expect(beta.line).toStartWith("acquired ");
  for (const { child } of [alpha, beta]) child.stdin?.end();
  expect(await Promise.all([exited(alpha.child), exited(beta.child)])).toEqual([0, 0]);
}, 20_000);

test("a second instance in the same workspace is refused with the owner and workspace named", async () => {
  const shared = workspace("shared project");
  const owner = await startChild(shared, "hold");
  const ownerPid = owner.line.split(" ")[1];
  expect(() => acquireOwnership(shared, "execution")).toThrow(
    `Another Ubume instance (process ${ownerPid} on ${hostname()}) is running a task in ${shared}.`,
  );
  // The live owner keeps its lease.
  expect(inspectOwnership(shared, "execution").owner?.pid).toBe(Number(ownerPid));
  owner.child.stdin?.end();
  expect(await exited(owner.child)).toBe(0);
  // After a clean release the next instance gets it.
  acquireOwnership(shared, "execution").release();
}, 20_000);

test("a crashed owner does not lock the workspace forever", async () => {
  const target = workspace("crashed");
  const crashed = await startChild(target, "crash");
  expect(await exited(crashed.child)).toBe(0);
  expect(inspectOwnership(target, "execution").locked).toBe(true);
  const lease = acquireOwnership(target, "execution");
  expect(lease.owner.pid).toBe(process.pid);
  lease.release();
  expect(inspectOwnership(target, "execution").locked).toBe(false);
}, 20_000);

function writeOwner(target: string, owner: Record<string, unknown>): void {
  const lock = join(
    resolveUbumeWorkspaceDataDir(target, { readOnly: true }),
    "locks",
    "execution.lock",
  );
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
}

test.skipIf(process.platform !== "linux")(
  "a live PID that was reused by another process is reclaimed; the recorded owner is not",
  () => {
    const target = workspace("reused");
    const base = { host: hostname(), token: "stale", createdAt: new Date(0).toISOString() };
    // This test process is alive, but not the process that started at tick 1.
    writeOwner(target, { ...base, pid: process.pid, startTime: "1" });
    const lease = acquireOwnership(target, "execution");
    expect(lease.owner.startTime).toBeString();
    lease.release();

    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    writeOwner(target, { ...base, pid: process.pid, startTime });
    expect(() => acquireOwnership(target, "execution")).toThrow("Another Ubume instance");
    // Leases written before start times were recorded keep the PID-only liveness check.
    writeOwner(target, { ...base, pid: process.pid });
    expect(() => acquireOwnership(target, "execution")).toThrow("Another Ubume instance");
  },
);
