import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error JavaScript utility script exports are exercised directly.
import { createUbumeDevShim, resolveInstallBinDir } from "./install-dev-shims.mjs";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("resolveInstallBinDir honors explicit ubume dev bin override", () => {
  assert.equal(resolveInstallBinDir({ UBUME_DEV_BIN_DIR: "/tmp/ubume-dev-bin" }), "/tmp/ubume-dev-bin");
});

test("install-dev-shims preserves published ubume while creating both local dev shims", () => {
  const binDir = mkdtempSync(join(tmpdir(), "ubume-dev-bin-"));
  const publishedBin = join(binDir, "ubume");
  writeFileSync(publishedBin, "published", "utf8");

  try {
    const result = createUbumeDevShim({ binDir });
    const shim = readFileSync(result.shimPath, "utf8");

    assert.equal(readFileSync(publishedBin, "utf8"), "published");
    assert.equal(existsSync(join(binDir, "ubume-dev")), process.platform !== "win32");
    assert.equal(existsSync(join(binDir, "ubd")), process.platform !== "win32");
    // New shims target the canonical launcher, quoted because the checkout path may contain spaces.
    assert.ok(shim.includes(JSON.stringify(join(repoRoot, "scripts", "development", "run-local-dev.mjs"))));
    assert.match(shim, /node/);
    assert.doesNotMatch(shim, /bin\/ubume\.js/);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("installed shims from both layouts answer --version without an interactive terminal", () => {
  // Shims installed before scripts were grouped exec scripts/run-local-dev.mjs; it must keep working.
  for (const launcher of [
    join(repoRoot, "scripts", "development", "run-local-dev.mjs"),
    join(repoRoot, "scripts", "run-local-dev.mjs"),
  ]) {
    const output = execFileSync(process.execPath, [launcher, "--version"], { encoding: "utf8" }).trim();
    assert.match(output, /^\d+\.\d+\.\d+-dev local$/);
  }
});
