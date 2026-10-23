import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helpers = fileURLToPath(new URL("./child-process.mjs", import.meta.url));

/**
 * Runs a tiny launcher that spawns `childArgs` through the helpers, the way the dev launcher
 * does, and returns how the launcher itself ended.
 */
function launch(executable: string, childArgs: string[]) {
  const script = `
    import { spawn } from "node:child_process";
    import { exitOnSpawnError, forwardChildExit } from ${JSON.stringify(helpers)};
    const child = spawn(${JSON.stringify(executable)}, ${JSON.stringify(childArgs)}, { stdio: "inherit" });
    exitOnSpawnError(child, "fixture", "install the fixture");
    forwardChildExit(child);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
}

test("forwardChildExit returns the child's exit code", () => {
  assert.equal(launch(process.execPath, ["-e", "process.exit(3)"]).status, 3);
  assert.equal(launch(process.execPath, ["-e", ""]).status, 0);
});

test("forwardChildExit re-raises a fatal signal instead of reporting success", () => {
  const result = launch(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]);
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM");
});

test("exitOnSpawnError exits 1 with the reason and the hint", () => {
  const result = launch("/nonexistent/ubume-fixture-binary", []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^fixture: failed to launch: .*ENOENT/m);
  assert.match(result.stderr, /install the fixture/);
});
