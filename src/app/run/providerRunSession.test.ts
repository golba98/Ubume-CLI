import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../core/providers/types.js";
import type { PersistedFileActivity } from "../../session/persistedResponse.js";
import type { Screen } from "../../session/types.js";
import {
  describeRunFailure,
  mergeFileActivity,
  presentToolApproval,
} from "./providerRunSession.js";

const route = (providerId: ProviderRoute["providerId"]) =>
  ({ providerId, modelId: "model-x", backendKind: "codex-cli-auth" }) as ProviderRoute;

test("a created file stays created when the run modifies it again", () => {
  const files = new Map<string, PersistedFileActivity>();
  mergeFileActivity(files, [{ path: "a.ts", operation: "created" }]);
  mergeFileActivity(files, [
    { path: "a.ts", operation: "modified" },
    { path: "b.ts", operation: "modified" },
  ]);
  assert.equal(files.get("a.ts")?.operation, "created");
  assert.equal(files.get("b.ts")?.operation, "modified");
  mergeFileActivity(files, [{ path: "a.ts", operation: "deleted" }]);
  assert.equal(files.get("a.ts")?.operation, "deleted");
});

test("model failures explain recovery and keep the provider message", () => {
  const result = describeRunFailure({
    message: "model not found",
    rawOutput: undefined,
    evidence: { kind: "model-unavailable", message: "model not found", retryable: false },
    route: route("google"),
  });
  assert.equal(result.codexAuthFailure, false);
  assert.match(result.failureMessage, /model-x/);
  assert.match(result.failureMessage, /model not found$/);
});

test("Codex auth failures add login recovery only on the OpenAI route", () => {
  const openai = describeRunFailure({
    message: "401 Unauthorized: please run codex login",
    rawOutput: "",
    evidence: undefined,
    route: route("openai"),
  });
  assert.equal(openai.codexAuthFailure, true);
  assert.match(openai.failureMessage, /Recovery:\n {2}codex login/);

  const anthropic = describeRunFailure({
    message: "401 Unauthorized: please run codex login",
    rawOutput: "",
    evidence: undefined,
    route: route("anthropic"),
  });
  assert.equal(anthropic.codexAuthFailure, false);
});

function approvalDeps() {
  const state = {
    screen: "main" as Screen,
    approval: null as ToolApprovalRequest | null,
    resolver: { current: null as ((decision: ToolApprovalDecision) => void) | null },
    queue: { paused: false },
  };
  const deps = {
    toolApprovalResolverRef: state.resolver,
    promptQueue: state.queue,
    bumpWorkbench: () => undefined,
    setToolApproval: (value: unknown) => {
      state.approval = value as ToolApprovalRequest | null;
    },
    setScreen: (value: unknown) => {
      state.screen = value as Screen;
    },
  } as unknown as Parameters<typeof presentToolApproval>[0];
  return { state, deps };
}

const writeRequest: ToolApprovalRequest = { tool: "Write", signature: "w", paths: ["index.html"] };

test("a tool approval opens the overlay and resolves with the user's decision", async () => {
  const { state, deps } = approvalDeps();
  const decision = presentToolApproval(deps, () => true, writeRequest);
  assert.equal(state.screen, "tool-approval");
  assert.equal(state.approval, writeRequest);
  assert.equal(state.queue.paused, true);
  state.resolver.current?.("allow-once");
  assert.equal(await decision, "allow-once");
});

test("a withdrawn approval closes its own overlay and resolves as denied", async () => {
  const { state, deps } = approvalDeps();
  const abort = new AbortController();
  const decision = presentToolApproval(deps, () => true, writeRequest, abort.signal);
  abort.abort();
  assert.equal(await decision, "deny");
  assert.equal(state.screen, "main");
  assert.equal(state.approval, null);
  assert.equal(state.resolver.current, null);
});

test("a withdrawal after a newer prompt opened leaves the newer prompt alone", async () => {
  const { state, deps } = approvalDeps();
  const abort = new AbortController();
  const first = presentToolApproval(deps, () => true, writeRequest, abort.signal);
  const second = presentToolApproval(deps, () => true, { ...writeRequest, signature: "w2" });
  assert.equal(await first, "deny");
  abort.abort();
  assert.equal(state.screen, "tool-approval");
  assert.equal(state.approval?.signature, "w2");
  state.resolver.current?.("deny");
  assert.equal(await second, "deny");
});

test("stale runs and already-withdrawn requests are denied without showing a prompt", async () => {
  const { state, deps } = approvalDeps();
  assert.equal(await presentToolApproval(deps, () => false, writeRequest), "deny");
  const abort = new AbortController();
  abort.abort();
  assert.equal(await presentToolApproval(deps, () => true, writeRequest, abort.signal), "deny");
  assert.equal(state.screen, "main");
  assert.equal(state.approval, null);
});
