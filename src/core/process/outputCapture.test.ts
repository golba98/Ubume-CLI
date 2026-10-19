import assert from "node:assert/strict";
import test from "node:test";
import { createOutputBuffer, omissionMarker } from "./outputCapture.js";

test("full capture keeps every character", () => {
  const buffer = createOutputBuffer("full");
  for (let i = 0; i < 100; i += 1) buffer.append(`line ${i}\n`);
  assert.equal(buffer.text(), Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join(""));
  assert.equal(buffer.omittedChars, 0);
});

test("bounded capture keeps head and tail with an explicit omission marker", () => {
  const buffer = createOutputBuffer({ maxChars: 10 });
  buffer.append("0123456789");
  buffer.append("abcdefghij");
  assert.equal(buffer.omittedChars, 10);
  assert.equal(buffer.text(), `01234${omissionMarker(10)}fghij`);
});

test("bounded capture below its limit is unchanged", () => {
  const buffer = createOutputBuffer({ maxChars: 64 });
  buffer.append("short");
  buffer.append(" output");
  assert.equal(buffer.text(), "short output");
  assert.equal(buffer.omittedChars, 0);
});

test("bounded capture never splits a surrogate pair", () => {
  const buffer = createOutputBuffer({ maxChars: 6 });
  for (let i = 0; i < 50; i += 1) buffer.append("a👩b");
  const text = buffer.text();
  assert.equal(text.length > 0, true);
  // A lone surrogate would not survive a UTF-8 round trip.
  assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
  assert.doesNotMatch(
    text,
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
  );
});

test("bounded capture memory stays bounded for large streams", () => {
  const buffer = createOutputBuffer({ maxChars: 1024 });
  const chunk = "x".repeat(4096);
  for (let i = 0; i < 2048; i += 1) buffer.append(chunk);
  assert.equal(buffer.omittedChars, 2048 * 4096 - 1024);
  assert.ok(buffer.text().length < 1200);
});

test("bounded capture rejects invalid budgets instead of retaining unbounded output", () => {
  for (const maxChars of [NaN, Infinity, -1, 0, 1, 2.5]) {
    assert.throws(() => createOutputBuffer({ maxChars }), RangeError);
  }
});
