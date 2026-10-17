import assert from "node:assert/strict";
import test from "node:test";
import type { CodexModelCapability } from "../../core/models/codexModelCapabilities.js";
import {
  buildCandidateRoute,
  classifyValidationFailure,
  reasoningExcludedByModel,
  reasoningNotAdvertised,
} from "./selectionLogic.js";

const levels = (...ids: string[]) =>
  ({
    reasoningControl: {
      kind: "levels",
      levels: ids.map((id) => ({ id, label: id })),
      default: ids[0],
      transport: "parameter",
    },
  }) as unknown as CodexModelCapability;

test("candidate Local routes resolve their backend; other providers carry none", () => {
  const config = { providers: { local: { localBackend: "unsloth" as const } } };
  const base = { modelId: "m", reasoning: "", config };
  assert.equal(
    buildCandidateRoute({ ...base, providerId: "local", backendKind: "local-openai-compatible" })
      .localBackend,
    "unsloth",
  );
  assert.equal(
    buildCandidateRoute({
      ...base,
      providerId: "local",
      backendKind: "local-openai-compatible",
      localBackend: "lm-studio",
    }).localBackend,
    "lm-studio",
  );
  assert.equal(
    "localBackend" in
      buildCandidateRoute({ ...base, providerId: "google", backendKind: "antigravity-cli-auth" }),
    false,
  );
});

test("activation only rejects reasoning a model explicitly excludes", () => {
  assert.equal(reasoningExcludedByModel(levels("low", "high"), "xhigh"), true);
  assert.equal(reasoningExcludedByModel(levels("low", "high"), "high"), false);
  assert.equal(reasoningExcludedByModel(levels("low"), ""), false, "no reasoning requested");
  assert.equal(reasoningExcludedByModel(null, "xhigh"), false, "no declared control");
  const fixed = { reasoningControl: { kind: "fixed", label: "x" } } as CodexModelCapability;
  assert.equal(reasoningExcludedByModel(fixed, "xhigh"), false);
});

test("/reasoning requires the level to be supported or advertised", () => {
  assert.equal(reasoningNotAdvertised(levels("low", "high"), "high"), false);
  assert.equal(reasoningNotAdvertised(levels("low", "high"), "xhigh"), true);
  assert.equal(reasoningNotAdvertised(null, "high"), true, "unknown model advertises nothing");
  const advertised = {
    supportedReasoningLevels: [{ id: "medium", label: "Medium" }],
  } as unknown as CodexModelCapability;
  assert.equal(reasoningNotAdvertised(advertised, "medium"), false);
  assert.equal(reasoningNotAdvertised(advertised, "high"), true);
});

test("a model rejection becomes a recovery prompt, not a provider route error", () => {
  const outcome = classifyValidationFailure(
    {
      message: "model not found",
      failure: { kind: "model-unavailable", message: "model not found", retryable: false },
    },
    "gemini-old",
    "setup",
  );
  assert.equal(outcome.isModelFailure, true);
  assert.equal(outcome.routeError, null);
  assert.match(outcome.userMessage, /gemini-old/);
});

test("authentication and setup failures keep the provider's message as a route error", () => {
  const auth = classifyValidationFailure(
    {
      message: "Please log in",
      failure: { kind: "authentication", message: "Please log in", retryable: false },
    },
    "m",
    "setup",
  );
  assert.equal(auth.isModelFailure, false);
  assert.equal(auth.userMessage, "Please log in");
  assert.equal(auth.routeError, "Please log in");

  const noMessage = classifyValidationFailure({}, "m", "Install the CLI first.");
  assert.equal(noMessage.userMessage, "Install the CLI first.");
});
