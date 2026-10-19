import assert from "node:assert/strict";
import test from "node:test";
import { waitFor } from "../../test/async.js";
import { withEnvironment } from "../../test/environment.js";
import { createOfflineSandbox } from "../../test/offlineSandbox.js";
import { probeCodexAuthStatus } from "./codexAuth.js";

test("auth rejects an invalid configured executable even after a successful environment probe", async () => {
  const sandbox = createOfflineSandbox({
    fakes: { codex: "console.log('Logged in using ChatGPT');" },
  });
  try {
    await withEnvironment(sandbox.env, async () => {
      assert.equal((await probeCodexAuthStatus()).state, "authenticated");
      const before = sandbox.readSpawnLog().length;
      assert.equal(
        (await probeCodexAuthStatus({ codexCommandPath: `${sandbox.root}/missing` })).state,
        "unknown",
      );
      assert.equal(sandbox.readSpawnLog().length, before);
      sandbox.assertSpawnedOnly([sandbox.fakes.codex!]);
    });
  } finally {
    sandbox.dispose();
  }
});

test("canceling auth stops the fake child and prevents a second status attempt", async () => {
  const sandbox = createOfflineSandbox({ fakes: { codex: "setInterval(() => {}, 1000);" } });
  try {
    await withEnvironment(sandbox.env, async () => {
      const controller = new AbortController();
      const pending = probeCodexAuthStatus({ signal: controller.signal, cwd: sandbox.root });
      await waitFor(() => sandbox.readSpawnLog().length === 1, {
        label: "fake auth child started",
      });
      const pid = sandbox.readSpawnLog()[0]!.pid;
      controller.abort();
      assert.equal((await pending).state, "unknown");
      assert.equal(sandbox.readSpawnLog().length, 1);
      assert.throws(() => process.kill(pid, 0), /ESRCH|No such process/);
    });
  } finally {
    sandbox.dispose();
  }
});
