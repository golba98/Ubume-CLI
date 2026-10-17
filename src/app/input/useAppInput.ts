/**
 * Composer submission: decides what Enter does with the composer's text.
 *
 * `handleSubmit` routes a submission through these steps, stopping at the
 * first one that consumes it (see `submitSteps.ts`):
 *
 * 1. Direct commands — `/codexa`, `/perf`, workbench views, `/send-now`,
 *    `/resume <id>`.
 * 2. Shell — `!command`.
 * 3. Slash commands — parsed by `commands/handler.ts`, applied by
 *    `commandDispatch.ts`.
 * 4. Prompts — attachments are expanded, then the text is either an answer to
 *    the assistant's pending question, queued behind an active run, sent to
 *    Codexa, intercepted for outside-workspace paths, or started as a plan or
 *    a normal run.
 *
 * Submissions and slash commands never overlap: `submissionRef` and the
 * pipeline generation counter let a cancel or `/clear` abandon a submission
 * that is still waiting for attachments or a previous run.
 */

import { useCallback, useRef } from "react";
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
import * as perf from "../../core/perf/profiler.js";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import type { ProviderImageAttachment } from "../../core/providerRuntime/types.js";
import { sanitizeTerminalInput } from "../../core/terminal/terminalSanitize.js";
import type { GlobalPackageManager } from "../../core/version/packageManager.js";
import type { UpdateCheckResult } from "../../core/version/updateCheck.js";
import type { ConversationRecord } from "../../core/workspace/conversationStore.js";
import type { WorkspaceCommandContext } from "../../core/workspace/launchContext.js";
import type { ProjectInstructionsLoadResult } from "../../core/workspace/projectInstructions.js";
import { findUserPrompt, type SessionAction, type SessionState } from "../../session/appSession.js";
import { buildFollowUpPrompt } from "../../session/chatLifecycle.js";
import { createPromptRunTiming, type PromptRunTiming } from "../../session/eventIds.js";
import { type PlanFlowState, startPlanGeneration } from "../../session/planFlow.js";
import type { Screen, TimelineEvent, UIState } from "../../session/types.js";
import { type FileAttachment, type PromptQueue, queuedPrompt } from "../../session/workbench.js";
import {
  type ImageAttachmentRegistry,
  type PastedContentRegistry,
  selectImageAttachments,
} from "../../ui/input/pastedContent.js";
import type { PendingImportFile } from "../../ui/panels/AttachmentImportPanel.js";
import type { WorkbenchView } from "../../ui/panels/WorkbenchPanel.js";
import type { PromptRunLifecycle } from "../run/promptRunPrep.js";
import {
  expandPromptAttachments,
  handleShellSubmission,
  interceptOutsideWorkspacePaths,
  matchDirectCommand,
  routeSlashCommand,
} from "./submitSteps.js";

export interface UseAppInputContext {
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
  handleQuit: () => void;
  handleClear: () => Promise<void>;
  openResumePicker: () => void;
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
  modelCapabilities: CodexModelCapabilities | null;
  refreshModelCapabilities: (
    forceRefresh?: boolean,
    announce?: boolean,
  ) => Promise<CodexModelCapabilities>;
  updateCheckResult: UpdateCheckResult | null;
  requestUpdateCheck: () => Promise<UpdateCheckResult>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  globalPackageManager: GlobalPackageManager;
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  workspaceRoot: string;
  uiState: UIState;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
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

export function useAppInput(context: UseAppInputContext) {
  // handleSubmit is stable; each submission reads the context from the latest
  // render once, at the moment Enter is pressed.
  const latestContext = useRef(context);
  latestContext.current = context;

  const handleSubmit = useCallback(async () => {
    const submitTiming = createPromptRunTiming();
    perf.mark("submit");
    const ctx = latestContext.current;
    if (ctx.submissionRef.current || ctx.recoveryRef.current) {
      return;
    }
    const value = sanitizeTerminalInput(ctx.getSessionState().inputValue).trim();
    if (!value) {
      return;
    }

    // --- Commands -------------------------------------------------------------
    // Matching is synchronous so that ordinary slash commands below still
    // dispatch inside the key event, as discrete (immediately rendered) updates.
    const directCommand = matchDirectCommand(ctx, value, submitTiming);
    if (directCommand) {
      await directCommand();
      return;
    }
    if (value.startsWith("!")) {
      await handleShellSubmission(ctx, value);
      return;
    }
    const command = routeSlashCommand(ctx, value);
    if (command) {
      return command.result;
    }

    // --- Prompts ----------------------------------------------------------------
    const generation = ctx.pipelineGenerationRef.current;
    const providerValue = await expandPromptAttachments(ctx, value);
    if (providerValue === null) {
      return;
    }
    const imageAttachments = selectImageAttachments(value, ctx.imageAttachmentRegistryRef.current);

    // An answer to the assistant's pending question resumes that turn.
    const { uiState } = ctx;
    if (uiState.kind === "AWAITING_USER_ACTION") {
      const originalUserEvent = findUserPrompt(
        [...ctx.staticEvents, ...ctx.activeEvents],
        uiState.turnId,
      );
      if (!originalUserEvent) {
        ctx.appendEvent(
          "error",
          "Follow-up unavailable",
          "The original turn could not be found, so the answer could not be resumed.",
        );
        ctx.dispatchSession({ type: "UI_ACTION", action: { type: "DISMISS_TRANSIENT" } });
        return;
      }
      if (ctx.busy) {
        return;
      }
      ctx.startPromptRun(
        value,
        buildFollowUpPrompt({
          originalPrompt: originalUserEvent.prompt,
          assistantQuestion: uiState.question,
          userAnswer: providerValue,
        }),
        { submitTiming, commitPrompt: true, imageAttachments },
      );
      return;
    }

    // A cancel or /clear while attachments were being read abandons the prompt.
    if (generation !== ctx.pipelineGenerationRef.current) {
      return;
    }

    // Prompts sent while a run is active wait in the queue.
    if (ctx.activeRunIdRef.current !== null) {
      ctx.promptQueue.push(queuedPrompt(value, providerValue, imageAttachments));
      ctx.dispatchSession({ type: "PUSH_HISTORY", value });
      ctx.resetComposer();
      ctx.saveWorkbenchRef.current?.();
      ctx.bumpWorkbench((version) => version + 1);
      return;
    }

    // Codexa is conversational-only: no workspace checks, no action parsing.
    if (ctx.activeRouteProvider?.id === "codexa-native") {
      ctx.startPromptRun(value, providerValue, {
        submitTiming,
        commitPrompt: true,
        parseActionRequired: false,
        imageAttachments,
      });
      return;
    }

    if (interceptOutsideWorkspacePaths(ctx, value, providerValue)) {
      return;
    }

    if (ctx.planMode) {
      const nextPlanState = startPlanGeneration(providerValue, ctx.mode);
      ctx.setPlanFlow(nextPlanState);
      ctx.runPlanGeneration(nextPlanState, value, submitTiming, true, imageAttachments);
      return;
    }
    ctx.startPromptRun(value, providerValue, {
      submitTiming,
      commitPrompt: true,
      imageAttachments,
    });
  }, []);

  return { handleSubmit };
}
