import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertProviderFreePath, createOfflineSandbox } from "./offlineSandbox.js";

test("offline sandbox excludes real providers and only executes explicit fixtures", () => {
  const sandbox = createOfflineSandbox({ fakes: { codex: true } });
  try {
    assertProviderFreePath(sandbox.env.PATH ?? "");
    assert.ok(sandbox.env.HOME?.startsWith(sandbox.root));
    assert.equal(sandbox.env.OPENAI_API_KEY, undefined);
    const run = spawnSync(sandbox.fakes.codex!, ["--version"], {
      env: sandbox.env,
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /offline-fake/);
    assert.equal(sandbox.readSpawnLog().length, 1);
    sandbox.assertSpawnedOnly([sandbox.fakes.codex!]);
  } finally {
    sandbox.dispose();
  }
});

test("test preload blocks external provider requests", async () => {
  await assert.rejects(fetch("https://example.invalid/ubume-test"), /offline test sandbox blocked/);
});
