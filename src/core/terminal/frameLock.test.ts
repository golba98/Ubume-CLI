import assert from "node:assert/strict";
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

  test("frame lock drops concurrent writes", () => {
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

    assert.equal(writeCount, 1); // Nested write should have been dropped by the lock
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
