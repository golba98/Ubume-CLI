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
  type ReasoningLevel,
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
import { findProvider } from "../../core/providerLauncher/registry.js";
import type {
  LocalBackendId,
  ProviderConfig,
  ProviderId,
  ProviderPickerAction,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import { saveProviderWorkspaceConfig } from "../../core/providerLauncher/workspaceConfig.js";
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
  screen:
    | "workbench-panel"
    | "resume-picker"
    | "external-session-viewer"
    | "resume-workspace"
    | "provider-picker"
    | "provider-setup"
    | "model-picker"
    | "mode-picker"
    | "reasoning-picker"
    | "theme-picker"
    | "settings-panel"
    | "auth-panel"
    | "permissions-panel"
    | "permissions-approval-picker"
    | "permissions-sandbox-picker"
    | "permissions-network-picker"
    | "permissions-add-writable-root"
    | "permissions-remove-writable-root"
    | "import-confirmation"
    | "tool-approval"
    | "update-prompt"
    | "usage-panel"
    | "saved-session-viewer";
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
  resumeConversations: ConversationListEntry[];
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
  setProviderWorkspaceConfig?: React.Dispatch<React.SetStateAction<ProviderWorkspaceConfig>>;
  localBackendStatuses: Record<LocalBackendId, LocalBackendStatus>;
  probeLocalBackends: () => void;
  modelPickerOpenRef: React.RefObject<boolean>;
  setPendingRouteProviderId: React.Dispatch<React.SetStateAction<ProviderId | null>>;
  pendingRouteProviderId: ProviderId | null;
  modelPickerModels: readonly CodexModelCapability[];
  modelPickerCurrentModel: string;
  modelPickerCurrentReasoning: string;
  modelPickerProviderLabel: string;
  modelPickerProviderId: ProviderId;
  modelCapabilitiesBusy: boolean;
  providerModelLoading: Record<string, boolean>;
  routeSwitchBusy: boolean;
  modelPickerEmptyMessage: string;
  activeProviderRoute: ProviderRoute;
  persistProviderDefaultModelAndReasoning: (
    providerId: ProviderId,
    modelId: string,
    nextReasoning: string,
  ) => void;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  setModelAndReasoningWithNotice: (
    nextModel: AvailableModel,
    nextReasoning: ReasoningLevel,
    providerId?: ProviderId,
    localBackend?: LocalBackendId,
  ) => Promise<void>;
  returnToChatMode: (reason?: string) => void;
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
  provider: BackendProvider;
  authPreference: "chatgpt-login-goal" | "api-key-first" | "runner-managed";
  authStatus: CodexAuthProbeResult;
  authStatusBusy: boolean;
  setAuthPreferenceWithNotice: (nextPreference: AuthPreference) => void;
  refreshAuthStatus: (announce: boolean) => Promise<void>;
  runtimeConfig: RuntimeConfig;
  resolvedRuntimeConfig: ResolvedRuntimeConfig;
  handlePermissionsPanelAction: (action: PermissionsPanelAction) => void;
  setApprovalPolicyWithNotice: (nextValue: RuntimeApprovalPolicy) => void;
  setSandboxModeWithNotice: (nextValue: RuntimeSandboxMode) => void;
  setNetworkAccessWithNotice: (nextValue: RuntimeNetworkAccess) => void;
  addWritableRootWithNotice: (pathValue: string) => void;
  removeWritableRootWithNotice: (pathValue: string) => void;
  themeSelection: ThemeSelectionState;
  themePreviewTimerRef: React.RefObject<NodeJS.Timeout | null>;
  repaintCommittedTheme: (themeName: string) => void;
  customTheme: Partial<Theme> | undefined;
  setCustomTheme: React.Dispatch<React.SetStateAction<Partial<Theme> | undefined>>;
  setThemeSelection: React.Dispatch<React.SetStateAction<ThemeSelectionState>>;
  currentUserSettings: UserSettingValues;
  saveSettingsFromPanel: (nextSettings: UserSettingValues) => void;
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
    resumeConversations,
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
    providerSetup,
    providerRegistry,
    runProviderSetup,
    setProviderSetup,
    terminalLayout,
    handleProviderAction,
    providerWorkspaceConfig,
    localBackendStatuses,
    probeLocalBackends,
    modelPickerOpenRef,
    setPendingRouteProviderId,
    pendingRouteProviderId,
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
    mode,
    planMode,
    setPlanModeWithNotice,
    setModeWithNotice,
    reasoningLevel,
    currentReasoningCapabilities,
    currentModelCapability,
    currentReasoningSourceLabel,
    setReasoningWithNotice,
    provider,
    authPreference,
    authStatus,
    authStatusBusy,
    setAuthPreferenceWithNotice,
    refreshAuthStatus,
    runtimeConfig,
    resolvedRuntimeConfig,
    handlePermissionsPanelAction,
    setApprovalPolicyWithNotice,
    setSandboxModeWithNotice,
    setNetworkAccessWithNotice,
    addWritableRootWithNotice,
    removeWritableRootWithNotice,
    themeSelection,
    themePreviewTimerRef,
    repaintCommittedTheme,
    customTheme,
    setCustomTheme,
    setThemeSelection,
    currentUserSettings,
    saveSettingsFromPanel,
    pendingImport,
    workspaceRoot,
    activeRouteProvider,
    handleImportConfirm,
    handleImportCancel,
    toolApproval,
    toolApprovalResolverRef,
    setToolApproval,
    handleCancel,
    updateCheckResult,
    globalPackageManager,
    handleSkipUpdateForSession,
    exit,
    activeTheme,
    usageView,
    usageRefreshAvailableAt,
    refreshUsage,
  } = props;
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
          onCancel={() => setScreen("main")}
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
          focusId="resume-workspace"
          title="Locate Original Workspace"
          subtitle={
            savedViewerSession.workspaceRoot ??
            "Enter the original project folder for this saved chat."
          }
          placeholder="/path/to/original/project"
          inputLabel="Folder"
          footerHint="Esc back · Enter locate"
          onSubmit={locateSavedWorkspace}
          onCancel={() => setScreen("saved-session-viewer")}
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

      {screen === "provider-setup" && providerSetup && (
        <ProviderSetupPrompt
          providerLabel={
            findProvider(providerRegistry, providerSetup)?.displayName ?? providerSetup
          }
          executable={
            findProvider(providerRegistry, providerSetup)?.launchCommand?.executable ??
            providerSetup
          }
          installCommand={
            getProviderSetupPlan(providerSetup, process.platform === "win32").installCommand
          }
          setupCommand={
            getProviderSetupPlan(providerSetup, process.platform === "win32").setupCommand
          }
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
          activeLocalBackend={
            providerWorkspaceConfig.activeRoute?.providerId === "local"
              ? (providerWorkspaceConfig.activeRoute.localBackend ?? "lm-studio")
              : (providerWorkspaceConfig.providers?.local?.localBackend ?? "lm-studio")
          }
          localBackendStatuses={localBackendStatuses}
          onLocalBackendsOpen={probeLocalBackends}
          onCancel={() => {
            modelPickerOpenRef.current = false;
            setPendingRouteProviderId(null);
            setScreen("main");
          }}
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
          isLoading={
            modelPickerModels.length === 0 &&
            ((modelPickerProviderId === "openai" && modelCapabilitiesBusy) ||
              providerModelLoading[modelPickerProviderId])
          }
          emptyMessage={modelPickerEmptyMessage}
          refreshMessage={
            providerModelLoading[modelPickerProviderId]
              ? "Refreshing model inventory…"
              : /fail|unverified|cached|credentials|unable|timed|removed|unavailable|unsupported/i.test(
                    modelPickerEmptyMessage ?? "",
                  )
                ? modelPickerEmptyMessage
                : undefined
          }
          onRefresh={() => {
            void handleProviderAction(modelPickerProviderId, "refresh-models");
          }}
          onSelect={(m, r) => {
            modelPickerOpenRef.current = false;
            void setModelAndReasoningWithNotice(
              m as AvailableModel,
              r as ReasoningLevel,
              modelPickerProviderId,
            );
          }}
          onCancel={() => {
            modelPickerOpenRef.current = false;
            setPendingRouteProviderId(null);
            returnToChatMode();
          }}
        />
      )}

      {screen === "mode-picker" && (
        <ModePicker
          currentMode={mode}
          planMode={planMode}
          onSelect={(value) => {
            if (value === "plan") {
              setPlanModeWithNotice(true);
              setScreen("main");
            } else setModeWithNotice(value as AvailableMode);
          }}
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
          onSubmit={(value) => {
            if (!value.trim()) {
              appendEvent("system", "Runtime policy", "Writable root path cannot be empty.");
              return;
            }
            addWritableRootWithNotice(value);
            setScreen("permissions-panel");
          }}
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
          onSelect={(value) => {
            if (themePreviewTimerRef.current) {
              clearTimeout(themePreviewTimerRef.current);
              themePreviewTimerRef.current = null;
            }
            repaintCommittedTheme(value);
            setScreen("main");
            if (value === "custom") {
              if (!customTheme) {
                setCustomTheme({ ...THEMES.purple });
              }
            }
          }}
          onHighlight={(value) => {
            if (themePreviewTimerRef.current) clearTimeout(themePreviewTimerRef.current);
            themePreviewTimerRef.current = null;
            setThemeSelection((currentTheme) => previewThemeSelection(currentTheme, value));
          }}
          onCancel={() => {
            if (themePreviewTimerRef.current) clearTimeout(themePreviewTimerRef.current);
            themePreviewTimerRef.current = null;
            setThemeSelection((currentTheme) => cancelThemeSelection(currentTheme));
            setScreen("main");
          }}
        />
      )}

      {screen === "settings-panel" && activeProviderRoute.providerId === "codexa-native" && (
        <CodexaSettingsPanel
          options={providerWorkspaceConfig.providers?.["codexa-native"]?.codexaNative}
          onCancel={() => setScreen("main")}
          onSave={(options) => {
            const next = {
              ...providerWorkspaceConfig,
              providers: {
                ...providerWorkspaceConfig.providers,
                "codexa-native": {
                  ...providerWorkspaceConfig.providers?.["codexa-native"],
                  codexaNative: options,
                },
              },
            };
            try {
              saveProviderWorkspaceConfig(workspaceRoot, next);
              props.setProviderWorkspaceConfig?.(next);
              appendEvent(
                "system",
                "Codexa settings",
                `Saved ${options.generation?.preset} preset; applies to the next message.`,
              );
              setScreen("main");
            } catch (error) {
              appendEvent("error", "Codexa settings", String(error));
            }
          }}
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
          onSelect={(decision) => {
            resolveToolApproval({ toolApprovalResolverRef, setToolApproval, setScreen }, decision);
          }}
          onCancelRun={() => {
            resolveToolApproval({ toolApprovalResolverRef, setToolApproval, setScreen }, "deny");
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
