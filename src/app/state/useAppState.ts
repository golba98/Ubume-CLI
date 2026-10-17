/**
 * Startup initialization and the app's top-level state.
 *
 * Runs once per App render, before any other hook, and returns every state
 * slot and ref that more than one hook shares: the session reducer, settings
 * and provider config loaded at startup, screen and overlay state, workbench
 * registries, provider/model loading state and the run refs (`useRunRefs`).
 *
 * Invariants:
 * - Values read from disk at startup are read exactly once.
 * - `screenRef`, `terminalLayoutColsRef` and `staticRepaintGenerationRef` are
 *   assigned during render, so code running at frame-write time (the
 *   clear-frame boundary) and in async callbacks sees the committing values.
 */

import { useMemo, useRef, useState } from "react";
import type { LaunchArgs } from "../../config/launchArgs.js";
import { type LayeredConfigResult, resolveLayeredConfig } from "../../config/layeredConfig.js";
import { DEFAULT_UPDATE_CHECK_SETTINGS, loadSettings } from "../../config/persistence.js";
import type { PartialRuntimeConfig } from "../../config/runtimeConfig.js";
import type {
  AuthPreference,
  TerminalTitleMode,
  WorkspaceDisplayMode,
} from "../../config/settings.js";
import type { CodexAuthProbeResult } from "../../core/codex/codexAuth.js";
import type { ExternalSessionSummary } from "../../core/externalSessions/index.js";
import type { CodexModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import { loadSeededCodexCapabilities } from "../../core/models/modelCache.js";
import { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";

import type {
  LocalBackendId,
  ProviderId,
  ProviderPickerAction,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import { loadProviderWorkspaceConfig } from "../../core/providerLauncher/workspaceConfig.js";
import type { ModelContextMetadata } from "../../core/providerRuntime/contextMetadata.js";

import { isProviderRoutableInUbume } from "../../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";

import type {
  BackendProvider,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../../core/providers/types.js";

import {
  shouldRunStartupUpdateCheck,
  type UpdateCheckResult,
} from "../../core/version/updateCheck.js";
import type { FileBoundary, FileCheckpoint } from "../../core/workspace/checkpoints.js";
import {
  type ConversationListEntry,
  type ConversationRecord,
  ConversationStore,
} from "../../core/workspace/conversationStore.js";
import {
  buildWorkspaceCommandContext,
  resolveLaunchContext,
} from "../../core/workspace/launchContext.js";
import type { OwnershipLease } from "../../core/workspace/ownership.js";
import { loadProjectInstructions } from "../../core/workspace/projectInstructions.js";
import { resolveWorkspaceRoot } from "../../core/workspace/workspaceRoot.js";
import { useAppSessionState } from "../../session/appSession.js";
import { createInitialAuthStatus, createStartupStaticEvents } from "../../session/eventIds.js";

import type { SessionCatalogResult, SessionSummary } from "../../session/sessionCatalog.js";
import type { Screen } from "../../session/types.js";

import { type FileAttachment, PromptQueue } from "../../session/workbench.js";

import type { InterruptHint } from "../../ui/chrome/composer/composerModel.js";
import type {
  ImageAttachmentRegistry,
  PastedContentRegistry,
} from "../../ui/input/pastedContent.js";

import { useTerminalViewport } from "../../ui/layout.js";
import type { PendingImportFile } from "../../ui/panels/AttachmentImportPanel.js";

import type { LocalBackendStatus } from "../../ui/panels/ProviderPicker.js";
import type { ExternalListScope, ResumePickerPosition } from "../../ui/panels/resumePickerRows.js";

import type { WorkbenchView } from "../../ui/panels/WorkbenchPanel.js";

import type { ThemeSelectionState } from "../../ui/theme.js";

import { loadCachedUpdateForRunningVersion } from "../lifecycle/useUpdateCheck.js";
import { useRunRefs } from "./useRunRefs.js";

/**
 * A ref whose initial value is computed once. Unlike `useRef(create())`,
 * `create` does not run again on every render, which matters for initial
 * values read from disk.
 */
function useInitialValueRef<T>(create: () => T): React.RefObject<T> {
  const [ref] = useState(() => ({ current: create() }));
  return ref;
}

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
  // Startup snapshots read from disk exactly once.
  const initialSettings = useInitialValueRef(loadSettings);
  const startupUpdateEnabled = useInitialValueRef(() =>
    shouldRunStartupUpdateCheck(
      process.env,
      !providerOverride &&
        (initialSettings.current.updateCheck ?? DEFAULT_UPDATE_CHECK_SETTINGS).enabled,
    ),
  );
  // A cached "update available" for the running version opens the update
  // prompt immediately; otherwise useUpdateCheck runs the startup check.
  const initialUpdateCheckResult = useInitialValueRef<UpdateCheckResult | null>(() =>
    startupUpdateEnabled.current ? loadCachedUpdateForRunningVersion() : null,
  );
  const initialProviderWorkspaceConfig = useInitialValueRef<ProviderWorkspaceConfig>(() =>
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

  // Layered config and the session override patch on top of it.
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
  // UI preferences (persisted by useAppLifecycleEffects).
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

  // Provider routing state.
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

  // Theme state.
  const [themeSelection, setThemeSelection] = useState<ThemeSelectionState>({
    committedTheme: initialSettings.current.ui.theme,
    previewTheme: null,
  });
  const [themeNotice, setThemeNotice] = useState<string | null>(null);
  const [customTheme, setCustomTheme] = useState(initialSettings.current.ui.customTheme);
  const [headerConfig] = useState(initialSettings.current.header);

  // Screen and pending outside-workspace import.
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

  // Attachment registries and tool approval.
  const pastedContentRegistryRef = useRef<PastedContentRegistry>(new Map());
  const imageAttachmentRegistryRef = useRef<ImageAttachmentRegistry>(new Map());
  const [toolApproval, setToolApproval] = useState<ToolApprovalRequest | null>(null);
  const toolApprovalResolverRef = useRef<((decision: ToolApprovalDecision) => void) | null>(null);
  const [registryNonce, setRegistryNonce] = useState(0);

  // Render-time mirrors: assigned during render so frame-time code and async
  // callbacks see the committing values.
  const screenRef = useRef<Screen>("main");
  screenRef.current = screen;
  const [composerInstanceKey, setComposerInstanceKey] = useState(0);
  // Bumped purely to force one extra React commit when the /clear boundary needs
  // the authoritative post-clear frame flushed (see the syncRenderState effect).
  const [, bumpPostClearRepaint] = useState(0);

  // Session reducer and conversation persistence.
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
  const promptQueue = useInitialValueRef(() => new PromptQueue()).current;
  const [workbenchVersion, bumpWorkbench] = useState(0);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("transcript");
  const fileAttachmentRegistryRef = useRef(new Map<string, FileAttachment>());
  const checkpointsRef = useRef<FileCheckpoint[]>([]);
  const restoredFileBoundaryRef = useRef<FileBoundary | undefined>(undefined);
  const workspaceLeaseRef = useRef<OwnershipLease | undefined>(undefined);

  // Run refs (see useRunRefs for what each group guards).
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

  // Resume and conversation-switch state.
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

  // Auth probe, usage totals and model discovery state.
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
  // True while a provider route switch is validating (subprocess probes).
  // Currently write-only: no view reads it yet.
  const [routeSwitchBusy, setRouteSwitchBusy] = useState(false);
  const [providerModelLoading, setProviderModelLoading] = useState<Record<string, boolean>>({});
  const [providerModelErrors, setProviderModelErrors] = useState<Record<string, string>>({});
  const [activeContextMetadata, setActiveContextMetadata] = useState<ModelContextMetadata | null>(
    null,
  );
  return {
    // Startup & workspace
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

    // Terminal layout & repaint
    terminalLayout,
    terminalLayoutColsRef,
    staticRepaintGeneration,
    bumpStaticRepaintGeneration,
    staticRepaintGenerationRef,

    // Layered config & runtime override
    baseLayeredConfig,
    setBaseLayeredConfig,
    sessionRuntimeOverride,
    setSessionRuntimeOverride,

    // UI preferences
    authPreference,
    setAuthPreference,
    workspaceDisplayMode,
    setWorkspaceDisplayMode,
    terminalTitleMode,
    setTerminalTitleMode,
    showBusyLoader,
    setShowBusyLoader,

    // Provider routing
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

    // Theme
    themeSelection,
    setThemeSelection,
    themeNotice,
    setThemeNotice,
    customTheme,
    setCustomTheme,
    headerConfig,

    // Screen & pending import
    screen,
    setScreen,
    shouldMountTranscript,
    pendingImport,
    setPendingImport,

    // Attachments, tool approval & registry
    pastedContentRegistryRef,
    imageAttachmentRegistryRef,
    toolApproval,
    setToolApproval,
    toolApprovalResolverRef,
    registryNonce,
    setRegistryNonce,

    // Render-time mirrors
    screenRef,
    composerInstanceKey,
    setComposerInstanceKey,
    bumpPostClearRepaint,

    // Session & conversation
    sessionState,
    dispatchSession,
    getSessionState,
    conversationStore,
    activeConversationRef,
    promptQueue,

    // Workbench & workspace registries
    workbenchVersion,
    bumpWorkbench,
    workbenchView,
    setWorkbenchView,
    fileAttachmentRegistryRef,
    checkpointsRef,
    restoredFileBoundaryRef,
    workspaceLeaseRef,

    // Run refs
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

    // Resume & conversation-switch state
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

    // Auth, usage & model discovery
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
