import { useApp, useFocusManager, useStdin, useStdout } from "ink";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { LaunchArgs } from "../config/launchArgs.js";
import { applyLayeredRuntimeOverride } from "../config/layeredConfig.js";
import { saveSettings } from "../config/persistence.js";
import { buildRuntimeSummary, resolveRuntimeConfig } from "../config/runtimeConfig.js";
import {
  estimateTokens,
  formatBusyLoaderSettingValue,
  formatReasoningLabel,
  formatThemeLabel,
  formatWorkspaceDisplayPath,
  type HeaderConfig,
  type UserSettingValues,
} from "../config/settings.js";
import {
  type CodexModelCapabilities,
  createFallbackModelCapabilities,
  findModelCapability,
  getSelectableModelCapabilities,
  normalizeReasoningForModelCapabilities,
} from "../core/models/codexModelCapabilities.js";
import { catalogContextKey } from "../core/models/modelCatalog.js";
import { traceModelStateDebug } from "../core/perf/debugLog.js";
import * as renderDebug from "../core/perf/renderDebug.js";
import { buildProviderRegistry, findProvider } from "../core/providerLauncher/registry.js";
import type { LocalBackendId, ProviderId } from "../core/providerLauncher/types.js";
import { resolveModelContextLength } from "../core/providerRuntime/contextMetadata.js";
import { isLocalRuntime } from "../core/providerRuntime/deployment.js";
import { modelRecoveryMessage } from "../core/providerRuntime/failures.js";
import { type checkLocalProvider, setLocalProviderConfig } from "../core/providerRuntime/local.js";
import { closeLocalHarnessSession } from "../core/providerRuntime/localHarness/runtime.js";
import { providerModelsToCodexCapabilities } from "../core/providerRuntime/models.js";
import {
  createRoutedProvider,
  discoverProviderModels,
  getProviderRouteSetupMessage,
  getProviderRuntime,
  resolveActiveProviderRoute,
} from "../core/providerRuntime/registry.js";
import type { RuntimeAvailability } from "../core/providerRuntime/types.js";
import { getBackendProvider } from "../core/providers/registry.js";
import type { BackendProvider } from "../core/providers/types.js";
import { createClearFrameBoundaryController } from "../core/terminal/clearFrameBoundary.js";
import {
  resetInkOutputForFreshFrame,
  resolveInkRenderInstance,
} from "../core/terminal/inkRenderReset.js";
import { createTerminalModeController } from "../core/terminal/terminalControl.js";
import { sanitizeTerminalOutput } from "../core/terminal/terminalSanitize.js";
import { detectGlobalPackageManager, getUpdateCommand } from "../core/version/packageManager.js";
import type { UpdateCheckResult } from "../core/version/updateCheck.js";
import { CheckpointStore, type FileCheckpoint } from "../core/workspace/checkpoints.js";
import { createEventId } from "../session/eventIds.js";
import { createInitialPlanFlowState, type PlanFlowState } from "../session/planFlow.js";
import type { Screen, TimelineEvent } from "../session/types.js";
import { isBusy as isUiBusy } from "../session/types.js";
import { AppShell } from "../ui/chrome/AppShell.js";
import { measureBottomComposerRows } from "../ui/chrome/composer/composerModel.js";
import { FOCUS_IDS } from "../ui/input/focus.js";

import { useStdinRawModeLease } from "../ui/input/useStdinRawModeLease.js";
import { getContentWidth, resolveStartupHeaderMode } from "../ui/layout.js";
import { measurePlanActionPickerRows } from "../ui/panels/PlanActionPicker.js";
import { measureTextEntryPanelRows } from "../ui/panels/TextEntryPanel.js";
import { buildActiveRuntimeDisplay, runtimeDisplayToSummary } from "../ui/render/runtimeDisplay.js";
import { commitThemeSelection, getDisplayedThemeName, THEMES, ThemeProvider } from "../ui/theme.js";
import { TranscriptShell } from "../ui/timeline/TranscriptShell.js";
import { useConversation } from "./conversation/useConversation.js";
import { useAppComposer } from "./input/useAppComposer.js";
import { useAppInput } from "./input/useAppInput.js";
import { useComposerEditing } from "./input/useComposerEditing.js";
import { useWorkbenchActions } from "./input/useWorkbenchActions.js";
import { useAppDebugTracing } from "./lifecycle/useAppDebugTracing.js";
import { useFocusRouting } from "./lifecycle/useFocusRouting.js";
import { useUpdateCheck } from "./lifecycle/useUpdateCheck.js";
import { useModelCatalog } from "./models/useModelCatalog.js";
import { useModelSelection } from "./models/useModelSelection.js";
import { useRuntimeSettings } from "./models/useRuntimeSettings.js";
import { buildSettingsPayload, useSettings } from "./models/useSettings.js";
import { OverlayPanels } from "./overlays/OverlayPanels.js";
import { useOverlayRouting } from "./overlays/useOverlayRouting.js";
import { useRouteStatus } from "./providers/routeStatus.js";
import { useProviderRoute } from "./providers/useProviderRoute.js";
import { useProviderUsage } from "./providers/useProviderUsage.js";
import { usePlanFlow } from "./run/usePlanFlow.js";
import { usePromptExecution } from "./run/usePromptExecution.js";
import { usePromptRun } from "./run/usePromptRun.js";
import { useRunLifecycle } from "./run/useRunLifecycle.js";
import { useAppState } from "./state/useAppState.js";

interface AppProps {
  launchArgs: LaunchArgs;
  /** Embedded/testing runtime; never exposed as a CLI flag. */
  providerOverride?: BackendProvider;
}

export function App({ launchArgs, providerOverride }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const focusManager = useFocusManager();
  const appState = useAppState({ providerOverride, launchArgs });
  const selectionVersion = useSyncExternalStore(
    appState.selectionCoordinator.subscribe,
    appState.selectionCoordinator.getSnapshot,
  );
  const {
    workspaceRoot,
    initialSettings,
    initialUpdateCheckResult,
    initialProviderWorkspaceConfig,
    terminalLayout,
    terminalLayoutColsRef,
    staticRepaintGeneration,
    bumpStaticRepaintGeneration,
    staticRepaintGenerationRef,
    baseLayeredConfig,
    sessionRuntimeOverride,
    authPreference,
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader,
    providerWorkspaceConfig,
    localBackendStatuses,
    pendingRouteProviderId,
    setPendingRouteProviderId,
    providerSetup,
    setProviderSetup,
    themeSelection,
    setThemeSelection,
    themeNotice,
    setThemeNotice,
    customTheme,
    setCustomTheme,
    headerConfig,
    screen,
    setScreen,
    shouldMountTranscript,
    pendingImport,
    pastedContentRegistryRef,
    imageAttachmentRegistryRef,
    toolApproval,
    setToolApproval,
    toolApprovalResolverRef,
    registryNonce,
    setRegistryNonce,
    screenRef,
    bumpPostClearRepaint,
    sessionState,
    dispatchSession,
    getSessionState,
    activeConversationRef,
    promptQueue,
    workbenchVersion,
    workbenchView,
    fileAttachmentRegistryRef,
    checkpointsRef,
    restoredFileBoundaryRef,
    stoppingRef,
    snapshotRef,
    deferredRouteCloseRef,
    isMountedRef,
    activeRunIdRef,
    clearEpochRef,
    interruptHint,
    conversationRouteOverride,
    preserveSavedRouteRef,
    savedViewerSession,
    resumeConversations,
    resumePickerPositionRef,
    externalViewerSession,
    authStatus,
    authStatusBusy,
    conversationChars,
    modelCapabilities,
    modelCapabilitiesBusy,
    routeSwitchBusy,
    providerModelLoading,
    providerModelErrors,
    activeContextMetadata,
    setActiveContextMetadata,
  } = appState;
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  // Keep Ink's raw-mode refcount above zero for the whole session so composer
  // remounts (overlay exit shell swap + instance key bump) never detach Ink's
  // stdin reader; see useStdinRawModeLease.
  useStdinRawModeLease();
  const terminalControl = useMemo(
    () => createTerminalModeController((chunk) => stdout.write(chunk)),
    [stdout],
  );
  // Shared by provider launches and native session resumes: the external CLI
  // owns the terminal, with mouse reporting off, until it exits.
  const externalCliLaunchHooks = useMemo(
    () => ({
      stdin,
      beforeLaunch: () => {
        terminalControl.setMouseReporting(false, "src/app/App.tsx:externalCliLaunch.disableMouse");
        stdout.write("\n");
      },
      afterLaunch: () => {
        terminalControl.setMouseReporting(
          false,
          "src/app/App.tsx:externalCliLaunch.keepMouseNative",
        );
      },
    }),
    [stdin, stdout, terminalControl],
  );
  // Live Ink instance behind this stdout, used to reset Ink's frame caches on
  // the /clear boundary so the next frame is authoritative (see handleClear).
  const inkInstance = useMemo(() => resolveInkRenderInstance(stdout), [stdout]);
  const clearFrameBoundaryController = useMemo(
    () =>
      createClearFrameBoundaryController({
        instance: inkInstance,
        terminalControl,
        stdout,
        source: "src/app/App.tsx:clearBoundary",
        onWidthResizeRefresh: () => bumpStaticRepaintGeneration((tick) => tick + 1),
        getRenderedRepaintGeneration: () => staticRepaintGenerationRef.current,
        getRenderedLayoutCols: () => terminalLayoutColsRef.current,
        // Read at frame-write time; screenRef is assigned during render, so it
        // always reflects the render that produced the frame being written.
        isOverlayActive: () => screenRef.current !== "main",
      }),
    [inkInstance, stdout, terminalControl],
  );
  const [verboseMode, setVerboseMode] = useState(false);
  const [planFlow, setPlanFlow] = useState<PlanFlowState>(createInitialPlanFlowState);
  snapshotRef.current = () => {
    const state = getSessionState();
    return {
      version: 1,
      events: [...state.staticEvents, ...state.activeEvents],
      uiState: state.uiState,
      plan: planFlow,
      draft: state.inputValue,
      cursor: state.cursor,
      history: state.history,
      pastes: [...pastedContentRegistryRef.current],
      images: [...imageAttachmentRegistryRef.current],
      files: [...fileAttachmentRegistryRef.current],
      queue: [...promptQueue.items],
      checkpoints: [...checkpointsRef.current],
      restoredFileBoundary: restoredFileBoundaryRef.current,
    };
  };
  const [initialRevisionText, setInitialRevisionText] = useState("");
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(
    initialUpdateCheckResult.current,
  );
  // Launcher path is fixed for the process lifetime, so detect once.
  const globalPackageManager = useMemo(() => detectGlobalPackageManager(), []);
  const overlayMode = screen !== "main";

  // ─── Effects & Handlers ──────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      clearFrameBoundaryController?.dispose();
    };
  }, [clearFrameBoundaryController]);

  useEffect(() => {
    if (!clearFrameBoundaryController) return;
    const postClearRepaintPending = clearFrameBoundaryController.syncRenderState({
      generation: sessionState.clearEpoch,
      staticEventsLength: sessionState.staticEvents.length,
      activeEventsLength: sessionState.activeEvents.length,
      transcriptCleared:
        sessionState.staticEvents.length === 0 && sessionState.activeEvents.length === 0,
      clearGenerationReady:
        sessionState.clearEpoch > 0 &&
        sessionState.uiState.kind === "IDLE" &&
        sessionState.activeEvents.length === 0,
      uiStateKind: sessionState.uiState.kind,
    });
    if (postClearRepaintPending) {
      // Ink already wrote (and suppressed) the cleared frame during the commit
      // that preceded this passive effect, so the boundary's gate only became
      // satisfiable just now. Force one more commit to deterministically flush
      // the authoritative post-clear frame instead of waiting on an incidental
      // later render. `bumpPostClearRepaint` is not an effect dependency, so this
      // re-render does not re-run the effect (no loop).
      bumpPostClearRepaint((tick) => tick + 1);
    }
  }, [clearFrameBoundaryController, sessionState]);

  useLayoutEffect(() => {
    // The clear-frame boundary owns alternate-screen switching so the buffer
    // flip happens atomically with the first frame of the new screen (see
    // clearFrameBoundary.ts). Toggling from an effect would run after Ink has
    // already written that frame into the wrong buffer — the overlay would
    // land in the normal buffer's scrollback and the alt screen would open
    // blank. This effect is only a fallback for environments where no live
    // Ink instance could be resolved (tests, exotic Ink versions).
    if (clearFrameBoundaryController) return;
    terminalControl.setAlternateScreen(
      overlayMode,
      overlayMode
        ? "src/app/App.tsx:overlay.enterAlternateScreen"
        : "src/app/App.tsx:overlay.exitAlternateScreen",
    );
  }, [clearFrameBoundaryController, overlayMode, terminalControl]);

  useEffect(() => {
    return () => {
      terminalControl.setAlternateScreen(false, "src/app/App.tsx:overlay.cleanupAlternateScreen");
    };
  }, [terminalControl]); // Incremented on /clear to suppress stale command events
  const externalCliStatusRef = useRef(sessionState.externalCliStatus);
  const previousScreenRef = useRef<Screen>("main");
  const themePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const themeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelDiscoveryInFlightRef = useRef<Promise<CodexModelCapabilities> | null>(null);
  const modelDiscoveryAnnounceRef = useRef(false);
  const intendedInputModeRef = useRef<"chat/input" | "model-picker">("chat/input");
  const intendedFocusTargetRef = useRef<string>(FOCUS_IDS.composer);
  const modelSelectionInFlightRef = useRef(false);
  // Async provider validation/model discovery must not infer that the picker
  // should close. This ref is set only by explicit picker open/close actions.
  const modelPickerOpenRef = useRef(false);
  const providerModelRefreshesRef = useRef(new Map<ProviderId, Promise<unknown>>());
  const localBackendCheckInFlightRef = useRef(
    new Map<LocalBackendId, ReturnType<typeof checkLocalProvider>>(),
  );
  const providerModelsLoadedRef = useRef(new Set<ProviderId>());
  const providerRouteErrorsRef = useRef<Record<string, string>>({});
  const providerDiagnosticsRef = useRef<
    Record<string, Record<string, string | number | boolean | null>>
  >({});
  const providerMigrationNoticeShownRef = useRef(
    Boolean(initialProviderWorkspaceConfig.current.migrationNotice),
  );
  const initialPromptSubmittedRef = useRef(false);
  const activeThemeName = getDisplayedThemeName(themeSelection);
  const activeTheme =
    activeThemeName === "custom"
      ? { ...THEMES.purple, ...customTheme }
      : (THEMES[activeThemeName] ?? THEMES.purple);
  const baseRuntimeConfigRef = useRef(baseLayeredConfig.runtime);
  const layeredRuntimeConfig = useMemo(
    () =>
      applyLayeredRuntimeOverride(
        baseLayeredConfig,
        sessionRuntimeOverride,
        "In-session overrides",
      ),
    [baseLayeredConfig, sessionRuntimeOverride],
  );
  const runtimeConfig = layeredRuntimeConfig.runtime;
  const { provider: backend, model, mode, reasoningLevel, planMode } = runtimeConfig;
  const resolvedRuntimeConfig = useMemo(() => resolveRuntimeConfig(runtimeConfig), [runtimeConfig]);
  const runtimeSummary = useMemo(
    () => buildRuntimeSummary(resolvedRuntimeConfig),
    [resolvedRuntimeConfig],
  );
  const activeProviderRoute = useMemo(() => {
    // When --model was given on the CLI, override the stored activeRoute's modelId so
    // the actual run uses the CLI model instead of whatever is persisted in providers.json.
    // The providers.json entry is left unchanged so it survives this session.
    const cliModel = appState.selectionCoordinator.interactiveSelection
      ? null
      : launchArgs.modelOverride;
    if (conversationRouteOverride) return conversationRouteOverride;
    const configuredRoute = providerWorkspaceConfig.activeRoute;
    const effectiveRoute =
      cliModel && configuredRoute ? { ...configuredRoute, modelId: cliModel } : configuredRoute;
    return resolveActiveProviderRoute({
      workspaceConfigActiveRoute: effectiveRoute,
      googleMigrationRequired: providerWorkspaceConfig.googleMigrationRequired,
      currentModel: model,
      currentReasoning: reasoningLevel,
    });
  }, [
    conversationRouteOverride,
    launchArgs.modelOverride,
    model,
    providerWorkspaceConfig.activeRoute,
    providerWorkspaceConfig.googleMigrationRequired,
    reasoningLevel,
    registryNonce,
    providerWorkspaceConfig,
    selectionVersion,
  ]);
  const previousProviderRouteRef = useRef(activeProviderRoute);
  useEffect(() => {
    const previous = previousProviderRouteRef.current;
    const changed =
      previous.providerId !== activeProviderRoute.providerId ||
      previous.modelId !== activeProviderRoute.modelId ||
      previous.localBackend !== activeProviderRoute.localBackend;
    if (changed && previous.providerId === "local") {
      const sessionId = activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
      if (activeRunIdRef.current !== null) deferredRouteCloseRef.current = sessionId;
      else
        stoppingRef.current = stoppingRef.current.then(() => closeLocalHarnessSession(sessionId));
    }
    previousProviderRouteRef.current = activeProviderRoute;
  }, [activeProviderRoute]);
  const activeProviderRuntime = useMemo(
    () => getProviderRuntime(activeProviderRoute.providerId),
    [activeProviderRoute.providerId],
  );
  const providerRegistry = useMemo(
    () => {
      setLocalProviderConfig(providerWorkspaceConfig.providers?.local);
      return buildProviderRegistry({
        activeModel: model,
        workspaceRoot,
        workspaceConfig: providerWorkspaceConfig,
        diagnostics: providerDiagnosticsRef.current,
        routeErrors: providerRouteErrorsRef.current,
      });
    },
    // registryNonce is intentionally included: startup probes and post-validation
    // updates mutate providerDiagnosticsRef/providerRouteErrorsRef (refs, not state)
    // and then increment the nonce to trigger a re-read of those refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, providerWorkspaceConfig, registryNonce, workspaceRoot],
  );
  const workspaceDefaultProvider = useMemo(
    () => providerRegistry.find((provider) => provider.isDefault) ?? providerRegistry[0] ?? null,
    [providerRegistry],
  );
  const activeRouteProviderId = activeProviderRoute.providerId;
  const markProviderAvailability = useCallback(
    (providerId: ProviderId, availability: RuntimeAvailability, reason: string) => {
      const previous = providerDiagnosticsRef.current[providerId] ?? {};
      const selectedModel =
        typeof previous.selectedModel === "string" && previous.selectedModel.trim()
          ? previous.selectedModel.trim()
          : providerId === activeProviderRoute.providerId
            ? activeProviderRoute.modelId
            : null;
      providerDiagnosticsRef.current[providerId] = {
        ...previous,
        selectedModel,
        availabilityStatus: availability,
        endpointCheckResult: availability,
      };
      traceModelStateDebug("provider_availability_marked", {
        providerId,
        selectedModel,
        availability,
        reason,
      });
      setRegistryNonce((current) => current + 1);
    },
    [activeProviderRoute.modelId, activeProviderRoute.providerId],
  );

  // Reset provider readiness when the user switches to a different provider.
  useEffect(() => {
    dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "idle" });
  }, [activeRouteProviderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeRouteProvider = useMemo(
    () => findProvider(providerRegistry, activeRouteProviderId) ?? providerRegistry[0] ?? null,
    [activeRouteProviderId, providerRegistry],
  );
  const modelPickerProviderId = pendingRouteProviderId ?? activeProviderRoute.providerId;
  const modelPickerRuntime = useMemo(
    () => getProviderRuntime(modelPickerProviderId),
    [modelPickerProviderId],
  );
  const modelPickerDiscovery = useMemo(() => {
    if (modelPickerProviderId === "openai") return null;
    return discoverProviderModels(modelPickerProviderId);
    // registryNonce is intentionally included: route validation discovers models
    // as a side effect and bumps the nonce so an open picker re-reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPickerProviderId, registryNonce]);
  const providerModelCapabilities = useMemo(() => {
    if (!modelPickerDiscovery) return null;
    return providerModelsToCodexCapabilities(
      modelPickerDiscovery.models,
      activeProviderRoute.modelId,
    );
  }, [activeProviderRoute.modelId, modelPickerDiscovery]);
  const activeRouteModelCapabilities = useMemo(() => {
    if (activeProviderRoute.providerId === "openai") return modelCapabilities;
    const discovery = discoverProviderModels(activeProviderRoute.providerId);
    return providerModelsToCodexCapabilities(discovery.models, activeProviderRoute.modelId);
    // Local startup discovery mutates the runtime cache without necessarily
    // changing the restored model id. Re-read it when the registry nonce moves
    // so discovered context metadata can replace the initial Unknown value.
  }, [
    activeProviderRoute.modelId,
    activeProviderRoute.providerId,
    modelCapabilities,
    registryNonce,
  ]);
  const modelPickerModels = useMemo(() => {
    const capabilities =
      providerModelCapabilities ??
      (modelPickerProviderId === "openai"
        ? (modelCapabilities ?? createFallbackModelCapabilities(null))
        : null);
    return capabilities
      ? getSelectableModelCapabilities(capabilities).map((entry) => ({
          ...entry,
          reasoningPreference:
            providerWorkspaceConfig.providers?.[modelPickerProviderId]?.models?.[entry.model]
              ?.reasoningPreference,
        }))
      : [];
  }, [
    modelCapabilities,
    modelPickerProviderId,
    providerModelCapabilities,
    providerWorkspaceConfig.providers,
  ]);
  const modelPickerCurrentModel = useMemo(() => {
    if (!pendingRouteProviderId) return activeProviderRoute.modelId;
    if (pendingRouteProviderId === activeProviderRoute.providerId)
      return activeProviderRoute.modelId;
    // Non-active provider: use stored default, fall back to first selectable model
    const storedDefault = providerWorkspaceConfig.providers?.[pendingRouteProviderId]?.currentModel;
    const selectable = getSelectableModelCapabilities(
      providerModelCapabilities ?? createFallbackModelCapabilities(null),
    );
    return storedDefault ?? selectable[0]?.model ?? model;
  }, [
    activeProviderRoute,
    model,
    pendingRouteProviderId,
    providerModelCapabilities,
    providerWorkspaceConfig,
  ]);
  const modelPickerCurrentReasoning = useMemo(() => {
    if (!pendingRouteProviderId) {
      return activeProviderRoute.reasoning ?? reasoningLevel;
    }
    if (pendingRouteProviderId === activeProviderRoute.providerId) {
      return activeProviderRoute.reasoning ?? reasoningLevel;
    }
    const storedReasoning =
      providerWorkspaceConfig.providers?.[pendingRouteProviderId]?.currentReasoning;
    if (storedReasoning) return storedReasoning;
    const pickerCapabilities =
      pendingRouteProviderId === "openai" ? modelCapabilities : providerModelCapabilities;
    const capability = findModelCapability(pickerCapabilities, modelPickerCurrentModel);
    return (
      capability?.defaultReasoningLevel ??
      capability?.supportedReasoningLevels?.[0]?.id ??
      reasoningLevel
    );
  }, [
    activeProviderRoute.providerId,
    activeProviderRoute.reasoning,
    modelPickerCurrentModel,
    modelCapabilities,
    pendingRouteProviderId,
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
  const modelPickerEmptyMessage = useMemo(() => {
    const connection = catalogContextKey(modelPickerProviderId, {
      cwd: workspaceRoot,
      providerConfig: providerWorkspaceConfig.providers?.[modelPickerProviderId],
      ...(modelPickerProviderId === "local"
        ? { localBackend: providerWorkspaceConfig.providers?.local?.localBackend ?? "lm-studio" }
        : {}),
    });
    if (
      appState.selectionCoordinator.state(connection, modelPickerCurrentModel)?.status ===
      "unavailable"
    )
      return modelRecoveryMessage(modelPickerCurrentModel);
    if (modelPickerProviderId === "openai") {
      return modelCapabilities?.error
        ? `No models available: ${modelCapabilities.error}`
        : "No models available.";
    }
    if (modelPickerDiscovery?.status === "ready" && modelPickerDiscovery.models.length === 0) {
      const setup = getProviderRouteSetupMessage(modelPickerProviderId);
      return `No ${modelPickerProviderLabel} models are currently advertised. Refresh models or change provider. ${setup}`;
    }
    if (providerModelErrors[modelPickerProviderId]) {
      return `${providerModelErrors[modelPickerProviderId]} Press Refresh models to retry.`;
    }
    return modelPickerDiscovery?.message ?? "No models available.";
  }, [
    selectionVersion,
    modelPickerCurrentModel,
    providerWorkspaceConfig.providers,
    workspaceRoot,
    modelCapabilities,
    modelPickerDiscovery,
    modelPickerProviderId,
    modelPickerProviderLabel,
    providerModelErrors,
  ]);
  const { routeStatusMessage } = useRouteStatus({
    ...appState,
    providerRegistry,
    providerDiagnosticsRef,
    activeProviderRoute,
    workspaceDefaultProvider,
    activeRouteProvider,
    activeProviderRuntime,
    activeRouteModelCapabilities,
    reasoningLevel,
  });
  const currentModelCapability = useMemo(
    () => findModelCapability(activeRouteModelCapabilities, activeProviderRoute.modelId),
    [activeProviderRoute.modelId, activeRouteModelCapabilities],
  );
  const currentModelRawMetadataKey = useMemo(
    () =>
      currentModelCapability?.raw === undefined ? "" : JSON.stringify(currentModelCapability.raw),
    [currentModelCapability?.raw],
  );
  const currentReasoningCapabilities = currentModelCapability?.supportedReasoningLevels ?? [];
  const currentReasoningSourceLabel = useMemo(() => {
    if (activeProviderRoute.providerId !== "anthropic") return null;
    const raw = currentModelCapability?.raw as
      | { source?: string; effortVerified?: boolean }
      | null
      | undefined;
    if (raw?.source === "claude-code" || raw?.source === "discovered")
      return "Discovered from Claude Code";
    if (raw?.source === "settings" || raw?.source === "config") return "From Claude settings";
    return raw?.effortVerified === false ? "Fallback defaults; unverified" : "Fallback defaults";
  }, [activeProviderRoute.providerId, currentModelCapability]);

  useEffect(() => {
    let cancelled = false;
    const providerId = activeProviderRoute.providerId;
    const modelId = activeProviderRoute.modelId;
    const rawMetadata = currentModelCapability?.raw;

    void resolveModelContextLength({
      providerId,
      modelId,
      providerConfig: providerWorkspaceConfig.providers?.[providerId],
      rawMetadata,
    }).then((metadata) => {
      if (cancelled || !isMountedRef.current) return;
      setActiveContextMetadata(metadata);

      const contextSource = metadata.source === "known-registry" ? "registry" : metadata.source;
      providerDiagnosticsRef.current[providerId] = {
        ...(providerDiagnosticsRef.current[providerId] ?? {}),
        contextLength: metadata.contextLength,
        contextSource,
        contextConfidence: metadata.confidence,
        contextRawField: metadata.rawField ?? null,
        contextError: metadata.error ?? null,
      };
      setRegistryNonce((current) => current + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeProviderRoute.modelId,
    activeProviderRoute.providerId,
    currentModelRawMetadataKey,
    providerWorkspaceConfig.providers,
  ]);

  const workspaceLabel = useMemo(
    () => formatWorkspaceDisplayPath(workspaceRoot, workspaceDisplayMode),
    [workspaceDisplayMode, workspaceRoot],
  );
  const { staticEvents, activeEvents, uiState, inputValue, cursor } = sessionState;

  const currentUserSettings = useMemo<UserSettingValues>(
    () => ({
      workspaceDisplayMode,
      terminalTitleMode,
      showBusyLoader: formatBusyLoaderSettingValue(showBusyLoader),
    }),
    [showBusyLoader, terminalTitleMode, workspaceDisplayMode],
  );

  const allowedWritableRoots = useMemo(
    () => resolvedRuntimeConfig.policy.writableRoots,
    [resolvedRuntimeConfig],
  );

  const activeRuntimeDisplay = useMemo(
    () =>
      buildActiveRuntimeDisplay({
        route: activeProviderRoute,
        reasoningLevel,
        mode,
        tokensUsed: estimateTokens(conversationChars),
        modelCapability: currentModelCapability,
        contextMetadata: activeContextMetadata,
        isLocalRuntime: isLocalRuntime(
          activeProviderRoute,
          providerWorkspaceConfig.providers?.[activeProviderRoute.providerId],
        ),
      }),
    [
      activeContextMetadata,
      activeProviderRoute,
      conversationChars,
      currentModelCapability,
      providerWorkspaceConfig.providers,
      mode,
      reasoningLevel,
    ],
  );
  const currentModelSpec = activeRuntimeDisplay.modelSpec;

  // Refs for mutable state values — used by stable callbacks below so they
  // always read the latest value without being listed as deps (which would
  // recreate the callbacks on every keystroke and defeat memoisation).
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const busy = isUiBusy(uiState);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const prevBusyRef = useRef(busy);
  useEffect(() => {
    if (!busy && prevBusyRef.current && screen === "main") {
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      focusManager.focus(FOCUS_IDS.composer);
    }
    prevBusyRef.current = busy;
  }, [busy, screen, focusManager]);

  const modelCapabilitiesBusyRef = useRef(modelCapabilitiesBusy);
  modelCapabilitiesBusyRef.current = modelCapabilitiesBusy;
  const composerWidth =
    screen === "main" ? terminalLayout.cols : getContentWidth(terminalLayout.cols);
  const composerRows = useMemo(() => {
    if (planFlow.kind === "awaiting_action") {
      return measurePlanActionPickerRows(terminalLayout.cols);
    }
    if (planFlow.kind === "collecting_feedback") {
      return measureTextEntryPanelRows();
    }
    return measureBottomComposerRows({
      queueCount: promptQueue.items.length,
      interruptHint,
      layout: terminalLayout,
      width: composerWidth,
      uiState,
      mode,
      model,
      reasoningLevel,
      tokensUsed: estimateTokens(conversationChars),
      modelSpec: currentModelSpec,
      value: inputValue,
      cursor,
    });
  }, [
    composerWidth,
    conversationChars,
    currentModelSpec,
    cursor,
    inputValue,
    interruptHint,
    mode,
    model,
    planFlow.kind,
    workbenchVersion,
    reasoningLevel,
    terminalLayout,
    uiState,
  ]);
  const activeRootComponent = screen === "main" ? "TranscriptShell" : "AppShell";
  const startupHeaderMode = useMemo(
    () =>
      resolveStartupHeaderMode({
        cols: terminalLayout.cols,
        rows: terminalLayout.rows,
        introRows: 8,
        composerRows,
      }),
    [composerRows, terminalLayout.cols, terminalLayout.rows],
  );
  useAppDebugTracing({
    ...appState,
    activeRootComponent,
    startupHeaderMode,
    staticEvents,
    activeEvents,
    uiState,
    inputValue,
    cursor,
    busy,
    composerRows,
    planFlow,
    mode,
    model,
    reasoningLevel,
  });

  const backendProvider: BackendProvider = useMemo(() => getBackendProvider(backend), [backend]);
  const provider: BackendProvider = useMemo(() => {
    if (providerOverride) return providerOverride;
    return createRoutedProvider(
      activeProviderRoute,
      backendProvider,
      providerWorkspaceConfig,
      () => activeConversationRef.current?.metadata.localHarnessSession,
      () => activeConversationRef.current?.metadata.nativeSessions,
    );
  }, [
    activeProviderRoute,
    backend,
    backendProvider,
    providerWorkspaceConfig.providers,
    providerOverride,
  ]);
  const { getInputDebugSnapshot, returnToChatMode, returnFromUpdateOverlay } = useFocusRouting({
    ...appState,
    busyRef,
    modelCapabilitiesBusyRef,
    intendedInputModeRef,
    modelSelectionInFlightRef,
    intendedFocusTargetRef,
    stdin,
    baseRuntimeConfigRef,
    providerOverride,
    themePreviewTimerRef,
    themeNoticeTimerRef,
    previousScreenRef,
    focusManager,
    planFlow,
    modelPickerOpenRef,
  });

  const appendStaticEvent = useCallback(
    (event: TimelineEvent) => {
      dispatchSession({ type: "APPEND_STATIC_EVENT", event });
    },
    [dispatchSession],
  );

  const appendEvent = useCallback(
    (type: "system" | "error", title: string, content: string) => {
      appendStaticEvent({
        id: createEventId(),
        type,
        createdAt: Date.now(),
        title: sanitizeTerminalOutput(title),
        content: sanitizeTerminalOutput(content, { preserveTabs: false, tabSize: 2 }),
      });
    },
    [appendStaticEvent],
  );
  const armTranscriptReplacement = useCallback(
    (source: string) => {
      const clearGeneration = sessionState.clearEpoch + 1;
      const clearBoundaryArmed =
        clearFrameBoundaryController?.beginClearGeneration(clearGeneration) ?? false;
      renderDebug.traceEvent("terminal", "clearCommandReceived", {
        source,
        clearGeneration,
        clearPending: clearBoundaryArmed,
        liveInkInstanceResolved: Boolean(inkInstance),
      });
      return {
        clearGeneration,
        clearBoundaryArmed,
        /** Call after dispatching the transcript swap. */
        finish: () => {
          if (clearBoundaryArmed) return;
          // Fallback path (unexpected Ink mismatch): clear imperatively.
          terminalControl.clearTranscript(`${source}:fallback`);
          resetInkOutputForFreshFrame({ instance: inkInstance, columns: stdout.columns });
          renderDebug.traceEvent("terminal", "clearBoundaryFallback", {
            source,
            clearGeneration,
            liveInkInstanceResolved: Boolean(inkInstance),
          });
        },
      };
    },
    [
      clearFrameBoundaryController,
      inkInstance,
      sessionState.clearEpoch,
      stdout.columns,
      terminalControl,
    ],
  );

  const conversation = useConversation({
    armTranscriptReplacement,
    ...appState,
    activeProviderRoute,
    appendEvent,
    inputValue,
    cursor,
    planFlow,
    busy,
    exit,
    busyRef,
    externalCliLaunchHooks,
    setPlanFlow,
    providerOverride,
    intendedFocusTargetRef,
    focusManager,
    providerRegistry,
    launchArgs,
    providerMigrationNoticeShownRef,
    appendStaticEvent,
  });
  const {
    loadResumeSessions,
    rememberResumePickerPosition,
    openExternalSession,
    loadExternalTranscript,
    returnToResumePicker,
    resumeExternalSessionNative,
    resumeConversation,
    continueExternalSession,
    selectResumeSession,
    locateSavedWorkspace,
  } = conversation;

  const runtimeSettings = useRuntimeSettings({
    ...appState,
    launchArgs,
    baseRuntimeConfigRef,
    appendEvent,
  });
  const { updateRuntimeConfig, persistProviderDefaultModelAndReasoning } = runtimeSettings;
  const { routeChoiceRequiredRef } = appState;
  const { refreshModelCapabilities, ensureProviderModels, refreshAuthStatus } = useModelCatalog({
    ...appState,
    ...runtimeSettings,
    providerOverride,
    modelDiscoveryInFlightRef,
    getInputDebugSnapshot,
    modelDiscoveryAnnounceRef,
    appendEvent,
    providerModelsLoadedRef,
    providerModelRefreshesRef,
    providerDiagnosticsRef,
    providerRouteErrorsRef,
    activeProviderRoute,
    markProviderAvailability,
    reasoningLevel,
  });
  const { requestUpdateCheck } = useUpdateCheck({
    ...appState,
    updateCheckResult,
    setUpdateCheckResult,
    returnFromUpdateOverlay,
  });

  const repaintCommittedTheme = useCallback(
    (themeName: string) => {
      // Persist the committed value synchronously as well as through the normal
      // settings effect. This matters when the terminal is closed immediately
      // after choosing a theme, before React gets another effect pass.
      saveSettings(
        buildSettingsPayload(
          initialSettings.current,
          {
            theme: themeName,
            workspaceDisplayMode,
            terminalTitleMode,
            showBusyLoader,
            customTheme,
          },
          authPreference,
          headerConfig,
        ),
      );
      setThemeSelection((currentTheme) => commitThemeSelection(currentTheme, themeName));
      setThemeNotice(`Theme switched to ${formatThemeLabel(themeName)}.`);
      if (themeNoticeTimerRef.current) clearTimeout(themeNoticeTimerRef.current);
      themeNoticeTimerRef.current = setTimeout(() => {
        setThemeNotice(null);
        themeNoticeTimerRef.current = null;
      }, 1800);
    },
    [
      authPreference,
      customTheme,
      headerConfig,
      showBusyLoader,
      terminalTitleMode,
      workspaceDisplayMode,
    ],
  );

  // Track clear epoch to suppress stale command result events
  useEffect(() => {
    clearEpochRef.current = sessionState.clearEpoch;
  }, [sessionState.clearEpoch]);

  useEffect(() => {
    externalCliStatusRef.current = sessionState.externalCliStatus;
  }, [sessionState.externalCliStatus]);

  // Reconcile effort only. A withdrawn model always requires explicit reselection.
  useEffect(() => {
    if (
      providerOverride ||
      preserveSavedRouteRef.current ||
      activeProviderRoute.providerId !== "openai" ||
      modelCapabilities?.status !== "ready" ||
      discoverProviderModels("openai").freshness !== "verified"
    )
      return;
    const selected = findModelCapability(modelCapabilities, model);
    if (!selected || !selected.available || selected.hidden) {
      const message = `Configured model ${model} is unavailable. Select a model explicitly before sending.`;
      if (routeChoiceRequiredRef.current !== message)
        appendEvent("error", "Selected model unavailable", message);
      routeChoiceRequiredRef.current = message;
      return;
    }
    if (
      routeChoiceRequiredRef.current ===
      `Configured model ${model} is unavailable. Select a model explicitly before sending.`
    )
      routeChoiceRequiredRef.current = null;
    const nextReasoning = normalizeReasoningForModelCapabilities(
      model,
      reasoningLevel,
      modelCapabilities,
    );
    if (nextReasoning === reasoningLevel) return;
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
  const modelSelection = useModelSelection({
    ...runtimeSettings,
    ...appState,
    appendEvent,
    busy,
    mode,
    planMode,
    setPlanFlow,
    currentModelCapability,
    model,
    launchArgs,
    activeProviderRoute,
    modelSelectionInFlightRef,
    getInputDebugSnapshot,
    reasoningLevel,
    activeRouteModelCapabilities,
    runtimeConfig,
    activeRouteProvider,
    returnToChatMode,
    markProviderAvailability,
    providerDiagnosticsRef,
    providerRouteErrorsRef,
    modelPickerOpenRef,
    ensureProviderModels,
  });
  const {
    setModeWithNotice,
    setReasoningWithNotice,
    setPlanModeWithNotice,
    setModelAndReasoningWithNotice,
  } = modelSelection;
  const settings = useSettings({
    ...appState,
    ...runtimeSettings,
    appendEvent,
    returnFromUpdateOverlay,
    busy,
  });
  const {
    setAuthPreferenceWithNotice,
    saveSettingsFromPanel,
    handleSkipUpdateForSession,
    setApprovalPolicyWithNotice,
    setSandboxModeWithNotice,
    setNetworkAccessWithNotice,
    addWritableRootWithNotice,
    removeWritableRootWithNotice,
  } = settings;
  const { probeLocalBackends, openProviderPicker, handleProviderAction, runProviderSetup } =
    useProviderRoute({
      ...appState,
      ...modelSelection,
      localBackendCheckInFlightRef,
      modelPickerOpenRef,
      modelSelectionInFlightRef,
      providerDiagnosticsRef,
      appendEvent,
      busy,
      providerRegistry,
      activeRouteProvider,
      model,
      providerRouteErrorsRef,
      intendedInputModeRef,
      intendedFocusTargetRef,
      activeProviderRoute,
      reasoningLevel,
      ensureProviderModels,
      refreshModelCapabilities,
      markProviderAvailability,
      runtimeConfig,
      resolvedRuntimeConfig,
      busyRef,
      externalCliLaunchHooks,
    });
  const overlayRouting = useOverlayRouting({
    ...appState,
    ...settings,
    modelSelectionInFlightRef,
    getInputDebugSnapshot,
    modelPickerOpenRef,
    intendedInputModeRef,
    intendedFocusTargetRef,
    focusManager,
    activeProviderRoute,
    refreshModelCapabilities,
    ensureProviderModels,
    appendEvent,
    busy,
    currentModelCapability,
    model,
    runtimeConfig,
  });
  const { handlePermissionsPanelAction } = overlayRouting;
  const runLifecycle = useRunLifecycle({
    ...appState,
    ...conversation,
    intendedFocusTargetRef,
    focusManager,
    activeProviderRoute,
    activeEvents,
    uiState,
    busy,
    planFlow,
    setPlanFlow,
    appendEvent,
    exit,
    staticEvents,
  });
  const { handleCancel } = runLifecycle;
  const { handleChangeInput, handleRegisterPaste, handlePasteImage, handleClear } =
    useComposerEditing({
      armTranscriptReplacement,
      ...appState,
      ...conversation,
      ...runLifecycle,
      busyRef,
      runtimeConfig,
      inputValueRef,
      cursorRef,
      appendEvent,
      setPlanFlow,
    });
  const promptExecution = usePromptExecution({
    ...appState,
    allowedWritableRoots,
    appendEvent,
    focusManager,
    busy,
    exit,
    staticEvents,
    activeEvents,
  });
  const { startPromptRun } = usePromptRun({
    ...appState,
    ...conversation,
    ...runLifecycle,
    appendEvent,
    allowedWritableRoots,
    activeProviderRoute,
    activeRouteProvider,
    runtimeConfig,
    provider,
    providerOverride,
    backend,
    externalCliStatusRef,
    refreshAuthStatus,
    mode,
  });
  const workbenchActions = useWorkbenchActions({
    armTranscriptReplacement,
    ...appState,
    ...runLifecycle,
    ...conversation,
    appendEvent,
    terminalControl,
    inkInstance,
    stdout,
    planFlow,
    suspendTerminal,
    startPromptRun,
    setPlanFlow,
  });
  const { handleQueueAction, handleRewind, handleImportConfirm, handleImportCancel } =
    workbenchActions;
  const { runPlanGeneration, handlePlanAction, handlePlanFeedbackSubmit } = usePlanFlow({
    ...runLifecycle,
    ...runtimeSettings,
    ...appState,
    startPromptRun,
    setPlanFlow,
    appendEvent,
    planFlow,
    initialPromptSubmittedRef,
    busy,
    launchArgs,
    allowedWritableRoots,
    planMode,
    mode,
    uiState,
  });
  const providerUsage = useProviderUsage({
    activeProviderRoute,
    providerWorkspaceConfig,
    workspaceRoot,
    activeContextMetadata,
    setScreen,
  });
  const { handleSubmit } = useAppInput({
    ...appState,
    ...runLifecycle,
    ...workbenchActions,
    ...conversation,
    ...promptExecution,
    ...modelSelection,
    ...settings,
    ...overlayRouting,
    openUsagePanel: providerUsage.openUsagePanel,
    appendEvent,
    busy,
    layeredRuntimeConfig,
    runtimeConfig,
    resolvedRuntimeConfig,
    activeRouteModelCapabilities,
    routeStatusMessage,
    activeRouteProvider,
    handleClear,
    providerDiagnosticsRef,
    repaintCommittedTheme,
    refreshAuthStatus,
    openProviderPicker,
    setVerboseMode,
    verboseMode,
    handlePasteImage,
    refreshModelCapabilities,
    updateCheckResult,
    requestUpdateCheck,
    globalPackageManager,
    uiState,
    startPromptRun,
    allowedWritableRoots,
    planMode,
    mode,
    setPlanFlow,
    runPlanGeneration,
    focusManager,
    handlePlanFeedbackSubmit,
    inputValue,
  });

  const modelDisplayName = activeRuntimeDisplay.modelDisplay;
  const activeConversationId = activeConversationRef.current?.metadata.id ?? null;
  const currentCheckpointStore = useMemo(
    () => (activeConversationId ? new CheckpointStore(workspaceRoot, activeConversationId) : null),
    [activeConversationId, workspaceRoot],
  );
  const recoveryCheckpoints = checkpointsRef.current.length
    ? checkpointsRef.current
    : (activeConversationRef.current?.messages ?? []).flatMap((message, index): FileCheckpoint[] =>
        message.role === "user"
          ? [
              {
                id: `legacy-${index}`,
                turnId: message.turnId ?? index,
                messageCount: index,
                prompt: message.submittedContent ?? message.content,
                before: { files: {}, complete: false, skipped: [] },
              },
            ]
          : [],
      );
  const composerReasoningLevel = "";
  const headerRuntimeSummary = useMemo(
    () => runtimeDisplayToSummary(activeRuntimeDisplay, runtimeSummary),
    [activeRuntimeDisplay, runtimeSummary],
  );
  const effectiveHeaderConfig = useMemo<HeaderConfig>(
    () => ({
      ...headerConfig,
      showProvider: true,
      showModel: false,
      showReasoning: false,
      showContext: false,
    }),
    [headerConfig],
  );
  const { composerElement } = useAppComposer({
    ...appState,
    ...runLifecycle,
    ...workbenchActions,
    ...promptExecution,
    ...overlayRouting,
    ...modelSelection,
    planFlow,
    handlePlanAction,
    initialRevisionText,
    setInitialRevisionText,
    handlePlanFeedbackSubmit,
    setPlanFlow,
    composerWidth,
    uiState,
    mode,
    modelDisplayName,
    activeRuntimeDisplay,
    activeThemeName,
    composerReasoningLevel,
    planMode,
    currentModelSpec,
    inputValue,
    cursor,
    handleChangeInput,
    handleRegisterPaste,
    handlePasteImage,
    handleSubmit,
    openProviderPicker,
    activeProviderRoute,
  });

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <ThemeProvider theme={activeThemeName} customTheme={customTheme}>
      {shouldMountTranscript && (
        <TranscriptShell
          layout={terminalLayout}
          authState={authStatus.state}
          workspaceLabel={workspaceLabel}
          workspaceRoot={workspaceRoot}
          runtimeSummary={headerRuntimeSummary}
          staticEvents={staticEvents}
          activeEvents={activeEvents}
          uiState={uiState}
          verboseMode={verboseMode}
          clearCount={sessionState.clearCount}
          repaintGeneration={staticRepaintGeneration}
          notice={themeNotice}
          composer={composerElement}
          composerRows={composerRows}
          visible={screen === "main"}
        />
      )}

      {screen !== "main" && (
        <AppShell
          layout={terminalLayout}
          screen={screen}
          authState={authStatus.state}
          workspaceLabel={workspaceLabel}
          workspaceRoot={workspaceRoot}
          runtimeSummary={headerRuntimeSummary}
          staticEvents={staticEvents}
          activeEvents={activeEvents}
          uiState={uiState}
          verboseMode={verboseMode}
          clearCount={sessionState.clearCount}
          headerConfig={effectiveHeaderConfig}
          updateAvailable={
            screen !== "update-prompt" &&
            updateCheckResult?.status === "update-available" &&
            updateCheckResult.latestVersion
              ? {
                  latestVersion: updateCheckResult.latestVersion,
                  currentVersion: updateCheckResult.currentVersion,
                  updateCommand: getUpdateCommand(globalPackageManager).displayCommand,
                }
              : null
          }
          panel={
            <OverlayPanels
              screen={screen}
              workbenchView={workbenchView}
              staticEvents={staticEvents}
              activeEvents={activeEvents}
              promptQueue={promptQueue}
              recoveryCheckpoints={recoveryCheckpoints}
              restoredFileBoundaryRef={restoredFileBoundaryRef}
              currentCheckpointStore={currentCheckpointStore}
              handleQueueAction={handleQueueAction}
              handleRewind={handleRewind}
              setScreen={setScreen}
              resumeConversations={resumeConversations}
              resumeConversation={resumeConversation}
              loadResumeSessions={loadResumeSessions}
              selectResumeSession={selectResumeSession}
              openExternalSession={openExternalSession}
              resumeExternalSessionNative={resumeExternalSessionNative}
              continueExternalSession={continueExternalSession}
              resumePickerPositionRef={resumePickerPositionRef}
              rememberResumePickerPosition={rememberResumePickerPosition}
              savedViewerSession={savedViewerSession}
              returnToResumePicker={returnToResumePicker}
              locateSavedWorkspace={locateSavedWorkspace}
              externalViewerSession={externalViewerSession}
              loadExternalTranscript={loadExternalTranscript}
              providerSetup={providerSetup}
              providerRegistry={providerRegistry}
              runProviderSetup={runProviderSetup}
              setProviderSetup={setProviderSetup}
              terminalLayout={terminalLayout}
              handleProviderAction={handleProviderAction}
              providerWorkspaceConfig={providerWorkspaceConfig}
              setProviderWorkspaceConfig={appState.setProviderWorkspaceConfig}
              localBackendStatuses={localBackendStatuses}
              probeLocalBackends={probeLocalBackends}
              modelPickerOpenRef={modelPickerOpenRef}
              setPendingRouteProviderId={setPendingRouteProviderId}
              pendingRouteProviderId={pendingRouteProviderId}
              modelPickerModels={modelPickerModels}
              modelPickerCurrentModel={modelPickerCurrentModel}
              modelPickerCurrentReasoning={modelPickerCurrentReasoning}
              modelPickerProviderLabel={modelPickerProviderLabel}
              modelPickerProviderId={modelPickerProviderId}
              modelCapabilitiesBusy={modelCapabilitiesBusy}
              providerModelLoading={providerModelLoading}
              routeSwitchBusy={routeSwitchBusy}
              modelPickerEmptyMessage={modelPickerEmptyMessage}
              activeProviderRoute={activeProviderRoute}
              persistProviderDefaultModelAndReasoning={persistProviderDefaultModelAndReasoning}
              appendEvent={appendEvent}
              setModelAndReasoningWithNotice={setModelAndReasoningWithNotice}
              returnToChatMode={returnToChatMode}
              mode={mode}
              planMode={planMode}
              setPlanModeWithNotice={setPlanModeWithNotice}
              setModeWithNotice={setModeWithNotice}
              reasoningLevel={reasoningLevel}
              currentReasoningCapabilities={currentReasoningCapabilities}
              currentModelCapability={currentModelCapability}
              currentReasoningSourceLabel={currentReasoningSourceLabel}
              setReasoningWithNotice={setReasoningWithNotice}
              provider={provider}
              authPreference={authPreference}
              authStatus={authStatus}
              authStatusBusy={authStatusBusy}
              setAuthPreferenceWithNotice={setAuthPreferenceWithNotice}
              refreshAuthStatus={refreshAuthStatus}
              runtimeConfig={runtimeConfig}
              resolvedRuntimeConfig={resolvedRuntimeConfig}
              handlePermissionsPanelAction={handlePermissionsPanelAction}
              setApprovalPolicyWithNotice={setApprovalPolicyWithNotice}
              setSandboxModeWithNotice={setSandboxModeWithNotice}
              setNetworkAccessWithNotice={setNetworkAccessWithNotice}
              addWritableRootWithNotice={addWritableRootWithNotice}
              removeWritableRootWithNotice={removeWritableRootWithNotice}
              themeSelection={themeSelection}
              themePreviewTimerRef={themePreviewTimerRef}
              repaintCommittedTheme={repaintCommittedTheme}
              customTheme={customTheme}
              setCustomTheme={setCustomTheme}
              setThemeSelection={setThemeSelection}
              currentUserSettings={currentUserSettings}
              saveSettingsFromPanel={saveSettingsFromPanel}
              pendingImport={pendingImport}
              workspaceRoot={workspaceRoot}
              activeRouteProvider={activeRouteProvider}
              handleImportConfirm={handleImportConfirm}
              handleImportCancel={handleImportCancel}
              toolApproval={toolApproval}
              toolApprovalResolverRef={toolApprovalResolverRef}
              setToolApproval={setToolApproval}
              handleCancel={handleCancel}
              updateCheckResult={updateCheckResult}
              globalPackageManager={globalPackageManager}
              handleSkipUpdateForSession={handleSkipUpdateForSession}
              exit={exit}
              activeTheme={activeTheme}
              usageView={providerUsage.usageView}
              usageRefreshAvailableAt={providerUsage.usageRefreshAvailableAt}
              refreshUsage={providerUsage.refreshUsage}
            />
          }
          mainPanel={null}
          mainPanelMode="viewport"
          composer={composerElement}
          composerRows={composerRows}
          panelHint={null}
        />
      )}
    </ThemeProvider>
  );
}
