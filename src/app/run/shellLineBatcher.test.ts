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

test("large line batches avoid argument limits and cancellation releases pending output", () => {
  const emitted: string[][] = [];
  const batcher = createShellLineBatcher((stdout) => emitted.push(stdout));
  const lines = Array.from({ length: 200_000 }, (_, index) => String(index));
  batcher.enqueue("stdout", lines);
  batcher.flush();
  assert.deepEqual(emitted[0], lines);
  batcher.enqueue("stdout", ["canceled"]);
  batcher.cancel();
  batcher.flush();
  assert.equal(emitted.length, 1);
});
