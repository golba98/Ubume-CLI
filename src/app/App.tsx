import type { PreparedStaticFrame } from "../core/terminal/preparedStaticFrame.js";
import { startupHeaderUsage } from "../ui/render/startupHeaderUsage.js";
/**
 * The interactive app's root component.
 *
 * App composes the hooks under `src/app/` and renders two roots:
 * `TranscriptShell` for the main chat and `AppShell` (with `OverlayPanels`)
 * for overlays. It owns very little logic itself; read
 * docs/architecture/app.md for the full map.
 *
 * Invariants (do not "simplify" these away):
 * - Hook call order is significant. Effects run in declaration order, and
 *   several hooks were split out of larger ones at exactly their original
 *   positions to keep that order. Move a hook only if you have checked the
 *   effects it contains and the ones around it.
 * - The terminal and clear-frame wiring stays inline here: creating and
 *   disposing the clear-frame boundary controller, syncing it with session
 *   state, the alternate-screen fallback, and `armTranscriptReplacement`.
 *   The frame write that owns screen transitions happens before effects run.
 * - Render-time ref assignments (`snapshotRef`, `inputValueRef`, `busyRef`, …)
 *   stay in render, never in effects, so async callbacks and the frame writer
 *   see the values of the render being committed.
 * - `OverlayPanels` is not memoized; `AppShell` is, with a custom comparator,
 *   so avoid adding props to it that change during streaming.
 */

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
import { buildRuntimeSummary, resolveRuntimeConfig } from "../config/runtimeConfig.js";
import {
  estimateTokens,
  formatBusyLoaderSettingValue,
  formatWorkspaceDisplayPath,
  type HeaderConfig,
  type UserSettingValues,
} from "../config/settings.js";
import type { CodexModelCapabilities } from "../core/models/codexModelCapabilities.js";
import * as renderDebug from "../core/perf/renderDebug.js";
import type { LocalBackendId, ProviderId } from "../core/providerLauncher/types.js";
import { isLocalRuntime } from "../core/providerRuntime/deployment.js";
import type { checkLocalProvider } from "../core/providerRuntime/local.js";
import { createRoutedProvider } from "../core/providerRuntime/registry.js";
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
import { CheckpointStore } from "../core/workspace/checkpoints.js";
import { createEventId } from "../session/eventIds.js";
import { createInitialPlanFlowState, type PlanFlowState } from "../session/planFlow.js";
import type { Screen, TimelineEvent } from "../session/types.js";
import { isBusy as isUiBusy } from "../session/types.js";
import type { WorkbenchSnapshot } from "../session/workbench.js";
import { AppShell } from "../ui/chrome/AppShell.js";
import { measureBottomComposerRows } from "../ui/chrome/composer/composerModel.js";
import { FOCUS_IDS } from "../ui/input/focus.js";

import { useStdinRawModeLease } from "../ui/input/useStdinRawModeLease.js";
import { getContentWidth, resolveStartupHeaderMode } from "../ui/layout.js";
import { measurePlanActionPickerRows } from "../ui/panels/PlanActionPicker.js";
import { measureTextEntryPanelRows } from "../ui/panels/TextEntryPanel.js";
import { buildActiveRuntimeDisplay, runtimeDisplayToSummary } from "../ui/render/runtimeDisplay.js";
import { getDisplayedThemeName, THEMES, ThemeProvider } from "../ui/theme.js";
import { isTranscriptEvent, TranscriptShell } from "../ui/timeline/TranscriptShell.js";
import { rewindCheckpoints } from "./conversation/conversationMetadata.js";
import { useClearConversation } from "./conversation/useClearConversation.js";
import { useConversation } from "./conversation/useConversation.js";
import { useAppComposer } from "./input/useAppComposer.js";
import { useAppInput } from "./input/useAppInput.js";
import { useComposerEditing } from "./input/useComposerEditing.js";
import { useWorkbenchActions } from "./input/useWorkbenchActions.js";
import { useAppDebugTracing } from "./lifecycle/useAppDebugTracing.js";
import { useAppLifecycleEffects } from "./lifecycle/useAppLifecycleEffects.js";
import { useFocusRouting } from "./lifecycle/useFocusRouting.js";
import { useTerminalUiState } from "./lifecycle/useTerminalUiState.js";
import { useUpdateCheck } from "./lifecycle/useUpdateCheck.js";
import { useActiveModelMetadata } from "./models/useActiveModelMetadata.js";
import { useModelCatalog } from "./models/useModelCatalog.js";
import { useModelPickerModel } from "./models/useModelPickerModel.js";
import { useModelSelection } from "./models/useModelSelection.js";
import { useOpenAiModelReconcile } from "./models/useOpenAiModelReconcile.js";
import { OverlayPanels } from "./overlays/OverlayPanels.js";
import { useOverlayRouting } from "./overlays/useOverlayRouting.js";
import { useRouteStatus } from "./providers/routeStatus.js";
import { useActiveProviderRoute } from "./providers/useActiveProviderRoute.js";
import { useProviderRoute } from "./providers/useProviderRoute.js";
import { useProviderUsage } from "./providers/useProviderUsage.js";
import { usePlanFlow } from "./run/usePlanFlow.js";
import { usePromptExecution } from "./run/usePromptExecution.js";
import { usePromptRun } from "./run/usePromptRun.js";
import { useRunLifecycle } from "./run/useRunLifecycle.js";
import { useRuntimeSettings } from "./settings/useRuntimeSettings.js";
import { useSettings } from "./settings/useSettings.js";
import { useStartupLogoCommit } from "./settings/useStartupLogoCommit.js";
import { useThemeCommit } from "./settings/useThemeCommit.js";
import { useAppState } from "./state/useAppState.js";

interface AppProps {
  launchArgs: LaunchArgs;
  /** Embedded/testing runtime; never exposed as a CLI flag. */
  providerOverride?: BackendProvider;
}

export function App({ launchArgs, providerOverride }: AppProps) {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
  const focusManager = useFocusManager();
  // ─── Startup state ───────────────────────────────────────────────────────────

  const appState = useAppState({ providerOverride, launchArgs });
  const selectionVersion = useSyncExternalStore(
    appState.selectionCoordinator.subscribe,
    appState.selectionCoordinator.getSnapshot,
  );
  const {
    workspaceRoot,
    initialUpdateCheckResult,
    initialProviderWorkspaceConfig,
    terminalLayout,
    terminalLayoutColsRef,
    terminalLayoutRowsRef,
    staticRepaintGeneration,
    bumpStaticRepaintGeneration,
    staticRepaintGenerationRef,
    baseLayeredConfig,
    sessionRuntimeOverride,
    authPreference,
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader,
    startupLogoStyle,
    startupAnimation,
    setStartupAnimation,
    startupHeaderMiddleLine,
    setStartupHeaderMiddleLine,
    startupLogoRendering,
    setStartupLogoRendering,
    providerWorkspaceConfig,
    localBackendStatuses,
    pendingRouteProviderId,
    setPendingRouteProviderId,
    providerSetup,
    setProviderSetup,
    themeSelection,
    setThemeSelection,
    themeNotice,
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
    snapshotRef,
    clearEpochRef,
    interruptHint,
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
    providerModelLoading,
    activeContextMetadata,
  } = appState;
  // ─── Terminal and clear-frame wiring (must stay inline) ─────────────────────

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
  const preparedStaticFrameRef = useRef<PreparedStaticFrame | null>(null);
  const reportPreparedStaticFrame = useCallback((frame: PreparedStaticFrame | null) => {
    preparedStaticFrameRef.current = frame;
  }, []);
  const historyReflowPendingRef = useRef(false);
  const reportHistoryReflow = useCallback((pending: boolean) => {
    historyReflowPendingRef.current = pending;
  }, []);
  const liveStartupHeaderRef = useRef(false);
  const responsiveStartupHeaderRef = useRef(false);
  const reportStartupLive = useCallback((live: boolean, responsive = live) => {
    liveStartupHeaderRef.current = live;
    responsiveStartupHeaderRef.current = responsive;
  }, []);
  const clearFrameBoundaryController = useMemo(
    () =>
      createClearFrameBoundaryController({
        instance: inkInstance,
        terminalControl,
        stdout,
        source: "src/app/App.tsx:clearBoundary",
        staticGenerationFollowsWidth: true,
        getPreparedStaticFrame: () => preparedStaticFrameRef.current,
        isHistoryReflowPending: () => historyReflowPendingRef.current,
        onWidthResizeRefresh: () => bumpStaticRepaintGeneration((tick) => tick + 1),
        getRenderedRepaintGeneration: () => staticRepaintGenerationRef.current,
        getRenderedLayoutCols: () => terminalLayoutColsRef.current,
        getRenderedLayoutRows: () => terminalLayoutRowsRef.current,
        // Read at frame-write time; screenRef is assigned during render, so it
        // always reflects the render that produced the frame being written.
        isOverlayActive: () => screenRef.current !== "main",
        hasLiveStartupHeader: () => liveStartupHeaderRef.current,
        hasResponsiveStartupHeader: () => responsiveStartupHeaderRef.current,
      }),
    [inkInstance, stdout, terminalControl],
  );
  const [verboseMode, setVerboseMode] = useState(false);
  const [planFlow, setPlanFlow] = useState<PlanFlowState>(createInitialPlanFlowState);
  // Which screen the theme picker returns to when it closes: the preferences
  // panel sets this to itself, every other opener resets it to `main`.
  const [themePickerReturnScreen, setThemePickerReturnScreen] = useState<Screen>("main");

  // The workbench snapshot saved with the active conversation. Defined as a
  // named builder, then assigned during render (never in an effect) so save
  // paths always serialize the state of the render being committed.
  const buildWorkbenchSnapshot = (): WorkbenchSnapshot => {
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
  snapshotRef.current = buildWorkbenchSnapshot;

  const [initialRevisionText, setInitialRevisionText] = useState("");
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(
    initialUpdateCheckResult.current,
  );
  // Launcher path is fixed for the process lifetime, so detect once.
  const globalPackageManager = useMemo(() => detectGlobalPackageManager(), []);
  const overlayMode = screen !== "main";

  useEffect(() => {
    return () => {
      clearFrameBoundaryController?.dispose();
    };
  }, [clearFrameBoundaryController]);

  // ─── Appearance home repaint ─────────────────────────────────────────────────
  // Normal's historical static banner needs the existing atomic home repaint.
  // Compact branding stays live on home and recolors without remounting input.
  // Switching between Normal and compact styles still needs a static reset.
  // Requests wait for overlays to close; conversation history stays untouched.
  const [homeRepaintTick, setHomeRepaintTick] = useState(0);
  const lastRepaintStyleRef = useRef(startupLogoStyle);
  const handledHomeRepaintTickRef = useRef(0);
  const requestHomeRepaint = useCallback(() => {
    setHomeRepaintTick((tick) => tick + 1);
  }, []);
  useEffect(() => {
    if (homeRepaintTick === handledHomeRepaintTickRef.current) return;
    if (screen !== "main") return;
    handledHomeRepaintTickRef.current = homeRepaintTick;
    const previousStyle = lastRepaintStyleRef.current;
    lastRepaintStyleRef.current = startupLogoStyle;
    // Compact home branding already reads the live theme. Repainting it would
    // unnecessarily remount the composer and interrupt input readiness.
    if (previousStyle !== "normal" && startupLogoStyle !== "normal") return;
    if (previousStyle !== startupLogoStyle) {
      if (
        sessionState.staticEvents.some(isTranscriptEvent) ||
        sessionState.activeEvents.some(isTranscriptEvent)
      )
        return;
    } else if (sessionState.staticEvents.length > 0 || sessionState.activeEvents.length > 0) return;
    if (!clearFrameBoundaryController?.requestHomeRepaint("appearanceChange")) return;
    // The boundary acts on incoming frames; force one so the armed repaint
    // begins immediately instead of waiting for an incidental re-render.
    bumpPostClearRepaint((tick) => tick + 1);
  }, [
    bumpPostClearRepaint,
    clearFrameBoundaryController,
    homeRepaintTick,
    screen,
    sessionState.activeEvents.length,
    sessionState.staticEvents.length,
    startupLogoStyle,
  ]);

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
  }, [terminalControl]);

  // ─── App-local refs ─────────────────────────────────────────────────────────
  // Shared by several hooks below; refs because async work reads and writes
  // them without needing a render.

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
  // ─── Runtime config, provider route and model metadata ───────────────────────

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
  const {
    activeProviderRoute,
    activeProviderRuntime,
    providerRegistry,
    workspaceDefaultProvider,
    markProviderAvailability,
    activeRouteProvider,
  } = useActiveProviderRoute({
    ...appState,
    launchArgs,
    selectionVersion,
    model,
    reasoningLevel,
    providerDiagnosticsRef,
    providerRouteErrorsRef,
  });
  const {
    activeRouteModelCapabilities,
    currentModelCapability,
    currentReasoningCapabilities,
    currentReasoningSourceLabel,
  } = useActiveModelMetadata({
    ...appState,
    activeProviderRoute,
    modelCapabilities,
    providerDiagnosticsRef,
  });
  const {
    modelPickerProviderId,
    modelPickerModels,
    modelPickerCurrentModel,
    modelPickerCurrentReasoning,
    modelPickerProviderLabel,
    modelPickerEmptyMessage,
  } = useModelPickerModel({
    ...appState,
    activeProviderRoute,
    modelCapabilities,
    providerRegistry,
    model,
    reasoningLevel,
    selectionVersion,
  });
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

  // ─── Presentation values ─────────────────────────────────────────────────────

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

  // ─── Composer state, busy focus and layout ─────────────────────────────────────

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
      permissionPending: toolApproval !== null,
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
    toolApproval,
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
  useTerminalUiState(uiState.kind, busy);
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

  // ─── Provider client, lifecycle effects and focus ──────────────────────────────

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
  useAppLifecycleEffects({
    ...appState,
    baseRuntimeConfigRef,
    providerOverride,
    themePreviewTimerRef,
    themeNoticeTimerRef,
  });
  const { getInputDebugSnapshot, returnToChatMode, returnFromUpdateOverlay } = useFocusRouting({
    ...appState,
    busyRef,
    modelCapabilitiesBusyRef,
    intendedInputModeRef,
    modelSelectionInFlightRef,
    intendedFocusTargetRef,
    stdin,
    themePreviewTimerRef,
    previousScreenRef,
    focusManager,
    planFlow,
    modelPickerOpenRef,
  });

  // ─── Transcript events and the clear-frame boundary arming ─────────────────────

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

  // ─── Feature hooks ─────────────────────────────────────────────────────────────
  // Conversation → settings and models → providers and overlays → runs →
  // input. Later hooks consume earlier hooks' callbacks.

  const conversation = useConversation({
    modelSelectionInFlightRef,
    modelPickerOpenRef,
    waitUntilRenderFlush,
    suspendTerminal: async (callback) => {
      let result!: Awaited<ReturnType<typeof callback>>;
      await suspendTerminal(async () => {
        result = await callback();
      });
      return result;
    },
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
    resumeLoading,
    cancelResume,
    relocationTarget,
    relocationError,
    cancelRelocation,
  } = conversation;

  const runtimeSettings = useRuntimeSettings({
    ...appState,
    launchArgs,
    baseRuntimeConfigRef,
    appendEvent,
  });
  const { updateRuntimeConfig } = runtimeSettings;
  const { routeChoiceRequiredRef } = appState;
  const { refreshModelCapabilities, ensureProviderModels, refreshAuthStatus } = useModelCatalog({
    runtimeConfig,
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
  });

  const { repaintCommittedTheme } = useThemeCommit({
    ...appState,
    themeNoticeTimerRef,
    requestHomeRepaint,
  });

  const { commitStartupLogoStyle } = useStartupLogoCommit({
    ...appState,
    themeNoticeTimerRef,
    requestHomeRepaint,
  });

  // Mirror session values into refs read by async callbacks. The clear epoch
  // lets late command results from before a /clear be ignored.
  useEffect(() => {
    clearEpochRef.current = sessionState.clearEpoch;
  }, [sessionState.clearEpoch]);

  useEffect(() => {
    externalCliStatusRef.current = sessionState.externalCliStatus;
  }, [sessionState.externalCliStatus]);

  useOpenAiModelReconcile({
    providerOverride,
    preserveSavedRouteRef,
    routeChoiceRequiredRef,
    activeProviderRoute,
    modelCapabilities,
    model,
    reasoningLevel,
    appendEvent,
    updateRuntimeConfig,
  });

  const modelSelection = useModelSelection({
    ...runtimeSettings,
    ...appState,
    appendEvent,
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
      busyRef,
      externalCliLaunchHooks,
      updateProviderWorkspaceConfig: runtimeSettings.updateProviderWorkspaceConfig,
    });

  const overlayRouting = useOverlayRouting({
    ...appState,
    ...settings,
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
    setThemePickerReturnScreen,
  });
  const { handlePermissionsPanelAction } = overlayRouting;

  const runLifecycle = useRunLifecycle({
    ...appState,
    ...conversation,
    intendedFocusTargetRef,
    focusManager,
    activeEvents,
    uiState,
    busy,
    planFlow,
    setPlanFlow,
    appendEvent,
    exit,
    staticEvents,
  });

  const {
    handleChangeInput,
    handleRegisterPaste,
    handlePasteImage,
    handleHistoryUp,
    handleHistoryDown,
  } = useComposerEditing({
    ...appState,
    busyRef,
    runtimeConfig,
    inputValueRef,
    cursorRef,
    appendEvent,
  });

  const { handleClear } = useClearConversation({
    appendEvent,
    ...appState,
    ...conversation,
    ...runLifecycle,
    armTranscriptReplacement,
    setPlanFlow,
  });

  const promptExecution = usePromptExecution({
    ...appState,
    allowedWritableRoots,
    appendEvent,
    focusManager,
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

  const startupUsageLabel = startupHeaderUsage(
    estimateTokens(conversationChars),
    currentModelSpec,
    providerUsage.usageView,
    providerUsage.usageScopeKey,
    activeProviderRoute.providerId,
  );

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
    staticEvents,
    activeEvents,
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
  });

  // ─── Render inputs ─────────────────────────────────────────────────────────────

  const modelDisplayName = activeRuntimeDisplay.modelDisplay;
  const activeConversationId = activeConversationRef.current?.metadata.id ?? null;
  const currentCheckpointStore = useMemo(
    () => (activeConversationId ? new CheckpointStore(workspaceRoot, activeConversationId) : null),
    [activeConversationId, workspaceRoot],
  );
  const recoveryCheckpoints = rewindCheckpoints(
    checkpointsRef.current,
    activeConversationRef.current?.messages ?? [],
  );
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
    handleHistoryUp,
    handleHistoryDown,
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

  // The update prompt shows its own notice, so the header card is hidden there.
  const headerUpdateNotice =
    screen !== "update-prompt" &&
    updateCheckResult?.status === "update-available" &&
    updateCheckResult.latestVersion
      ? {
          latestVersion: updateCheckResult.latestVersion,
          currentVersion: updateCheckResult.currentVersion,
          updateCommand: getUpdateCommand(globalPackageManager).displayCommand,
        }
      : null;

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
          logoStyle={startupLogoStyle}
          onStartupLiveChange={reportStartupLive}
          startupAnimation={startupAnimation}
          startupHeaderMiddleLine={startupHeaderMiddleLine}
          startupLogoRendering={startupLogoRendering}
          startupModelLabel={activeRuntimeDisplay.modelOnlyDisplay}
          startupUsageLabel={startupUsageLabel}
          staticEvents={staticEvents}
          activeEvents={activeEvents}
          uiState={uiState}
          verboseMode={verboseMode}
          clearCount={sessionState.clearCount}
          repaintGeneration={staticRepaintGeneration}
          onHistoryReflowChange={reportHistoryReflow}
          onPreparedStaticFrame={reportPreparedStaticFrame}
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
          updateAvailable={headerUpdateNotice}
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
              resumeLoading={resumeLoading}
              cancelResume={cancelResume}
              relocationTarget={relocationTarget}
              relocationError={relocationError}
              cancelRelocation={cancelRelocation}
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
              updateProviderWorkspaceConfig={runtimeSettings.updateProviderWorkspaceConfig}
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
              modelPickerEmptyMessage={modelPickerEmptyMessage}
              activeProviderRoute={activeProviderRoute}
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
              startupLogoStyle={startupLogoStyle}
              commitStartupLogoStyle={commitStartupLogoStyle}
              startupAnimation={startupAnimation}
              setStartupAnimation={setStartupAnimation}
              startupHeaderMiddleLine={startupHeaderMiddleLine}
              setStartupHeaderMiddleLine={setStartupHeaderMiddleLine}
              startupLogoRendering={startupLogoRendering}
              startupPreviewProvider={headerRuntimeSummary.providerLabel}
              startupPreviewModel={activeRuntimeDisplay.modelOnlyDisplay}
              startupPreviewUsage={startupUsageLabel}
              setStartupLogoRendering={setStartupLogoRendering}
              themePickerReturnScreen={themePickerReturnScreen}
              setThemePickerReturnScreen={setThemePickerReturnScreen}
              pendingImport={pendingImport}
              workspaceRoot={workspaceRoot}
              activeRouteProvider={activeRouteProvider}
              handleImportConfirm={handleImportConfirm}
              handleImportCancel={handleImportCancel}
              toolApproval={toolApproval}
              toolApprovalResolverRef={toolApprovalResolverRef}
              setToolApproval={setToolApproval}
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
