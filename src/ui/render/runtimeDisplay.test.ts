import assert from "node:assert/strict";
import test from "node:test";
import type { CodexModelCapability } from "../../core/models/codexModelCapabilities.js";
import type { ModelContextMetadata } from "../../core/providerRuntime/contextMetadata.js";
import type { ActiveProviderRoute } from "../../core/providerRuntime/types.js";
import { buildActiveRuntimeDisplay } from "./runtimeDisplay.js";

function capability(model: string, label = model): CodexModelCapability {
  return {
    id: model,
    model,
    label,
    description: null,
    available: true,
    hidden: false,
    isDefault: true,
    defaultReasoningLevel: null,
    supportedReasoningLevels: ["low", "medium", "high"].map((id) => ({
      id,
      label: id,
      description: null,
    })),
    reasoningLevelCount: null,
    source: "runtime",
    raw: null,
  };
}

function context(
  route: ActiveProviderRoute,
  contextLength: number | null,
  confidence: ModelContextMetadata["confidence"] = "known",
): ModelContextMetadata {
  return {
    providerId: route.providerId,
    modelId: route.modelId,
    contextLength,
    source: contextLength === null ? "unknown" : "known-registry",
    confidence: contextLength === null ? "unknown" : confidence,
  };
}

test("Claude route display uses Claude model and context, not stale Gemini", () => {
  const route: ActiveProviderRoute = {
    providerId: "anthropic",
    modelId: "sonnet",
    backendKind: "claude-code-auth",
    reasoning: "low",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "medium",
    mode: "full-auto",
    tokensUsed: 0,
    modelCapability: capability("sonnet", "Sonnet 4.6"),
    contextMetadata: context(route, 200_000),
  });

  assert.equal(display.providerLabel, "Claude Code CLI");
  assert.equal(display.modelDisplay, "Claude Code CLI / Sonnet 4.6 / reasoning: Low");
  assert.equal(display.footerModelDisplay, "Claude Code CLI / Sonnet 4.6 (Low)");
  assert.equal(display.contextDisplay, "");
  assert.equal(display.showContext, false);
  assert.doesNotMatch(display.modelDisplay, /Gemini|OpenAI/i);
});

test("Google route display uses Google model and estimated context", () => {
  const route: ActiveProviderRoute = {
    providerId: "google",
    modelId: "gemini-3.5-flash",
    backendKind: "antigravity-cli-auth",
    reasoning: "medium",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 12_400,
    contextMetadata: context(route, 1_048_576, "estimated"),
  });

  assert.equal(display.modelDisplay, "Google / Gemini 3.5 Flash");
  assert.equal(display.footerModelDisplay, "Google / Gemini 3.5 Flash");
  assert.equal(display.contextDisplay, "");
  assert.doesNotMatch(display.modelDisplay, /Claude|OpenAI/i);
});

test("OpenAI route display uses OpenAI model and unknown context without stale Claude", () => {
  const route: ActiveProviderRoute = {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth",
    reasoning: "medium",
  };
  const staleClaude = context(
    {
      providerId: "anthropic",
      modelId: "sonnet",
      backendKind: "claude-code-auth",
    },
    200_000,
  );
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "medium",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: staleClaude,
  });

  assert.equal(display.modelDisplay, "OpenAI Codex CLI / gpt-5.4-mini / reasoning: Medium");
  assert.equal(display.footerModelDisplay, "OpenAI Codex CLI / gpt-5.4-mini (Medium)");
  assert.equal(display.contextDisplay, "");
  assert.equal(display.modelSpec.status, "unknown");
  assert.doesNotMatch(display.modelDisplay, /Claude|Gemini/i);
});

test("Header and footer display values share the same context string", () => {
  const route: ActiveProviderRoute = {
    providerId: "google",
    modelId: "gemini-3.5-flash",
    backendKind: "antigravity-cli-auth",
    reasoning: "medium",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "medium",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, 1_048_576, "known"),
  });

  assert.equal(display.contextDisplay, "");
  assert.ok(display.modelDisplay.includes("Google / Gemini 3.5 Flash"));
  assert.ok(display.footerModelDisplay.includes("Google / Gemini 3.5 Flash"));
});

test("provider label system recognizes Mistral Vibe CLI", () => {
  const route: ActiveProviderRoute = {
    providerId: "mistral",
    modelId: "mistral-medium-3.5",
    backendKind: "mistral-vibe-cli-auth",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.providerLabel, "Mistral Vibe CLI");
  assert.equal(display.footerModelDisplay, "Mistral Vibe CLI / mistral-medium-3.5");
});

test("Local route omits the non-adjustable reasoning suffix", () => {
  const route: ActiveProviderRoute = {
    providerId: "local",
    modelId: "qwen/qwen3.8-27b",
    backendKind: "local-openai-compatible",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.modelDisplay, "Local / qwen/qwen3.8-27b");
  assert.equal(display.footerModelDisplay, "Local / qwen/qwen3.8-27b");
  assert.doesNotMatch(display.footerModelDisplay, /\(Low\)/);
});

test("Codexa Native does not silently relabel unavailable legacy routes", () => {
  const route: ActiveProviderRoute = {
    providerId: "codexa-native",
    modelId: "codexa-900m-sft-v2-native",
    backendKind: "codexa-native-pytorch",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.footerModelDisplay, "Codexa Native / codexa-900m-sft-v2-native");
});

test("Codexa CuPy is presented as a Codexa Native model route", () => {
  const route: ActiveProviderRoute = {
    providerId: "codexa-cupy",
    modelId: "codexa-250m-cupy",
    backendKind: "codexa-cupy",
  };
  const display = buildActiveRuntimeDisplay({
    route,
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 0,
    contextMetadata: context(route, null),
  });

  assert.equal(display.providerLabel, "Codexa Native");
  assert.equal(display.footerModelDisplay, "Codexa Native / codexa-250m-cupy");
});

test("Google native variant display ignores unrelated global reasoning", () => {
  const model = capability("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)");
  model.defaultReasoningLevel = "medium";
  const display = buildActiveRuntimeDisplay({
    route: { providerId: "google", modelId: model.model, backendKind: "antigravity-cli-auth" },
    reasoningLevel: "low",
    mode: "full-auto",
    tokensUsed: 0,
    modelCapability: model,
  });
  assert.equal(display.footerModelDisplay, "Google / Gemini 3.8 Flash (Medium)");
});
