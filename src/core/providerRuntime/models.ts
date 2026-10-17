/**
 * Defines shared provider model fallbacks, aliases, normalization, and conversion to Codex-style
 * capabilities. Normalizes provider reasoning levels and selects valid defaults for discovered
 * models.
 */

import { formatReasoningLabel } from "../../config/settings.js";
import type {
  CodexModelCapabilities,
  CodexModelCapability,
  ReasoningEffortCapability,
} from "../models/codexModelCapabilities.js";
import type { ProviderModel } from "./types.js";

export const CLAUDE_CODE_EFFORT_LEVELS: readonly ReasoningEffortCapability[] = [
  { id: "low", label: "Low", description: "Claude Code low effort." },
  { id: "medium", label: "Medium", description: "Claude Code medium effort." },
  { id: "high", label: "High", description: "Claude Code high effort." },
  { id: "xhigh", label: "XHigh", description: "Claude Code extra-high effort." },
  { id: "max", label: "Max", description: "Claude Code maximum effort." },
] as const;

function fallbackModelDescription(family: string): string {
  return `Claude ${family} alias — version unknown because model discovery is unavailable`;
}

export const ANTHROPIC_FALLBACK_MODELS: readonly ProviderModel[] = [
  {
    id: "fable",
    modelId: "fable",
    label: "Claude Fable (version unknown)",
    description: fallbackModelDescription("Fable"),
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    reasoningControl: { kind: "unknown" },
    source: "fallback",
    canonicalId: "fable",
    family: "fable",
    effortSource: "fallback",
    effortVerified: false,
  },
  {
    id: "opus",
    modelId: "opus",
    label: "Claude Opus (version unknown)",
    description: fallbackModelDescription("Opus"),
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    reasoningControl: { kind: "unknown" },
    source: "fallback",
    canonicalId: "opus",
    family: "opus",
    effortSource: "fallback",
    effortVerified: false,
  },

  {
    id: "sonnet",
    modelId: "sonnet",
    label: "Claude Sonnet (version unknown)",
    description: fallbackModelDescription("Sonnet"),
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    reasoningControl: { kind: "unknown" },
    source: "fallback",
    canonicalId: "sonnet",
    family: "sonnet",
    effortSource: "fallback",
    effortVerified: false,
  },
  {
    id: "haiku",
    modelId: "haiku",
    label: "Claude Haiku (version unknown)",
    description: fallbackModelDescription("Haiku"),
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    reasoningControl: { kind: "unknown" },
    source: "fallback",
    canonicalId: "haiku",
    family: "haiku",
    effortSource: "fallback",
    effortVerified: false,
  },
];

function isRuntimeSource(source: ProviderModel["source"]): boolean {
  return (
    source === "discovered" ||
    source === "claude-code" ||
    source === "claude-code-command" ||
    source === "claude-code-package" ||
    source === "claude-code-cache" ||
    source === "claude-code-config" ||
    source === "settings" ||
    source === "config"
  );
}

/**
 * Adapts shared provider models for existing capability consumers without claiming live Codex
 * discovery.
 */
export function providerModelsToCodexCapabilities(
  models: readonly ProviderModel[],
  currentModel: string,
): CodexModelCapabilities {
  const capabilities: readonly CodexModelCapability[] = models.map((model, index) => ({
    id: model.id,
    model: model.modelId,
    label: model.label,
    description: model.description,
    available: model.available !== false,
    hidden: false,
    isDefault: model.modelId === currentModel || (!currentModel && index === 0),
    defaultReasoningLevel: model.defaultReasoningLevel,
    supportedReasoningLevels: model.supportedReasoningLevels,
    reasoningLevelCount: model.supportedReasoningLevels
      ? model.supportedReasoningLevels.length
      : null,
    source: isRuntimeSource(model.source) ? "runtime" : "fallback",
    raw: model,
    reasoningControl: model.reasoningControl,
  }));

  const anyDiscovered = models.some((m) => isRuntimeSource(m.source));
  return {
    status: "ready",
    source: anyDiscovered ? "runtime" : "fallback",
    models: capabilities,
    discoveredAt: Date.now(),
    executable: null,
    error: null,
  };
}

/** Labels supplied Claude effort ids while retaining unfamiliar native ids and their formatted labels. */
export function getClaudeCodeEffortLevels(
  ids: readonly string[],
): readonly ReasoningEffortCapability[] {
  return ids.map(
    (id) =>
      CLAUDE_CODE_EFFORT_LEVELS.find((level) => level.id === id) ?? {
        id,
        label: formatReasoningLabel(id),
        description: null,
      },
  );
}
