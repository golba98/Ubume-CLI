import type { useFocusManager } from "ink";
import { useCallback } from "react";
import * as perf from "../../core/perf/profiler.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import { unloadCodexaNative } from "../../core/providerRuntime/codexaNative.js";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../core/providers/types.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { resetLocalUsageRecords } from "../../core/usage/localUsageTracker.js";
import type { ConversationStore } from "../../core/workspace/conversationStore.js";
import { savePlan } from "../../core/workspace/planStorage.js";
import type { SessionAction } from "../../session/appSession.js";
import { isCurrentRun } from "../../session/chatLifecycle.js";
import { createEventId, type PromptRunTiming } from "../../session/eventIds.js";
import type { PersistedRunStatus } from "../../session/persistedResponse.js";
import { cancelPlanFeedback, type PlanFlowState, resetPlanFlow } from "../../session/planFlow.js";
import { useTranscriptExport } from "../../session/transcriptExport.js";
import type { RunEvent, Screen, ShellEvent, TimelineEvent, UIState } from "../../session/types.js";

import type { PromptQueue } from "../../session/workbench.js";

import { FOCUS_IDS } from "../../ui/input/focus.js";

import type { PromptRunLifecycle } from "./promptRunPrep.js";
import {
  parseFinalResponse,
  sanitizeResponseText,
  shouldPauseQueueAfterRun,
} from "./runFinalize.js";

interface UseRunLifecycleContext {
  dispatchSession: (action: SessionAction) => void;
  setConversationChars: React.Dispatch<React.SetStateAction<number>>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  intendedFocusTargetRef: React.RefObject<string>;
  focusManager: ReturnType<typeof useFocusManager>;
  activeRunIdRef: React.RefObject<number | null>;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
  finalFlushRef: React.RefObject<{ runId: number; flush: () => void } | null>;
  cleanupRef: React.RefObject<(() => void) | null>;
  activeTurnIdRef: React.RefObject<number | null>;
  persistRunConversationMessage: (
    runId: number,
    status: PersistedRunStatus,
    response?: { renderedResponse?: string; completeResponse?: string; errorMessage?: string },
  ) => void;
  promptQueue: PromptQueue;
  captureFinalRef: React.RefObject<((runId: number) => void) | null>;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  toolApprovalResolverRef: React.RefObject<((decision: ToolApprovalDecision) => void) | null>;
  setToolApproval: React.Dispatch<React.SetStateAction<ToolApprovalRequest | null>>;
  screenRef: React.RefObject<Screen>;
  activeEvents: TimelineEvent[];
  uiState: UIState;
  submissionRef: React.RefObject<boolean>;
  pipelineGenerationRef: React.RefObject<number>;
  busy: boolean;
  planFlow: PlanFlowState;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  stoppingRef: React.RefObject<Promise<void>>;
  conversationStore: ConversationStore;
  exit: (errorOrResult?: Error | unknown) => void;
  recoveryRef: React.RefObject<boolean>;
  pendingQuitRef: React.RefObject<(() => void) | null>;
  staticEvents: TimelineEvent[];
  workspaceRoot: string;
}

export function useRunLifecycle(context: UseRunLifecycleContext) {
  const {
    dispatchSession,
    setConversationChars,
    setScreen,
    intendedFocusTargetRef,
    focusManager,
    activeRunIdRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    finalFlushRef,
    cleanupRef,
    activeTurnIdRef,
    persistRunConversationMessage,
    promptQueue,
    captureFinalRef,
    saveWorkbenchRef,
    bumpWorkbench,
    toolApprovalResolverRef,
    setToolApproval,
    screenRef,
    activeEvents,
    uiState,
    submissionRef,
    pipelineGenerationRef,
    busy,
    planFlow,
    setPlanFlow,
    appendEvent,
    stoppingRef,
    conversationStore,
    exit,
    recoveryRef,
    pendingQuitRef,
    staticEvents,
    workspaceRoot,
  } = context;

  const resetComposer = useCallback(() => {
    dispatchSession({ type: "RESET_INPUT" });
  }, [dispatchSession]);

  const resetToHomeScreen = useCallback(
    (seedEvents: TimelineEvent[] = []) => {
      dispatchSession({
        type: "CLEAR_TRANSCRIPT",
        seedEvents,
      });
      setConversationChars(0);
      // Local token totals describe one conversation; a new one starts from zero.
      resetLocalUsageRecords();
      setScreen("main");
      resetComposer();
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      focusManager.focus(FOCUS_IDS.composer);
    },
    [dispatchSession, focusManager, resetComposer],
  );

  /**
   * Clears the active-run refs so no further callbacks treat the run as
   * current, and returns its cleanup and lifecycle for the caller to finish.
   * Focus returns to the composer only on the main screen, so a run that
   * ends while a picker or panel is open (for example during model
   * recovery) does not steal focus from it.
   */
  const detachActiveRun = useCallback(() => {
    const detached = { cleanup: cleanupRef.current, lifecycle: activeRunLifecycleRef.current };
    cleanupRef.current = null;
    activeRunLifecycleRef.current = null;
    activeRunTimingRef.current = null;
    activeRunIdRef.current = null;
    activeTurnIdRef.current = null;
    if (screenRef.current === "main") {
      focusManager.focus(FOCUS_IDS.composer);
    }
    return detached;
  }, [focusManager]);

  /** Moves the UI state machine out of its running state after a cancel. */
  const dispatchRunEnded = useCallback(
    (runId: number, promptTurnId: number | null) => {
      if (uiState.kind === "SHELL_RUNNING") {
        dispatchSession({ type: "UI_ACTION", action: { type: "SHELL_FINISHED", shellId: runId } });
      } else if (promptTurnId !== null) {
        dispatchSession({
          type: "UI_ACTION",
          action: { type: "RUN_CANCELED", turnId: promptTurnId },
        });
      }
    },
    [dispatchSession, uiState.kind],
  );

  /**
   * Ends the current run: flushes its last live updates, detaches it, runs its
   * cleanup, persists the assistant message and dispatches `FINALIZE_RUN`.
   *
   * Returns false (and does nothing) when `runId` is no longer the current run,
   * which makes late provider callbacks harmless. `response === undefined`
   * tells the reducer to keep the streamed text as the final answer.
   */
  const finalizePromptRun = useCallback(
    (
      runId: number,
      turnId: number,
      status: "completed" | "failed" | "canceled",
      message?: string,
      response?: string,
      persistedResponse?: string,
    ) => {
      if (!isCurrentRun(activeRunIdRef.current, runId)) {
        return false;
      }
      perf.mark("finalize_start");

      const timing =
        activeRunTimingRef.current?.runId === runId ? activeRunTimingRef.current : null;
      const finalMonotonicMs = performance.now();
      const durationMs = timing
        ? Math.max(0, Math.round(finalMonotonicMs - timing.submitMonotonicMs))
        : 0;
      renderDebug.traceEvent("run", "finalizeTiming", {
        runId,
        turnId,
        status,
        promptSubmitEpochMs: timing?.submitEpochMs,
        promptSubmitMonotonicMs: timing?.submitMonotonicMs,
        finalRenderMonotonicMs: finalMonotonicMs,
        elapsedWallMs: durationMs,
      });
      if (finalFlushRef.current?.runId === runId) {
        finalFlushRef.current.flush();
        finalFlushRef.current = null;
      }
      const { cleanup, lifecycle } = detachActiveRun();
      cleanup?.();

      const safeMessage = message ? sanitizeTerminalOutput(message) : undefined;
      const parsed = parseFinalResponse(
        status,
        sanitizeResponseText(response),
        lifecycle?.parseActionRequired ?? true,
      );
      persistRunConversationMessage(runId, status, {
        renderedResponse: parsed.content,
        completeResponse: sanitizeResponseText(persistedResponse),
        errorMessage: safeMessage,
      });
      dispatchSession({
        type: "FINALIZE_RUN",
        runId,
        turnId,
        status,
        message: safeMessage,
        response: parsed.content,
        durationMs,
        responsePresentation: lifecycle?.responsePresentation,
        question: status === "completed" ? parsed.question : null,
        assistantFactory: () => ({
          id: createEventId(),
          type: "assistant",
          createdAt: Date.now(),
          content: parsed.content?.trim() ? parsed.content : "",
          contentChunks: [],
          turnId,
        }),
      });
      if (shouldPauseQueueAfterRun(status, parsed.question, lifecycle)) {
        promptQueue.paused = true;
      }
      captureFinalRef.current?.(runId);
      saveWorkbenchRef.current?.();
      bumpWorkbench((value) => value + 1);
      perf.mark("finalize_done");
      perf.setMeta("content_length", parsed.content?.length ?? 0);
      perf.setMeta("status", status);
      perf.setMeta("elapsed_wall_ms", durationMs);
      const perfSession = perf.getSession();
      if (perfSession) {
        perf.persistSession(perfSession);
      }

      if (status === "completed") {
        lifecycle?.onCompleted?.({
          response: parsed.content ?? "",
          turnId,
          runId,
        });
      } else if (status === "failed") {
        lifecycle?.onFailed?.({
          message: safeMessage ?? "Run failed",
          turnId,
          runId,
        });
      } else {
        lifecycle?.onCanceled?.({
          turnId,
          runId,
        });
      }

      return true;
    },
    [detachActiveRun, dispatchSession, persistRunConversationMessage],
  );

  /**
   * Cancels the active prompt or shell run (Ctrl+C, /quit, queue edits).
   *
   * Any pending tool approval is denied first. With `retainHistory` the
   * canceled turn stays in the transcript (a prompt run is finalized as
   * "canceled"; a shell run is marked failed). Without it, the run's events
   * are removed and the conversation records the turn as canceled.
   */
  const cancelActiveRun = useCallback(
    (retainHistory = true) => {
      const runId = activeRunIdRef.current;
      if (runId === null) {
        return false;
      }
      toolApprovalResolverRef.current?.("deny");
      toolApprovalResolverRef.current = null;
      setToolApproval(null);
      if (screenRef.current === "tool-approval") {
        setScreen("main");
      }
      const promptTurnId = activeTurnIdRef.current;

      if (!isCurrentRun(activeRunIdRef.current, runId)) {
        return false;
      }

      const shellEvent = activeEvents.find(
        (event) => event.type === "shell" && event.id === runId,
      ) as ShellEvent | undefined;
      const runEvent = activeEvents.find((event) => event.type === "run" && event.id === runId) as
        | RunEvent
        | undefined;

      if (retainHistory && runEvent) {
        return finalizePromptRun(runId, runEvent.turnId, "canceled");
      }

      const { cleanup, lifecycle } = detachActiveRun();
      cleanup?.();

      if (retainHistory) {
        if (shellEvent) {
          dispatchSession({
            type: "FINALIZE_SHELL",
            shellId: runId,
            finalEvent: { ...shellEvent, status: "failed", exitCode: -1, durationMs: null },
          });
        } else {
          // A run event would have been finalized above, so only the prompt remains.
          dispatchSession({ type: "REMOVE_ACTIVE_RUNTIME", runId, turnId: promptTurnId });
          if (promptTurnId !== null) {
            lifecycle?.onCanceled?.({ turnId: promptTurnId, runId });
          }
        }
      } else {
        persistRunConversationMessage(runId, "canceled");
        if (promptTurnId !== null) {
          lifecycle?.onCanceled?.({ turnId: promptTurnId, runId });
        }
        dispatchRunEnded(runId, promptTurnId);
        dispatchSession({ type: "REMOVE_ACTIVE_RUNTIME", runId, turnId: promptTurnId });
        return true;
      }

      dispatchRunEnded(runId, promptTurnId);
      return true;
    },
    [
      activeEvents,
      detachActiveRun,
      dispatchRunEnded,
      dispatchSession,
      finalizePromptRun,
      persistRunConversationMessage,
    ],
  );

  /**
   * Esc / Ctrl+C handling, in priority order: cancel a running turn, leave
   * plan feedback, cancel plan review, or dismiss a transient error/question.
   * Always pauses the prompt queue and invalidates an in-progress submission.
   */
  const handleCancel = useCallback(() => {
    if (submissionRef.current) {
      pipelineGenerationRef.current++;
    }
    promptQueue.paused = true;
    bumpWorkbench((value) => value + 1);
    if (busy) {
      cancelActiveRun(true);
      return;
    }
    if (planFlow.kind === "collecting_feedback") {
      setPlanFlow((current) => cancelPlanFeedback(current));
      return;
    }
    if (planFlow.kind === "awaiting_action") {
      setPlanFlow(resetPlanFlow());
      appendEvent("system", "Plan review", "Plan review canceled. No changes were made.");
      return;
    }
    if (uiState.kind === "AWAITING_USER_ACTION" || uiState.kind === "ERROR") {
      dispatchSession({ type: "UI_ACTION", action: { type: "DISMISS_TRANSIENT" } });
      resetComposer();
    }
  }, [
    appendEvent,
    busy,
    cancelActiveRun,
    dispatchSession,
    planFlow.kind,
    resetComposer,
    uiState.kind,
  ]);

  const handleQuit = useCallback(() => {
    const quit = () => {
      pipelineGenerationRef.current++;
      promptQueue.paused = true;
      cancelActiveRun(true);
      void Promise.all([stoppingRef.current, unloadCodexaNative("Ubume exiting.")]).then(() => {
        saveWorkbenchRef.current?.();
        conversationStore.release();
        exit();
      });
    };
    // Let journaled file transactions and session switches finish before exiting.
    if (recoveryRef.current) {
      pendingQuitRef.current = quit;
    } else {
      quit();
    }
  }, [cancelActiveRun, conversationStore, exit, promptQueue]);

  const { handleCopy } = useTranscriptExport(staticEvents, appendEvent);

  const savePlanFile = useCallback(
    (planContent: string): string | null => {
      const filePath = savePlan(planContent, workspaceRoot);
      if (!filePath) {
        appendEvent("error", "Plan file unavailable", "The generated plan could not be saved.");
      }
      return filePath;
    },
    [appendEvent, workspaceRoot],
  );
  return {
    resetComposer,
    resetToHomeScreen,
    finalizePromptRun,
    cancelActiveRun,
    handleCancel,
    handleQuit,
    handleCopy,
    savePlanFile,
  };
}
