import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RUNTIME_CONFIG } from "../../config/runtimeConfig.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { ConversationRecord } from "../../core/workspace/conversationStore.js";
import {
  chooseFinalResponse,
  finishAfterLiveFlush,
  formatCodexAuthFailure,
  preparePromptRun,
  selectProviderHistory,
} from "./promptRunPrep.js";

test("Codexa stays conversational even with editing mode and a cleanup-looking prompt", () => {
  const result = preparePromptRun(
    { ...DEFAULT_RUNTIME_CONFIG, mode: "auto-edit" },
    {},
    "Delete generated temporary files and implement the plan",
    {
      providerId: "codexa-native",
      modelId: "codexa-934m-balanced",
      backendKind: "codexa-native-pytorch",
    },
    {},
  );
  assert.equal(result.effectiveMode, "suggest");
  assert.equal(result.executionModeDecision.autoUpgraded, false);
  assert.equal(result.fastCleanupRun, false);
});

test("chooseFinalResponse drops a response the stream already showed", () => {
  assert.equal(chooseFinalResponse("Hello  world", "Hello world", "", "assistant"), undefined);
  // A streamed prefix covering more than 80% of the final answer counts as shown.
  assert.equal(chooseFinalResponse("abcdefghi", "abcdefghij", "", "assistant"), undefined);
});

test("chooseFinalResponse keeps a response the stream did not fully show", () => {
  assert.equal(chooseFinalResponse("", "final", "", "assistant"), "final");
  assert.equal(chooseFinalResponse("ab", "abcdefghij", "", "assistant"), "abcdefghij");
  assert.equal(chooseFinalResponse("other", "final", "", "assistant"), "final");
});

test("chooseFinalResponse prefers captured plan sections for plan presentation", () => {
  assert.equal(chooseFinalResponse("x", "full", "## Plan", "plan"), "## Plan");
  assert.equal(chooseFinalResponse("x", "full", "   ", "plan"), "full");
});

test("formatCodexAuthFailure adds login recovery only for auth failures", () => {
  assert.equal(formatCodexAuthFailure("boom", false), "boom");
  const formatted = formatCodexAuthFailure("expired", true);
  assert.match(formatted, /codex login/);
  assert.match(formatted, /Raw error: expired$/);
});

test("selectProviderHistory keeps the full history for providers that compact their own window", () => {
  const conversation = {
    messages: [
      { role: "user", content: "hi", createdAt: 1 },
      { role: "assistant", content: "hello", createdAt: 2 },
    ],
  } as unknown as ConversationRecord;
  for (const providerId of ["local", "mistral", "codexa-native"] as const) {
    const history = selectProviderHistory(
      conversation,
      { providerId, modelId: "m", backendKind: "codex-cli-auth" } as ProviderRoute,
      null,
    );
    assert.equal(history.length, 2);
  }
  assert.deepEqual(
    selectProviderHistory(
      null,
      { providerId: "openai", modelId: "m", backendKind: "codex-cli-auth" } as ProviderRoute,
      null,
    ),
    [],
  );
});

test("finishAfterLiveFlush defers only after a live flush", async () => {
  const order: string[] = [];
  finishAfterLiveFlush(false, () => order.push("sync"));
  finishAfterLiveFlush(true, () => order.push("deferred"));
  order.push("after-call");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["sync", "after-call", "deferred"]);
});
