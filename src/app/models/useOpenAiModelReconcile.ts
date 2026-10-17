/**
 * Keeps the OpenAI route consistent with a verified Codex model inventory.
 *
 * - When the configured model is missing, unavailable or hidden, prompts are
 *   blocked (`routeChoiceRequiredRef`) until the user selects a model; Ubume
 *   never silently switches to another model.
 * - When the model is available, its reasoning level is normalized to one
 *   the model supports.
 *
 * Only a verified inventory is trusted, and a resumed conversation keeping
 * its saved route (`preserveSavedRouteRef`) is left alone.
 */

import { useEffect } from "react";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import { formatReasoningLabel } from "../../config/settings.js";
import {
  type CodexModelCapabilities,
  findModelCapability,
  normalizeReasoningForModelCapabilities,
} from "../../core/models/codexModelCapabilities.js";
import { discoverProviderModels } from "../../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { BackendProvider } from "../../core/providers/types.js";

interface UseOpenAiModelReconcileContext {
  // Route and selection guards
  providerOverride: BackendProvider | undefined;
  preserveSavedRouteRef: React.RefObject<boolean>;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  activeProviderRoute: ProviderRoute;

  // Model and capabilities
  modelCapabilities: CodexModelCapabilities | null;
  model: string;
  reasoningLevel: string;

  // Session and config
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  updateRuntimeConfig: (updater: (current: RuntimeConfig) => RuntimeConfig) => void;
}

/** The prompt-blocking message for a configured model that is not offered. */
function unavailableConfiguredModelMessage(model: string): string {
  return `Configured model ${model} is unavailable. Select a model explicitly before sending.`;
}

export function useOpenAiModelReconcile(context: UseOpenAiModelReconcileContext) {
  const {
    providerOverride,
    preserveSavedRouteRef,
    routeChoiceRequiredRef,
    activeProviderRoute,
    modelCapabilities,
    model,
    reasoningLevel,
    appendEvent,
    updateRuntimeConfig,
  } = context;

  useEffect(() => {
    const applies =
      !providerOverride &&
      !preserveSavedRouteRef.current &&
      activeProviderRoute.providerId === "openai" &&
      modelCapabilities?.status === "ready" &&
      discoverProviderModels("openai").freshness === "verified";
    if (!applies) {
      return;
    }

    const message = unavailableConfiguredModelMessage(model);
    const selected = findModelCapability(modelCapabilities, model);
    if (!selected || !selected.available || selected.hidden) {
      if (routeChoiceRequiredRef.current !== message) {
        appendEvent("error", "Selected model unavailable", message);
      }
      routeChoiceRequiredRef.current = message;
      return;
    }
    // The model is offered again: lift a block this effect set earlier.
    if (routeChoiceRequiredRef.current === message) {
      routeChoiceRequiredRef.current = null;
    }

    const nextReasoning = normalizeReasoningForModelCapabilities(
      model,
      reasoningLevel,
      modelCapabilities,
    );
    if (nextReasoning === reasoningLevel) {
      return;
    }
    updateRuntimeConfig((current) => ({ ...current, reasoningLevel: nextReasoning }));
    appendEvent(
      "system",
      "Reasoning updated",
      `Reasoning level is now ${formatReasoningLabel(nextReasoning)} for ${model}.`,
    );
  }, [
    activeProviderRoute.providerId,
    appendEvent,
    model,
    modelCapabilities,
    providerOverride,
    reasoningLevel,
    updateRuntimeConfig,
  ]);
}
