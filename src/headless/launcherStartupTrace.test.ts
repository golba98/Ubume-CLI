import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTestEnvironment } from "../test/environment.js";

const launcher = fileURLToPath(new URL("../../bin/ubume.js", import.meta.url));

function probe(root: string, performanceSetup: string, traceFile?: string) {
  return spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `${performanceSetup}; process.argv = [process.execPath, ${JSON.stringify(launcher)}, "--version"]; await import(${JSON.stringify(pathToFileURL(launcher).href)});`,
    ],
    {
      cwd: root,
      env: createTestEnvironment(root, traceFile ? { UBUME_STARTUP_TRACE: traceFile } : {}),
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

test("disabled launcher tracing does not initialize the performance clock", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-launcher-trace-off-"));
  try {
    const result = probe(
      root,
      'Object.defineProperty(globalThis, "performance", { get() { throw new Error("disabled tracing accessed the clock"); } })',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled launcher tracing retains process-origin and script timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-launcher-trace-on-"));
  try {
    const trace = join(root, "startup.jsonl");
    const result = probe(
      root,
      'Object.defineProperty(globalThis, "performance", { value: { timeOrigin: 1000, now: () => 2 } })',
      trace,
    );
    assert.equal(result.status, 0, result.stderr);
    const rows = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.find((row) => row.stage === "launcher-process-start")?.t, 1000);
    assert.equal(rows.find((row) => row.stage === "launcher-script-start")?.t, 1002);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
