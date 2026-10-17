/**
 * Mode, plan-mode, reasoning and model selection for the interactive app.
 *
 * `setModelAndReasoningWithNotice` is the **single activation path** for a
 * provider route: the model picker, `/model`, provider "Use in Ubume" and the
 * Local backend probe all end here. It runs one selection *transition* owned
 * by the session's `SelectionCoordinator`:
 *
 * 1. Build the candidate route and begin a transition. Beginning a transition
 *    aborts any older one, so only the newest selection can commit.
 * 2. Reject reasoning the model explicitly does not support.
 * 3. Validate the route with the provider (abortable).
 * 4. Persist it to `providers.json`. A failed save commits nothing.
 * 5. Publish: commit the transition and update the runtime model/reasoning.
 *
 * Any failure "recovers" instead of committing: the previous route and saved
 * preferences stay in place, a model rejection is recorded against the
 * provider connection, and (if this selection still owns navigation) the
 * failing provider's model picker opens so the user can choose another model.
 * Stale transitions are ignored at every step, so an older validation cannot
 * report errors, steal focus or clear a newer selection's busy state.
 */

import { useCallback, useEffect, useRef } from "react";
import type { LaunchArgs } from "../../config/launchArgs.js";
import { saveRuntimeModePreference } from "../../config/persistence.js";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import {
  type AvailableMode,
  type AvailableModel,
  formatModeLabel,
  formatReasoningLabel,
  getNextRotatingMode,
  type ReasoningLevel,
} from "../../config/settings.js";
import type { CodexModelCapability } from "../../core/models/codexModelCapabilities.js";
import {
  type CodexModelCapabilities,
  findModelCapability,
  normalizeReasoningForModelCapabilities,
} from "../../core/models/codexModelCapabilities.js";
import { providerConnectionKey } from "../../core/models/modelCatalog.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import type {
  LocalBackendId,
  ProviderId,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import { classifyProviderFailure } from "../../core/providerRuntime/failures.js";
import { providerModelsToCodexCapabilities } from "../../core/providerRuntime/models.js";
import {
  discoverProviderModels,
  getProviderRouteSetupMessage,
  getProviderRuntime,
  validateProviderRouteActivation,
} from "../../core/providerRuntime/registry.js";
import type { ProviderRoute, RuntimeAvailability } from "../../core/providerRuntime/types.js";
import { errorMessage } from "../../core/shared/values.js";
import type { SessionAction } from "../../session/appSession.js";
import { type PlanFlowState, resetPlanFlow } from "../../session/planFlow.js";
import type { Screen } from "../../session/types.js";
import {
  buildCandidateRoute,
  CONNECTION_CHANGED_MESSAGE,
  classifyValidationFailure,
  googleReasoningModels,
  reasoningExcludedByModel,
  reasoningNotAdvertised,
  SELECTION_SAVE_FAILED_MESSAGE,
} from "./selectionLogic.js";

interface UseModelSelectionContext {
  dispatchSession: (action: SessionAction) => void;
  selectionCoordinator: SelectionCoordinator;
  pendingRouteProviderId: ProviderId | null;
  ensureProviderModels: (providerId: ProviderId, forceRefresh?: boolean) => Promise<unknown>;
  updateRuntimeConfig: (updater: (current: RuntimeConfig) => RuntimeConfig) => void;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  mode: "suggest" | "auto-edit" | "full-auto";
  planMode: boolean;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  currentModelCapability: CodexModelCapability | null;
  model: string;
  launchArgs: LaunchArgs;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  activeProviderRoute: ProviderRoute;
  persistProviderDefaultModelAndReasoning: (
    providerId: ProviderId,
    modelId: string,
    nextReasoning: string,
  ) => void;
  persistActiveRoute: (
    providerId: ProviderId,
    nextModel: string,
    nextReasoning: string,
    backendKindOverride?: ReturnType<typeof getProviderRuntime>["backendKind"],
    localBackend?: LocalBackendId,
  ) => boolean | void;
  modelSelectionInFlightRef: React.RefObject<boolean>;
  getInputDebugSnapshot: (extra?: Record<string, unknown>) => Record<string, unknown>;
  reasoningLevel: string;
  workspaceRoot: string;
  returnToChatMode: (reason?: string) => void;
  modelCapabilities: CodexModelCapabilities | null;
  setPendingRouteProviderId: React.Dispatch<React.SetStateAction<ProviderId | null>>;
  setRouteSwitchBusy: React.Dispatch<React.SetStateAction<boolean>>;
  markProviderAvailability: (
    providerId: ProviderId,
    availability: RuntimeAvailability,
    reason: string,
  ) => void;
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
  setRegistryNonce: React.Dispatch<React.SetStateAction<number>>;
  providerRouteErrorsRef: React.RefObject<Record<string, string>>;
  modelPickerOpenRef: React.RefObject<boolean>;
}

export function useModelSelection(context: UseModelSelectionContext) {
  const {
    dispatchSession,
    updateRuntimeConfig,
    setScreen,
    appendEvent,
    mode,
    planMode,
    setPlanFlow,
    routeChoiceRequiredRef,
    currentModelCapability,
    model,
    launchArgs,
    providerWorkspaceConfig,
    activeProviderRoute,
    persistProviderDefaultModelAndReasoning,
    persistActiveRoute,
    modelSelectionInFlightRef,
    getInputDebugSnapshot,
    reasoningLevel,
    workspaceRoot,
    returnToChatMode,
    modelCapabilities,
    setPendingRouteProviderId,
    setRouteSwitchBusy,
    markProviderAvailability,
    providerDiagnosticsRef,
    setRegistryNonce,
    providerRouteErrorsRef,
    modelPickerOpenRef,
    selectionCoordinator,
    pendingRouteProviderId,
    ensureProviderModels,
  } = context;

  // Async validation must compare against, and recover with, the values
  // current when it finishes, not the ones captured when it started.
  const latest = useRef({ providerWorkspaceConfig, ensureProviderModels });
  latest.current = { providerWorkspaceConfig, ensureProviderModels };

  // Abort any in-flight validation when the app unmounts.
  useEffect(() => () => selectionCoordinator.cancel(), [selectionCoordinator]);

  // ---------------------------------------------------------------------------
  // Execution mode and plan mode
  // ---------------------------------------------------------------------------

  const setModeWithNotice = useCallback(
    (nextMode: AvailableMode) => {
      updateRuntimeConfig((current) => ({ ...current, mode: nextMode, planMode: false }));
      saveRuntimeModePreference(nextMode, false);
      setScreen("main");
      appendEvent(
        "system",
        "Mode updated",
        `Execution mode switched to ${formatModeLabel(nextMode)}.`,
      );
    },
    [appendEvent, updateRuntimeConfig],
  );

  const cycleModeWithNotice = useCallback(() => {
    const next = getNextRotatingMode(mode, planMode);
    updateRuntimeConfig((current) => ({ ...current, mode: next.mode, planMode: next.planMode }));
    saveRuntimeModePreference(next.mode, next.planMode);
    if (!next.planMode) {
      setPlanFlow(resetPlanFlow());
    }
  }, [mode, planMode, updateRuntimeConfig]);

  const setPlanModeWithNotice = useCallback(
    (nextEnabled: boolean) => {
      updateRuntimeConfig((current) => ({ ...current, planMode: nextEnabled }));
      saveRuntimeModePreference(mode, nextEnabled);
      if (!nextEnabled) {
        setPlanFlow(resetPlanFlow());
      }
      appendEvent("system", "Plan mode", `Plan mode ${nextEnabled ? "enabled" : "disabled"}.`);
    },
    [appendEvent, mode, updateRuntimeConfig],
  );

  const togglePlanModeWithNotice = useCallback(() => {
    setPlanModeWithNotice(!planMode);
  }, [planMode, setPlanModeWithNotice]);

  // ---------------------------------------------------------------------------
  // Reasoning
  // ---------------------------------------------------------------------------

  /**
   * Changes the reasoning level of the active route and saves it as that
   * provider's preference. OpenAI keeps reasoning as a provider default; other
   * providers re-save the active route.
   */
  const setReasoningWithNotice = useCallback(
    (nextReasoningLevel: ReasoningLevel) => {
      if (routeChoiceRequiredRef.current) {
        appendEvent("error", "Select a route first", routeChoiceRequiredRef.current);
        return;
      }
      if (reasoningNotAdvertised(currentModelCapability, nextReasoningLevel)) {
        appendEvent(
          "error",
          "Reasoning unavailable",
          `${model} does not advertise ${formatReasoningLabel(nextReasoningLevel)} reasoning in the detected Codex runtime.`,
        );
        return;
      }

      updateRuntimeConfig((current) => ({ ...current, reasoningLevel: nextReasoningLevel }));

      // With --model on the command line the active route reflects that CLI
      // argument, not providers.json. Persist the stored model instead so a
      // CLI-only override is never written permanently.
      let modelToPersist = launchArgs.modelOverride
        ? (providerWorkspaceConfig.activeRoute?.modelId ?? activeProviderRoute.modelId)
        : activeProviderRoute.modelId;

      if (activeProviderRoute.providerId === "google") {
        const google = googleReasoningModels(
          modelToPersist,
          activeProviderRoute.modelId,
          nextReasoningLevel,
          discoverProviderModels("google").models,
        );
        modelToPersist = google.modelToPersist;
        const runtimeModel = google.runtimeModel;
        if (runtimeModel) {
          updateRuntimeConfig((current) => ({ ...current, model: runtimeModel }));
        }
      }

      if (activeProviderRoute.providerId === "openai") {
        persistProviderDefaultModelAndReasoning("openai", modelToPersist, nextReasoningLevel);
      } else {
        persistActiveRoute(
          activeProviderRoute.providerId,
          modelToPersist,
          nextReasoningLevel,
          activeProviderRoute.backendKind,
        );
      }

      setScreen("main");
      appendEvent(
        "system",
        "Reasoning updated",
        `Reasoning level is now ${formatReasoningLabel(nextReasoningLevel)}.`,
      );
    },
    [
      activeProviderRoute.backendKind,
      activeProviderRoute.modelId,
      activeProviderRoute.providerId,
      appendEvent,
      currentModelCapability,
      launchArgs.modelOverride,
      model,
      persistActiveRoute,
      persistProviderDefaultModelAndReasoning,
      providerWorkspaceConfig.activeRoute,
      updateRuntimeConfig,
    ],
  );

  // ---------------------------------------------------------------------------
  // Model activation (see the module comment for the full lifecycle)
  // ---------------------------------------------------------------------------

  const setModelAndReasoningWithNotice = useCallback(
    async (
      nextModel: AvailableModel,
      nextReasoning: ReasoningLevel,
      providerId: ProviderId = pendingRouteProviderId ?? activeProviderRoute.providerId,
      localBackend?: LocalBackendId,
    ) => {
      // Step 1: candidate route and transition.
      const providerConfig = providerWorkspaceConfig.providers?.[providerId];
      const route = buildCandidateRoute({
        providerId,
        modelId: nextModel,
        reasoning: nextReasoning,
        backendKind: getProviderRuntime(providerId).backendKind,
        config: providerWorkspaceConfig,
        localBackend,
      });
      const connectionFor = (config: ProviderWorkspaceConfig) =>
        providerConnectionKey(providerId, {
          cwd: workspaceRoot,
          config,
          routeLocalBackend: route.localBackend,
        });
      const connection = connectionFor(providerWorkspaceConfig);
      const connectionUnchanged = () =>
        connectionFor(latest.current.providerWorkspaceConfig) === connection;

      const transition = selectionCoordinator.begin(route, connection);
      modelSelectionInFlightRef.current = true;
      setPendingRouteProviderId(providerId);
      setRouteSwitchBusy(true);

      // Set when this selection hands the user back to the model picker; the
      // `finally` block then leaves focus on the picker instead of the chat.
      let openedRecoveryPicker = false;
      const recover = (message: string) => {
        if (!selectionCoordinator.isCurrent(transition)) {
          return;
        }
        appendEvent("error", "Selection unavailable", message);
        if (selectionCoordinator.ownsNavigation(transition)) {
          openedRecoveryPicker = true;
          modelPickerOpenRef.current = true;
          setPendingRouteProviderId(providerId);
          setScreen("model-picker");
          void latest.current.ensureProviderModels(providerId);
        }
      };

      try {
        // Step 2: reasoning support, checked locally before any provider call.
        const routeCapabilities =
          providerId === "openai"
            ? modelCapabilities
            : providerModelsToCodexCapabilities(
                discoverProviderModels(providerId).models,
                nextModel,
              );
        const capability = findModelCapability(routeCapabilities, nextModel);
        if (reasoningExcludedByModel(capability, nextReasoning)) {
          recover(
            `${nextModel} does not support the selected reasoning setting. Choose a model and supported reasoning setting.`,
          );
          return;
        }
        route.reasoning = normalizeReasoningForModelCapabilities(
          nextModel,
          nextReasoning,
          routeCapabilities,
        );

        // Step 3: validate with the provider.
        traceInputDebug(
          "model_selection_app_start",
          getInputDebugSnapshot({ model: nextModel, providerId, transition: transition.id }),
        );
        if (providerId === "local") {
          markProviderAvailability("local", "checking", "provider-validation");
        }
        const validation = await validateProviderRouteActivation({
          signal: transition.signal,
          providerConfig,
          route,
          workspaceRoot,
          antigravityCommandPath: providerWorkspaceConfig.providers?.google?.antigravityCommandPath,
          claudeCommandPath: providerWorkspaceConfig.providers?.anthropic?.claudeCommandPath,
          localConfig:
            providerId === "local"
              ? { ...providerConfig, localBackend: route.localBackend }
              : providerWorkspaceConfig.providers?.local,
        });
        if (!selectionCoordinator.isCurrent(transition)) {
          return;
        }
        if (!connectionUnchanged()) {
          recover(CONNECTION_CHANGED_MESSAGE);
          return;
        }
        if (validation.diagnostics) {
          providerDiagnosticsRef.current[providerId] = validation.diagnostics;
        }
        setRegistryNonce((n) => n + 1);

        if (validation.status !== "ready") {
          const outcome = classifyValidationFailure(
            validation,
            nextModel,
            getProviderRouteSetupMessage(providerId),
          );
          selectionCoordinator.reject(connection, nextModel, outcome.failure);
          if (outcome.routeError) {
            providerRouteErrorsRef.current[providerId] = outcome.routeError;
          }
          recover(outcome.userMessage);
          return;
        }

        // Step 4: persist before publishing, so a failed save cannot
        // partially commit a route.
        const saved = persistActiveRoute(
          providerId,
          nextModel,
          route.reasoning ?? "",
          validation.backendKind,
          localBackend,
        );
        if (saved === false) {
          recover(SELECTION_SAVE_FAILED_MESSAGE);
          return;
        }

        // Step 5: publish.
        selectionCoordinator.commit(transition);
        // A successful replacement clears the stale error from the failed
        // attempt without touching the failed turn or a pending question.
        dispatchSession({
          type: "UI_ACTION",
          action: { type: "DISMISS_TRANSIENT", onlyError: true },
        });
        updateRuntimeConfig((current) => ({
          ...current,
          model: nextModel,
          reasoningLevel: route.reasoning ?? "",
        }));
        delete providerRouteErrorsRef.current[providerId];
        if (selectionCoordinator.ownsNavigation(transition) && !modelPickerOpenRef.current) {
          setPendingRouteProviderId(null);
        }
        traceInputDebug(
          "model_selection_app_success",
          getInputDebugSnapshot({ model: nextModel, providerId, transition: transition.id }),
        );
      } catch (error) {
        if (!selectionCoordinator.isCurrent(transition)) {
          return;
        }
        if (!connectionUnchanged()) {
          recover(CONNECTION_CHANGED_MESSAGE);
          return;
        }
        const message = errorMessage(error);
        selectionCoordinator.reject(connection, nextModel, classifyProviderFailure(message));
        recover(message);
      } finally {
        // Only the current transition may clear busy state or move focus.
        if (selectionCoordinator.isCurrent(transition)) {
          selectionCoordinator.finish(transition);
          setRouteSwitchBusy(false);
          modelSelectionInFlightRef.current = false;
          if (!openedRecoveryPicker && selectionCoordinator.ownsNavigation(transition)) {
            returnToChatMode("selection");
          }
        }
      }
    },
    [
      activeProviderRoute.providerId,
      appendEvent,
      dispatchSession,
      getInputDebugSnapshot,
      markProviderAvailability,
      modelCapabilities,
      pendingRouteProviderId,
      persistActiveRoute,
      providerWorkspaceConfig,
      returnToChatMode,
      selectionCoordinator,
      updateRuntimeConfig,
      workspaceRoot,
    ],
  );

  const setModelWithNotice = useCallback(
    (nextModel: AvailableModel) => setModelAndReasoningWithNotice(nextModel, reasoningLevel),
    [setModelAndReasoningWithNotice, reasoningLevel],
  );

  return {
    setModeWithNotice,
    cycleModeWithNotice,
    setReasoningWithNotice,
    setPlanModeWithNotice,
    togglePlanModeWithNotice,
    setModelWithNotice,
    setModelAndReasoningWithNotice,
  };
}
