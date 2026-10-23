import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAttachedContent,
  createAtomicContentToken,
  createPastedContentLabel,
  createPastedContentToken,
  deleteAdjacentPastedContent,
  expandPastedContent,
  isLargePaste,
  moveAcrossPastedContent,
} from "./pastedContent.js";

test("large paste labels use Unicode character counts and the 1000 character threshold", () => {
  assert.equal(isLargePaste("x".repeat(999)), false);
  assert.equal(isLargePaste("😀".repeat(1_000)), true);
  assert.equal(createPastedContentLabel("😀".repeat(1_000)), "[Pasted Content 1,000 chars]");
});

test("pasted labels expand to raw provider content in occurrence order", () => {
  const first = createPastedContentToken("x".repeat(1_000));
  const second = createPastedContentToken("y".repeat(1_000));
  const registry = new Map([
    [first, ["first raw paste"]],
    [second, ["second raw paste"]],
  ]);
  assert.notEqual(first, second);
  assert.equal(
    expandPastedContent(`before ${first} between ${second} after`, registry),
    "before first raw paste between second raw paste after",
  );
});

test("cursor movement and deletion treat a pasted label as an atomic span", () => {
  const label = "[Pasted Content 1,000 chars]";
  const value = `a${label}b`;
  assert.equal(moveAcrossPastedContent(value, 5, "right"), 1 + label.length);
  assert.equal(moveAcrossPastedContent(value, 5, "left"), 1);
  assert.deepEqual(deleteAdjacentPastedContent(value, 1 + label.length, "backward"), {
    value: "ab",
    cursorOffset: 1,
  });
  assert.deepEqual(deleteAdjacentPastedContent(value, 1, "forward"), {
    value: "ab",
    cursorOffset: 1,
  });
});

test("cursor movement and deletion treat image attachment chips atomically", () => {
  const token = `[Image: clipboard-image.png]\u2063\uFE01\u2063`;
  const value = `before ${token} after`;
  const tokenStart = value.indexOf("[Image:");
  const tokenEnd = tokenStart + token.length;

  assert.equal(moveAcrossPastedContent(value, tokenStart + 3, "left"), tokenStart);
  assert.equal(moveAcrossPastedContent(value, tokenStart + 3, "right"), tokenEnd);
  assert.deepEqual(deleteAdjacentPastedContent(value, tokenEnd, "backward"), {
    value: "before  after",
    cursorOffset: tokenStart,
  });
});

test("unresolved attachments are rejected before expansion while attached literal labels remain valid", () => {
  const token = createAtomicContentToken("[File: example.ts]");
  assert.throws(() => assertAttachedContent(token, new Map(), new Map(), new Map()), /unresolved/);
  assert.doesNotThrow(() =>
    assertAttachedContent(
      token,
      new Map(),
      new Map(),
      new Map([[token, { content: "[File: literal]" }]]),
    ),
  );
  assert.throws(
    () => assertAttachedContent("[Image: missing.png]", new Map(), new Map(), new Map()),
    /image attachment/,
  );
});

test("large pastes expand byte-for-byte at every size, with Unicode and line breaks intact", () => {
  const unit = "line \u00e9\u0301 \u{10eeee}\u0305\u030d 👩🏽‍💻\r\n\tindented — 日本\n";
  for (const size of [1_000, 10_000, 22_704, 50_000, 100_000]) {
    const units = Array.from(unit.repeat(Math.ceil(size / Array.from(unit).length) + 1));
    const content = units.slice(0, size).join("");
    assert.equal(Array.from(content).length, size);
    assert.equal(isLargePaste(content), true);
    const token = createPastedContentToken(content);
    assert.equal(token.startsWith(`[Pasted Content ${size.toLocaleString("en-US")} chars]`), true);
    const registry = new Map([[token, [content]]]);
    const started = performance.now();
    const expanded = expandPastedContent(`before ${token} after`, registry);
    const elapsed = performance.now() - started;
    assert.ok(
      Buffer.from(expanded, "utf8").equals(Buffer.from(`before ${content} after`, "utf8")),
      `paste of ${size} chars changed`,
    );
    // Expansion is a single regex pass; generous bound catches accidental quadratic work.
    assert.ok(elapsed < 250, `expanding ${size} chars took ${elapsed.toFixed(1)}ms`);
  }
});

test("two identical large pastes keep separate payloads", () => {
  const first = "a".repeat(22_704);
  const second = "b".repeat(22_704);
  const firstToken = createPastedContentToken(first);
  const secondToken = createPastedContentToken(second);
  assert.notEqual(firstToken, secondToken);
  const registry = new Map([
    [firstToken, [first]],
    [secondToken, [second]],
  ]);
  assert.equal(expandPastedContent(`${secondToken}|${firstToken}`, registry), `${second}|${first}`);
});
