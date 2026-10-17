/**
 * Conversation lifecycle for the interactive app: the active conversation
 * record and its autosave, switching conversations (/resume, imports,
 * relaunches), and one-time startup notices.
 *
 * This hook only composes three focused hooks, in this order so their
 * effects keep their original declaration order:
 * 1. `useActiveConversation` — create, append, autosave, final checkpoints.
 * 2. `useResumeFlows` — resume picker and every conversation switch.
 * 3. `useStartupNotices` — migration and project-instruction notices.
 */

import type { useFocusManager } from "ink";
import type { LaunchArgs } from "../../config/launchArgs.js";
import type { ExternalSessionSummary } from "../../core/externalSessions/index.js";
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
import { useActiveConversation } from "./useActiveConversation.js";
import { useResumeFlows } from "./useResumeFlows.js";
import { useStartupNotices } from "./useStartupNotices.js";

export interface UseConversationContext {
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
  inputValue: string;
  cursor: number;
  workbenchVersion: number;
  planFlow: PlanFlowState;
  busy: boolean;
  stoppingRef: React.RefObject<Promise<void>>;
  workspaceLeaseRef: React.RefObject<OwnershipLease | undefined>;
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
  setResumeConversations: React.Dispatch<React.SetStateAction<ConversationListEntry[]>>;
  catalogListsRef: React.RefObject<Map<ExternalListScope, Promise<SessionCatalogResult>>>;
  resumePickerPositionRef: React.RefObject<ResumePickerPosition | undefined>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  workspaceRoot: string;
  activeRunIdRef: React.RefObject<number | null>;
  submissionRef: React.RefObject<boolean>;
  recoveryRef: React.RefObject<boolean>;
  launchContext: LaunchContext;
  exit: (errorOrResult?: Error | unknown) => void;
  setExternalViewerSession: React.Dispatch<React.SetStateAction<ExternalSessionSummary | null>>;
  externalViewerSession: ExternalSessionSummary | null;
  setSavedViewerSession: React.Dispatch<React.SetStateAction<SessionSummary | null>>;
  busyRef: React.RefObject<boolean>;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  isMountedRef: React.RefObject<boolean>;
  externalCliLaunchHooks: {
    stdin: NodeJS.ReadStream;
    beforeLaunch: () => void;
    afterLaunch: () => void;
  };
  setConversationChars: React.Dispatch<React.SetStateAction<number>>;
  pipelineGenerationRef: React.RefObject<number>;
  runControlRef: React.RefObject<ProviderRunControl | null>;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
  activeTurnIdRef: React.RefObject<number | null>;
  toolApprovalResolverRef: React.RefObject<((decision: ToolApprovalDecision) => void) | null>;
  setToolApproval: React.Dispatch<React.SetStateAction<ToolApprovalRequest | null>>;
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  checkpointsRef: React.RefObject<FileCheckpoint[]>;
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  promptQueue: PromptQueue;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  dispatchSession: (action: SessionAction) => void;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  providerOverride: BackendProvider | undefined;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  setConversationRouteOverride: React.Dispatch<React.SetStateAction<ProviderRoute | null>>;
  intendedFocusTargetRef: React.RefObject<string>;
  focusManager: ReturnType<typeof useFocusManager>;
  pendingQuitRef: React.RefObject<(() => void) | null>;
  providerRegistry: ProviderConfig[];
  savedViewerSession: SessionSummary | null;
  startupResumeHandledRef: React.RefObject<boolean>;
  launchArgs: LaunchArgs;
  providerMigrationNoticeShownRef: React.RefObject<boolean>;
  appendStaticEvent: (event: TimelineEvent) => void;
  projectInstructionsLoad: ProjectInstructionsLoadResult;
}

export function useConversation(context: UseConversationContext) {
  const activeConversation = useActiveConversation(context);
  const resumeFlows = useResumeFlows({
    ...context,
    saveActiveConversation: activeConversation.saveActiveConversation,
  });
  useStartupNotices(context);
  return { ...activeConversation, ...resumeFlows };
}
