import { useCallback } from "react";
import type { RuntimeConfig } from "../config/runtimeConfig.js";
import {
  type CodexAuthProbeResult,
  getRunGateDecision,
  isLikelyAuthFailure,
} from "../core/codex/codexAuth.js";
import {
  detectHollowResponse,
  formatHollowResponse,
  getBlockedCleanupFailure,
} from "../core/codex/codexPrompt.js";
import { catalogContextKey } from "../core/models/modelCatalog.js";
import type { SelectionCoordinator } from "../core/models/selectionCoordinator.js";
import * as perf from "../core/perf/profiler.js";
import * as renderDebug from "../core/perf/renderDebug.js";
import type { ProviderConfig, ProviderWorkspaceConfig } from "../core/providerLauncher/types.js";
import type { ModelContextMetadata } from "../core/providerRuntime/contextMetadata.js";
import {
  classifyProviderFailure,
  isModelFailure,
  modelRecoveryMessage,
} from "../core/providerRuntime/failures.js";
import { formatRuntimeProviderLabel } from "../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../core/providerRuntime/types.js";
import { isNoiseLine } from "../core/providers/codexTranscript.js";
import type {
  BackendProgressUpdate,
  BackendProvider,
  ProviderRunControl,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../core/providers/types.js";
import {
  sanitizeTerminalInput,
  sanitizeTerminalOutput,
} from "../core/terminal/terminalSanitize.js";
import { recordLocalContextUsage } from "../core/usage/localUsageTracker.js";
import { buildUsageScopeKey } from "../core/usage/normalize.js";
import type { FileBoundary } from "../core/workspace/checkpoints.js";
import {
  assertFileRecoveryReady,
  CheckpointStore,
  type FileCheckpoint,
} from "../core/workspace/checkpoints.js";
import type {
  ConversationMessage,
  ConversationRecord,
  ConversationStore,
} from "../core/workspace/conversationStore.js";
import { acquireOwnership, type OwnershipLease } from "../core/workspace/ownership.js";
import type { ProjectInstructions } from "../core/workspace/projectInstructions.js";
import {
  captureWorkspaceSnapshot,
  createWorkspaceActivityTracker,
  diffWorkspaceSnapshots,
} from "../core/workspace/workspaceActivity.js";
import { getPromptWorkspaceGuardMessage } from "../core/workspace/workspaceGuard.js";
import type { SessionAction } from "../session/appSession.js";
import { createRunEvent, isCurrentRun } from "../session/chatLifecycle.js";
import {
  createEventId,
  createPromptRunTiming,
  createTurnId,
  type PromptRunTiming,
} from "../session/eventIds.js";
import {
  createLiveRenderScheduler,
  type LiveRenderUpdate,
  schedulePromptRunStartAfterVisibleCommit,
} from "../session/liveRenderScheduler.js";
import type { PersistedFileActivity } from "../session/persistedResponse.js";
import type { ExternalCliStatus, Screen, UserPromptEvent } from "../session/types.js";
import {
  type PromptQueue,
  ToolOutputBudget,
  type WorkbenchSnapshot,
} from "../session/workbench.js";
import { saveConversationRecord } from "./conversationPersistence.js";
import {
  chooseFinalResponse,
  finishAfterLiveFlush,
  formatCodexAuthFailure,
  LIVE_UPDATE_FLUSH_MS,
  PROGRESS_ONLY_FLUSH_MS,
  type PromptRunLifecycle,
  preparePromptRun,
  selectProviderHistory,
} from "./promptRunPrep.js";

interface UsePromptRunContext {
  selectionCoordinator: SelectionCoordinator;
  pendingRouteProviderId: ProviderRoute["providerId"] | null;
  activeRunIdRef: React.RefObject<number | null>;
  recoveryRef: React.RefObject<boolean>;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  workspaceRoot: string;
  allowedWritableRoots: string[];
  activeProviderRoute: ProviderRoute;
  activeRouteProvider: ProviderConfig;
  runtimeConfig: RuntimeConfig;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  provider: BackendProvider;
  providerOverride: BackendProvider | undefined;
  backend: "codex-subprocess";
  authStatus: CodexAuthProbeResult;
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  activeContextMetadata: ModelContextMetadata | null;
  promptQueue: PromptQueue;
  appendConversationMessage: (message: ConversationMessage) => void;
  setConversationChars: React.Dispatch<React.SetStateAction<number>>;
  activeRunCaptureRef: React.RefObject<{
    runId: number;
    text: string;
    tools: Map<string, string>;
    files: Map<string, PersistedFileActivity>;
  } | null>;
  rolloverResponseCharsRef: React.RefObject<number>;
  activeTurnIdRef: React.RefObject<number | null>;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
  externalCliStatusRef: React.RefObject<ExternalCliStatus>;
  dispatchSession: (action: SessionAction) => void;
  finalFlushRef: React.RefObject<{ runId: number; flush: () => void } | null>;
  processStoppedRef: React.RefObject<Promise<void>>;
  runControlRef: React.RefObject<ProviderRunControl | null>;
  workspaceLeaseRef: React.RefObject<OwnershipLease | undefined>;
  finalizePromptRun: (
    runId: number,
    turnId: number,
    status: "completed" | "failed" | "canceled",
    message?: string,
    response?: string,
    persistedResponse?: string,
  ) => boolean;
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  checkpointsRef: React.RefObject<FileCheckpoint[]>;
  activeCheckpointRef: React.RefObject<{
    runId: number;
    checkpoint: FileCheckpoint;
    store: CheckpointStore;
  } | null>;
  pendingCaptureRef: React.RefObject<Promise<void>>;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;
  projectInstructions: ProjectInstructions | null;
  toolApprovalResolverRef: React.RefObject<((decision: ToolApprovalDecision) => void) | null>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  setToolApproval: React.Dispatch<React.SetStateAction<ToolApprovalRequest | null>>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  refreshAuthStatus: (announce: boolean) => Promise<void>;
  conversationStore: ConversationStore;
  snapshotRef: React.RefObject<(() => WorkbenchSnapshot) | null>;
  lastSaveErrorRef: React.RefObject<string | null>;
  cleanupRef: React.RefObject<(() => void) | null>;
  stoppingRef: React.RefObject<Promise<void>>;
  mode: "suggest" | "auto-edit" | "full-auto";
}

export function usePromptRun(context: UsePromptRunContext) {
  const {
    selectionCoordinator,
    pendingRouteProviderId,
    activeRunIdRef,
    recoveryRef,
    routeChoiceRequiredRef,
    appendEvent,
    workspaceRoot,
    allowedWritableRoots,
    activeProviderRoute,
    activeRouteProvider,
    runtimeConfig,
    providerWorkspaceConfig,
    provider,
    providerOverride,
    backend,
    authStatus,
    activeConversationRef,
    activeContextMetadata,
    promptQueue,
    appendConversationMessage,
    setConversationChars,
    activeRunCaptureRef,
    rolloverResponseCharsRef,
    activeTurnIdRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    externalCliStatusRef,
    dispatchSession,
    finalFlushRef,
    processStoppedRef,
    runControlRef,
    workspaceLeaseRef,
    finalizePromptRun,
    restoredFileBoundaryRef,
    checkpointsRef,
    activeCheckpointRef,
    pendingCaptureRef,
    saveWorkbenchRef,
    projectInstructions,
    toolApprovalResolverRef,
    bumpWorkbench,
    setToolApproval,
    setScreen,
    refreshAuthStatus,
    conversationStore,
    snapshotRef,
    lastSaveErrorRef,
    cleanupRef,
    stoppingRef,
    mode,
  } = context;

  const startPromptRun = useCallback(
    (displayPrompt: string, providerPrompt: string, lifecycle: PromptRunLifecycle = {}) => {
      if (activeRunIdRef.current !== null || recoveryRef.current) return false;
      if (routeChoiceRequiredRef.current) {
        appendEvent("error", "Select a route first", routeChoiceRequiredRef.current);
        return false;
      }
      if (pendingRouteProviderId && pendingRouteProviderId !== activeProviderRoute.providerId) {
        appendEvent(
          "error",
          "Choose a model",
          `Choose a model for ${pendingRouteProviderId} with /model, or change provider with /providers.`,
        );
        return false;
      }
      const modelConnection = catalogContextKey(activeProviderRoute.providerId, {
        cwd: workspaceRoot,
        providerConfig: providerWorkspaceConfig.providers?.[activeProviderRoute.providerId],
        ...(activeProviderRoute.providerId === "local"
          ? { localBackend: activeProviderRoute.localBackend }
          : {}),
      });
      const modelRevision = selectionCoordinator.revision(
        modelConnection,
        activeProviderRoute.modelId,
      );
      const retryDelay = selectionCoordinator.retryDelay(
        modelConnection,
        activeProviderRoute.modelId,
      );
      if (retryDelay > 0) {
        appendEvent(
          "error",
          "Retry later",
          `The provider requested a retry delay. Retry in ${Math.ceil(retryDelay / 1000)} seconds, or change model or provider.`,
        );
        return false;
      }
      if (
        selectionCoordinator.state(modelConnection, activeProviderRoute.modelId)?.status ===
        "unavailable"
      ) {
        appendEvent(
          "error",
          "Model unavailable",
          modelRecoveryMessage(activeProviderRoute.modelId),
        );
        return false;
      }
      const submitTiming = lifecycle.submitTiming ?? createPromptRunTiming();
      const safeDisplayPrompt = sanitizeTerminalInput(displayPrompt).trim();
      const safeProviderPrompt = sanitizeTerminalInput(providerPrompt).trim();
      if (!safeDisplayPrompt || !safeProviderPrompt) {
        appendEvent(
          "error",
          "Prompt blocked",
          "The prompt only contained non-printable/control characters after sanitization.",
        );
        return false;
      }

      const guardMessage = getPromptWorkspaceGuardMessage(
        safeProviderPrompt,
        workspaceRoot,
        allowedWritableRoots,
      );
      if (guardMessage) {
        appendEvent("error", "Workspace boundary", guardMessage);
        return false;
      }
      const imageAttachments = lifecycle.imageAttachments ?? [];
      if (imageAttachments.length > 0) {
        const supportsImages =
          activeProviderRoute.providerId === "openai" ||
          (activeProviderRoute.providerId === "local" &&
            activeRouteProvider?.capabilityProfile?.supportsVision === true);
        if (!supportsImages) {
          const detail =
            activeProviderRoute.providerId === "local"
              ? "The active Local model is not configured with supports_vision: true. Switch to a vision model or remove the image."
              : `${formatRuntimeProviderLabel(activeProviderRoute.providerId)} does not have verified image transport in Ubume yet. Switch to Ubume/OpenAI or a vision-enabled Local model.`;
          appendEvent("error", "Image not supported", detail);
          return false;
        }
      }

      const { runtimeForTurn, fastCleanupRun, executionModeDecision, effectiveMode } =
        preparePromptRun(
          runtimeConfig,
          lifecycle,
          safeProviderPrompt,
          activeProviderRoute,
          providerWorkspaceConfig,
        );
      if (executionModeDecision.autoUpgraded) {
        appendEvent(
          "system",
          "Mode auto-upgraded",
          "This prompt looks like a file-editing request, so the run is using Auto instead of Read-only.",
        );
      }
      if (fastCleanupRun) {
        appendEvent(
          "system",
          "Fast cleanup path",
          "Using a low-latency cleanup profile: shallow inspection, generated artifacts only, no branch/bootstrap setup.",
        );
      }

      if (!provider.run) {
        appendEvent(
          "error",
          "Backend unavailable",
          `${provider.label} is a planned provider placeholder. Use Ubume Core for runnable execution in v1.`,
        );
        return false;
      }
      const runProvider = provider.run;

      if (
        !providerOverride &&
        activeProviderRoute.providerId === "openai" &&
        backend === "codex-subprocess"
      ) {
        const decision = getRunGateDecision(authStatus.state, {
          warnOnUnknown: authStatus.checkedAt > 0,
        });
        if (!decision.allowRun) {
          appendEvent(
            "error",
            "Authentication required",
            decision.blockMessage ?? "Please sign in with `codex login`.",
          );
          return false;
        }
        if (decision.warningMessage) {
          appendEvent("system", "Auth warning", decision.warningMessage);
        }
      }

      const turnId = createTurnId();
      // Local Harness session reuse hashes the history, so local requests get the
      // exact saved reply text; other providers also see what earlier runs did.
      const conversationHistory = selectProviderHistory(
        activeConversationRef.current,
        activeProviderRoute,
        activeContextMetadata,
      );
      const userEvent: UserPromptEvent = {
        id: createEventId(),
        type: "user",
        createdAt: submitTiming.submitEpochMs,
        prompt: safeDisplayPrompt,
        turnId,
      };
      for (const id of lifecycle.queuedPromptIds ?? []) promptQueue.remove(id);
      appendConversationMessage({
        role: "user",
        content: safeDisplayPrompt,
        submittedContent: safeProviderPrompt,
        turnId,
        createdAt: submitTiming.submitEpochMs,
      });
      setConversationChars((count) => count + safeProviderPrompt.length);

      const runId = createEventId();
      activeRunCaptureRef.current = { runId, text: "", tools: new Map(), files: new Map() };
      // A failed or canceled rollover must not reduce the next response's
      // accounting. Each provider run starts with no response text covered.
      rolloverResponseCharsRef.current = 0;
      perf.startSession(String(runId));
      perf.mark("dispatch_start");
      perf.setMeta("fast_cleanup", fastCleanupRun);
      perf.setMeta("reasoning", runtimeForTurn.reasoningLevel);
      activeRunIdRef.current = runId;
      activeTurnIdRef.current = turnId;
      activeRunLifecycleRef.current = lifecycle;
      activeRunTimingRef.current = { ...submitTiming, runId, turnId };
      if (externalCliStatusRef.current === "idle") {
        dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "starting" });
      }
      dispatchSession({
        type: "SUBMIT_PROMPT_RUN",
        historyValue: lifecycle.commitPrompt ? safeDisplayPrompt : undefined,
        preserveInput: lifecycle.preserveInput,
        turnId,
        runId,
        events: [
          userEvent,
          {
            ...createRunEvent({
              id: runId,
              backendId: backend,
              backendLabel: provider.label,
              runtime: runtimeForTurn,
              prompt: safeProviderPrompt,
              turnId,
              startedAtMs: submitTiming.submitEpochMs,
              responsePresentation: lifecycle.responsePresentation,
              approvedPlan: lifecycle.approvedPlan,
            }),
            summary: "Ubume is starting...",
          },
        ],
      });

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
      const captureFileActivity = (activity: readonly PersistedFileActivity[]) => {
        const capture = activeRunCaptureRef.current;
        if (capture?.runId !== runId) return;
        for (const entry of activity) {
          const previous = capture.files.get(entry.path);
          if (previous?.operation === "created" && entry.operation === "modified") continue;
          capture.files.set(entry.path, { path: entry.path, operation: entry.operation });
        }
      };

      let preRunSnapshot: ReturnType<typeof captureWorkspaceSnapshot> | null = null;
      let finalWorkspacePollDone = false;
      let activityTracker: ReturnType<typeof createWorkspaceActivityTracker> | null = null;

      const liveScheduler = createLiveRenderScheduler({
        assistantFlushMs: LIVE_UPDATE_FLUSH_MS,
        progressOnlyFlushMs: PROGRESS_ONLY_FLUSH_MS,
        flush: (updates: LiveRenderUpdate[]) => {
          if (!isCurrentRun(activeRunIdRef.current, runId)) {
            return;
          }

          if (!firstRenderFired && updates.some((update) => update.type === "assistant")) {
            firstRenderFired = true;
            perf.mark("first_render");
          }

          dispatchSession({
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

      const flushLiveUpdates = (): boolean => {
        perf.inc("flushes");
        return liveScheduler.flushNow();
      };

      finalFlushRef.current = {
        runId,
        flush: () => {
          flushLiveUpdates();
        },
      };

      const traceLiveRunDiagnostics = (status: "completed" | "failed" | "canceled") => {
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
        if (externalCliStatusRef.current === "ready") return;
        externalCliStatusRef.current = "ready";
        dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "ready" });
      };

      let resolveStartup: () => void = () => undefined;
      let startupBegan = false;
      processStoppedRef.current = new Promise<void>((resolve) => {
        resolveStartup = resolve;
      });
      runControlRef.current = null;
      let stopProviderRun: (() => void) | undefined;
      let cancelScheduledProviderStart: (() => void) | null = null;
      let providerStartCancelled = false;

      const startProviderRun = async () => {
        if (providerStartCancelled || !isCurrentRun(activeRunIdRef.current, runId)) {
          return;
        }

        try {
          workspaceLeaseRef.current = acquireOwnership(workspaceRoot, "execution");
          await assertFileRecoveryReady(workspaceRoot);
        } catch (error) {
          workspaceLeaseRef.current?.release();
          workspaceLeaseRef.current = undefined;
          appendEvent("error", "Workspace busy", (error as Error).message);
          finalizePromptRun(runId, turnId, "failed", (error as Error).message);
          return;
        }
        if (providerStartCancelled || !isCurrentRun(activeRunIdRef.current, runId)) {
          workspaceLeaseRef.current?.release();
          workspaceLeaseRef.current = undefined;
          return;
        }
        const conversation = activeConversationRef.current;
        if (conversation) {
          restoredFileBoundaryRef.current = undefined;
          const checkpointStore = new CheckpointStore(workspaceRoot, conversation.metadata.id);
          const checkpoint: FileCheckpoint = {
            id: String(runId),
            turnId,
            messageCount: conversation.messages.length - 1,
            prompt: safeDisplayPrompt,
            before: { files: {}, complete: false, skipped: [] },
          };
          checkpointsRef.current.push(checkpoint);
          activeCheckpointRef.current = { runId, checkpoint, store: checkpointStore };
          const capture = checkpointStore.capture().then((boundary) => {
            checkpoint.before = boundary;
          });
          pendingCaptureRef.current = capture;
          try {
            await capture;
          } catch (error) {
            appendEvent("error", "Checkpoint unavailable", (error as Error).message);
          }
          saveWorkbenchRef.current?.();
        }
        if (providerStartCancelled || !isCurrentRun(activeRunIdRef.current, runId)) return;

        // Capture the workspace state after the visible run has had a chance to
        // render, so first-prompt filesystem work cannot block initial progress.
        if (
          (activeProviderRoute.providerId === "openai" && backend === "codex-subprocess") ||
          activeProviderRoute.providerId === "local"
        ) {
          preRunSnapshot = captureWorkspaceSnapshot(workspaceRoot);
          activityTracker = createWorkspaceActivityTracker({
            rootDir: workspaceRoot,
            initialSnapshot: preRunSnapshot,
            onActivity: (activity) => {
              if (!isCurrentRun(activeRunIdRef.current, runId)) return;
              captureFileActivity(activity);
              liveScheduler.enqueue({ type: "activity", activity });
            },
          });
        }

        perf.mark("provider_run_start");
        stopProviderRun = runProvider(
          safeProviderPrompt,
          {
            runtime: runtimeForTurn,
            workspaceRoot,
            projectInstructions,
            runIntent: lifecycle.runIntent ?? "normal",
            conversationHistory,
            localContextCheckpoint:
              activeProviderRoute.providerId === "local" ||
              activeProviderRoute.providerId === "codexa-native"
                ? activeConversationRef.current?.metadata.localContextCheckpoint
                : undefined,
            imageAttachments,
          },
          {
            onAssistantDelta: (chunk) => {
              if (!chunk || !isCurrentRun(activeRunIdRef.current, runId)) {
                return;
              }
              const t0 = performance.now();
              const safeChunk = sanitizeTerminalOutput(chunk, { preserveTabs: false, tabSize: 2 });
              perf.accumulate("sanitize_ms", performance.now() - t0);
              perf.inc("chunks");
              if (!safeChunk) {
                return;
              }
              markExternalCliReady();
              liveScheduler.enqueue({
                type: lifecycle.responsePresentation === "plan" ? "plan" : "assistant",
                chunk: safeChunk,
              });
              streamedAssistantContent += safeChunk;
              if (activeRunCaptureRef.current?.runId === runId)
                activeRunCaptureRef.current.text += safeChunk;
              if (lifecycle.responsePresentation === "plan") {
                planSectionContent += safeChunk;
              }
            },
            onFinalAnswerObserved: (response) => {
              if (!isCurrentRun(activeRunIdRef.current, runId) || finalAnswerVisibleFired) return;
              const flushedLiveUpdates = flushLiveUpdates();
              const markFinalAnswerVisible = () => {
                if (!isCurrentRun(activeRunIdRef.current, runId) || finalAnswerVisibleFired) return;
                finalAnswerVisibleFired = true;
                const safeResponse = sanitizeTerminalOutput(response, {
                  preserveTabs: false,
                  tabSize: 2,
                });
                dispatchSession({
                  type: "RUN_MARK_FINAL_ANSWER_OBSERVED",
                  runId,
                  turnId,
                  // Plan runs keep their text in the plan block; the reducer also
                  // guards this, but never offer text that would be synthesized
                  // into a duplicate response segment.
                  response:
                    lifecycle.responsePresentation !== "plan" && safeResponse.trim()
                      ? safeResponse
                      : undefined,
                });
                perf.mark("final_answer_visible");
              };

              finishAfterLiveFlush(flushedLiveUpdates, markFinalAnswerVisible);
            },
            onToolActivity: (activity) => {
              if (!isCurrentRun(activeRunIdRef.current, runId)) return;
              markExternalCliReady();
              if (activeRunCaptureRef.current?.runId === runId)
                activeRunCaptureRef.current.tools.set(activity.id, activity.command);
              if (lifecycle.responsePresentation === "plan" && !planSeenToolIds.has(activity.id)) {
                // First sight of a tool: mirrors the reducer's insert-only demotion.
                planSeenToolIds.add(activity.id);
                planSectionContent = "";
              }
              liveScheduler.enqueue({ type: "tool", activity: toolOutputBudget.bound(activity) });
              if (activity.status === "running") {
                return;
              }
              if (fastCleanupRun && !blockedCleanupFailureSurfaced) {
                const blockedCleanupFailure = getBlockedCleanupFailure(activity);
                if (blockedCleanupFailure) {
                  blockedCleanupFailureSurfaced = true;
                  flushLiveUpdates();
                  traceLiveRunDiagnostics("failed");
                  void finalizePromptRun(runId, turnId, "failed", blockedCleanupFailure);
                  return;
                }
              }
            },
            onToolApproval: (request) =>
              new Promise<ToolApprovalDecision>((resolve) => {
                toolApprovalResolverRef.current?.("deny");
                toolApprovalResolverRef.current = resolve;
                promptQueue.paused = true;
                bumpWorkbench((value) => value + 1);
                setToolApproval(request);
                setScreen("tool-approval");
              }),
            onResponse: (response) => {
              if (!isCurrentRun(activeRunIdRef.current, runId)) {
                return;
              }
              selectionCoordinator.validate(modelConnection, activeProviderRoute, modelRevision);
              perf.mark("response_cb_start");

              // Force one final synchronous workspace poll before finalizing the run.
              // This closes the race condition where the activity tracker's interval
              // hasn't fired yet and late file changes would be missed.
              if (activityTracker && preRunSnapshot) {
                try {
                  perf.mark("snapshot_start");
                  const finalSnapshot = captureWorkspaceSnapshot(workspaceRoot);
                  perf.mark("snapshot_end");
                  const lateActivity = diffWorkspaceSnapshots(preRunSnapshot, finalSnapshot);
                  if (lateActivity.length > 0) {
                    captureFileActivity(lateActivity);
                    liveScheduler.enqueue({ type: "activity", activity: lateActivity });
                  }
                } catch {
                  // Non-fatal: best-effort final poll
                } finally {
                  finalWorkspacePollDone = true;
                }
              }

              const flushedLiveUpdates = flushLiveUpdates();
              const finalizeResponse = () => {
                if (!isCurrentRun(activeRunIdRef.current, runId)) return;
                const safeResponse = sanitizeTerminalOutput(response, {
                  preserveTabs: false,
                  tabSize: 2,
                });
                const newlyVisibleResponseChars = Math.max(
                  0,
                  safeResponse.length - rolloverResponseCharsRef.current,
                );
                rolloverResponseCharsRef.current = 0;
                setConversationChars((count) => count + newlyVisibleResponseChars);

                // Validate response quality for write-intent/destructive prompts:
                // If the backend returned filler like "Hello." instead of execution
                // feedback, inject a warning so the user isn't silently misled.
                if (effectiveMode !== "suggest") {
                  const hollow = detectHollowResponse(safeProviderPrompt, safeResponse);
                  if (hollow.isHollow) {
                    const formatted = formatHollowResponse(hollow, safeResponse);
                    traceLiveRunDiagnostics("completed");
                    void finalizePromptRun(runId, turnId, "completed", undefined, formatted);
                    return;
                  }
                }

                // If the streamed content matches the sanitized response (after
                // normalizing whitespace), pass undefined so FINALIZE_RUN preserves
                // the already-rendered streamed content — avoiding a visual flash.
                const finalResponse = chooseFinalResponse(
                  streamedAssistantContent,
                  safeResponse,
                  planSectionContent,
                  lifecycle.responsePresentation,
                );
                traceLiveRunDiagnostics("completed");
                void finalizePromptRun(
                  runId,
                  turnId,
                  "completed",
                  undefined,
                  finalResponse,
                  safeResponse,
                );
              };

              finishAfterLiveFlush(flushedLiveUpdates, finalizeResponse);
            },
            onError: (message, rawOutput, evidence) => {
              if (!isCurrentRun(activeRunIdRef.current, runId)) return;
              rolloverResponseCharsRef.current = 0;
              const flushedLiveUpdates = flushLiveUpdates();
              const finalizeError = () => {
                if (!isCurrentRun(activeRunIdRef.current, runId)) return;
                const safeMessage = sanitizeTerminalOutput(message);
                const safeRawOutput = sanitizeTerminalOutput(rawOutput ?? "");
                const combinedOutput = [safeMessage, safeRawOutput].filter(Boolean).join("\n");
                // The recovery hint is Codex-specific; other providers report their own auth errors.
                const codexAuthFailure =
                  activeProviderRoute.providerId === "openai" &&
                  isLikelyAuthFailure(combinedOutput);
                const failure = evidence ?? classifyProviderFailure(safeMessage);
                selectionCoordinator.reject(
                  modelConnection,
                  activeProviderRoute.modelId,
                  failure,
                  modelRevision,
                );
                const failureMessage = isModelFailure(failure)
                  ? `${modelRecoveryMessage(activeProviderRoute.modelId)}\n${safeMessage}`
                  : formatCodexAuthFailure(safeMessage, codexAuthFailure);

                if (codexAuthFailure) {
                  // Re-probe instead of assuming signed-out: a misclassified error
                  // must not block every later run behind the auth gate.
                  void refreshAuthStatus(false);
                }

                traceLiveRunDiagnostics("failed");
                void finalizePromptRun(runId, turnId, "failed", failureMessage);
              };

              finishAfterLiveFlush(flushedLiveUpdates, finalizeError);
            },
            onProgress: (update) => {
              perf.inc("progress_updates");
              const safeText = sanitizeTerminalOutput(update.text);
              if (!safeText) return;
              if (isNoiseLine(safeText)) return;
              if (!isCurrentRun(activeRunIdRef.current, runId)) return;
              markExternalCliReady();
              const safeUpdate: BackendProgressUpdate = {
                id: update.id?.trim() ? update.id : `legacy-progress-${++legacyProgressSequence}`,
                source: update.source,
                text: safeText,
              };
              liveScheduler.enqueue({ type: "progress", update: safeUpdate });
            },
            onLocalContextCheckpoint: (checkpoint) => {
              const current = activeConversationRef.current;
              if (
                !current ||
                (activeProviderRoute.providerId !== "local" &&
                  activeProviderRoute.providerId !== "codexa-native")
              )
                return;
              rolloverResponseCharsRef.current = checkpoint.responseCharsCovered ?? 0;
              if (typeof checkpoint.activeWindowChars === "number") {
                setConversationChars(checkpoint.activeWindowChars);
              }
              const next: ConversationRecord = {
                ...current,
                metadata: { ...current.metadata, localContextCheckpoint: checkpoint },
              };
              activeConversationRef.current = next;
              saveConversationRecord(
                next,
                { conversationStore, snapshotRef, lastSaveErrorRef, appendEvent },
                { title: "Context checkpoint save failed" },
              );
            },
            onNativeSession: (reference) => {
              const current = activeConversationRef.current;
              if (!current || !isCurrentRun(activeRunIdRef.current, runId)) return;
              current.metadata.nativeSessions = [
                ...(current.metadata.nativeSessions ?? []).filter(
                  (previous) =>
                    previous.source !== reference.source ||
                    previous.sessionId !== reference.sessionId,
                ),
                reference,
              ];
              saveWorkbenchRef.current?.();
            },
            onLocalHarnessSession: (session, sessionId) => {
              const current = activeConversationRef.current;
              if (
                !current ||
                activeProviderRoute.providerId !== "local" ||
                !isCurrentRun(activeRunIdRef.current, runId)
              )
                return;
              if (!session && current.metadata.localHarnessSession?.sessionId !== sessionId) return;
              const { localHarnessSession: _previousSession, ...metadata } = current.metadata;
              const next: ConversationRecord = {
                ...current,
                metadata: session ? { ...metadata, localHarnessSession: session } : metadata,
              };
              activeConversationRef.current = next;
              saveConversationRecord(
                next,
                { conversationStore, snapshotRef, lastSaveErrorRef, appendEvent },
                { title: "Local chat save failed", rememberError: true },
              );
            },
            onRunControl: (control) => {
              if (isCurrentRun(activeRunIdRef.current, runId)) {
                runControlRef.current = control;
                processStoppedRef.current = control.stopped;
              }
            },
            onContextUsage: (usage) => {
              if (!isCurrentRun(activeRunIdRef.current, runId)) return;
              recordLocalContextUsage(
                buildUsageScopeKey(
                  activeProviderRoute,
                  providerWorkspaceConfig.providers?.[activeProviderRoute.providerId],
                ),
                usage,
                Date.now(),
              );
              // A failed turn can report zero usage; keep the known conversation size.
              if (usage.contextTokens <= 0) return;
              setConversationChars(Math.max(0, usage.contextTokens * 4));
            },
          },
        );
      };

      cancelScheduledProviderStart = schedulePromptRunStartAfterVisibleCommit(() => {
        startupBegan = true;
        void startProviderRun()
          .catch((error) => {
            finalizePromptRun(runId, turnId, "failed", (error as Error).message);
          })
          .finally(resolveStartup);
      });

      cleanupRef.current = () => {
        providerStartCancelled = true;
        cancelScheduledProviderStart?.();
        if (!startupBegan) resolveStartup();
        stoppingRef.current = processStoppedRef.current;
        flushLiveUpdates();
        // Do one final sync poll before stopping the tracker to capture
        // any last-moment file changes that were in-flight.
        if (activityTracker && preRunSnapshot && !finalWorkspacePollDone) {
          try {
            const cleanupSnapshot = captureWorkspaceSnapshot(workspaceRoot);
            const lastActivity = diffWorkspaceSnapshots(preRunSnapshot, cleanupSnapshot);
            if (lastActivity.length > 0 && isCurrentRun(activeRunIdRef.current, runId)) {
              dispatchSession({ type: "RUN_APPEND_ACTIVITY", runId, activity: lastActivity });
            }
          } catch {
            // Non-fatal
          }
        }
        activityTracker?.stop();
        stopProviderRun?.();
        liveScheduler.cancel();
      };

      return true;
    },
    [
      activeProviderRoute,
      selectionCoordinator,
      pendingRouteProviderId,
      allowedWritableRoots,
      providerOverride,
      activeRouteProvider,
      activeContextMetadata,
      appendConversationMessage,
      appendEvent,
      appendEvent,
      authStatus.checkedAt,
      authStatus.state,
      finalizePromptRun,
      mode,
      provider,
      projectInstructions,
      providerWorkspaceConfig,
      dispatchSession,
      refreshAuthStatus,
      runtimeConfig,
      workspaceRoot,
    ],
  );
  return { startPromptRun };
}
