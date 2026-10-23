import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, test } from "node:test";
import { releaseFrameLock, resetFrameLockForResize, wrapStdoutWithFrameLock } from "./frameLock.js";

describe("frameLock", () => {
  test("deduplicates identical consecutive frames", () => {
    const writes: string[] = [];
    const stdout = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    };

    const wrapped = wrapStdoutWithFrameLock({ stdout, env: {} });

    wrapped.write("frame 1");
    wrapped.write("frame 1"); // Should be dropped
    wrapped.write("frame 2");
    wrapped.write("frame 1"); // Should NOT be dropped (not consecutive)

    // Note: frameLock appends \x1b[K
    assert.deepEqual(writes, ["frame 1\x1b[K", "frame 2\x1b[K", "frame 1\x1b[K"]);
  });

  test("injects \x1b[K before newlines and at end of frame", () => {
    const writes: string[] = [];
    const stdout = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    };

    const wrapped = wrapStdoutWithFrameLock({ stdout, env: {} });

    wrapped.write("line 1\nline 2");

    assert.equal(writes[0], "line 1\x1b[K\nline 2\x1b[K");
  });

  test("frame lock preserves reentrant writes", () => {
    let writeCount = 0;
    const stdout = {
      write: (_chunk: string) => {
        writeCount++;
        // Trigger a nested write during the first write
        if (writeCount === 1) {
          wrapped.write("nested frame");
        }
        return true;
      },
    };

    const wrapped = wrapStdoutWithFrameLock({ stdout, env: {} });

    wrapped.write("initial frame");

    assert.equal(writeCount, 2);
  });

  test("terminal resize invalidates identical-frame deduplication", () => {
    const writes: string[] = [];
    const stdout = {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    };

    const wrapped = wrapStdoutWithFrameLock({ stdout, env: {} });
    wrapped.write("same frame");
    wrapped.write("same frame");
    resetFrameLockForResize(stdout);
    wrapped.write("same frame");

    assert.deepEqual(writes, ["same frame\x1b[K", "same frame\x1b[K"]);
  });
});

test("releasing and rewrapping frame lock restores the writer without nested wrappers", () => {
  const writes: string[] = [];
  const write = (chunk: string) => {
    writes.push(chunk);
    return true;
  };
  const stdout = { write };
  wrapStdoutWithFrameLock({ stdout, env: {} });
  stdout.write("same");
  wrapStdoutWithFrameLock({ stdout, env: {} });
  stdout.write("same");
  releaseFrameLock(stdout);
  assert.equal(stdout.write, write);
  stdout.write("same");
  releaseFrameLock(stdout);
  assert.deepEqual(writes, ["same\x1b[K", "same\x1b[K", "same"]);
});

test("frame lock preserves ordered empty-write, deduplicated-write and encoding callbacks", async () => {
  const chunks: string[] = [];
  const completed: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      setTimeout(() => {
        chunks.push(chunk.toString());
        callback();
      }, 5);
    },
  });
  wrapStdoutWithFrameLock({ stdout, env: {} });
  try {
    await new Promise<void>((resolve, reject) => {
      stdout.write("fixture", "utf8", (error) => {
        if (error) reject(error);
        completed.push("first");
      });
      stdout.write("fixture", (error) => {
        if (error) reject(error);
        completed.push("duplicate");
      });
      stdout.write("", (error) => {
        if (error) reject(error);
        completed.push("barrier");
        resolve();
      });
    });
    assert.deepEqual(completed, ["first", "duplicate", "barrier"]);
    assert.equal(chunks.filter(Boolean).join(""), "fixture\x1b[K");
  } finally {
    releaseFrameLock(stdout);
    stdout.destroy();
  }
});

test("height-only resize preserves a pending historical publication when Ink has no new live frame", async () => {
  let output = "";
  const stdout = {
    isTTY: true,
    fd: 123,
    write(
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) {
      output += String(chunk);
      const done = typeof encoding === "function" ? encoding : callback;
      done?.();
      return true;
    },
  };
  wrapStdoutWithFrameLock({ stdout, env: {} });
  const history = "HISTORICAL_ROW\n".repeat(4000);
  stdout.write(history);
  resetFrameLockForResize(stdout, false);
  await new Promise<void>((resolve) => stdout.write("", () => resolve()));
  assert.equal(output.split("HISTORICAL_ROW").length - 1, 4000);
  releaseFrameLock(stdout);
});
