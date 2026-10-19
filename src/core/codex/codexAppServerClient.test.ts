import assert from "node:assert/strict";
import test from "node:test";
import { waitFor } from "../../test/async.js";
import { withEnvironment } from "../../test/environment.js";
import { createOfflineSandbox } from "../../test/offlineSandbox.js";
import { withCodexAppServer } from "./codexAppServerClient.js";

test("app-server cancellation waits for an ignoring fake process to stop", async () => {
  const sandbox = createOfflineSandbox({
    fakes: { codex: "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);" },
  });
  try {
    await withEnvironment(sandbox.env, async () => {
      const controller = new AbortController();
      const pending = withCodexAppServer(
        sandbox.fakes.codex!,
        {
          timeoutMs: 6000,
          signal: controller.signal,
          operation: "offline cancellation",
          cwd: sandbox.root,
        },
        async () => "unreachable",
      );
      // Observe rejection immediately while the cancellation fixture starts.
      const rejected = assert.rejects(pending, /canceled/);
      await waitFor(() => sandbox.readSpawnLog().length === 1, {
        label: "app-server fake started",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const pid = sandbox.readSpawnLog()[0]!.pid;
      controller.abort();
      await rejected;
      assert.throws(() => process.kill(pid, 0), /ESRCH|No such process/);
    });
  } finally {
    sandbox.dispose();
  }
});

test("app-server discovery uses the workspace and decodes fragmented Unicode before awaiting exit", async () => {
  const sandbox = createOfflineSandbox({
    fakes: {
      codex: `
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  if (request.id == null) return;
  const result=request.method==='initialize'?{}:{cwd:process.cwd(),text:'你好🌸'};
  const data=Buffer.from(JSON.stringify({id:request.id,result})+'\\n');
  const split=Math.max(1,data.indexOf(Buffer.from('你'))+1);
  process.stdout.write(data.subarray(0,split));
  setTimeout(()=>process.stdout.write(data.subarray(split)),5);
});
`,
    },
  });
  try {
    await withEnvironment(sandbox.env, async () => {
      const result = await withCodexAppServer(
        sandbox.fakes.codex!,
        { timeoutMs: 3000, cwd: sandbox.root, operation: "offline discovery" },
        (client) => client.request("ping"),
      );
      assert.deepEqual(result, { cwd: sandbox.root, text: "你好🌸" });
      assert.throws(() => process.kill(sandbox.readSpawnLog()[0]!.pid, 0), /ESRCH|No such process/);
    });
  } finally {
    sandbox.dispose();
  }
});

test("an already canceled discovery never starts a child", async () => {
  const sandbox = createOfflineSandbox({ fakes: { codex: true } });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      withCodexAppServer(
        sandbox.fakes.codex!,
        { signal: controller.signal, timeoutMs: 1000, operation: "offline discovery" },
        async () => "unexpected",
      ),
      /canceled/,
    );
    assert.equal(sandbox.readSpawnLog().length, 0);
  } finally {
    sandbox.dispose();
  }
});
