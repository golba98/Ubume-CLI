import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_UPDATE_FLUSH_MS } from "./promptRunPrep.js";
import { createShellLineBatcher } from "./shellLineBatcher.js";

test("createShellLineBatcher batches lines per stream and flushes once", async () => {
  const emitted: Array<[string[], string[]]> = [];
  const batcher = createShellLineBatcher((stdout, stderr) => emitted.push([stdout, stderr]));
  batcher.enqueue("stdout", ["a"]);
  batcher.enqueue("stderr", ["e"]);
  batcher.enqueue("stdout", ["b"]);
  assert.equal(emitted.length, 0);
  batcher.flush();
  assert.deepEqual(emitted, [[["a", "b"], ["e"]]]);
  batcher.flush();
  assert.equal(emitted.length, 1, "an empty flush emits nothing");

  batcher.enqueue("stdout", ["c"]);
  await new Promise((resolve) => setTimeout(resolve, LIVE_UPDATE_FLUSH_MS + 20));
  assert.deepEqual(emitted[1], [["c"], []]);

  batcher.enqueue("stdout", ["d"]);
  batcher.cancel();
  await new Promise((resolve) => setTimeout(resolve, LIVE_UPDATE_FLUSH_MS + 20));
  assert.equal(emitted.length, 2, "cancel drops the pending timer");
});
