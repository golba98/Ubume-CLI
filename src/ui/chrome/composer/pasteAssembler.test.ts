import assert from "node:assert/strict";
import test from "node:test";
import { PASTE_CHUNK_CANDIDATE_MIN, PASTE_CHUNK_SETTLE_MS } from "./composerKeymap.js";
import { PasteAssembler, type PasteAssemblerTimers } from "./pasteAssembler.js";

function harness() {
  const events: string[] = [];
  let pending: { callback: () => void; ms: number } | null = null;
  let cleared = 0;
  const timers: PasteAssemblerTimers = {
    setTimeout: (callback, ms) => {
      pending = { callback, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      pending = null;
      cleared += 1;
    },
  };
  const assembler = new PasteAssembler(
    { text: (text) => events.push(`text:${text}`), paste: (text) => events.push(`paste:${text}`) },
    timers,
  );
  return {
    assembler,
    events,
    fire: () => {
      const timer = pending;
      pending = null;
      timer?.callback();
    },
    pendingMs: () => pending?.ms ?? null,
    cleared: () => cleared,
  };
}

test("short typed chunks are inserted immediately as text", () => {
  const h = harness();
  h.assembler.feed("hi");
  assert.deepEqual(h.events, ["text:hi"]);
  assert.equal(h.pendingMs(), null);
});

test("a bracketed paste split across chunks is emitted once", () => {
  const h = harness();
  h.assembler.feed("before \u001b[200~part one ");
  h.assembler.feed("part two\r\n");
  assert.deepEqual(h.events, ["text:before "]);
  h.assembler.feed("end\u001b[201~ after");
  assert.deepEqual(h.events, ["text:before ", "paste:part one part two\nend", "text: after"]);
});

test("bracket markers without ESC (as some readline layers deliver them) still work", () => {
  const h = harness();
  h.assembler.feed("[200~x[201~");
  assert.deepEqual(h.events, ["paste:x"]);
});

test("an unbracketed burst is coalesced until the settle timer fires", () => {
  const h = harness();
  const big = "y".repeat(PASTE_CHUNK_CANDIDATE_MIN);
  h.assembler.feed(big);
  assert.deepEqual(h.events, [], "large chunk waits for more");
  assert.equal(h.pendingMs(), PASTE_CHUNK_SETTLE_MS);
  h.assembler.feed("tail");
  assert.deepEqual(h.events, [], "small chunk joins a burst in progress");
  h.fire();
  assert.deepEqual(h.events, [`paste:${big}tail`]);
  h.assembler.feed("ok");
  assert.deepEqual(h.events.at(-1), "text:ok", "typing resumes normally after the burst");
});

test("dispose cancels a pending burst without emitting it", () => {
  const h = harness();
  h.assembler.feed("z".repeat(PASTE_CHUNK_CANDIDATE_MIN + 1));
  h.assembler.dispose();
  assert.equal(h.pendingMs(), null);
  assert.equal(h.cleared(), 1);
  assert.deepEqual(h.events, []);
});
