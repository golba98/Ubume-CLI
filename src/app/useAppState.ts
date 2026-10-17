import { useMemo, useRef, useState } from "react";
import type { LaunchArgs } from "../config/launchArgs.js";
import { type LayeredConfigResult, resolveLayeredConfig } from "../config/layeredConfig.js";
import { DEFAULT_UPDATE_CHECK_SETTINGS, loadSettings } from "../config/persistence.js";
import type { PartialRuntimeConfig } from "../config/runtimeConfig.js";
import {
  APP_VERSION,
  type AuthPreference,
  type TerminalTitleMode,
  type WorkspaceDisplayMode,
} from "../config/settings.js";
import type { CodexAuthProbeResult } from "../core/codex/codexAuth.js";
import type { ExternalSessionSummary } from "../core/externalSessions/index.js";
import type { CodexModelCapabilities } from "../core/models/codexModelCapabilities.js";
import { loadSeededCodexCapabilities } from "../core/models/modelCache.js";
import { SelectionCoordinator } from "../core/models/selectionCoordinator.js";

import type {
  LocalBackendId,
  ProviderId,
  ProviderPickerAction,
  ProviderWorkspaceConfig,
} from "../core/providerLauncher/types.js";
import { loadProviderWorkspaceConfig } from "../core/providerLauncher/workspaceConfig.js";
import type { ModelContextMetadata } from "../core/providerRuntime/contextMetadata.js";

import { isProviderRoutableInUbume } from "../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../core/providerRuntime/types.js";

import type {
  BackendProvider,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../core/providers/types.js";

import {
  isCacheForRunningVersion,
  loadUpdateCheckCache,
  shouldRunStartupUpdateCheck,
  type UpdateCheckResult,
} from "../core/version/updateCheck.js";
import type { FileBoundary, FileCheckpoint } from "../core/workspace/checkpoints.js";
import {
  type ConversationListEntry,
  type ConversationRecord,
  ConversationStore,
} from "../core/workspace/conversationStore.js";
import {
  buildWorkspaceCommandContext,
  resolveLaunchContext,
} from "../core/workspace/launchContext.js";
import type { OwnershipLease } from "../core/workspace/ownership.js";
import { loadProjectInstructions } from "../core/workspace/projectInstructions.js";
import { resolveWorkspaceRoot } from "../core/workspace/workspaceRoot.js";
import { useAppSessionState } from "../session/appSession.js";
import { createInitialAuthStatus, createStartupStaticEvents } from "../session/eventIds.js";

import type { SessionCatalogResult, SessionSummary } from "../session/sessionCatalog.js";
import type { Screen } from "../session/types.js";

import { type FileAttachment, PromptQueue } from "../session/workbench.js";

import type { InterruptHint } from "../ui/chrome/composer/composerModel.js";
import type { ImageAttachmentRegistry, PastedContentRegistry } from "../ui/input/pastedContent.js";

import { useTerminalViewport } from "../ui/layout.js";
import type { PendingImportFile } from "../ui/panels/AttachmentImportPanel.js";

import type { LocalBackendStatus } from "../ui/panels/ProviderPicker.js";
import type { ExternalListScope, ResumePickerPosition } from "../ui/panels/resumePickerRows.js";

import type { WorkbenchView } from "../ui/panels/WorkbenchPanel.js";

import type { ThemeSelectionState } from "../ui/theme.js";

import { useRunRefs } from "./useRunRefs.js";

interface UseAppStateContext {
  providerOverride: BackendProvider | undefined;
  launchArgs: LaunchArgs;
}

export function useAppState(context: UseAppStateContext) {
  const [selectionCoordinator] = useState(() => new SelectionCoordinator());
  const { providerOverride, launchArgs } = context;

  const workspaceRoot = useMemo(() => resolveWorkspaceRoot(), []);
  const projectInstructionsLoad = useMemo(
    () => loadProjectInstructions(workspaceRoot),
    [workspaceRoot],
  );
  const projectInstructions =
    projectInstructionsLoad.status === "loaded" ? projectInstructionsLoad.instructions : null;
  const initialSettings = useRef(loadSettings());
  const startupUpdateEnabled = useRef(
    shouldRunStartupUpdateCheck(
      process.env,
      !providerOverride &&
        (initialSettings.current.updateCheck ?? DEFAULT_UPDATE_CHECK_SETTINGS).enabled,
    ),
  );
  const initialUpdateCheckResult = useRef<UpdateCheckResult | null>(
    (() => {
      if (!startupUpdateEnabled.current) return null;
      const cache = loadUpdateCheckCache();
      if (
        !cache?.updateAvailable ||
        !cache.latestVersion ||
        !isCacheForRunningVersion(cache, APP_VERSION)
      ) {
        return null;
      }
      return {
        status: "update-available",
        currentVersion: cache.currentVersion,
        latestVersion: cache.latestVersion,
        checkedAt: cache.lastChecked,
        source: "cache",
      };
    })(),
  );
  const initialProviderWorkspaceConfig = useRef<ProviderWorkspaceConfig>(
    loadProviderWorkspaceConfig(workspaceRoot),
  );
  const initialLayeredConfig = useRef<LayeredConfigResult | null>(null);
  if (initialLayeredConfig.current === null) {
    initialLayeredConfig.current = resolveLayeredConfig({ workspaceRoot, launchArgs });
  }
  const launchContext = useMemo(
    () => resolveLaunchContext({ workspaceRoot, forwardArgs: launchArgs.passthroughArgs }),
    [launchArgs.passthroughArgs, workspaceRoot],
  );
  const workspaceCommandContext = useMemo(
    () => buildWorkspaceCommandContext(launchContext),
    [launchContext],
  );
  const terminalLayout = useTerminalViewport();
  // Assigned during render (like screenRef) so the clear-frame boundary can
  // tell, at frame-write time, whether the committing tree was laid out
  // against the current terminal width (the viewport hook commits dimensions
  // on a trailing settle, so frames can lag stdout.columns).
  const terminalLayoutColsRef = useRef<number | undefined>(
    terminalLayout.rawCols ?? terminalLayout.cols,
  );
  terminalLayoutColsRef.current = terminalLayout.rawCols ?? terminalLayout.cols;
  const [staticRepaintGeneration, bumpStaticRepaintGeneration] = useState(0);
  const staticRepaintGenerationRef = useRef(0);
  staticRepaintGenerationRef.current = staticRepaintGeneration;

  // ─── State & Refs ────────────────────────────────────────────────────────────

  const [baseLayeredConfig, setBaseLayeredConfig] = useState<LayeredConfigResult>(
    initialLayeredConfig.current,
  );
  const [sessionRuntimeOverride, setSessionRuntimeOverride] = useState<PartialRuntimeConfig>(() => {
    const initialRoute = initialProviderWorkspaceConfig.current.activeRoute;
    if (!initialRoute || !isProviderRoutableInUbume(initialRoute.providerId)) {
      return {};
    }

    // When --model was given on the CLI, that arg must win over the persisted activeRoute
    // model so that explicit test/benchmark model flags are actually honoured for the session.
    const cliModel = launchArgs.modelOverride;
    return {
      model: cliModel ?? initialRoute.modelId,
      ...(initialRoute.reasoning ? { reasoningLevel: initialRoute.reasoning } : {}),
    };
  });
  const [authPreference, setAuthPreference] = useState<AuthPreference>(
    initialSettings.current.auth.preference,
  );
  const [workspaceDisplayMode, setWorkspaceDisplayMode] = useState<WorkspaceDisplayMode>(
    initialSettings.current.ui.workspaceDisplayMode,
  );
  const [terminalTitleMode, setTerminalTitleMode] = useState<TerminalTitleMode>(
    initialSettings.current.ui.terminalTitleMode,
  );
  const [showBusyLoader, setShowBusyLoader] = useState(initialSettings.current.ui.showBusyLoader);
  const [providerWorkspaceConfig, setProviderWorkspaceConfig] = useState<ProviderWorkspaceConfig>(
    initialProviderWorkspaceConfig.current,
  );
  const [localBackendStatuses, setLocalBackendStatuses] = useState<
    Record<LocalBackendId, LocalBackendStatus>
  >({
    "lm-studio": { state: "idle", label: "Not checked" },
    unsloth: { state: "idle", label: "Not checked" },
  });
  const [pendingRouteProviderId, setPendingRouteProviderId] = useState<ProviderId | null>(null);
  const [providerSetup, setProviderSetup] = useState<ProviderId | null>(null);
  const providerLaunchBypassRef = useRef(false);
  const providerActionRef = useRef<
    | ((
        providerId: ProviderId,
        action: ProviderPickerAction,
        localBackend?: LocalBackendId,
      ) => void)
    | null
  >(null);
  const [themeSelection, setThemeSelection] = useState<ThemeSelectionState>({
    committedTheme: initialSettings.current.ui.theme,
    previewTheme: null,
  });
  const [themeNotice, setThemeNotice] = useState<string | null>(null);
  const [customTheme, setCustomTheme] = useState(initialSettings.current.ui.customTheme);
  const [headerConfig] = useState(initialSettings.current.header);
  // Hold the first interactive frame behind the update check. A cached update
  // opens immediately; an uncached launch shows a short checking panel instead
  // of allowing input and interrupting the user a moment later.
  const [screen, setScreen] = useState<Screen>(
    startupUpdateEnabled.current ? "update-prompt" : "main",
  );
  // A startup update check can be the first frame Ink ever renders. Do not
  // pre-mount TranscriptShell hidden in that case: its <Static> intro would be
  // consumed before the normal buffer has received it, leaving only the live
  // composer/footer when the overlay exits. Mount it fresh on the first real
  // main-screen render, then keep it mounted across later overlays so normal
  // transcript/static-buffer preservation continues to work.
  const transcriptHasMountedRef = useRef(screen === "main");
  const shouldMountTranscript = screen === "main" || transcriptHasMountedRef.current;
  if (screen === "main") {
    transcriptHasMountedRef.current = true;
  }
  const [pendingImport, setPendingImport] = useState<{
    prompt: string;
    providerPrompt: string;
    files: PendingImportFile[];
    attachmentsDir: string;
  } | null>(null);
  const pastedContentRegistryRef = useRef<PastedContentRegistry>(new Map());
  const imageAttachmentRegistryRef = useRef<ImageAttachmentRegistry>(new Map());
  const [toolApproval, setToolApproval] = useState<ToolApprovalRequest | null>(null);
  const toolApprovalResolverRef = useRef<((decision: ToolApprovalDecision) => void) | null>(null);
  const [registryNonce, setRegistryNonce] = useState(0);
  const screenRef = useRef<Screen>("main");
  screenRef.current = screen;
  const [composerInstanceKey, setComposerInstanceKey] = useState(0);
  // Bumped purely to force one extra React commit when the /clear boundary needs
  // the authoritative post-clear frame flushed (see the syncRenderState effect).
  const [, bumpPostClearRepaint] = useState(0);
  const {
    state: sessionState,
    dispatch: dispatchSession,
    getState: getSessionState,
  } = useAppSessionState(() => {
    return createStartupStaticEvents({
      providerWorkspaceConfig: initialProviderWorkspaceConfig.current,
    });
  });
  const conversationStore = useMemo(
    () =>
      new ConversationStore(workspaceRoot, {
        ownership: true,
      }),
    [workspaceRoot],
  );
  const activeConversationRef = useRef<ConversationRecord | null>(null);
  const promptQueue = useRef(new PromptQueue()).current;
  const [workbenchVersion, bumpWorkbench] = useState(0);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("transcript");
  const fileAttachmentRegistryRef = useRef(new Map<string, FileAttachment>());
  const checkpointsRef = useRef<FileCheckpoint[]>([]);
  const restoredFileBoundaryRef = useRef<FileBoundary | undefined>(undefined);
  const workspaceLeaseRef = useRef<OwnershipLease | undefined>(undefined);
  const runRefs = useRunRefs();
  const {
    stoppingRef,
    submissionRef,
    recoveryRef,
    pendingQuitRef,
    snapshotRef,
    lastSaveErrorRef,
    saveWorkbenchRef,
    captureFinalRef,
    activeCheckpointRef,
    pendingCaptureRef,
    deferredRouteCloseRef,
    runControlRef,
    processStoppedRef,
    pipelineGenerationRef,
    finalFlushRef,
    activeRunCaptureRef,
    cleanupRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    isMountedRef,
    activeRunIdRef,
    activeTurnIdRef,
    clearEpochRef,
  } = runRefs;

  const [interruptHint, setInterruptHint] = useState<InterruptHint | null>(null);
  const [conversationRouteOverride, setConversationRouteOverride] = useState<ProviderRoute | null>(
    null,
  );
  const preserveSavedRouteRef = useRef(false);
  const routeChoiceRequiredRef = useRef<string | null>(null);
  const startupResumeHandledRef = useRef(false);
  const [savedViewerSession, setSavedViewerSession] = useState<SessionSummary | null>(null);
  const [resumeConversations, setResumeConversations] = useState<ConversationListEntry[]>([]);
  // /resume native sections: listing cache for one picker session, the picker's
  // section/scope/selection (restored when returning from the viewer), and the
  // session shown in the transcript viewer.
  const catalogListsRef = useRef(new Map<ExternalListScope, Promise<SessionCatalogResult>>());
  const resumePickerPositionRef = useRef<ResumePickerPosition | undefined>(undefined);
  const [externalViewerSession, setExternalViewerSession] = useState<ExternalSessionSummary | null>(
    null,
  );
  const [authStatus, setAuthStatus] = useState<CodexAuthProbeResult>(createInitialAuthStatus());
  const [authStatusBusy, setAuthStatusBusy] = useState(false);
  // Running character total across the conversation — used to estimate token usage
  const [conversationChars, setConversationChars] = useState(0);
  const rolloverResponseCharsRef = useRef(0);
  // Seeded synchronously from local caches (codex's models_cache.json or the
  // persisted last-good discovery) so the model picker opens instantly with
  // real models; live discovery replaces this in the background.
  const [modelCapabilities, setModelCapabilities] = useState<CodexModelCapabilities | null>(() =>
    loadSeededCodexCapabilities(),
  );
  const [modelCapabilitiesBusy, setModelCapabilitiesBusy] = useState(false);
  // True while a provider route switch is validating (subprocess probes);
  // drives the model picker's loading state for non-openai providers.
  const [routeSwitchBusy, setRouteSwitchBusy] = useState(false);
  const [providerModelLoading, setProviderModelLoading] = useState<Record<string, boolean>>({});
  const [providerModelErrors, setProviderModelErrors] = useState<Record<string, string>>({});
  const [activeContextMetadata, setActiveContextMetadata] = useState<ModelContextMetadata | null>(
    null,
  );
  return {
    selectionCoordinator,
    workspaceRoot,
    projectInstructionsLoad,
    projectInstructions,
    initialSettings,
    startupUpdateEnabled,
    initialUpdateCheckResult,
    initialProviderWorkspaceConfig,
    launchContext,
    workspaceCommandContext,
    terminalLayout,
    terminalLayoutColsRef,
    staticRepaintGeneration,
    bumpStaticRepaintGeneration,
    staticRepaintGenerationRef,
    baseLayeredConfig,
    setBaseLayeredConfig,
    sessionRuntimeOverride,
    setSessionRuntimeOverride,
    authPreference,
    setAuthPreference,
    workspaceDisplayMode,
    setWorkspaceDisplayMode,
    terminalTitleMode,
    setTerminalTitleMode,
    showBusyLoader,
    setShowBusyLoader,
    providerWorkspaceConfig,
    setProviderWorkspaceConfig,
    localBackendStatuses,
    setLocalBackendStatuses,
    pendingRouteProviderId,
    setPendingRouteProviderId,
    providerSetup,
    setProviderSetup,
    providerLaunchBypassRef,
    providerActionRef,
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
    setPendingImport,
    pastedContentRegistryRef,
    imageAttachmentRegistryRef,
    toolApproval,
    setToolApproval,
    toolApprovalResolverRef,
    registryNonce,
    setRegistryNonce,
    screenRef,
    composerInstanceKey,
    setComposerInstanceKey,
    bumpPostClearRepaint,
    sessionState,
    dispatchSession,
    getSessionState,
    conversationStore,
    activeConversationRef,
    promptQueue,
    workbenchVersion,
    bumpWorkbench,
    workbenchView,
    setWorkbenchView,
    fileAttachmentRegistryRef,
    checkpointsRef,
    restoredFileBoundaryRef,
    workspaceLeaseRef,
    stoppingRef,
    submissionRef,
    recoveryRef,
    pendingQuitRef,
    snapshotRef,
    lastSaveErrorRef,
    saveWorkbenchRef,
    captureFinalRef,
    activeCheckpointRef,
    pendingCaptureRef,
    deferredRouteCloseRef,
    runControlRef,
    processStoppedRef,
    pipelineGenerationRef,
    finalFlushRef,
    activeRunCaptureRef,
    cleanupRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    isMountedRef,
    activeRunIdRef,
    activeTurnIdRef,
    clearEpochRef,
    interruptHint,
    setInterruptHint,
    conversationRouteOverride,
    setConversationRouteOverride,
    preserveSavedRouteRef,
    routeChoiceRequiredRef,
    startupResumeHandledRef,
    savedViewerSession,
    setSavedViewerSession,
    resumeConversations,
    setResumeConversations,
    catalogListsRef,
    resumePickerPositionRef,
    externalViewerSession,
    setExternalViewerSession,
    authStatus,
    setAuthStatus,
    authStatusBusy,
    setAuthStatusBusy,
    conversationChars,
    setConversationChars,
    rolloverResponseCharsRef,
    modelCapabilities,
    setModelCapabilities,
    modelCapabilitiesBusy,
    setModelCapabilitiesBusy,
    routeSwitchBusy,
    setRouteSwitchBusy,
    providerModelLoading,
    setProviderModelLoading,
    providerModelErrors,
    setProviderModelErrors,
    activeContextMetadata,
    setActiveContextMetadata,
  };
}
