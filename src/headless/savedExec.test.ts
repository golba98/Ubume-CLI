import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRecord } from "../core/workspace/conversationStore.js";
import { appendCrashInterruptedAnswer, runStatusForExitCode } from "./savedExec.js";

function record(runStatus: string, lastRole: "user" | "assistant"): ConversationRecord {
  return {
    metadata: {},
    messages: [{ role: lastRole, content: "hello", turnId: 2 }],
    session: {
      events: [
        { id: 1, type: "run", turnId: 2, status: runStatus },
        { id: 2, type: "assistant", turnId: 2, content: "stale", contentChunks: ["par", "tial"] },
      ],
    },
  } as unknown as ConversationRecord;
}

test("a crash-interrupted partial answer is restored into history exactly once", () => {
  const crashed = record("running", "user");
  appendCrashInterruptedAnswer(crashed);
  assert.deepEqual(crashed.messages.at(-1), {
    role: "assistant",
    content: "partial\n\n[Run interrupted before session closed]",
    turnId: 2,
  });
  appendCrashInterruptedAnswer(crashed);
  assert.equal(crashed.messages.length, 2, "the last message is now the assistant's");
});

test("finished runs and already-answered turns are left alone", () => {
  for (const candidate of [record("completed", "user"), record("running", "assistant")]) {
    appendCrashInterruptedAnswer(candidate);
    assert.equal(candidate.messages.length, 1);
  }
});

test("exit codes map onto persisted run statuses", () => {
  assert.equal(runStatusForExitCode(0), "completed");
  assert.equal(runStatusForExitCode(130), "canceled");
  for (const code of [1, 2, 3]) assert.equal(runStatusForExitCode(code), "failed");
});
