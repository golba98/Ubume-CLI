import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type {
  ConversationMessage,
  ConversationMetadata,
} from "../../core/workspace/conversationStore.js";
import type { TimelineEvent } from "../../session/types.js";
import {
  buildRunAssistantMessage,
  conversationCharCount,
  interruptedRunMessage,
  promptHistoryFromMessages,
  withRouteMetadata,
} from "./conversationMetadata.js";

const user = (content: string): ConversationMessage => ({ role: "user", content });
const assistant = (content: string): ConversationMessage => ({ role: "assistant", content });

test("route metadata records optional fields only when the route has them", () => {
  const base = { id: "c1", title: "t" } as unknown as ConversationMetadata;
  const route = {
    providerId: "google",
    modelId: "gemini",
    backendKind: "antigravity-cli-auth",
  } as ProviderRoute;
  const recorded = withRouteMetadata(base, route);
  assert.equal(recorded.modelId, "gemini");
  assert.equal("localBackend" in recorded, false);
  assert.equal("reasoning" in recorded, false);
  const local = withRouteMetadata(base, {
    ...route,
    providerId: "local",
    localBackend: "unsloth",
    reasoning: "high",
  } as ProviderRoute);
  assert.equal(local.localBackend, "unsloth");
  assert.equal(local.reasoning, "high");
});

test("composer history restores the newest 50 prompts first", () => {
  const messages = Array.from({ length: 60 }, (_, index) => user(`p${index}`));
  messages.splice(1, 0, assistant("reply"));
  const history = promptHistoryFromMessages(messages);
  assert.equal(history.length, 50);
  assert.equal(history[0], "p59");
  assert.equal(conversationCharCount([user("ab"), assistant("cde")]), 5);
});

test("a chat saved mid-run gets its partial reply marked as interrupted", () => {
  const events = [
    { type: "user", turnId: 1 },
    { type: "run", turnId: 1, status: "running" },
    { type: "assistant", turnId: 1, content: "", contentChunks: ["Hel", "lo"] },
  ] as unknown as TimelineEvent[];
  const message = interruptedRunMessage(events, [user("hi")]);
  assert.equal(message?.role, "assistant");
  assert.equal(message?.content, "Hello\n\n[Run interrupted before session closed]");
});

test("finished or answered runs are not marked as interrupted", () => {
  const finished = [
    { type: "run", turnId: 1, status: "completed" },
    { type: "assistant", turnId: 1, content: "done", contentChunks: [] },
  ] as unknown as TimelineEvent[];
  assert.equal(interruptedRunMessage(finished, [user("hi")]), null);
  const running = [
    { type: "run", turnId: 2, status: "running" },
    { type: "assistant", turnId: 1, content: "old", contentChunks: [] },
  ] as unknown as TimelineEvent[];
  assert.equal(interruptedRunMessage(running, [user("hi")]), null, "partial is from another turn");
  assert.equal(interruptedRunMessage(running, [user("hi"), assistant("x")]), null);
});

test("run messages carry generation metadata, and Codexa keeps raw output when nothing rendered", () => {
  const generationMetadata = { providerId: "codexa-native", rawOutput: "raw reply" };
  const capture = {
    runId: 1,
    text: "",
    tools: new Map(),
    files: new Map(),
    generationMetadata,
  } as never;
  assert.deepEqual(buildRunAssistantMessage(capture, "completed", { renderedResponse: "" }), {
    role: "assistant",
    content: "raw reply",
    generationMetadata,
  });
  assert.deepEqual(buildRunAssistantMessage(capture, "completed", { renderedResponse: "Hi" }), {
    role: "assistant",
    content: "Hi",
    generationMetadata,
  });
  assert.equal(buildRunAssistantMessage(null, "completed", {}), null);
});
