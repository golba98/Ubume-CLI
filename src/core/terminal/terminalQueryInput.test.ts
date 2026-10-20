import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalReplyFilter } from "./terminalQueryInput.js";

test("fragmented terminal replies are consumed while concurrent typing survives", () => {
  const filter = createTerminalReplyFilter();
  const parts = [
    "hello\x1b_Gi=31",
    "4159;OK\x1b",
    "\\🌱\x1bP>|kit",
    "ty(0.47.1)\x1b\\",
    "\x1b[?62;4cworld",
  ];
  let input = "";
  const replies: string[] = [];
  for (const part of parts) {
    const result = filter.push(part, true);
    input += result.input;
    replies.push(...result.replies);
  }
  assert.equal(input, "hello🌱world");
  assert.equal(replies.length, 3);
  assert.equal(filter.flush(), "");
});
test("ordinary key sequences, unrelated graphics replies and non-probed streams pass unchanged", () => {
  const text = "\x1b[?31u\x1b[A\x03\x1b[200~paste\x1b[201~\x1b_Gi=999;OK\x1b\\";
  const filter = createTerminalReplyFilter();
  assert.equal(filter.push(text, true).input, text);
  assert.equal(filter.push("\x1b_Gi=314159;OK\x1b\\", false).input, "\x1b_Gi=314159;OK\x1b\\");
  assert.equal(filter.push("\x1b", true).input, "");
  assert.equal(filter.flush(), "\x1b");
});
test("malformed responses cannot grow the pending input buffer indefinitely", () => {
  const filter = createTerminalReplyFilter();
  const malformed = "\x1bP>|" + "x".repeat(1000);
  assert.equal(filter.push(malformed, true).input + filter.flush(), malformed);
});

test("fragmented image capability, cell size and background replies never reach input", () => {
  const filter = createTerminalReplyFilter();
  const replies = [
    "\x1b[6;24;12t",
    "\x1b]11;rgb:ffff/aaaa/0000\x07",
    "\x1b]1337;Capabilities=F\x1b\\",
    "\x1b]1337;ReportCellSize=20;9;2\x07",
  ];
  for (const expected of replies) {
    let input = "";
    const received: string[] = [];
    for (const character of expected) {
      const part = filter.push(character, true);
      input += part.input;
      received.push(...part.replies);
    }
    assert.equal(input, "");
    assert.deepEqual(received, [expected]);
  }
  assert.equal(filter.push("\x1b[6;2~typed", true).input, "\x1b[6;2~typed");
});
