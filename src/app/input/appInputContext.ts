/**
 * Everything a composer submission may need: the app state, command
 * handlers and run starters `useAppInput` and `submitSteps.ts` read.
 * Kept in its own module so the submission steps do not import the hook.
 */

import type { LayeredConfigResult } from "../../config/layeredConfig.js";
import type {
  ResolvedRuntimeConfig,
  RuntimeApprovalPolicy,
  RuntimeConfig,
  RuntimeNetworkAccess,
  RuntimePersonality,
  RuntimeSandboxMode,
  RuntimeServiceTier,
} from "../../config/runtimeConfig.js";
import type {
  AuthPreference,
  AvailableMode,
  AvailableModel,
  ReasoningLevel,
  TerminalTitleMode,
  WorkspaceDisplayMode,
} from "../../config/settings.js";
import type { CodexModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import type { ProviderImageAttachment } from "../../core/providerRuntime/types.js";
import type { GlobalPackageManager } from "../../core/version/packageManager.js";
import type { UpdateCheckResult } from "../../core/version/updateCheck.js";
import type { ConversationRecord } from "../../core/workspace/conversationStore.js";
import type { WorkspaceCommandContext } from "../../core/workspace/launchContext.js";
import type { ProjectInstructionsLoadResult } from "../../core/workspace/projectInstructions.js";
import type { SessionAction, SessionState } from "../../session/appSession.js";
import type { PromptRunTiming } from "../../session/eventIds.js";
import type { PlanFlowState } from "../../session/planFlow.js";
import type { Screen, TimelineEvent, UIState } from "../../session/types.js";
import type { FileAttachment, PromptQueue } from "../../session/workbench.js";
import type {
  ImageAttachmentRegistry,
  PastedContentRegistry,
} from "../../ui/input/pastedContent.js";
import type { PendingImportFile } from "../../ui/panels/AttachmentImportPanel.js";
import type { WorkbenchView } from "../../ui/panels/WorkbenchPanel.js";
import type { PromptRunLifecycle } from "../run/promptRunPrep.js";

export interface UseAppInputContext {
  // Session and run guards
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  submissionRef: React.RefObject<boolean>;
  recoveryRef: React.RefObject<boolean>;
  getSessionState: () => SessionState;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  dispatchSession: (action: SessionAction) => void;
  resetComposer: () => void;
  openWorkbench: (view: WorkbenchView) => void;
  handleSendNow: () => Promise<void>;
  busy: boolean;
  resumeConversation: (id: string) => Promise<void>;
  pipelineGenerationRef: React.RefObject<number>;
  stoppingRef: React.RefObject<Promise<void>>;
  activeRunIdRef: React.RefObject<number | null>;
  handleShellExecute: (command: string) => Promise<void>;

  // Runtime config and presentation values
  layeredRuntimeConfig: LayeredConfigResult;
  runtimeConfig: RuntimeConfig;
  resolvedRuntimeConfig: ResolvedRuntimeConfig;
  workspaceDisplayMode: "dir" | "name" | "simple";
  terminalTitleMode: "dir" | "name" | "simple";
  showBusyLoader: boolean;
  workspaceCommandContext: WorkspaceCommandContext;
  conversationChars: number;
  activeRouteModelCapabilities: CodexModelCapabilities | null;
  routeStatusMessage: string;
  activeRouteProvider: ProviderConfig;
  projectInstructionsLoad: ProjectInstructionsLoadResult;

  // Session commands
  handleQuit: () => void;
  handleClear: () => Promise<void>;
  openResumePicker: () => void;

  // Setting setters used by slash commands (each announces its change)
  setModelWithNotice: (nextModel: AvailableModel) => Promise<void>;
  setModeWithNotice: (nextMode: AvailableMode) => void;
  setReasoningWithNotice: (nextReasoningLevel: ReasoningLevel) => void;
  setPlanModeWithNotice: (nextEnabled: boolean) => void;
  setProjectTrustWithNotice: (trusted: boolean) => void;
  setApprovalPolicyWithNotice: (nextValue: RuntimeApprovalPolicy) => void;
  setSandboxModeWithNotice: (nextValue: RuntimeSandboxMode) => void;
  setNetworkAccessWithNotice: (nextValue: RuntimeNetworkAccess) => void;
  addWritableRootWithNotice: (pathValue: string) => void;
  removeWritableRootWithNotice: (pathValue: string) => void;
  clearWritableRootsWithNotice: () => void;
  setServiceTierWithNotice: (nextValue: RuntimeServiceTier) => void;
  setPersonalityWithNotice: (nextValue: RuntimePersonality) => void;
  setAuthPreferenceWithNotice: (nextPreference: AuthPreference) => void;
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
  setWorkspaceDisplayModeWithNotice: (nextMode: WorkspaceDisplayMode) => void;
  setTerminalTitleModeWithNotice: (nextMode: TerminalTitleMode) => void;
  setShowBusyLoader: React.Dispatch<React.SetStateAction<boolean>>;
  repaintCommittedTheme: (themeName: string) => void;
  refreshAuthStatus: (announce: boolean) => Promise<void>;

  // Panels, pickers and clipboard
  openProviderPicker: () => void;
  openModelPicker: () => void;
  openModePicker: () => void;
  openReasoningPicker: () => void;
  openSettingsPanel: () => void;
  openThemePicker: () => void;
  openPermissionsPanel: () => void;
  openAuthPanel: () => void;
  openUsagePanel: () => void;
  setVerboseMode: React.Dispatch<React.SetStateAction<boolean>>;
  verboseMode: boolean;
  handleCopy: () => Promise<void>;
  handlePasteImage: (replaceCommand?: boolean) => Promise<void>;
  handleWorkspaceRelaunch: (targetPath: string) => void;

  // Model discovery and update checks
  modelCapabilities: CodexModelCapabilities | null;
  refreshModelCapabilities: (
    forceRefresh?: boolean,
    announce?: boolean,
  ) => Promise<CodexModelCapabilities>;
  updateCheckResult: UpdateCheckResult | null;
  requestUpdateCheck: () => Promise<UpdateCheckResult>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  globalPackageManager: GlobalPackageManager;

  // Attachment registries and workspace
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  workspaceRoot: string;
  uiState: UIState;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];

  // Prompt runs
  startPromptRun: (
    displayPrompt: string,
    providerPrompt: string,
    lifecycle?: PromptRunLifecycle,
  ) => boolean;
  promptQueue: PromptQueue;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  allowedWritableRoots: string[];
  setPendingImport: React.Dispatch<
    React.SetStateAction<{
      prompt: string;
      providerPrompt: string;
      files: PendingImportFile[];
      attachmentsDir: string;
    } | null>
  >;

  // Plan mode
  planMode: boolean;
  mode: "suggest" | "auto-edit" | "full-auto";
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  runPlanGeneration: (
    state: Extract<PlanFlowState, { kind: "generating" }>,
    displayPrompt: string,
    submitTiming?: PromptRunTiming,
    commitPrompt?: boolean,
    imageAttachments?: readonly ProviderImageAttachment[],
    preserveInput?: boolean,
    queuedPromptIds?: readonly string[],
  ) => boolean;
}
