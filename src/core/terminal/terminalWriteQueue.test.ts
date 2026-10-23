import { expect, test } from "bun:test";
import { createTerminalWriteQueue, terminalChunkEnd } from "./terminalWriteQueue.js";

test("large terminal writes yield between complete lines and preserve callback barriers", async () => {
  const writes: string[] = [],
    callbacks: string[] = [];
  let inputHadATurn = false;
  const queue = createTerminalWriteQueue(
    (text, _encoding, done) => {
      writes.push(String(text));
      done?.();
      return true;
    },
    { threshold: 10, chunkSize: 12 },
  );
  const text = "雪 👩🏽‍💻\n".repeat(20);
  queue.write(text, () => callbacks.push("frame"));
  setImmediate(() => {
    inputHadATurn = true;
    expect(writes.join("").length).toBeLessThan(text.length);
  });
  const barrier = new Promise<void>((resolve) =>
    queue.write("", () => {
      callbacks.push("barrier");
      resolve();
    }),
  );
  await barrier;
  expect(inputHadATurn).toBe(true);
  expect(writes.join("")).toBe(text);
  expect(callbacks).toEqual(["frame", "barrier"]);
  expect(writes.filter(Boolean).every((part) => part.endsWith("\n"))).toBe(true);
  queue.dispose();
});
test("resize cancels obsolete queued output and releases its completion barriers", async () => {
  const writes: string[] = [];
  let completed = false;
  const queue = createTerminalWriteQueue(
    (text, _encoding, done) => {
      writes.push(String(text));
      done?.();
      return true;
    },
    { threshold: 2, chunkSize: 4 },
  );
  queue.write("old\n".repeat(20), () => {
    completed = true;
  });
  queue.cancel();
  await new Promise<void>((resolve) => queue.write("new", () => resolve()));
  expect(completed).toBe(true);
  expect(writes.join("")).not.toContain("old");
  expect(writes.join("")).toContain("new");
  queue.dispose();
});
test("ANSI control strings containing newlines cannot be split", () => {
  const text = "\x1b]title\nline\x07text\nnext\n";
  const end = terminalChunkEnd(text, 0, 4);
  expect(text.slice(0, end)).toBe("\x1b]title\nline\x07text\n");
});
test("small terminal writes preserve synchronous acceptance and errors", () => {
  const error = new Error("closed");
  const queue = createTerminalWriteQueue(() => {
    throw error;
  });
  expect(() => queue.write("small")).toThrow(error);
  queue.dispose();
});
test("disposing a queued repaint prevents late output after terminal handoff", async () => {
  let output = "";
  let finished = false;
  const queue = createTerminalWriteQueue(
    (text, _encoding, done) => {
      output += String(text);
      done?.();
      return true;
    },
    { threshold: 1 },
  );
  queue.write("obsolete\n", () => {
    finished = true;
  });
  queue.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  expect(finished).toBe(true);
  expect(output).not.toContain("obsolete");
});

test("a partially published frame cannot write again after resize, and handoff waits for native drain", async () => {
  const output: string[] = [],
    completions: (() => void)[] = [];
  let oldDone = 0;
  const queue = createTerminalWriteQueue(
    (text, _encoding, done) => {
      output.push(String(text));
      if (done) completions.push(() => done());
      return true;
    },
    { threshold: 2, chunkSize: 4 },
  );
  queue.write("old\n".repeat(10), () => {
    oldDone++;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(output).toEqual(["old\n"]);
  queue.cancel();
  expect(oldDone).toBe(0);
  for (const finish of completions.splice(0)) finish();
  expect(oldDone).toBe(1);
  queue.write("new");
  await new Promise((resolve) => setImmediate(resolve));
  for (const finish of completions.splice(0)) finish();
  expect(output.filter((part) => part === "old\n")).toHaveLength(1);
  expect(output.join("")).toContain("new");
  expect(oldDone).toBe(1);
  queue.dispose();
});
