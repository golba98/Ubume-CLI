import {
  APP_VERSION,
  formatWorkspaceBrandingPath,
  STARTUP_HEADER_LINES,
  type StartupHeaderMiddleLine,
  type StartupLogoRendering,
} from "../../config/settings.js";
import { logoRendererStatus } from "../../core/terminal/startupGraphics.js";
import { formatUbumeVersionLabel } from "../../core/version/channel.js";
import { LogoRenderingPanel } from "../../ui/panels/LogoRenderingPanel.js";
import { useStartupGraphicsCapabilities } from "../../ui/render/useStartupGraphicsCapabilities.js";
/**
 * Renders whichever overlay the current `screen` names: pickers, panels,
 * viewers and prompts shown in the alternate screen above the transcript.
 *
 * This component is deliberately not memoized (see docs/architecture/app.md):
 * it renders only while an overlay is open, and each overlay is cheap. It
 * holds no state of its own; every action calls back into the hooks that own
 * the state. Exactly one overlay renders for a given screen.
 */

import { Box, Text } from "ink";
import type { ResolvedRuntimeConfig, RuntimeConfig } from "../../config/runtimeConfig.js";
import {
  AVAILABLE_APPROVAL_POLICIES,
  AVAILABLE_NETWORK_ACCESS_VALUES,
  AVAILABLE_SANDBOX_MODES,
  type RuntimeApprovalPolicy,
  type RuntimeNetworkAccess,
  type RuntimeSandboxMode,
} from "../../config/runtimeConfig.js";
import type { Theme } from "../../config/settings.js";
import {
  type AuthPreference,
  type AvailableMode,
  type AvailableModel,
  formatStartupLogoStyleLabel,
  formatThemeLabel,
  normalizeStartupLogoStyle,
  type ReasoningLevel,
  STARTUP_LOGO_STYLES,
  type StartupLogoStyle,
  USER_SETTING_DEFINITIONS,
  type UserSettingValues,
} from "../../config/settings.js";
import type { CodexAuthProbeResult } from "../../core/codex/codexAuth.js";
import type { ExternalSessionSummary } from "../../core/externalSessions/index.js";
import type { ExternalTranscript } from "../../core/externalSessions/types.js";
import type {
  CodexModelCapability,
  ReasoningEffortCapability,
} from "../../core/models/codexModelCapabilities.js";
import { resolveLocalBackend } from "../../core/providerLauncher/localBackend.js";
import { findProvider } from "../../core/providerLauncher/registry.js";
import type {
  LocalBackendId,
  ProviderConfig,
  ProviderId,
  ProviderPickerAction,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import type { CodexaNativeOptions } from "../../core/providerRuntime/codexaNativeConfig.js";
import { getProviderSetupPlan } from "../../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type {
  BackendProvider,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../../core/providers/types.js";
import type { UsageViewState } from "../../core/usage/usageService.js";
import type { GlobalPackageManager } from "../../core/version/packageManager.js";
import type { UpdateCheckResult } from "../../core/version/updateCheck.js";
import type {
  CheckpointStore,
  FileBoundary,
  FileCheckpoint,
  RestoreOperation,
} from "../../core/workspace/checkpoints.js";
import type { ConversationListEntry } from "../../core/workspace/conversationStore.js";
import type { SessionCatalogResult, SessionSummary } from "../../session/sessionCatalog.js";
import type { Screen, TimelineEvent } from "../../session/types.js";
import type { PromptQueue } from "../../session/workbench.js";
import { FOCUS_IDS } from "../../ui/input/focus.js";
import type { TerminalViewport } from "../../ui/layout.js";
import {
  AttachmentImportPanel,
  type PendingImportFile,
} from "../../ui/panels/AttachmentImportPanel.js";
import { AuthPanel } from "../../ui/panels/AuthPanel.js";
import { CodexaSettingsPanel } from "../../ui/panels/CodexaSettingsPanel.js";
import {
  ExternalSessionViewer,
  SavedSessionViewer,
} from "../../ui/panels/ExternalSessionViewer.js";
import { ModelPickerScreen } from "../../ui/panels/ModelPickerScreen.js";
import { PermissionsPanel, type PermissionsPanelAction } from "../../ui/panels/PermissionsPanel.js";
import { type PreferencesEntry, PreferencesPanel } from "../../ui/panels/PreferencesPanel.js";
import { type LocalBackendStatus, ProviderPicker } from "../../ui/panels/ProviderPicker.js";
import { ProviderSetupPrompt } from "../../ui/panels/ProviderSetupPrompt.js";
import { ResumePicker } from "../../ui/panels/ResumePicker.js";
import type { ExternalListScope, ResumePickerPosition } from "../../ui/panels/resumePickerRows.js";
import { SelectionPanel } from "../../ui/panels/SelectionPanel.js";
import { SettingsPanel } from "../../ui/panels/SettingsPanel.js";
import { ModePicker, ReasoningPicker, ThemePicker } from "../../ui/panels/SimplePickers.js";
import { TextEntryPanel } from "../../ui/panels/TextEntryPanel.js";
import { ToolApprovalPanel } from "../../ui/panels/ToolApprovalPanel.js";
import { UpdatePromptPanel } from "../../ui/panels/UpdatePromptPanel.js";
import { UsagePanel } from "../../ui/panels/UsagePanel.js";
import {
  type QueueAction,
  type RecoveryMode,
  WorkbenchPanel,
  type WorkbenchView,
} from "../../ui/panels/WorkbenchPanel.js";

import {
  cancelThemeSelection,
  previewThemeSelection,
  THEMES,
  type ThemeSelectionState,
} from "../../ui/theme.js";

interface OverlayPanelsProps {
  screen: Screen;

  // Workbench
  workbenchView: WorkbenchView;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  promptQueue: PromptQueue;
  recoveryCheckpoints: FileCheckpoint[];
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  currentCheckpointStore: CheckpointStore | null;
  handleQueueAction: (action: QueueAction, id?: string) => void;
  handleRewind: (
    checkpoint: FileCheckpoint,
    recoveryMode: RecoveryMode,
    operations: RestoreOperation[],
  ) => Promise<void>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;

  // Resume picker and session viewers
  resumeConversations: ConversationListEntry[];
  resumeLoading: boolean;
  cancelResume: () => void;
  relocationTarget: string | null;
  relocationError: string | null;
  cancelRelocation: () => void;
  resumeConversation: (id: string) => Promise<void>;
  loadResumeSessions: (scope: ExternalListScope) => Promise<SessionCatalogResult>;
  selectResumeSession: (session: SessionSummary) => Promise<void>;
  openExternalSession: (summary: ExternalSessionSummary) => void;
  resumeExternalSessionNative: (summary: ExternalSessionSummary) => Promise<void>;
  continueExternalSession: (summary: ExternalSessionSummary) => Promise<void>;
  resumePickerPositionRef: React.RefObject<ResumePickerPosition | undefined>;
  rememberResumePickerPosition: (position: ResumePickerPosition) => void;
  savedViewerSession: SessionSummary | null;
  returnToResumePicker: () => void;
  locateSavedWorkspace: (value: string) => Promise<void>;
  externalViewerSession: ExternalSessionSummary | null;
  loadExternalTranscript: () => Promise<ExternalTranscript>;

  // Provider picker and setup
  providerSetup: ProviderId | null;
  providerRegistry: ProviderConfig[];
  runProviderSetup: (providerId: ProviderId) => void;
  setProviderSetup: React.Dispatch<React.SetStateAction<ProviderId | null>>;
  terminalLayout: TerminalViewport;
  handleProviderAction: (
    providerId: ProviderId,
    action: ProviderPickerAction,
    selectedLocalBackend?: LocalBackendId,
  ) => void;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  /** Saves a transform of the latest provider config; see useRuntimeSettings. */
  updateProviderWorkspaceConfig: (
    transform: (latest: ProviderWorkspaceConfig) => ProviderWorkspaceConfig,
  ) => ProviderWorkspaceConfig;
  localBackendStatuses: Record<LocalBackendId, LocalBackendStatus>;
  probeLocalBackends: () => void;
  modelPickerOpenRef: React.RefObject<boolean>;
  setPendingRouteProviderId: React.Dispatch<React.SetStateAction<ProviderId | null>>;
  pendingRouteProviderId: ProviderId | null;

  // Model picker
  modelPickerModels: readonly CodexModelCapability[];
  modelPickerCurrentModel: string;
  modelPickerCurrentReasoning: string;
  modelPickerProviderLabel: string;
  modelPickerProviderId: ProviderId;
  modelCapabilitiesBusy: boolean;
  providerModelLoading: Record<string, boolean>;
  modelPickerEmptyMessage: string;
  activeProviderRoute: ProviderRoute;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  setModelAndReasoningWithNotice: (
    nextModel: AvailableModel,
    nextReasoning: ReasoningLevel,
    providerId?: ProviderId,
    localBackend?: LocalBackendId,
  ) => Promise<void>;
  returnToChatMode: (reason?: string) => void;

  // Mode and reasoning pickers
  mode: "suggest" | "auto-edit" | "full-auto";
  planMode: boolean;
  setPlanModeWithNotice: (nextEnabled: boolean) => void;
  setModeWithNotice: (nextMode: AvailableMode) => void;
  reasoningLevel: string;
  currentReasoningCapabilities: readonly ReasoningEffortCapability[];
  currentModelCapability: CodexModelCapability | null;
  currentReasoningSourceLabel:
    | "Discovered from Claude Code"
    | "From Claude settings"
    | "Fallback defaults; unverified"
    | "Fallback defaults"
    | null;
  setReasoningWithNotice: (nextReasoningLevel: ReasoningLevel) => void;

  // Auth panel
  provider: BackendProvider;
  authPreference: "chatgpt-login-goal" | "api-key-first" | "runner-managed";
  authStatus: CodexAuthProbeResult;
  authStatusBusy: boolean;
  setAuthPreferenceWithNotice: (nextPreference: AuthPreference) => void;
  refreshAuthStatus: (announce: boolean) => Promise<void>;

  // Permissions panels
  runtimeConfig: RuntimeConfig;
  resolvedRuntimeConfig: ResolvedRuntimeConfig;
  handlePermissionsPanelAction: (action: PermissionsPanelAction) => void;
  setApprovalPolicyWithNotice: (nextValue: RuntimeApprovalPolicy) => void;
  setSandboxModeWithNotice: (nextValue: RuntimeSandboxMode) => void;
  setNetworkAccessWithNotice: (nextValue: RuntimeNetworkAccess) => void;
  addWritableRootWithNotice: (pathValue: string) => void;
  removeWritableRootWithNotice: (pathValue: string) => void;

  // Theme picker and settings
  themeSelection: ThemeSelectionState;
  themePreviewTimerRef: React.RefObject<NodeJS.Timeout | null>;
  repaintCommittedTheme: (themeName: string) => void;
  customTheme: Partial<Theme> | undefined;
  setCustomTheme: React.Dispatch<React.SetStateAction<Partial<Theme> | undefined>>;
  setThemeSelection: React.Dispatch<React.SetStateAction<ThemeSelectionState>>;
  currentUserSettings: UserSettingValues;
  saveSettingsFromPanel: (nextSettings: UserSettingValues) => void;

  // Preferences panel
  startupLogoStyle: StartupLogoStyle;
  commitStartupLogoStyle: (style: StartupLogoStyle) => void;
  startupAnimation: boolean;
  startupHeaderMiddleLine: StartupHeaderMiddleLine;
  setStartupHeaderMiddleLine: (value: StartupHeaderMiddleLine) => void;
  startupLogoRendering: StartupLogoRendering;
  startupPreviewProvider?: string | null;
  startupPreviewModel?: string;
  startupPreviewUsage?: string;
  setStartupLogoRendering: (value: StartupLogoRendering) => void;
  setStartupAnimation: React.Dispatch<React.SetStateAction<boolean>>;
  /** Screen the theme picker returns to when it was opened from /preferences. */
  themePickerReturnScreen: Screen;
  setThemePickerReturnScreen: React.Dispatch<React.SetStateAction<Screen>>;

  // Import confirmation and tool approval
  pendingImport: {
    prompt: string;
    providerPrompt: string;
    files: PendingImportFile[];
    attachmentsDir: string;
  } | null;
  workspaceRoot: string;
  activeRouteProvider: ProviderConfig;
  handleImportConfirm: () => Promise<void>;
  handleImportCancel: () => void;
  toolApproval: ToolApprovalRequest | null;
  toolApprovalResolverRef: React.RefObject<((decision: ToolApprovalDecision) => void) | null>;
  setToolApproval: React.Dispatch<React.SetStateAction<ToolApprovalRequest | null>>;
  handleCancel: () => void;

  // Update prompt and usage
  updateCheckResult: UpdateCheckResult | null;
  globalPackageManager: GlobalPackageManager;
  handleSkipUpdateForSession: () => void;
  exit: (errorOrResult?: Error | unknown) => void;
  activeTheme: Theme;
  usageView: UsageViewState;
  usageRefreshAvailableAt: number;
  refreshUsage: () => void;
}

export function OverlayPanels(props: OverlayPanelsProps) {
  const {
    screen,

    // Workbench
    workbenchView,
    staticEvents,
    activeEvents,
    promptQueue,
    recoveryCheckpoints,
    restoredFileBoundaryRef,
    currentCheckpointStore,
    handleQueueAction,
    handleRewind,
    setScreen,

    // Resume picker and session viewers
    resumeConversations,
    resumeLoading,
    cancelResume,
    relocationTarget,
    relocationError,
    cancelRelocation,
    resumeConversation,
    loadResumeSessions,
    selectResumeSession,
    openExternalSession,
    resumeExternalSessionNative,
    continueExternalSession,
    resumePickerPositionRef,
    rememberResumePickerPosition,
    savedViewerSession,
    returnToResumePicker,
    locateSavedWorkspace,
    externalViewerSession,
    loadExternalTranscript,

    // Provider picker and setup
    providerSetup,
    providerRegistry,
    runProviderSetup,
    setProviderSetup,
    terminalLayout,
    handleProviderAction,
    providerWorkspaceConfig,
    updateProviderWorkspaceConfig,
    localBackendStatuses,
    probeLocalBackends,
    modelPickerOpenRef,
    setPendingRouteProviderId,
    pendingRouteProviderId,

    // Model picker
    modelPickerModels,
    modelPickerCurrentModel,
    modelPickerCurrentReasoning,
    modelPickerProviderLabel,
    modelPickerProviderId,
    modelCapabilitiesBusy,
    providerModelLoading,
    modelPickerEmptyMessage,
    activeProviderRoute,
    appendEvent,
    setModelAndReasoningWithNotice,
    returnToChatMode,

    // Mode and reasoning pickers
    mode,
    planMode,
    setPlanModeWithNotice,
    setModeWithNotice,
    reasoningLevel,
    currentReasoningCapabilities,
    currentModelCapability,
    currentReasoningSourceLabel,
    setReasoningWithNotice,

    // Auth panel
    provider,
    authPreference,
    authStatus,
    authStatusBusy,
    setAuthPreferenceWithNotice,
    refreshAuthStatus,

    // Permissions panels
    runtimeConfig,
    resolvedRuntimeConfig,
    handlePermissionsPanelAction,
    setApprovalPolicyWithNotice,
    setSandboxModeWithNotice,
    setNetworkAccessWithNotice,
    addWritableRootWithNotice,
    removeWritableRootWithNotice,

    // Theme picker and settings
    themeSelection,
    themePreviewTimerRef,
    repaintCommittedTheme,
    customTheme,
    setCustomTheme,
    setThemeSelection,
    currentUserSettings,
    saveSettingsFromPanel,

    // Preferences panel
    startupLogoStyle,
    commitStartupLogoStyle,
    startupAnimation,
    startupHeaderMiddleLine,
    setStartupHeaderMiddleLine,
    startupLogoRendering,
    startupPreviewProvider,
    startupPreviewModel,
    startupPreviewUsage,
    setStartupLogoRendering,
    setStartupAnimation,
    themePickerReturnScreen,
    setThemePickerReturnScreen,

    // Import confirmation and tool approval
    pendingImport,
    workspaceRoot,
    activeRouteProvider,
    handleImportConfirm,
    handleImportCancel,
    toolApproval,
    toolApprovalResolverRef,
    setToolApproval,
    handleCancel,

    // Update prompt and usage
    updateCheckResult,
    globalPackageManager,
    handleSkipUpdateForSession,
    exit,
    activeTheme,
    usageView,
    usageRefreshAvailableAt,
    refreshUsage,
  } = props;

  // --- Provider setup ---------------------------------------------------------

  const setupProvider = providerSetup ? findProvider(providerRegistry, providerSetup) : undefined;
  const setupPlan = providerSetup
    ? getProviderSetupPlan(providerSetup, process.platform === "win32")
    : null;

  // --- Provider and model pickers ----------------------------------------------

  const activeLocalBackend = resolveLocalBackend(
    providerWorkspaceConfig,
    providerWorkspaceConfig.activeRoute?.providerId === "local"
      ? providerWorkspaceConfig.activeRoute.localBackend
      : undefined,
  );
  const modelPickerRefreshing = providerModelLoading[modelPickerProviderId] === true;
  const modelPickerLoading =
    modelPickerModels.length === 0 &&
    ((modelPickerProviderId === "openai" && modelCapabilitiesBusy) || modelPickerRefreshing);

  const closeProviderPicker = () => {
    modelPickerOpenRef.current = false;
    setPendingRouteProviderId(null);
    setScreen("main");
  };

  const selectPickedModel = (model: string, reasoning: string) => {
    modelPickerOpenRef.current = false;
    void setModelAndReasoningWithNotice(
      model as AvailableModel,
      reasoning as ReasoningLevel,
      modelPickerProviderId,
    );
  };

  const closeModelPicker = () => {
    modelPickerOpenRef.current = false;
    setPendingRouteProviderId(null);
    returnToChatMode();
  };

  // --- Mode picker -----------------------------------------------------------------

  const selectMode = (value: string) => {
    if (value === "plan") {
      setPlanModeWithNotice(true);
      setScreen("main");
    } else {
      setModeWithNotice(value as AvailableMode);
    }
  };

  // --- Permissions -----------------------------------------------------------------

  const addWritableRoot = (value: string) => {
    if (!value.trim()) {
      appendEvent("system", "Runtime policy", "Writable root path cannot be empty.");
      return;
    }
    addWritableRootWithNotice(value);
    setScreen("permissions-panel");
  };

  // --- Theme picker ------------------------------------------------------------------

  const clearThemePreviewTimer = () => {
    if (themePreviewTimerRef.current) {
      clearTimeout(themePreviewTimerRef.current);
    }
    themePreviewTimerRef.current = null;
  };

  const commitTheme = (value: string) => {
    clearThemePreviewTimer();
    repaintCommittedTheme(value);
    setScreen(themePickerReturnScreen);
    setThemePickerReturnScreen("main");
    // The custom theme starts from Purple the first time it is chosen.
    if (value === "custom" && !customTheme) {
      setCustomTheme({ ...THEMES.purple });
    }
  };

  const previewTheme = (value: string) => {
    clearThemePreviewTimer();
    setThemeSelection((current) => previewThemeSelection(current, value));
  };

  const cancelThemePicker = () => {
    clearThemePreviewTimer();
    setThemeSelection((current) => cancelThemeSelection(current));
    setScreen(themePickerReturnScreen);
    setThemePickerReturnScreen("main");
  };

  // --- Preferences panel --------------------------------------------------------------

  const selectPreferencesEntry = (entry: PreferencesEntry) => {
    if (entry.target === "theme-picker") {
      // The theme picker commits through the same repaintCommittedTheme path
      // as /theme; it just returns to the preferences panel afterwards.
      setThemePickerReturnScreen("preferences");
      setScreen("theme-picker");
      return;
    }
    setScreen(entry.target);
  };

  const selectStartupLogoStyle = (value: string) => {
    commitStartupLogoStyle(normalizeStartupLogoStyle(value));
    setScreen("preferences");
  };

  const { capabilities: graphicsCapabilities, trueColor: graphicsTrueColor } =
    useStartupGraphicsCapabilities();
  const graphicsStatus = logoRendererStatus(
    startupLogoRendering,
    graphicsCapabilities,
    graphicsTrueColor,
  );

  const selectStartupAnimation = (value: string) => {
    setStartupAnimation(value === "on");
    setScreen("preferences");
  };

  const preferencesEntries: readonly PreferencesEntry[] = [
    {
      id: "startup-logo",
      label: "Startup Logo",
      value: formatStartupLogoStyleLabel(startupLogoStyle),
      target: "startup-logo-picker",
    },
    {
      id: "startup-animation",
      label: "Startup Animation",
      value: startupAnimation ? "Enabled" : "Disabled",
      target: "startup-animation-picker",
    },
    {
      id: "color-theme",
      label: "Color Theme",
      value: formatThemeLabel(themeSelection.committedTheme),
      target: "theme-picker",
    },
    {
      id: "startup-rendering",
      label: "Logo Rendering",
      value: graphicsStatus,
      target: "startup-rendering-picker",
    },
    {
      id: "startup-header",
      label: "Middle Line",
      section: "Startup Header",
      value: STARTUP_HEADER_LINES.find((entry) => entry.id === startupHeaderMiddleLine)!.label,
      target: "startup-header-picker",
    },
  ];

  // --- Codexa settings -----------------------------------------------------------------

  const saveCodexaSettings = (options: CodexaNativeOptions) => {
    try {
      updateProviderWorkspaceConfig((latest) => ({
        ...latest,
        providers: {
          ...latest.providers,
          "codexa-native": { ...latest.providers?.["codexa-native"], codexaNative: options },
        },
      }));
      appendEvent(
        "system",
        "Codexa settings",
        `Saved ${options.generation?.preset} preset; applies to the next message.`,
      );
      setScreen("main");
    } catch (error) {
      appendEvent("error", "Codexa settings", String(error));
    }
  };

  // --- Tool approval -------------------------------------------------------------------

  const toolApprovalContext = { toolApprovalResolverRef, setToolApproval, setScreen };

  return (
    <>
      {screen === "workbench-panel" && (
        <WorkbenchPanel
          key={workbenchView}
          view={workbenchView}
          events={[...staticEvents, ...activeEvents]}
          queue={promptQueue.items}
          paused={promptQueue.paused}
          checkpoints={recoveryCheckpoints}
          restoredFileBoundary={restoredFileBoundaryRef.current}
          store={currentCheckpointStore}
          onQueueAction={handleQueueAction}
          onRewind={handleRewind}
          onClose={() => setScreen("main")}
        />
      )}
      {screen === "resume-picker" && (
        <ResumePicker
          conversations={resumeConversations}
          onSelect={resumeConversation}
          onCancel={cancelResume}
          loading={resumeLoading}
          loadSessions={loadResumeSessions}
          onSelectSession={selectResumeSession}
          onOpenExternal={openExternalSession}
          onResumeExternalNative={resumeExternalSessionNative}
          onContinueExternal={continueExternalSession}
          position={resumePickerPositionRef.current}
          onPositionChange={rememberResumePickerPosition}
        />
      )}
      {screen === "saved-session-viewer" && savedViewerSession && (
        <SavedSessionViewer
          session={savedViewerSession}
          onBack={returnToResumePicker}
          onLocateWorkspace={() => setScreen("resume-workspace")}
        />
      )}
      {screen === "resume-workspace" && savedViewerSession && (
        <TextEntryPanel
          key={relocationTarget ? "relocation-confirm" : "relocation-path"}
          focusId="resume-workspace"
          title={relocationTarget ? "Confirm Workspace Relocation" : "Locate Workspace"}
          subtitle={
            relocationError ??
            (relocationTarget
              ? `Create a separate conversation in ${relocationTarget}. The original is retained. Type RELOCATE to confirm.`
              : (savedViewerSession.workspaceRoot ??
                "Enter the original project folder for this saved chat."))
          }
          placeholder={relocationTarget ? "RELOCATE" : "/path/to/project"}
          inputLabel={relocationTarget ? "Confirm" : "Folder"}
          footerHint="Esc back · Enter locate"
          onSubmit={locateSavedWorkspace}
          onCancel={cancelRelocation}
        />
      )}
      {screen === "external-session-viewer" && externalViewerSession && (
        <ExternalSessionViewer
          summary={externalViewerSession}
          loadTranscript={loadExternalTranscript}
          onBack={returnToResumePicker}
          onOpenNative={resumeExternalSessionNative}
          onContinue={continueExternalSession}
        />
      )}

      {screen === "provider-setup" && providerSetup && setupPlan && (
        <ProviderSetupPrompt
          providerLabel={setupProvider?.displayName ?? providerSetup}
          executable={setupProvider?.launchCommand?.executable ?? providerSetup}
          installCommand={setupPlan.installCommand}
          setupCommand={setupPlan.setupCommand}
          onInstall={() => runProviderSetup(providerSetup)}
          onCancel={() => {
            setProviderSetup(null);
            setScreen("provider-picker");
          }}
        />
      )}

      {screen === "provider-picker" && (
        <ProviderPicker
          layout={terminalLayout}
          providers={providerRegistry}
          onAction={handleProviderAction}
          activeLocalBackend={activeLocalBackend}
          localBackendStatuses={localBackendStatuses}
          onLocalBackendsOpen={probeLocalBackends}
          onCancel={closeProviderPicker}
          initialProviderId={pendingRouteProviderId ?? undefined}
        />
      )}

      {screen === "model-picker" && (
        <ModelPickerScreen
          layout={terminalLayout}
          models={modelPickerModels}
          currentModel={modelPickerCurrentModel}
          currentReasoning={modelPickerCurrentReasoning}
          activeProviderLabel={modelPickerProviderLabel}
          isLoading={modelPickerLoading}
          emptyMessage={modelPickerEmptyMessage}
          refreshMessage={modelPickerRefreshMessage(modelPickerRefreshing, modelPickerEmptyMessage)}
          onRefresh={() => handleProviderAction(modelPickerProviderId, "refresh-models")}
          onSelect={selectPickedModel}
          onCancel={closeModelPicker}
        />
      )}

      {screen === "mode-picker" && (
        <ModePicker
          currentMode={mode}
          planMode={planMode}
          onSelect={selectMode}
          onCancel={() => setScreen("main")}
        />
      )}

      {screen === "reasoning-picker" && (
        <ReasoningPicker
          currentModel={activeProviderRoute.modelId}
          currentReasoning={activeProviderRoute.reasoning ?? reasoningLevel}
          reasoningLevels={currentReasoningCapabilities}
          defaultReasoning={currentModelCapability?.defaultReasoningLevel ?? null}
          sourceLabel={currentReasoningSourceLabel}
          control={currentModelCapability?.reasoningControl}
          onSelect={(value) => setReasoningWithNotice(value as ReasoningLevel)}
          onCancel={() => setScreen("main")}
        />
      )}

      {screen === "auth-panel" && (
        <AuthPanel
          focusId={FOCUS_IDS.authPanel}
          provider={provider}
          authPreference={authPreference}
          authStatus={authStatus}
          authStatusBusy={authStatusBusy}
          onSetPreference={(value) => setAuthPreferenceWithNotice(value as AuthPreference)}
          onRefreshAuthStatus={() => {
            void refreshAuthStatus(false);
          }}
          onClose={() => setScreen("main")}
        />
      )}

      {screen === "usage-panel" && (
        <UsagePanel
          focusId={FOCUS_IDS.usagePanel}
          view={usageView}
          refreshAvailableAt={usageRefreshAvailableAt}
          onRefresh={refreshUsage}
          onClose={() => setScreen("main")}
        />
      )}

      {screen === "permissions-panel" && (
        <PermissionsPanel
          providerManaged={activeProviderRoute.providerId === "google"}
          runtime={runtimeConfig}
          resolvedRuntime={resolvedRuntimeConfig}
          onSelect={handlePermissionsPanelAction}
          onCancel={() => setScreen("main")}
        />
      )}

      {screen === "permissions-approval-picker" && (
        <PolicySelectionPanel
          focusId={FOCUS_IDS.permissionsApprovalPicker}
          title="Approval Policy"
          subtitle="Choose how Ubume should handle approval prompts."
          options={AVAILABLE_APPROVAL_POLICIES}
          currentValue={runtimeConfig.policy.approvalPolicy}
          onSelect={(value) => setApprovalPolicyWithNotice(value as RuntimeApprovalPolicy)}
          onClose={() => setScreen("permissions-panel")}
        />
      )}

      {screen === "permissions-sandbox-picker" && (
        <PolicySelectionPanel
          focusId={FOCUS_IDS.permissionsSandboxPicker}
          title="Sandbox Mode"
          subtitle="Choose the effective filesystem sandbox for future runs."
          options={AVAILABLE_SANDBOX_MODES}
          currentValue={runtimeConfig.policy.sandboxMode}
          onSelect={(value) => setSandboxModeWithNotice(value as RuntimeSandboxMode)}
          onClose={() => setScreen("permissions-panel")}
        />
      )}

      {screen === "permissions-network-picker" && (
        <PolicySelectionPanel
          focusId={FOCUS_IDS.permissionsNetworkPicker}
          title="Network Access"
          subtitle="Choose whether network access is enabled for future runs."
          options={AVAILABLE_NETWORK_ACCESS_VALUES}
          currentValue={runtimeConfig.policy.networkAccess}
          onSelect={(value) => setNetworkAccessWithNotice(value as RuntimeNetworkAccess)}
          onClose={() => setScreen("permissions-panel")}
        />
      )}

      {screen === "permissions-add-writable-root" && (
        <TextEntryPanel
          focusId={FOCUS_IDS.permissionsAddWritableRoot}
          title="Add Writable Root"
          subtitle="Enter an absolute path or a path relative to the locked workspace."
          placeholder="relative\\or\\absolute\\path"
          inputLabel="Path"
          footerHint="Esc to close · Enter to confirm"
          onSubmit={addWritableRoot}
          onCancel={() => setScreen("permissions-panel")}
        />
      )}

      {screen === "permissions-remove-writable-root" && (
        <SelectionPanel
          focusId={FOCUS_IDS.permissionsRemoveWritableRoot}
          title="Remove Writable Root"
          subtitle="Select a configured writable root to remove."
          items={runtimeConfig.policy.writableRoots.map((root) => ({
            label: root,
            value: root,
          }))}
          onSelect={(value) => {
            removeWritableRootWithNotice(value);
            setScreen("permissions-panel");
          }}
          onCancel={() => setScreen("permissions-panel")}
        />
      )}

      {screen === "theme-picker" && (
        <ThemePicker
          currentTheme={themeSelection.committedTheme}
          onSelect={commitTheme}
          onHighlight={previewTheme}
          onCancel={cancelThemePicker}
        />
      )}

      {screen === "preferences" && (
        <PreferencesPanel
          focusId={FOCUS_IDS.preferencesPanel}
          entries={preferencesEntries}
          onSelect={selectPreferencesEntry}
          onCancel={() => setScreen("main")}
        />
      )}

      {screen === "startup-logo-picker" && (
        <SelectionPanel
          focusId={FOCUS_IDS.startupLogoPicker}
          title="Startup Logo"
          subtitle="Choose how Ubume presents itself on startup"
          items={STARTUP_LOGO_STYLES.map((style) => ({
            label: style.id === startupLogoStyle ? `${style.label}  ✓` : style.label,
            value: style.id,
          }))}
          initialValue={startupLogoStyle}
          onSelect={selectStartupLogoStyle}
          onCancel={() => setScreen("preferences")}
        />
      )}

      {screen === "startup-header-picker" && (
        <SelectionPanel
          focusId={FOCUS_IDS.startupHeaderPicker}
          title="Middle Line"
          subtitle="Startup header only; the bottom model status stays visible"
          items={STARTUP_HEADER_LINES.map((entry) => ({
            label: entry.label + (entry.id === startupHeaderMiddleLine ? "  ✓" : ""),
            value: entry.id,
          }))}
          initialValue={startupHeaderMiddleLine}
          onSelect={(value) => {
            setStartupHeaderMiddleLine(value as StartupHeaderMiddleLine);
            setScreen("preferences");
          }}
          onCancel={() => setScreen("preferences")}
        />
      )}
      {screen === "startup-rendering-picker" && (
        <LogoRenderingPanel
          focusId={FOCUS_IDS.startupRenderingPicker}
          value={startupLogoRendering}
          animation={startupAnimation}
          item={{
            key: "startup-preview",
            type: "intro",
            padded: false,
            intro: {
              version: formatUbumeVersionLabel(APP_VERSION),
              layoutMode: "regular",
              authLabel: "",
              workspaceLabel: "",
              logoStyle: "minimal",
              providerLabel: startupPreviewProvider ?? activeRouteProvider.displayName,
              startupModelLabel: startupPreviewModel,
              usageLabel: startupPreviewUsage,
              workspacePath: formatWorkspaceBrandingPath(workspaceRoot),
              middleLine: startupHeaderMiddleLine,
            },
          }}
          onSelect={(value) => {
            setStartupLogoRendering(value);
            setScreen("preferences");
          }}
          onCancel={() => setScreen("preferences")}
        />
      )}
      {screen === "startup-animation-picker" && (
        <SelectionPanel
          focusId={FOCUS_IDS.startupAnimationPicker}
          title="Startup Animation"
          subtitle="Play the logo assembly animation when Ubume starts"
          items={[
            { label: startupAnimation ? "Enabled  ✓" : "Enabled", value: "on" },
            { label: !startupAnimation ? "Disabled  ✓" : "Disabled", value: "off" },
          ]}
          initialValue={startupAnimation ? "on" : "off"}
          onSelect={selectStartupAnimation}
          onCancel={() => setScreen("preferences")}
        />
      )}

      {screen === "settings-panel" && activeProviderRoute.providerId === "codexa-native" && (
        <CodexaSettingsPanel
          options={providerWorkspaceConfig.providers?.["codexa-native"]?.codexaNative}
          onCancel={() => setScreen("main")}
          onSave={saveCodexaSettings}
        />
      )}
      {screen === "settings-panel" && activeProviderRoute.providerId !== "codexa-native" && (
        <SettingsPanel
          focusId={FOCUS_IDS.settingsPanel}
          settings={USER_SETTING_DEFINITIONS}
          values={currentUserSettings}
          onSave={(values) => saveSettingsFromPanel(values as UserSettingValues)}
          onCancel={() => setScreen("main")}
        />
      )}

      {screen === "import-confirmation" && pendingImport && (
        <AttachmentImportPanel
          focusId={FOCUS_IDS.importConfirmationPanel}
          files={pendingImport.files}
          attachmentsDir={pendingImport.attachmentsDir}
          workspaceRoot={workspaceRoot}
          modelSupportsVision={activeRouteProvider?.capabilityProfile?.supportsVision ?? null}
          onConfirm={() => {
            void handleImportConfirm();
          }}
          onCancel={handleImportCancel}
        />
      )}

      {screen === "tool-approval" && toolApproval && (
        <ToolApprovalPanel
          focusId={FOCUS_IDS.toolApprovalPanel}
          request={toolApproval}
          onSelect={(decision) => resolveToolApproval(toolApprovalContext, decision)}
          onCancelRun={() => {
            resolveToolApproval(toolApprovalContext, "deny");
            handleCancel();
          }}
        />
      )}

      {screen === "update-prompt" &&
        updateCheckResult?.status === "update-available" &&
        updateCheckResult.latestVersion && (
          <UpdatePromptPanel
            focusId={FOCUS_IDS.updatePrompt}
            currentVersion={updateCheckResult.currentVersion}
            latestVersion={updateCheckResult.latestVersion}
            packageManager={globalPackageManager}
            onSkip={handleSkipUpdateForSession}
            onRestart={exit}
          />
        )}
      {screen === "update-prompt" &&
        updateCheckResult !== null &&
        updateCheckResult.status !== "update-available" && (
          <SelectionPanel
            focusId={FOCUS_IDS.updatePrompt}
            title={
              updateCheckResult.status === "up-to-date"
                ? "Ubume is up to date"
                : "Update check unavailable"
            }
            subtitle=""
            items={[{ label: "Return to chat", value: "close" }]}
            onSelect={handleSkipUpdateForSession}
            onCancel={handleSkipUpdateForSession}
          />
        )}
      {screen === "update-prompt" && updateCheckResult === null && (
        <Box
          borderStyle="round"
          borderColor={activeTheme.borderFocused}
          paddingX={2}
          paddingY={1}
          width="100%"
          marginTop={1}
        >
          <Text color={activeTheme.textMuted}>Checking for Ubume updates...</Text>
        </Box>
      )}
    </>
  );
}

type PolicySelectionPanelProps = Omit<
  React.ComponentProps<typeof SelectionPanel>,
  "items" | "onSelect" | "onCancel"
> & {
  options: readonly { id: string; label: string }[];
  currentValue: string;
  onSelect: (value: string) => void;
  onClose: () => void;
};

function PolicySelectionPanel({
  options,
  currentValue,
  onSelect,
  onClose,
  ...panel
}: PolicySelectionPanelProps) {
  return (
    <SelectionPanel
      {...panel}
      items={options.map((item) => ({
        label: item.id === currentValue ? `${item.label}  ✓` : item.label,
        value: item.id,
      }))}
      onSelect={(value) => {
        onSelect(value);
        onClose();
      }}
      onCancel={onClose}
    />
  );
}

/**
 * Text under the model list explaining an empty or stale inventory: a
 * refresh in progress, or a discovery problem worth repeating. Generic "no
 * models" text is not repeated.
 */
function modelPickerRefreshMessage(refreshing: boolean, emptyMessage: string): string | undefined {
  if (refreshing) {
    return "Refreshing model inventory…";
  }
  const describesProblem =
    /fail|unverified|cached|credentials|unable|timed|removed|unavailable|unsupported/i.test(
      emptyMessage,
    );
  return describesProblem ? emptyMessage : undefined;
}

/** Answers the pending tool approval and closes the approval overlay. */
function resolveToolApproval(
  context: Pick<OverlayPanelsProps, "toolApprovalResolverRef" | "setToolApproval" | "setScreen">,
  decision: ToolApprovalDecision,
): void {
  const resolve = context.toolApprovalResolverRef.current;
  context.toolApprovalResolverRef.current = null;
  context.setToolApproval(null);
  context.setScreen("main");
  resolve?.(decision);
}
