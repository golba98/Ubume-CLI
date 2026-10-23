import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../../src/test/environment.js";

const script = fileURLToPath(new URL("./configure-codexa-native.mjs", import.meta.url));

test("native registry rewrite preserves model IDs and refuses conflicting output", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-native-registry-fixture-"));
  try {
    const checkpoint = join(root, "fixture.pt");
    const tokenizer = join(root, "tokenizer.json");
    const bytes = Buffer.from("local metadata fixture; never loaded as a model");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(checkpoint, bytes);
    writeFileSync(`${checkpoint}.sha256`, `${sha256}  fixture.pt\n`);
    writeFileSync(tokenizer, "{}");
    const candidates = Object.fromEntries(
      ["base", "repair", "balanced", "original_2h", "END3"].map((key) => [key, { path: checkpoint, sha256 }]),
    );
    const inventory = join(root, "plan.json");
    writeFileSync(inventory, JSON.stringify({ candidates, tokenizer_path: tokenizer, tokenizer_sha256: createHash("sha256").update("{}").digest("hex") }));
    const run = () => spawnSync("node", [script, "--model-root", root, "--inventory", inventory], {
      encoding: "utf8", env: createTestEnvironment(join(root, "home")), timeout: 10000,
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const destination = join(root, "artifacts.codexa-native.local.json");
    const saved = readFileSync(destination, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(saved).models), [
      "codexa-934m-base", "codexa-934m-repair", "codexa-934m-balanced", "codexa-934m-original-2h", "codexa-934m-end3",
    ]);
    if (process.platform !== "win32") assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(destination, "utf8"), saved);
    writeFileSync(destination, '{"existing":"keep"}\n');
    const conflict = run();
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /Existing local registry differs/);
    assert.equal(readFileSync(destination, "utf8"), '{"existing":"keep"}\n');
    assert.deepEqual(readFileSync(checkpoint), bytes);
    assert.equal(readFileSync(tokenizer, "utf8"), "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
