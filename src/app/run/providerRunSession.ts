/**
 * One provider run, from scheduled start to cleanup. React-free.
 *
 * `usePromptRun` decides *whether* a prompt runs and creates the turn; this
 * module owns *the run itself*:
 *
 * 1. **Scheduling.** The provider starts only after the "starting" frame has
 *    been committed, so the user sees the prompt before any filesystem work.
 * 2. **Workspace preparation.** Take the workspace execution lease, capture a
 *    file checkpoint for rewind, and start the workspace activity tracker
 *    (Codex subprocess and Local routes).
 * 3. **Streaming.** Provider callbacks are batched through a live render
 *    scheduler. Every callback first checks that its run is still current,
 *    because a canceled or replaced run can keep emitting events.
 * 4. **Completion.** Response and error handlers flush pending live updates,
 *    then finalize the run on the next tick so the last streamed frame lands
 *    before the final one.
 * 5. **Cleanup.** `cleanupRef` is installed to cancel a not-yet-started run,
 *    do a final workspace poll, stop the tracker and the provider process.
 *
 * All mutable per-run state lives in this closure; shared state is reached
 * only through the refs and callbacks in {@link ProviderRunDeps}.
 */

import { isLikelyAuthFailure } from "../../core/codex/codexAuth.js";
import {
  detectHollowResponse,
  formatHollowResponse,
  getBlockedCleanupFailure,
} from "../../core/codex/codexPrompt.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import * as benchTrace from "../../core/perf/benchTrace.js";
import * as perf from "../../core/perf/profiler.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import {
  classifyProviderFailure,
  isModelFailure,
  modelRecoveryMessage,
  type ProviderFailure,
} from "../../core/providerRuntime/failures.js";
import type { ProviderImageAttachment, ProviderRoute } from "../../core/providerRuntime/types.js";
import { isNoiseLine } from "../../core/providers/codexTranscript.js";
import type {
  BackendProgressUpdate,
  BackendProvider,
  BackendRunHandlers,
  GenerationMetadata,
  ProviderRunControl,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../../core/providers/types.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { recordLocalContextUsage } from "../../core/usage/localUsageTracker.js";
import { buildUsageScopeKey } from "../../core/usage/normalize.js";
import {
  assertFileRecoveryReady,
  CheckpointStore,
  type FileBoundary,
  type FileCheckpoint,
} from "../../core/workspace/checkpoints.js";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationStore,
} from "../../core/workspace/conversationStore.js";
import { acquireOwnership, type OwnershipLease } from "../../core/workspace/ownership.js";
import type { ProjectInstructions } from "../../core/workspace/projectInstructions.js";
import {
  captureWorkspaceSnapshot,
  captureWorkspaceSnapshotAsync,
  createWorkspaceActivityTracker,
  createWorkspaceContentCache,
  diffWorkspaceSnapshots,
} from "../../core/workspace/workspaceActivity.js";
import type { SessionAction } from "../../session/appSession.js";
import { isCurrentRun } from "../../session/chatLifecycle.js";
import { createEventId, type PromptRunTiming } from "../../session/eventIds.js";
import {
  createLiveRenderScheduler,
  type LiveRenderUpdate,
  schedulePromptRunStartAfterVisibleCommit,
} from "../../session/liveRenderScheduler.js";
import type { PersistedFileActivity } from "../../session/persistedResponse.js";
import type { ExternalCliStatus, Screen } from "../../session/types.js";
import {
  type PromptQueue,
  ToolOutputBudget,
  type WorkbenchSnapshot,
} from "../../session/workbench.js";
import { saveConversationRecord } from "../conversation/conversationPersistence.js";
import {
  chooseFinalResponse,
  finishAfterLiveFlush,
  formatCodexAuthFailure,
  LIVE_UPDATE_FLUSH_MS,
  PROGRESS_ONLY_FLUSH_MS,
  type PromptRunLifecycle,
} from "./promptRunPrep.js";

type RunStatus = "completed" | "failed" | "canceled";

/** Text, tools and files a run produced, kept for the saved assistant message. */
export interface ActiveRunCapture {
  runId: number;
  text: string;
  tools: Map<string, string>;
  files: Map<string, PersistedFileActivity>;
  generationMetadata?: GenerationMetadata;
}

/** Shared app state and services a provider run reads or updates. */
export interface ProviderRunDeps {
  // Run inputs
  workspaceRoot: string;
  backend: "codex-subprocess";
  projectInstructions: ProjectInstructions | null;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  promptQueue: PromptQueue;
  conversationStore: ConversationStore;
  selectionCoordinator: SelectionCoordinator;

  // Run identity and output capture
  activeRunIdRef: React.RefObject<number | null>;
  activeRunCaptureRef: React.RefObject<ActiveRunCapture | null>;
  rolloverResponseCharsRef: React.RefObject<number>;

  // Live-render completion
  finalFlushRef: React.RefObject<{ runId: number; flush: () => void } | null>;

  // Provider process control
  processStoppedRef: React.RefObject<Promise<void>>;
  runControlRef: React.RefObject<ProviderRunControl | null>;
  stoppingRef: React.RefObject<Promise<void>>;
  cleanupRef: React.RefObject<(() => void) | null>;

  // Workspace lease and rewind checkpoints
  workspaceLeaseRef: React.RefObject<OwnershipLease | undefined>;
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  checkpointsRef: React.RefObject<FileCheckpoint[]>;
  activeCheckpointRef: React.RefObject<{
    runId: number;
    checkpoint: FileCheckpoint;
    store: CheckpointStore;
  } | null>;
  pendingCaptureRef: React.RefObject<Promise<void>>;

  // Conversation persistence
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;
  snapshotRef: React.RefObject<(() => WorkbenchSnapshot) | null>;
  lastSaveErrorRef: React.RefObject<string | null>;

  // UI and tool approval
  externalCliStatusRef: React.RefObject<ExternalCliStatus>;
  toolApprovalResolverRef: React.RefObject<((decision: ToolApprovalDecision) => void) | null>;

  // Session and UI callbacks
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  dispatchSession: (action: SessionAction) => void;
  finalizePromptRun: (
    runId: number,
    turnId: number,
    status: RunStatus,
    message?: string,
    response?: string,
    persistedResponse?: string,
  ) => boolean;
  setConversationChars: React.Dispatch<React.SetStateAction<number>>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  setToolApproval: React.Dispatch<React.SetStateAction<ToolApprovalRequest | null>>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  refreshAuthStatus: (announce: boolean) => Promise<void>;
}

/** Everything decided about this run before it starts. */
export interface ProviderRunPlan {
  // Identity
  runId: number;
  turnId: number;

  // Route, lifecycle and timing
  route: ProviderRoute;
  lifecycle: PromptRunLifecycle;
  submitTiming: PromptRunTiming;

  // Prompts
  safeDisplayPrompt: string;
  safeProviderPrompt: string;

  // Runtime
  runtimeForTurn: Parameters<NonNullable<BackendProvider["run"]>>[1]["runtime"];
  fastCleanupRun: boolean;
  effectiveMode: string;

  // Provider content
  conversationHistory: readonly ConversationMessage[];
  imageAttachments: readonly ProviderImageAttachment[];

  // Model evidence and provider entry point
  /** Connection and selection revision used to record model evidence. */
  modelConnection: string;
  modelRevision: number;
  runProvider: NonNullable<BackendProvider["run"]>;
}

const OUTPUT_SANITIZE_OPTIONS = { preserveTabs: false, tabSize: 2 } as const;

/** What a provider error means for the user and for model evidence. */
export function describeRunFailure(input: {
  message: string;
  rawOutput: string | undefined;
  evidence: ProviderFailure | undefined;
  route: ProviderRoute;
}): { failure: ProviderFailure; failureMessage: string; codexAuthFailure: boolean } {
  const safeMessage = sanitizeTerminalOutput(input.message);
  const safeRawOutput = sanitizeTerminalOutput(input.rawOutput ?? "");
  const combinedOutput = [safeMessage, safeRawOutput].filter(Boolean).join("\n");
  // The recovery hint is Codex-specific; other providers report their own auth errors.
  const codexAuthFailure =
    input.route.providerId === "openai" && isLikelyAuthFailure(combinedOutput);
  const failure = input.evidence ?? classifyProviderFailure(safeMessage);
  const failureMessage = isModelFailure(failure)
    ? `${modelRecoveryMessage(input.route.modelId)}\n${safeMessage}`
    : formatCodexAuthFailure(safeMessage, codexAuthFailure);
  return { failure, failureMessage, codexAuthFailure };
}

/**
 * Merges newly observed file activity into a run's file map. A file the run
 * created stays "created" even when it is modified again afterwards.
 */
export function mergeFileActivity(
  files: Map<string, PersistedFileActivity>,
  activity: readonly PersistedFileActivity[],
): void {
  for (const entry of activity) {
    const previous = files.get(entry.path);
    if (previous?.operation === "created" && entry.operation === "modified") {
      continue;
    }
    files.set(entry.path, { path: entry.path, operation: entry.operation });
  }
}

/** Starts a provider run (after the next visible frame) and installs its cleanup. */
export function startProviderRunSession(deps: ProviderRunDeps, plan: ProviderRunPlan): void {
  if (benchTrace.streamTraceEnabled) benchTrace.beginStreamTrace();
  const { runId, turnId, route, lifecycle, submitTiming, safeProviderPrompt } = plan;
  const isPlanPresentation = lifecycle.responsePresentation === "plan";
  const isCurrent = () => isCurrentRun(deps.activeRunIdRef.current, runId);

  // --- Per-run state --------------------------------------------------------

  const toolOutputBudget = new ToolOutputBudget();
  let streamedAssistantContent = "";
  // Plan runs: text streamed since the last tool call. The reducer demotes
  // pre-tool text to prose (chatLifecycle.demoteActivePlanToResponseSegment),
  // so the plan handed to planFlow must be the same trailing section.
  let planSectionContent = "";
  const planSeenToolIds = new Set<string>();
  let legacyProgressSequence = 0;
  let firstRenderFired = false;
  let finalAnswerVisibleFired = false;
  let blockedCleanupFailureSurfaced = false;

  let preRunSnapshot: ReturnType<typeof captureWorkspaceSnapshot> | null = null;
  // Shared by the baseline, the tracker's polls and the final polls, so unchanged files are
  // read once per run rather than on every scan.
  const workspaceContentCache = createWorkspaceContentCache();
  let finalWorkspacePollDone = false;
  let activityTracker: ReturnType<typeof createWorkspaceActivityTracker> | null = null;

  let stopProviderRun: (() => void) | undefined;
  let cancelScheduledProviderStart: (() => void) | null = null;
  let providerStartCancelled = false;
  let startupBegan = false;
  let resolveStartup: () => void = () => undefined;

  // Until the provider reports its own run control, "stopped" means
  // "startup finished" (or never began).
  deps.processStoppedRef.current = new Promise<void>((resolve) => {
    resolveStartup = resolve;
  });
  deps.runControlRef.current = null;

  // --- Live rendering ---------------------------------------------------------

  const liveScheduler = createLiveRenderScheduler({
    assistantFlushMs: LIVE_UPDATE_FLUSH_MS,
    progressOnlyFlushMs: PROGRESS_ONLY_FLUSH_MS,
    flush: (updates: LiveRenderUpdate[]) => {
      if (!isCurrent()) {
        return;
      }
      if (!firstRenderFired && updates.some((update) => update.type === "assistant")) {
        firstRenderFired = true;
        perf.mark("first_render");
      }
      if (benchTrace.streamTraceEnabled) {
        for (const update of updates) {
          benchTrace.streamMark("flush", "chunk" in update ? update.chunk : JSON.stringify(update));
        }
      }
      deps.dispatchSession({
        type: "RUN_APPLY_LIVE_UPDATES",
        turnId,
        runId,
        updates,
        assistantEventFactory: (chunk) => ({
          id: createEventId(),
          type: "assistant",
          createdAt: Date.now(),
          content: "",
          contentChunks: [chunk],
          turnId,
        }),
      });
    },
  });

  /** Flushes queued live updates now; returns whether anything was written. */
  const flushLiveUpdates = (): boolean => {
    perf.inc("flushes");
    return liveScheduler.flushNow();
  };

  deps.finalFlushRef.current = {
    runId,
    flush: () => {
      flushLiveUpdates();
    },
  };

  const traceLiveRunDiagnostics = (status: RunStatus) => {
    const stats = liveScheduler.getStats();
    const now = performance.now();
    renderDebug.traceEvent("run", "liveBatchSummary", {
      runId,
      turnId,
      status,
      promptSubmitEpochMs: submitTiming.submitEpochMs,
      promptSubmitMonotonicMs: submitTiming.submitMonotonicMs,
      finalRenderMonotonicMs: now,
      elapsedWallMs: Math.max(0, Math.round(now - submitTiming.submitMonotonicMs)),
      providerEventsReceived: stats.providerEvents,
      uiFlushes: stats.flushes,
      averageFlushIntervalMs: stats.averageFlushIntervalMs,
      maxFlushIntervalMs: stats.maxFlushIntervalMs,
    });
  };

  // Any provider output (text, tool calls, reasoning) proves the CLI is up,
  // so the composer stops reporting "Still waiting for <CLI>".
  const markExternalCliReady = () => {
    if (deps.externalCliStatusRef.current === "ready") {
      return;
    }
    deps.externalCliStatusRef.current = "ready";
    deps.dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "ready" });
  };

  const captureFileActivity = (activity: readonly PersistedFileActivity[]) => {
    const capture = deps.activeRunCaptureRef.current;
    if (capture?.runId === runId) {
      mergeFileActivity(capture.files, activity);
    }
  };

  const saveConversation = (
    next: ConversationRecord,
    options: { title: string; rememberError?: boolean },
  ) => {
    deps.activeConversationRef.current = next;
    saveConversationRecord(
      next,
      {
        conversationStore: deps.conversationStore,
        snapshotRef: deps.snapshotRef,
        lastSaveErrorRef: deps.lastSaveErrorRef,
        appendEvent: deps.appendEvent,
      },
      options,
    );
  };

  // --- Workspace preparation ------------------------------------------------

  const releaseWorkspaceLease = () => {
    deps.workspaceLeaseRef.current?.release();
    deps.workspaceLeaseRef.current = undefined;
  };

  /**
   * Takes the workspace lease, captures the rewind checkpoint and starts the
   * activity tracker. Returns false when the run must not start (the
   * workspace is busy, or the run was canceled meanwhile).
   */
  const prepareRunWorkspace = async (): Promise<boolean> => {
    try {
      deps.workspaceLeaseRef.current = acquireOwnership(deps.workspaceRoot, "execution");
      await assertFileRecoveryReady(deps.workspaceRoot);
    } catch (error) {
      releaseWorkspaceLease();
      deps.appendEvent("error", "Workspace busy", (error as Error).message);
      deps.finalizePromptRun(runId, turnId, "failed", (error as Error).message);
      return false;
    }
    if (providerStartCancelled || !isCurrent()) {
      releaseWorkspaceLease();
      return false;
    }

    const conversation = deps.activeConversationRef.current;
    if (conversation) {
      deps.restoredFileBoundaryRef.current = undefined;
      const checkpointStore = new CheckpointStore(deps.workspaceRoot, conversation.metadata.id);
      const checkpoint: FileCheckpoint = {
        id: String(runId),
        turnId,
        // Messages before this turn; its user message is already appended.
        messageCount: conversation.messages.length - 1,
        prompt: plan.safeDisplayPrompt,
        before: { files: {}, complete: false, skipped: [] },
      };
      deps.checkpointsRef.current.push(checkpoint);
      deps.activeCheckpointRef.current = { runId, checkpoint, store: checkpointStore };
      const capture = checkpointStore.capture().then((boundary) => {
        checkpoint.before = boundary;
      });
      deps.pendingCaptureRef.current = capture;
      try {
        await capture;
      } catch (error) {
        deps.appendEvent("error", "Checkpoint unavailable", (error as Error).message);
      }
      deps.saveWorkbenchRef.current?.();
    }
    if (providerStartCancelled || !isCurrent()) {
      return false;
    }

    // Capture the workspace state after the visible run has had a chance to
    // render, so first-prompt filesystem work cannot block initial progress.
    const tracksWorkspace =
      (route.providerId === "openai" && deps.backend === "codex-subprocess") ||
      route.providerId === "local";
    if (tracksWorkspace) {
      // Asynchronous so a large workspace cannot freeze the visible starting frame.
      const baseline = await captureWorkspaceSnapshotAsync(
        deps.workspaceRoot,
        workspaceContentCache,
      );
      if (providerStartCancelled || !isCurrent()) {
        return false;
      }
      preRunSnapshot = baseline;
      activityTracker = createWorkspaceActivityTracker({
        rootDir: deps.workspaceRoot,
        initialSnapshot: preRunSnapshot,
        contentCache: workspaceContentCache,
        onActivity: (activity) => {
          if (!isCurrent()) {
            return;
          }
          captureFileActivity(activity);
          liveScheduler.enqueue({ type: "activity", activity });
        },
      });
    }
    return true;
  };

  // --- Provider callbacks -----------------------------------------------------

  const onGenerationMetadata: BackendRunHandlers["onGenerationMetadata"] = (metadata) => {
    const capture = deps.activeRunCaptureRef.current;
    if (!isCurrent() || capture?.runId !== runId) {
      return;
    }
    capture.generationMetadata = metadata;
    if (route.providerId === "codexa-native") {
      deps.appendEvent(
        "system",
        "Codexa response",
        `${metadata.modelId} · ${metadata.finishReason} · ${metadata.generatedTokens} tokens · ${metadata.preset}`,
      );
    }
  };

  const onAssistantDelta: BackendRunHandlers["onAssistantDelta"] = (chunk) => {
    benchTrace.streamMark("handler", chunk);
    if (!chunk || !isCurrent()) {
      return;
    }
    const sanitizeStart = performance.now();
    const safeChunk = sanitizeTerminalOutput(chunk, OUTPUT_SANITIZE_OPTIONS);
    perf.accumulate("sanitize_ms", performance.now() - sanitizeStart);
    perf.inc("chunks");
    if (!safeChunk) {
      return;
    }
    markExternalCliReady();
    benchTrace.streamMark("normalize", safeChunk);
    liveScheduler.enqueue({ type: isPlanPresentation ? "plan" : "assistant", chunk: safeChunk });
    benchTrace.streamMark("schedule", safeChunk);
    streamedAssistantContent += safeChunk;
    const capture = deps.activeRunCaptureRef.current;
    if (capture?.runId === runId) {
      capture.text += safeChunk;
    }
    if (isPlanPresentation) {
      planSectionContent += safeChunk;
    }
  };

  const onFinalAnswerObserved: BackendRunHandlers["onFinalAnswerObserved"] = (response) => {
    if (!isCurrent() || finalAnswerVisibleFired) {
      return;
    }
    const flushedLiveUpdates = flushLiveUpdates();
    const markFinalAnswerVisible = () => {
      if (!isCurrent() || finalAnswerVisibleFired) {
        return;
      }
      finalAnswerVisibleFired = true;
      const safeResponse = sanitizeTerminalOutput(response, OUTPUT_SANITIZE_OPTIONS);
      deps.dispatchSession({
        type: "RUN_MARK_FINAL_ANSWER_OBSERVED",
        runId,
        turnId,
        // Plan runs keep their text in the plan block; the reducer also
        // guards this, but never offer text that would be synthesized
        // into a duplicate response segment.
        response: !isPlanPresentation && safeResponse.trim() ? safeResponse : undefined,
      });
      perf.mark("final_answer_visible");
    };
    finishAfterLiveFlush(flushedLiveUpdates, markFinalAnswerVisible);
  };

  const onToolActivity: BackendRunHandlers["onToolActivity"] = (activity) => {
    benchTrace.streamMark("handler", activity.command);
    if (!isCurrent()) {
      return;
    }
    markExternalCliReady();
    const capture = deps.activeRunCaptureRef.current;
    if (capture?.runId === runId) {
      capture.tools.set(activity.id, activity.command);
    }
    if (isPlanPresentation && !planSeenToolIds.has(activity.id)) {
      // First sight of a tool: mirrors the reducer's insert-only demotion.
      planSeenToolIds.add(activity.id);
      planSectionContent = "";
    }
    const boundedActivity = toolOutputBudget.bound(activity);
    benchTrace.streamMark("normalize", boundedActivity.command);
    liveScheduler.enqueue({ type: "tool", activity: boundedActivity });
    benchTrace.streamMark("schedule", boundedActivity.command);
    if (activity.status === "running") {
      return;
    }

    // The fast cleanup profile fails fast when a cleanup command is blocked,
    // rather than letting the model improvise a riskier alternative.
    if (plan.fastCleanupRun && !blockedCleanupFailureSurfaced) {
      const blockedCleanupFailure = getBlockedCleanupFailure(activity);
      if (blockedCleanupFailure) {
        blockedCleanupFailureSurfaced = true;
        flushLiveUpdates();
        traceLiveRunDiagnostics("failed");
        void deps.finalizePromptRun(runId, turnId, "failed", blockedCleanupFailure);
      }
    }
  };

  /** Pauses the queue and shows the approval overlay; a newer request denies the older one. */
  const onToolApproval: BackendRunHandlers["onToolApproval"] = (request) =>
    new Promise<ToolApprovalDecision>((resolve) => {
      deps.toolApprovalResolverRef.current?.("deny");
      deps.toolApprovalResolverRef.current = resolve;
      deps.promptQueue.paused = true;
      deps.bumpWorkbench((value) => value + 1);
      deps.setToolApproval(request);
      deps.setScreen("tool-approval");
    });

  /**
   * Forces one final synchronous workspace poll so file changes made just
   * before the provider finished are not missed between tracker intervals.
   */
  const pollLateWorkspaceActivity = () => {
    if (!activityTracker || !preRunSnapshot) {
      return;
    }
    try {
      perf.mark("snapshot_start");
      const finalSnapshot = captureWorkspaceSnapshot(deps.workspaceRoot, workspaceContentCache);
      perf.mark("snapshot_end");
      const lateActivity = diffWorkspaceSnapshots(preRunSnapshot, finalSnapshot);
      if (lateActivity.length > 0) {
        captureFileActivity(lateActivity);
        liveScheduler.enqueue({ type: "activity", activity: lateActivity });
      }
    } catch {
      // Best effort: a failed final poll must not fail a completed run.
    } finally {
      finalWorkspacePollDone = true;
    }
  };

  const finalizeResponse = (response: string) => {
    if (!isCurrent()) {
      return;
    }
    const safeResponse = sanitizeTerminalOutput(response, OUTPUT_SANITIZE_OPTIONS);
    // Text already counted by a context rollover is not counted twice.
    const newlyVisibleResponseChars = Math.max(
      0,
      safeResponse.length - deps.rolloverResponseCharsRef.current,
    );
    deps.rolloverResponseCharsRef.current = 0;
    deps.setConversationChars((count) => count + newlyVisibleResponseChars);

    // For write-intent prompts, a filler reply like "Hello." instead of
    // execution feedback gets a warning so the user is not silently misled.
    if (plan.effectiveMode !== "suggest" && route.providerId !== "codexa-native") {
      const hollow = detectHollowResponse(safeProviderPrompt, safeResponse);
      if (hollow.isHollow) {
        traceLiveRunDiagnostics("completed");
        void deps.finalizePromptRun(
          runId,
          turnId,
          "completed",
          undefined,
          formatHollowResponse(hollow, safeResponse),
        );
        return;
      }
    }

    // When the streamed text already shows the response, pass undefined so
    // FINALIZE_RUN keeps the rendered stream instead of flashing a re-render.
    const finalResponse = chooseFinalResponse(
      streamedAssistantContent,
      safeResponse,
      planSectionContent,
      lifecycle.responsePresentation,
    );
    traceLiveRunDiagnostics("completed");
    void deps.finalizePromptRun(runId, turnId, "completed", undefined, finalResponse, safeResponse);
  };

  const onResponse: BackendRunHandlers["onResponse"] = (response) => {
    if (!isCurrent()) {
      return;
    }
    // A completed response proves the model works on this connection.
    deps.selectionCoordinator.validate(plan.modelConnection, route, plan.modelRevision);
    perf.mark("response_cb_start");
    pollLateWorkspaceActivity();
    const flushedLiveUpdates = flushLiveUpdates();
    finishAfterLiveFlush(flushedLiveUpdates, () => finalizeResponse(response));
  };

  const onError: BackendRunHandlers["onError"] = (message, rawOutput, evidence) => {
    if (!isCurrent()) {
      return;
    }
    deps.rolloverResponseCharsRef.current = 0;
    const flushedLiveUpdates = flushLiveUpdates();
    const finalizeError = () => {
      if (!isCurrent()) {
        return;
      }
      const { failure, failureMessage, codexAuthFailure } = describeRunFailure({
        message,
        rawOutput,
        evidence,
        route,
      });
      // The revision makes sure this error cannot reject a model the user has
      // re-selected since the run started.
      deps.selectionCoordinator.reject(
        plan.modelConnection,
        route.modelId,
        failure,
        plan.modelRevision,
      );
      if (codexAuthFailure) {
        // Re-probe instead of assuming signed-out: a misclassified error
        // must not block every later run behind the auth gate.
        void deps.refreshAuthStatus(false);
      }
      traceLiveRunDiagnostics("failed");
      void deps.finalizePromptRun(runId, turnId, "failed", failureMessage);
    };
    finishAfterLiveFlush(flushedLiveUpdates, finalizeError);
  };

  const onProgress: BackendRunHandlers["onProgress"] = (update) => {
    perf.inc("progress_updates");
    const safeText = sanitizeTerminalOutput(update.text);
    if (!safeText || isNoiseLine(safeText) || !isCurrent()) {
      return;
    }
    markExternalCliReady();
    const safeUpdate: BackendProgressUpdate = {
      id: update.id?.trim() ? update.id : `legacy-progress-${++legacyProgressSequence}`,
      source: update.source,
      text: safeText,
    };
    liveScheduler.enqueue({ type: "progress", update: safeUpdate });
  };

  /** Local and Codexa compact their own context window and report checkpoints. */
  const onLocalContextCheckpoint: BackendRunHandlers["onLocalContextCheckpoint"] = (checkpoint) => {
    const current = deps.activeConversationRef.current;
    const ownsContext = route.providerId === "local" || route.providerId === "codexa-native";
    if (!current || !ownsContext) {
      return;
    }
    deps.rolloverResponseCharsRef.current = checkpoint.responseCharsCovered ?? 0;
    if (typeof checkpoint.activeWindowChars === "number") {
      deps.setConversationChars(checkpoint.activeWindowChars);
    }
    saveConversation(
      { ...current, metadata: { ...current.metadata, localContextCheckpoint: checkpoint } },
      { title: "Context checkpoint save failed" },
    );
  };

  /** Remembers the provider CLI's own session id so the run can be resumed natively. */
  const onNativeSession: BackendRunHandlers["onNativeSession"] = (reference) => {
    const current = deps.activeConversationRef.current;
    if (!current || !isCurrent()) {
      return;
    }
    const otherSessions = (current.metadata.nativeSessions ?? []).filter(
      (previous) =>
        previous.source !== reference.source || previous.sessionId !== reference.sessionId,
    );
    deps.activeConversationRef.current = {
      ...current,
      metadata: { ...current.metadata, nativeSessions: [...otherSessions, reference] },
    };
    deps.saveWorkbenchRef.current?.();
  };

  /**
   * Tracks the Local harness session backing this conversation. A `null`
   * session clears it, but only if it is still the session being reported.
   */
  const onLocalHarnessSession: BackendRunHandlers["onLocalHarnessSession"] = (
    session,
    sessionId,
  ) => {
    const current = deps.activeConversationRef.current;
    if (!current || route.providerId !== "local" || !isCurrent()) {
      return;
    }
    if (!session && current.metadata.localHarnessSession?.sessionId !== sessionId) {
      return;
    }
    const { localHarnessSession: _previousSession, ...metadata } = current.metadata;
    saveConversation(
      {
        ...current,
        metadata: session ? { ...metadata, localHarnessSession: session } : metadata,
      },
      { title: "Local chat save failed", rememberError: true },
    );
  };

  const onRunControl: BackendRunHandlers["onRunControl"] = (control) => {
    if (isCurrent()) {
      deps.runControlRef.current = control;
      deps.processStoppedRef.current = control.stopped;
    }
  };

  const onContextUsage: BackendRunHandlers["onContextUsage"] = (usage) => {
    if (!isCurrent()) {
      return;
    }
    recordLocalContextUsage(
      buildUsageScopeKey(route, deps.providerWorkspaceConfig.providers?.[route.providerId]),
      usage,
      Date.now(),
    );
    // A failed turn can report zero usage; keep the known conversation size.
    if (usage.contextTokens > 0) {
      deps.setConversationChars(Math.max(0, usage.contextTokens * 4));
    }
  };

  // --- Start and cleanup ------------------------------------------------------

  const startProviderRun = async () => {
    if (providerStartCancelled || !isCurrent()) {
      return;
    }
    if (!(await prepareRunWorkspace())) {
      return;
    }

    perf.mark("provider_run_start");
    const ownsContext = route.providerId === "local" || route.providerId === "codexa-native";
    stopProviderRun = plan.runProvider(
      safeProviderPrompt,
      {
        runtime: plan.runtimeForTurn,
        workspaceRoot: deps.workspaceRoot,
        projectInstructions: deps.projectInstructions,
        runIntent: lifecycle.runIntent ?? "normal",
        conversationHistory: plan.conversationHistory,
        localContextCheckpoint: ownsContext
          ? deps.activeConversationRef.current?.metadata.localContextCheckpoint
          : undefined,
        imageAttachments: plan.imageAttachments,
      },
      {
        onGenerationMetadata,
        onAssistantDelta,
        onFinalAnswerObserved,
        onToolActivity,
        onToolApproval,
        onResponse,
        onError,
        onProgress,
        onLocalContextCheckpoint,
        onNativeSession,
        onLocalHarnessSession,
        onRunControl,
        onContextUsage,
      },
    );
  };

  cancelScheduledProviderStart = schedulePromptRunStartAfterVisibleCommit(() => {
    startupBegan = true;
    void startProviderRun()
      .catch((error) => {
        deps.finalizePromptRun(runId, turnId, "failed", (error as Error).message);
      })
      .finally(resolveStartup);
  });

  deps.cleanupRef.current = () => {
    providerStartCancelled = true;
    cancelScheduledProviderStart?.();
    if (!startupBegan) {
      resolveStartup();
    }
    deps.stoppingRef.current = deps.processStoppedRef.current;
    flushLiveUpdates();
    // One final sync poll before stopping the tracker captures any
    // last-moment file changes that were in flight.
    if (activityTracker && preRunSnapshot && !finalWorkspacePollDone) {
      try {
        const cleanupSnapshot = captureWorkspaceSnapshot(deps.workspaceRoot, workspaceContentCache);
        const lastActivity = diffWorkspaceSnapshots(preRunSnapshot, cleanupSnapshot);
        if (lastActivity.length > 0 && isCurrent()) {
          deps.dispatchSession({ type: "RUN_APPEND_ACTIVITY", runId, activity: lastActivity });
        }
      } catch {
        // Best effort during cleanup.
      }
    }
    activityTracker?.stop();
    stopProviderRun?.();
    liveScheduler.cancel();
  };
}
