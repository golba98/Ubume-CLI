/**
 * The context `useConversation` receives and shares with its sub-hooks
 * (`useActiveConversation`, `useResumeFlows`, `useStartupNotices`). Kept in its
 * own module so the sub-hooks do not import their composer.
 */

import type { useApp, useFocusManager } from "ink";
import type { LaunchArgs } from "../../config/launchArgs.js";
import type { ExternalSessionSummary } from "../../core/externalSessions/index.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import type { ProviderConfig, ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type {
  BackendProvider,
  ProviderRunControl,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../../core/providers/types.js";
import type {
  CheckpointStore,
  FileBoundary,
  FileCheckpoint,
} from "../../core/workspace/checkpoints.js";
import type {
  ConversationListEntry,
  ConversationRecord,
  ConversationStore,
} from "../../core/workspace/conversationStore.js";
import type { LaunchContext } from "../../core/workspace/launchContext.js";
import type { OwnershipLease } from "../../core/workspace/ownership.js";
import type { ProjectInstructionsLoadResult } from "../../core/workspace/projectInstructions.js";
import type { SessionAction } from "../../session/appSession.js";
import type { PromptRunTiming } from "../../session/eventIds.js";
import type { PlanFlowState } from "../../session/planFlow.js";
import type { SessionCatalogResult, SessionSummary } from "../../session/sessionCatalog.js";
import type { Screen, TimelineEvent } from "../../session/types.js";
import type { FileAttachment, PromptQueue, WorkbenchSnapshot } from "../../session/workbench.js";
import type {
  ImageAttachmentRegistry,
  PastedContentRegistry,
} from "../../ui/input/pastedContent.js";
import type { ExternalListScope, ResumePickerPosition } from "../../ui/panels/resumePickerRows.js";
import type { PromptRunLifecycle } from "../run/promptRunPrep.js";
import type { ActiveRunCapture } from "../run/providerRunSession.js";

export interface UseConversationContext {
  selectionCoordinator: SelectionCoordinator;
  modelSelectionInFlightRef: React.RefObject<boolean>;
  modelPickerOpenRef: React.RefObject<boolean>;
  setRouteSwitchBusy: React.Dispatch<React.SetStateAction<boolean>>;
  waitUntilRenderFlush: ReturnType<typeof useApp>["waitUntilRenderFlush"];
  suspendTerminal: <T>(callback: () => Promise<T>) => Promise<T>;
  // Transcript swap and the active conversation record
  armTranscriptReplacement: (source: string) => {
    clearGeneration: number;
    clearBoundaryArmed: boolean;
    finish: () => void;
  };
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  snapshotRef: React.RefObject<(() => WorkbenchSnapshot) | null>;
  preserveSavedRouteRef: React.RefObject<boolean>;
  activeProviderRoute: ProviderRoute;
  conversationStore: ConversationStore;
  lastSaveErrorRef: React.RefObject<string | null>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;

  // Composer, workbench and run guards
  inputValue: string;
  cursor: number;
  workbenchVersion: number;
  planFlow: PlanFlowState;
  busy: boolean;
  stoppingRef: React.RefObject<Promise<void>>;
  workspaceLeaseRef: React.RefObject<OwnershipLease | undefined>;
  submissionRef: React.RefObject<boolean>;
  recoveryRef: React.RefObject<boolean>;
  pipelineGenerationRef: React.RefObject<number>;

  // Active-run bookkeeping (checkpoints, captures, lifecycle, control)
  activeRunIdRef: React.RefObject<number | null>;
  activeTurnIdRef: React.RefObject<number | null>;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
  runControlRef: React.RefObject<ProviderRunControl | null>;
  captureFinalRef: React.RefObject<((runId: number) => void) | null>;
  activeCheckpointRef: React.RefObject<{
    runId: number;
    checkpoint: FileCheckpoint;
    store: CheckpointStore;
  } | null>;
  processStoppedRef: React.RefObject<Promise<void>>;
  pendingCaptureRef: React.RefObject<Promise<void>>;
  deferredRouteCloseRef: React.RefObject<string | undefined>;
  activeRunCaptureRef: React.RefObject<ActiveRunCapture | null>;

  // Tool approval
  toolApprovalResolverRef: React.RefObject<((decision: ToolApprovalDecision) => void) | null>;
  setToolApproval: React.Dispatch<React.SetStateAction<ToolApprovalRequest | null>>;

  // Attachment and checkpoint registries
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  checkpointsRef: React.RefObject<FileCheckpoint[]>;
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  promptQueue: PromptQueue;

  // Session dispatch and plan flow
  dispatchSession: (action: SessionAction) => void;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;

  // Resume picker, viewers and conversation switches
  setResumeConversations: React.Dispatch<React.SetStateAction<ConversationListEntry[]>>;
  catalogListsRef: React.RefObject<Map<ExternalListScope, Promise<SessionCatalogResult>>>;
  resumePickerPositionRef: React.RefObject<ResumePickerPosition | undefined>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  workspaceRoot: string;
  launchContext: LaunchContext;
  exit: (errorOrResult?: Error | unknown) => void;
  setExternalViewerSession: React.Dispatch<React.SetStateAction<ExternalSessionSummary | null>>;
  externalViewerSession: ExternalSessionSummary | null;
  setSavedViewerSession: React.Dispatch<React.SetStateAction<SessionSummary | null>>;
  savedViewerSession: SessionSummary | null;
  startupResumeHandledRef: React.RefObject<boolean>;
  launchArgs: LaunchArgs;

  // Provider config and route override
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  providerOverride: BackendProvider | undefined;
  providerRegistry: ProviderConfig[];
  routeChoiceRequiredRef: React.RefObject<string | null>;
  setConversationRouteOverride: React.Dispatch<React.SetStateAction<ProviderRoute | null>>;

  // Focus routing and lifecycle
  busyRef: React.RefObject<boolean>;
  isMountedRef: React.RefObject<boolean>;
  intendedFocusTargetRef: React.RefObject<string>;
  focusManager: ReturnType<typeof useFocusManager>;
  pendingQuitRef: React.RefObject<(() => void) | null>;
  externalCliLaunchHooks: {
    stdin: NodeJS.ReadStream;
    beforeLaunch: () => void;
    afterLaunch: () => void;
  };

  // Usage totals and startup notices
  setConversationChars: React.Dispatch<React.SetStateAction<number>>;
  appendStaticEvent: (event: TimelineEvent) => void;
  projectInstructionsLoad: ProjectInstructionsLoadResult;
  providerMigrationNoticeShownRef: React.RefObject<boolean>;
}
