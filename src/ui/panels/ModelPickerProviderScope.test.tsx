/**
 * Tests that the model picker is correctly scoped to each provider:
 * - model lists contain only models for the correct provider
 * - picker title/copy uses the provider-specific label
 * - modelPickerLabel is set on each runtime
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { render } from "ink";
import { getSelectableModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import { anthropicRuntime } from "../../core/providerRuntime/anthropic.js";
import { googleRuntime, parseAgyModelsOutput } from "../../core/providerRuntime/antigravity.js";
import {
  ANTHROPIC_FALLBACK_MODELS,
  providerModelsToCodexCapabilities,
} from "../../core/providerRuntime/models.js";
import type { ProviderModel } from "../../core/providerRuntime/types.js";
import { createLayoutSnapshot } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import { ModelPickerScreen } from "./ModelPickerScreen.js";
import { ProviderPicker } from "./ProviderPicker.js";

class TestInput extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  override resume(): this {
    return this;
  }
  override pause(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 120;
  rows = 40;
}

function stripAnsi(value: string): string {
  return value.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Model list content — no cross-provider leakage
// ---------------------------------------------------------------------------

test("ANTHROPIC_FALLBACK_MODELS uses short CLI alias model IDs (not full API IDs)", () => {
  const ids = ANTHROPIC_FALLBACK_MODELS.map((m) => m.modelId);
  for (const id of ids) {
    assert.ok(
      !id.startsWith("gpt-"),
      `Anthropic model list must not contain OpenAI model: "${id}"`,
    );
  }
  // Short aliases, not full versioned API IDs
  assert.ok(ids.includes("opus"), "Missing opus alias");
  assert.ok(ids.includes("sonnet"), "Missing sonnet alias");
  assert.ok(ids.includes("haiku"), "Missing haiku alias");
});

test("ANTHROPIC_FALLBACK_MODELS contains the expected models", () => {
  const ids = ANTHROPIC_FALLBACK_MODELS.map((m) => m.modelId);
  assert.ok(ids.includes("opus"), "Missing opus");
  assert.ok(ids.includes("sonnet"), "Missing sonnet");
  assert.ok(ids.includes("haiku"), "Missing haiku");
  for (const model of ANTHROPIC_FALLBACK_MODELS) {
    assert.match(
      model.label,
      /version unknown/i,
      "Fallback labels must honestly mark unknown Claude versions",
    );
  }
});

test("ANTHROPIC_FALLBACK_MODELS does not contain OpenAI model IDs", () => {
  for (const m of ANTHROPIC_FALLBACK_MODELS) {
    assert.ok(
      !m.modelId.startsWith("gpt-"),
      `Anthropic model list must not contain OpenAI model: "${m.modelId}"`,
    );
  }
});

const sampleAgyStdout = `gemini-3.8-flash-high  Gemini 3.8 Flash (High)
gemini-3.8-flash-medium  Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low  Gemini 3.8 Flash (Low)
gemini-3.5-pro  Gemini 3.5 Pro
claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)`;

const GOOGLE_DISCOVERED_MODELS = parseAgyModelsOutput(sampleAgyStdout);

test("GOOGLE_DISCOVERED_MODELS contains the expected discovered models from agy", () => {
  const ids = GOOGLE_DISCOVERED_MODELS.map((m) => m.modelId);
  assert.ok(ids.includes("gemini-3.8-flash-high"), "Missing gemini-3.8-flash-high");
  assert.ok(ids.includes("gemini-3.5-pro"), "Missing gemini-3.5-pro");
  assert.ok(ids.includes("claude-sonnet-4-6"), "Missing claude-sonnet-4-6");
});

test("GOOGLE_DISCOVERED_MODELS does not contain OpenAI model IDs", () => {
  for (const m of GOOGLE_DISCOVERED_MODELS) {
    assert.ok(
      !m.modelId.startsWith("gpt-"),
      `Google list must not contain OpenAI model: "${m.modelId}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// providerModelsToCodexCapabilities conversion
// ---------------------------------------------------------------------------

test("providerModelsToCodexCapabilities converts Anthropic models to selectable capabilities", () => {
  const caps = providerModelsToCodexCapabilities(ANTHROPIC_FALLBACK_MODELS, "sonnet");
  const selectable = getSelectableModelCapabilities(caps);

  assert.ok(selectable.length > 0, "Should produce selectable models");
  const modelIds = selectable.map((m) => m.model);
  assert.ok(modelIds.includes("sonnet"), "Should include sonnet alias");
  assert.ok(modelIds.includes("opus"), "Should include opus alias");
  assert.ok(modelIds.includes("haiku"), "Should include haiku alias");
  assert.ok(modelIds.includes("fable"), "Should include fable alias");
  for (const id of modelIds) {
    assert.ok(
      !id.startsWith("gpt-"),
      `Converted Anthropic capabilities must not contain OpenAI model: "${id}"`,
    );
  }
  const sonnet = selectable.find((model) => model.model === "sonnet");
  assert.deepEqual(sonnet?.supportedReasoningLevels, null);
});

test("Claude fallback does not advertise unverified reasoning options", () => {
  const caps = providerModelsToCodexCapabilities(ANTHROPIC_FALLBACK_MODELS, "sonnet");
  const sonnet = getSelectableModelCapabilities(caps).find((model) => model.model === "sonnet");
  const opus = getSelectableModelCapabilities(caps).find((model) => model.model === "opus");
  const ids = sonnet?.supportedReasoningLevels?.map((level) => level.id) ?? [];

  assert.equal(ids.length, 0);
  assert.deepEqual(opus?.supportedReasoningLevels, null);
  assert.ok(!ids.includes("none"), "Claude picker must not show OpenAI none reasoning");
  assert.ok(!ids.includes("minimal"), "Claude picker must not show OpenAI minimal reasoning");
});

test("providerModelsToCodexCapabilities converts Google models to selectable capabilities", () => {
  const caps = providerModelsToCodexCapabilities(GOOGLE_DISCOVERED_MODELS, "gemini-3.8-flash-high");
  const selectable = getSelectableModelCapabilities(caps);

  assert.ok(selectable.length > 0, "Should produce selectable models");
  const modelIds = selectable.map((m) => m.model);
  assert.ok(modelIds.includes("gemini-3.8-flash-high"), "Should include gemini-3.8-flash-high");
  assert.ok(modelIds.includes("gemini-3.5-pro"), "Should include gemini-3.5-pro");
  for (const id of modelIds) {
    assert.ok(
      !id.startsWith("gpt-"),
      `Converted Google capabilities must not contain OpenAI model: "${id}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// ProviderRuntime.modelPickerLabel
// ---------------------------------------------------------------------------

test("anthropicRuntime.modelPickerLabel is 'Claude'", () => {
  assert.equal(anthropicRuntime.modelPickerLabel, "Claude");
});

test("googleRuntime.modelPickerLabel is 'Google'", () => {
  assert.equal(googleRuntime.modelPickerLabel, "Google");
  assert.equal(googleRuntime.label, "Google");
});

// ---------------------------------------------------------------------------
// ModelPickerScreen renders correct copy per provider label
// ---------------------------------------------------------------------------

test("model picker renders 'Choose a Claude model' when activeProviderLabel is Claude", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const claudeModels = getSelectableModelCapabilities(
    providerModelsToCodexCapabilities(ANTHROPIC_FALLBACK_MODELS, "sonnet"),
  );

  const { cleanup } = render(
    <ThemeProvider theme="mono">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={claudeModels}
        currentModel="sonnet"
        currentReasoning="high"
        activeProviderLabel="Claude"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true },
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.match(stripped, /Choose a Claude model to use inside Ubume/);
    // Must not say "OpenAI"
    assert.ok(!stripped.includes("OpenAI"), "Should not mention OpenAI when picking Claude models");
  } finally {
    cleanup();
  }
});

test("model picker renders 'Choose a Google model' when activeProviderLabel is Google", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const googleModels = getSelectableModelCapabilities(
    providerModelsToCodexCapabilities(GOOGLE_DISCOVERED_MODELS, "gemini-3.8-flash"),
  );

  const { cleanup } = render(
    <ThemeProvider theme="mono">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={googleModels}
        currentModel="gemini-3.8-flash"
        currentReasoning="high"
        activeProviderLabel="Google"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true },
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.match(stripped, /Choose a Google model to use inside Ubume/);
    assert.match(stripped, /Select model · Google/);
    assert.ok(!stripped.includes("OpenAI"), "Should not mention OpenAI when picking Google models");
  } finally {
    cleanup();
  }
});

test("model picker renders 'Choose an OpenAI model' when activeProviderLabel is OpenAI", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const { cleanup } = render(
    <ThemeProvider theme="mono">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={[]}
        currentModel="gpt-5.4"
        currentReasoning="high"
        activeProviderLabel="OpenAI"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true },
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.match(stripped, /Choose an OpenAI model to use inside Ubume/);
  } finally {
    cleanup();
  }
});

test("model picker Claude list does not contain OpenAI models", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const claudeModels = getSelectableModelCapabilities(
    providerModelsToCodexCapabilities(ANTHROPIC_FALLBACK_MODELS, "sonnet"),
  );

  const { cleanup } = render(
    <ThemeProvider theme="mono">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={claudeModels}
        currentModel="sonnet"
        currentReasoning="high"
        activeProviderLabel="Claude"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true },
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    // OpenAI model names must not appear in the rendered output
    assert.ok(!stripped.includes("gpt-5"), "Claude picker must not display OpenAI models");
    // Claude model aliases must appear and must not be vague family names only.
    assert.ok(
      stripped.includes("Claude Opus") ||
        stripped.includes("Claude Sonnet") ||
        stripped.includes("Claude Haiku"),
      "Claude picker must display Claude model names",
    );
    assert.ok(
      stripped.includes("version unknown"),
      "Fallback picker labels must mark unknown versions",
    );
  } finally {
    cleanup();
  }
});

test("model picker shows alias-resolved Claude package source and versioned labels", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const packageModels: ProviderModel[] = [
    {
      id: "opus",
      modelId: "opus",
      label: "Claude Opus 4.8",
      description: "Resolved from Claude Code package metadata",
      defaultReasoningLevel: "xhigh",
      supportedReasoningLevels: ANTHROPIC_FALLBACK_MODELS[0].supportedReasoningLevels,
      source: "claude-code-package",
      canonicalId: "claude-opus-4-8",
      family: "opus",
      version: "4.8",
      isFallback: false,
      discoveryKind: "aliases",
    },
  ];

  const claudeModels = getSelectableModelCapabilities(
    providerModelsToCodexCapabilities(packageModels, "opus"),
  );

  const { cleanup } = render(
    <ThemeProvider theme="mono">
      <ModelPickerScreen
        layout={createLayoutSnapshot(120, 40)}
        models={claudeModels}
        currentModel="opus"
        currentReasoning="xhigh"
        activeProviderLabel="Claude"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true },
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.ok(stripped.includes("Claude Opus 4.8"));
    assert.ok(stripped.includes("Claude Code aliases resolved from installed package metadata"));
    assert.ok(!stripped.includes("version unknown"));
    assert.ok(!stripped.includes("Claude Code model discovery unavailable"));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ProviderPicker initialProviderId — selects that provider in the direct-use list
// ---------------------------------------------------------------------------

test("ProviderPicker with initialProviderId=anthropic selects Anthropic in the provider list", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const mockProviders: ProviderConfig[] = [
    {
      id: "openai",
      displayName: "OpenAI",
      currentModel: "gpt-5",
      backendType: "openai-api-key",
      routeMode: "in-ubume",
      enabled: true,
      statusLabel: "Enabled",
      launchCommand: null,
      isDefault: false,
      isActiveRoute: true,
      routeUnavailableReason: null,
    },
    {
      id: "anthropic",
      displayName: "Anthropic",
      currentModel: "sonnet",
      backendType: "claude-code-auth",
      routeMode: "in-ubume",
      enabled: true,
      statusLabel: "Enabled",
      launchCommand: null,
      isDefault: false,
      isActiveRoute: false,
      routeUnavailableReason: null,
    },
  ];

  const { cleanup } = render(
    <ThemeProvider theme="mono">
      <ProviderPicker
        layout={createLayoutSnapshot(120, 40)}
        providers={mockProviders}
        onAction={() => {}}
        onCancel={() => {}}
        initialProviderId="anthropic"
      />
    </ThemeProvider>,
    { stdin: stdin as any, stdout: stdout as any, debug: true },
  );

  try {
    await sleep(100);
    const stripped = stripAnsi(output);
    assert.ok(
      stripped.includes("Anthropic") || stripped.includes("anthropic"),
      "ProviderPicker should show Anthropic context when initialProviderId=anthropic",
    );
    assert.match(stripped, />\s*Anthropic/);
    assert.doesNotMatch(stripped, /Refresh Claude capabilities/);
  } finally {
    cleanup();
  }
});
