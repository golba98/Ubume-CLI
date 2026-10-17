import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFinalResponse,
  sanitizeResponseText,
  shouldPauseQueueAfterRun,
} from "./runFinalize.js";

test("undefined responses stay undefined so streamed text is kept", () => {
  assert.equal(sanitizeResponseText(undefined), undefined);
  assert.equal(sanitizeResponseText(null), undefined);
  assert.equal(sanitizeResponseText("plain"), "plain");
});

test("only non-empty completed responses are parsed for follow-up questions", () => {
  assert.deepEqual(parseFinalResponse("failed", "text", true), { content: "text", question: null });
  assert.deepEqual(parseFinalResponse("completed", undefined, true), {
    content: undefined,
    question: null,
  });
  assert.deepEqual(parseFinalResponse("completed", "  ", true), { content: "  ", question: null });
  assert.deepEqual(parseFinalResponse("completed", "answer", false), {
    content: "answer",
    question: null,
  });
  assert.equal(parseFinalResponse("completed", "answer", true).content, "answer");
});

test("the queue pauses after failures, questions and plans", () => {
  assert.equal(shouldPauseQueueAfterRun("completed", null, null), false);
  assert.equal(shouldPauseQueueAfterRun("failed", null, null), true);
  assert.equal(shouldPauseQueueAfterRun("canceled", null, null), true);
  assert.equal(shouldPauseQueueAfterRun("completed", "Which file?", null), true);
  assert.equal(shouldPauseQueueAfterRun("completed", null, { responsePresentation: "plan" }), true);
});
