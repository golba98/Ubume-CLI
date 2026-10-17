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
import { isSupportedReasoning } from "../../core/models/reasoningControl.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import { resolveLocalBackend } from "../../core/providerLauncher/localBackend.js";
import type {
  LocalBackendId,
  ProviderConfig,
  ProviderId,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import { getAgyModelSelector } from "../../core/providerRuntime/antigravity.js";
import {
  classifyProviderFailure,
  isModelFailure,
  modelRecoveryMessage,
} from "../../core/providerRuntime/failures.js";

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

interface UseModelSelectionContext {
  dispatchSession: (action: SessionAction) => void;
  selectionCoordinator: SelectionCoordinator;
  pendingRouteProviderId: ProviderId | null;
  ensureProviderModels: (providerId: ProviderId, forceRefresh?: boolean) => Promise<unknown>;
  updateRuntimeConfig: (updater: (current: RuntimeConfig) => RuntimeConfig) => void;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  busy: boolean;
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
  getInputDebugSnapshot: (extra?: Record<string, unknown>) => {
    screen: Screen;
    mode: "model-picker" | "chat/input";
    modelPickerOpen: boolean;
    composerEnabled: boolean;
    inputLocked: boolean;
    busy: boolean;
    modelLoading: boolean;
    modelSelection: boolean;
    focusTarget: string;
    stdin: Record<string, unknown>;
  };
  reasoningLevel: string;
  activeRouteModelCapabilities: CodexModelCapabilities | null;
  workspaceRoot: string;
  runtimeConfig: RuntimeConfig;
  activeRouteProvider: ProviderConfig;
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
    busy,
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

  const latest = useRef({ providerWorkspaceConfig, ensureProviderModels });
  latest.current = { providerWorkspaceConfig, ensureProviderModels };
  useEffect(() => () => selectionCoordinator.cancel(), [selectionCoordinator]);

  const setModeWithNotice = useCallback(
    (nextMode: AvailableMode) => {
      updateRuntimeConfig((current) => ({
        ...current,
        mode: nextMode,
        planMode: false,
      }));
      saveRuntimeModePreference(nextMode, false);
      setScreen("main");
      appendEvent(
        "system",
        "Mode updated",
        `Execution mode switched to ${formatModeLabel(nextMode)}.`,
      );
    },
    [appendEvent, busy, updateRuntimeConfig],
  );

  const cycleModeWithNotice = useCallback(() => {
    const next = getNextRotatingMode(mode, planMode);
    updateRuntimeConfig((current) => ({
      ...current,
      mode: next.mode,
      planMode: next.planMode,
    }));
    saveRuntimeModePreference(next.mode, next.planMode);
    if (!next.planMode) {
      setPlanFlow(resetPlanFlow());
    }
  }, [appendEvent, busy, mode, planMode, updateRuntimeConfig]);

  const setReasoningWithNotice = useCallback(
    (nextReasoningLevel: ReasoningLevel) => {
      if (routeChoiceRequiredRef.current) {
        appendEvent("error", "Select a route first", routeChoiceRequiredRef.current);
        return;
      }
      const supported = currentModelCapability?.supportedReasoningLevels;
      if (
        (currentModelCapability?.reasoningControl &&
          !isSupportedReasoning(currentModelCapability.reasoningControl, nextReasoningLevel)) ||
        (!currentModelCapability?.reasoningControl &&
          (!supported || !supported.some((item) => item.id === nextReasoningLevel)))
      ) {
        appendEvent(
          "error",
          "Reasoning unavailable",
          `${model} does not advertise ${formatReasoningLabel(nextReasoningLevel)} reasoning in the detected Codex runtime.`,
        );
        return;
      }

      updateRuntimeConfig((current) => ({
        ...current,
        reasoningLevel: nextReasoningLevel,
      }));
      // When --model was given on the CLI the active route's modelId reflects that CLI arg,
      // not what is stored in providers.json. Persist the stored model so the CLI-only
      // override is never written permanently; fall back to activeProviderRoute.modelId when
      // no CLI model is active (normal interactive case).
      let modelToPersist = launchArgs.modelOverride
        ? (providerWorkspaceConfig.activeRoute?.modelId ?? activeProviderRoute.modelId)
        : activeProviderRoute.modelId;
      if (activeProviderRoute.providerId === "google") {
        const models = discoverProviderModels("google").models;
        const selector = getAgyModelSelector(modelToPersist, nextReasoningLevel, models);
        const native = models.find((item) => item.modelId === selector);
        if (native) modelToPersist = native.modelId;
        const activeSelector = getAgyModelSelector(
          activeProviderRoute.modelId,
          nextReasoningLevel,
          models,
        );
        if (models.some((item) => item.modelId === activeSelector))
          updateRuntimeConfig((current) => ({ ...current, model: activeSelector! }));
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
      appendEvent,
      busy,
      currentModelCapability,
      launchArgs.modelOverride,
      model,
      persistActiveRoute,
      persistProviderDefaultModelAndReasoning,
      providerWorkspaceConfig.activeRoute,
      updateRuntimeConfig,
    ],
  );

  const setPlanModeWithNotice = useCallback(
    (nextEnabled: boolean) => {
      updateRuntimeConfig((current) => ({
        ...current,
        planMode: nextEnabled,
      }));
      saveRuntimeModePreference(mode, nextEnabled);
      if (!nextEnabled) {
        setPlanFlow(resetPlanFlow());
      }
      appendEvent("system", "Plan mode", `Plan mode ${nextEnabled ? "enabled" : "disabled"}.`);
    },
    [appendEvent, busy, mode, updateRuntimeConfig],
  );

  const togglePlanModeWithNotice = useCallback(() => {
    setPlanModeWithNotice(!planMode);
  }, [planMode, setPlanModeWithNotice]);

  const setModelAndReasoningWithNotice = useCallback(
    async (
      nextModel: AvailableModel,
      nextReasoning: ReasoningLevel,
      providerId: ProviderId = pendingRouteProviderId ?? activeProviderRoute.providerId,
      localBackend?: LocalBackendId,
    ) => {
      const providerConfig = providerWorkspaceConfig.providers?.[providerId];
      const route: ProviderRoute = {
        providerId,
        modelId: nextModel,
        reasoning: nextReasoning,
        backendKind: getProviderRuntime(providerId).backendKind,
        ...(providerId === "local"
          ? { localBackend: resolveLocalBackend(providerWorkspaceConfig, localBackend) }
          : {}),
      };
      const connection = providerConnectionKey(providerId, {
        cwd: workspaceRoot,
        config: providerWorkspaceConfig,
        routeLocalBackend: route.localBackend,
      });
      const sameConnection = () =>
        providerConnectionKey(providerId, {
          cwd: workspaceRoot,
          config: latest.current.providerWorkspaceConfig,
          routeLocalBackend: route.localBackend,
        }) === connection;
      const transition = selectionCoordinator.begin(route, connection);
      modelSelectionInFlightRef.current = true;
      setPendingRouteProviderId(providerId);
      setRouteSwitchBusy(true);
      let recovery = false;
      const recover = (message: string) => {
        if (!selectionCoordinator.isCurrent(transition)) return;
        appendEvent("error", "Selection unavailable", message);
        if (selectionCoordinator.ownsNavigation(transition)) {
          recovery = true;
          modelPickerOpenRef.current = true;
          setPendingRouteProviderId(providerId);
          setScreen("model-picker");
          void latest.current.ensureProviderModels(providerId);
        }
      };
      try {
        const discovery = discoverProviderModels(providerId);
        const routeCapabilities =
          providerId === "openai"
            ? modelCapabilities
            : providerModelsToCodexCapabilities(discovery.models, nextModel);
        const capability = findModelCapability(routeCapabilities, nextModel);
        if (
          nextReasoning &&
          (capability?.reasoningControl?.kind === "levels" ||
            capability?.reasoningControl?.kind === "budget") &&
          !isSupportedReasoning(capability.reasoningControl, nextReasoning)
        ) {
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
        traceInputDebug(
          "model_selection_app_start",
          getInputDebugSnapshot({ model: nextModel, providerId, transition: transition.id }),
        );
        if (providerId === "local")
          markProviderAvailability("local", "checking", "provider-validation");
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
        if (!selectionCoordinator.isCurrent(transition)) return;
        if (!sameConnection()) {
          recover(
            "The provider connection changed during validation. Choose a model again using the current connection.",
          );
          return;
        }
        if (validation.diagnostics)
          providerDiagnosticsRef.current[providerId] = validation.diagnostics;
        setRegistryNonce((n) => n + 1);
        if (validation.status !== "ready") {
          const message = validation.message ?? getProviderRouteSetupMessage(providerId);
          const failure = validation.failure ?? classifyProviderFailure(message);
          selectionCoordinator.reject(connection, nextModel, failure);
          if (!isModelFailure(failure)) providerRouteErrorsRef.current[providerId] = message;
          recover(isModelFailure(failure) ? modelRecoveryMessage(nextModel) : message);
          return;
        }
        // Write before publishing runtime state. A failed save cannot partially commit a route.
        if (
          persistActiveRoute(
            providerId,
            nextModel,
            route.reasoning ?? "",
            validation.backendKind,
            localBackend,
          ) === false
        ) {
          recover(
            "Unable to save the selection. The previous active route and preferences were preserved.",
          );
          return;
        }
        selectionCoordinator.commit(transition);
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
        if (selectionCoordinator.ownsNavigation(transition) && !modelPickerOpenRef.current)
          setPendingRouteProviderId(null);
        traceInputDebug(
          "model_selection_app_success",
          getInputDebugSnapshot({ model: nextModel, providerId, transition: transition.id }),
        );
      } catch (error) {
        if (!selectionCoordinator.isCurrent(transition)) return;
        if (!sameConnection()) {
          recover(
            "The provider connection changed during validation. Choose a model again using the current connection.",
          );
          return;
        }
        const message = errorMessage(error);
        selectionCoordinator.reject(connection, nextModel, classifyProviderFailure(message));
        recover(message);
      } finally {
        if (selectionCoordinator.isCurrent(transition)) {
          selectionCoordinator.finish(transition);
          setRouteSwitchBusy(false);
          modelSelectionInFlightRef.current = false;
          if (!recovery && selectionCoordinator.ownsNavigation(transition))
            returnToChatMode("selection");
        }
      }
    },
    [
      activeProviderRoute.providerId,
      pendingRouteProviderId,
      appendEvent,
      ensureProviderModels,
      dispatchSession,
      getInputDebugSnapshot,
      markProviderAvailability,
      modelCapabilities,
      persistActiveRoute,
      providerWorkspaceConfig.providers,
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
