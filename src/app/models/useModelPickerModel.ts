/**
 * Everything the model picker displays, derived for the provider it is
 * acting on.
 *
 * The picker targets the *pending* provider when one is set (the user chose a
 * provider whose model is not active yet, or a selection failed and is being
 * recovered) and otherwise the active route's provider. This lets the picker
 * show and select another provider's models while the previously committed
 * route stays active.
 *
 * Memos only; no effects.
 */

import { useMemo } from "react";
import {
  type CodexModelCapabilities,
  createFallbackModelCapabilities,
  findModelCapability,
  getSelectableModelCapabilities,
} from "../../core/models/codexModelCapabilities.js";
import { providerConnectionKey } from "../../core/models/modelCatalog.js";
import { findProvider } from "../../core/providerLauncher/registry.js";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import { modelRecoveryMessage } from "../../core/providerRuntime/failures.js";
import { providerModelsToCodexCapabilities } from "../../core/providerRuntime/models.js";
import {
  discoverProviderModels,
  getProviderRouteSetupMessage,
  getProviderRuntime,
} from "../../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { useAppState } from "../state/useAppState.js";

type AppState = ReturnType<typeof useAppState>;

interface UseModelPickerModelContext
  extends Pick<
    AppState,
    | "selectionCoordinator"
    | "pendingRouteProviderId"
    | "providerWorkspaceConfig"
    | "registryNonce"
    | "workspaceRoot"
    | "providerModelErrors"
  > {
  // Active route and model
  activeProviderRoute: ProviderRoute;
  model: string;
  reasoningLevel: string;

  // Capabilities and registry
  modelCapabilities: CodexModelCapabilities | null;
  providerRegistry: ProviderConfig[];

  // Selection state
  /** Changes whenever the selection coordinator publishes a new state. */
  selectionVersion: number;
}

export function useModelPickerModel(context: UseModelPickerModelContext) {
  const {
    selectionCoordinator,
    pendingRouteProviderId,
    providerWorkspaceConfig,
    registryNonce,
    workspaceRoot,
    providerModelErrors,
    activeProviderRoute,
    modelCapabilities,
    providerRegistry,
    model,
    reasoningLevel,
    selectionVersion,
  } = context;

  const modelPickerProviderId = pendingRouteProviderId ?? activeProviderRoute.providerId;
  const pickerTargetsActiveProvider =
    !pendingRouteProviderId || pendingRouteProviderId === activeProviderRoute.providerId;

  const modelPickerRuntime = useMemo(
    () => getProviderRuntime(modelPickerProviderId),
    [modelPickerProviderId],
  );

  // OpenAI's inventory comes from the Codex capability snapshot instead.
  const modelPickerDiscovery = useMemo(() => {
    if (modelPickerProviderId === "openai") return null;
    return discoverProviderModels(modelPickerProviderId);
    // registryNonce is intentionally included: route validation discovers models
    // as a side effect and bumps the nonce so an open picker re-reads them.
  }, [modelPickerProviderId, registryNonce]);

  const providerModelCapabilities = useMemo(() => {
    if (!modelPickerDiscovery) return null;
    return providerModelsToCodexCapabilities(
      modelPickerDiscovery.models,
      activeProviderRoute.modelId,
    );
  }, [activeProviderRoute.modelId, modelPickerDiscovery]);

  const modelPickerModels = useMemo(() => {
    const openAiCapabilities =
      modelPickerProviderId === "openai"
        ? (modelCapabilities ?? createFallbackModelCapabilities(null))
        : null;
    const capabilities = providerModelCapabilities ?? openAiCapabilities;
    if (!capabilities) {
      return [];
    }
    const savedModels = providerWorkspaceConfig.providers?.[modelPickerProviderId]?.models;
    return getSelectableModelCapabilities(capabilities).map((entry) => ({
      ...entry,
      reasoningPreference: savedModels?.[entry.model]?.reasoningPreference,
    }));
  }, [
    modelCapabilities,
    modelPickerProviderId,
    providerModelCapabilities,
    providerWorkspaceConfig.providers,
  ]);

  /**
   * The model the picker highlights: the active model for the active
   * provider; otherwise the pending provider's saved model, then its first
   * selectable model.
   */
  const modelPickerCurrentModel = useMemo(() => {
    if (pickerTargetsActiveProvider || !pendingRouteProviderId) {
      return activeProviderRoute.modelId;
    }
    const storedDefault = providerWorkspaceConfig.providers?.[pendingRouteProviderId]?.currentModel;
    const selectable = getSelectableModelCapabilities(
      providerModelCapabilities ?? createFallbackModelCapabilities(null),
    );
    return storedDefault ?? selectable[0]?.model ?? model;
  }, [
    activeProviderRoute,
    model,
    pendingRouteProviderId,
    pickerTargetsActiveProvider,
    providerModelCapabilities,
    providerWorkspaceConfig,
  ]);

  /**
   * The reasoning the picker starts from: the active route's reasoning for
   * the active provider; otherwise the pending provider's saved reasoning,
   * then the highlighted model's default or first supported level.
   */
  const modelPickerCurrentReasoning = useMemo(() => {
    if (pickerTargetsActiveProvider || !pendingRouteProviderId) {
      return activeProviderRoute.reasoning ?? reasoningLevel;
    }
    const storedReasoning =
      providerWorkspaceConfig.providers?.[pendingRouteProviderId]?.currentReasoning;
    if (storedReasoning) {
      return storedReasoning;
    }
    const pickerCapabilities =
      pendingRouteProviderId === "openai" ? modelCapabilities : providerModelCapabilities;
    const capability = findModelCapability(pickerCapabilities, modelPickerCurrentModel);
    return (
      capability?.defaultReasoningLevel ??
      capability?.supportedReasoningLevels?.[0]?.id ??
      reasoningLevel
    );
  }, [
    activeProviderRoute.reasoning,
    modelPickerCurrentModel,
    modelCapabilities,
    pendingRouteProviderId,
    pickerTargetsActiveProvider,
    providerModelCapabilities,
    providerWorkspaceConfig.providers,
    reasoningLevel,
  ]);

  const modelPickerProviderLabel = useMemo(
    () =>
      modelPickerRuntime.modelPickerLabel ??
      findProvider(providerRegistry, modelPickerProviderId)?.displayName ??
      modelPickerRuntime.label,
    [modelPickerProviderId, modelPickerRuntime, providerRegistry],
  );

  /**
   * Explains an empty or failed picker. A model rejected this session takes
   * priority so the user sees why the picker opened instead of a generic
   * "no models" message.
   */
  const modelPickerEmptyMessage = useMemo(() => {
    const connection = providerConnectionKey(modelPickerProviderId, {
      cwd: workspaceRoot,
      config: providerWorkspaceConfig,
      routeLocalBackend:
        activeProviderRoute.providerId === modelPickerProviderId
          ? activeProviderRoute.localBackend
          : undefined,
    });
    const highlightedState = selectionCoordinator.state(connection, modelPickerCurrentModel);
    if (highlightedState?.status === "unavailable") {
      return modelRecoveryMessage(modelPickerCurrentModel);
    }
    if (modelPickerProviderId === "openai") {
      return modelCapabilities?.error
        ? `No models available: ${modelCapabilities.error}`
        : "No models available.";
    }
    if (modelPickerDiscovery?.status === "ready" && modelPickerDiscovery.models.length === 0) {
      const setup = getProviderRouteSetupMessage(modelPickerProviderId);
      return `No ${modelPickerProviderLabel} models are currently advertised. Refresh models or change provider. ${setup}`;
    }
    const discoveryError = providerModelErrors[modelPickerProviderId];
    if (discoveryError) {
      return `${discoveryError} Press Refresh models to retry.`;
    }
    return modelPickerDiscovery?.message ?? "No models available.";
    // selectionVersion re-reads coordinator state, which is not React state.
  }, [
    activeProviderRoute,
    selectionVersion,
    modelPickerCurrentModel,
    providerWorkspaceConfig,
    workspaceRoot,
    modelCapabilities,
    modelPickerDiscovery,
    modelPickerProviderId,
    modelPickerProviderLabel,
    providerModelErrors,
  ]);

  return {
    modelPickerProviderId,
    modelPickerModels,
    modelPickerCurrentModel,
    modelPickerCurrentReasoning,
    modelPickerProviderLabel,
    modelPickerEmptyMessage,
  };
}
