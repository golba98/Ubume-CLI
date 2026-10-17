import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import type {
  ProviderModel,
  ProviderModelDiscoveryResult,
} from "../../core/providerRuntime/types.js";
import {
  buildSetupSpawn,
  isUsableSavedModel,
  localBackendStatusFromError,
  localBackendStatusFromValidation,
  resolveProviderActivation,
  routeUnavailableMessage,
  selectedLocalModel,
  workspaceDefaultNotice,
} from "./providerActions.js";

function model(modelId: string): ProviderModel {
  return {
    id: modelId,
    modelId,
    label: modelId,
    description: null,
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
  };
}

test("Vibe's own default entry is a real Mistral choice, so selecting Mistral needs no picker", () => {
  const vibeCatalog = [model("devstral-small"), model("Vibe default"), model("mistral-medium-3.5")];
  assert.equal(isUsableSavedModel("Vibe default", vibeCatalog), true);
});

test("registry placeholders that no catalog lists still require a model choice", () => {
  assert.equal(isUsableSavedModel("Google default", [model("gemini-3.8-flash")]), false);
  assert.equal(isUsableSavedModel("Claude Code default", []), false);
  assert.equal(isUsableSavedModel("Vibe default", []), false);
  assert.equal(isUsableSavedModel("", [model("x")]), false);
  assert.equal(isUsableSavedModel(undefined, [model("x")]), false);
});

test("concrete saved models stay usable even before discovery has loaded", () => {
  assert.equal(isUsableSavedModel("mistral-medium-3.5", []), true);
  assert.equal(isUsableSavedModel("gemini-3.8-flash", []), true);
});

test("a verified catalog is authoritative: only listed, available models are usable", () => {
  const unavailable = { ...model("gemini-old"), available: false };
  const catalog = [model("gemini-3.8-flash"), unavailable];
  assert.equal(isUsableSavedModel("gemini-3.8-flash", catalog, true), true);
  assert.equal(isUsableSavedModel("gemini-old", catalog, true), false);
  assert.equal(isUsableSavedModel("gemini-removed", catalog, true), false);
  assert.equal(isUsableSavedModel(undefined, catalog, true), false);
});

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "google",
    displayName: "Google",
    currentModel: "Google default",
    routeMode: "in-ubume",
    isDefault: false,
    ...overrides,
  } as ProviderConfig;
}

function discovery(
  overrides: Partial<ProviderModelDiscoveryResult> = {},
): ProviderModelDiscoveryResult {
  return { models: [], freshness: "verified", ...overrides } as ProviderModelDiscoveryResult;
}

test("a usable saved model activates with the provider's saved reasoning", () => {
  const activation = resolveProviderActivation({
    provider: provider(),
    config: {
      providers: { google: { currentModel: "gemini-3.8-flash", currentReasoning: "low" } },
    },
    discovery: discovery({ models: [model("gemini-3.8-flash")] }),
    rejected: false,
    catalogMarksUnavailable: false,
    sessionReasoningLevel: "high",
  });
  assert.deepEqual(activation, { kind: "activate", model: "gemini-3.8-flash", reasoning: "low" });
});

test("a saved model rejected this session opens the picker instead of retrying it", () => {
  const input = {
    provider: provider(),
    config: { providers: { google: { currentModel: "gemini-gone" } } },
    discovery: discovery(),
    rejected: true,
    catalogMarksUnavailable: false,
    sessionReasoningLevel: "",
  };
  assert.deepEqual(resolveProviderActivation(input), { kind: "pick-model" });
  assert.deepEqual(
    resolveProviderActivation({ ...input, rejected: false, catalogMarksUnavailable: true }),
    { kind: "pick-model" },
  );
});

test("an authoritative catalog that omits the saved model opens the picker", () => {
  const activation = resolveProviderActivation({
    provider: provider(),
    config: { providers: { google: { currentModel: "gemini-removed" } } },
    discovery: discovery({ models: [model("gemini-3.8-flash")], complete: true }),
    rejected: false,
    catalogMarksUnavailable: false,
    sessionReasoningLevel: "",
  });
  assert.deepEqual(activation, { kind: "pick-model" });
});

test("reasoning falls back to the active route, then the catalog default for Google", () => {
  const flash = { ...model("gemini-3.8-flash"), defaultReasoningLevel: "medium" };
  const base = {
    provider: provider(),
    discovery: discovery({ models: [flash] }),
    rejected: false,
    catalogMarksUnavailable: false,
    sessionReasoningLevel: "xhigh",
  };
  const activeGoogle = {
    providers: { google: { currentModel: "gemini-3.8-flash" } },
    activeRoute: {
      providerId: "google" as const,
      modelId: "gemini-3.8-flash",
      reasoning: "high",
      backendKind: "antigravity-cli-auth" as const,
    },
  };
  assert.deepEqual(resolveProviderActivation({ ...base, config: activeGoogle }), {
    kind: "activate",
    model: "gemini-3.8-flash",
    reasoning: "high",
  });
  const { activeRoute: _unused, ...notActive } = activeGoogle;
  assert.deepEqual(resolveProviderActivation({ ...base, config: notActive }), {
    kind: "activate",
    model: "gemini-3.8-flash",
    reasoning: "medium",
  });
  const anthropic = provider({ id: "anthropic", currentModel: "claude-x" });
  assert.deepEqual(
    resolveProviderActivation({ ...base, provider: anthropic, config: {}, discovery: discovery() }),
    { kind: "activate", model: "claude-x", reasoning: "xhigh" },
  );
});

test("Local backend badges reflect the probe outcome", () => {
  assert.deepEqual(
    localBackendStatusFromValidation({ status: "ready", diagnostics: { selectedModel: " qwen " } }),
    { state: "ready", label: "qwen" },
  );
  assert.deepEqual(localBackendStatusFromValidation({ status: "ready" }), {
    state: "ready",
    label: "Model loaded",
  });
  assert.equal(
    localBackendStatusFromValidation({
      status: "not-configured",
      diagnostics: { endpointCheckResult: "no-models" },
    }).state,
    "no-model",
  );
  assert.equal(
    localBackendStatusFromValidation({ status: "not-configured", message: "Request timed out" })
      .state,
    "timeout",
  );
  assert.equal(
    localBackendStatusFromValidation({ status: "not-configured", message: "Invalid API key" })
      .state,
    "auth-required",
  );
  assert.equal(localBackendStatusFromError("ECONNREFUSED").state, "not-running");
  assert.equal(
    selectedLocalModel({ diagnostics: { selectedModel: "  " } }, "fallback"),
    "fallback",
  );
});

test("provider setup chains install and setup so setup is skipped when install fails", () => {
  assert.deepEqual(
    buildSetupSpawn({ installCommand: "npm i -g x", setupCommand: "x login" }, false),
    {
      command: "sh",
      args: ["-lc", "npm i -g x && x login"],
    },
  );
  assert.deepEqual(
    buildSetupSpawn({ installCommand: "npm i -g x", setupCommand: "" }, false).args,
    ["-lc", "npm i -g x"],
  );
  const windows = buildSetupSpawn({ installCommand: "irm a | iex", setupCommand: "agy" }, true);
  assert.equal(windows.command, "powershell.exe");
  assert.equal(windows.args.at(-1), "$ErrorActionPreference='Stop'; irm a | iex; agy");
});

test("provider notices name the provider and the route that stays active", () => {
  assert.match(routeUnavailableMessage(provider({ isDefault: true })), /workspace default/);
  assert.equal(
    routeUnavailableMessage(provider()),
    "Google in-Ubume routing is not configured yet.",
  );
  assert.equal(
    workspaceDefaultNotice(provider({ routeMode: "launch-only" }), false, "OpenAI / gpt"),
    "Google is now the workspace default external CLI. Active chat route remains OpenAI / gpt.",
  );
  assert.equal(
    workspaceDefaultNotice(provider(), true, "OpenAI / gpt"),
    "Google is now the workspace default provider. Active chat route remains OpenAI / gpt.",
  );
  assert.match(workspaceDefaultNotice(provider(), false, "OpenAI / gpt"), /not configured yet/);
});
