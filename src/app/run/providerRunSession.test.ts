import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { PersistedFileActivity } from "../../session/persistedResponse.js";
import { describeRunFailure, mergeFileActivity } from "./providerRunSession.js";

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
