import type { useFocusManager } from "ink";
import { useCallback } from "react";
import * as perf from "../core/perf/profiler.js";
import * as renderDebug from "../core/perf/renderDebug.js";
import { unloadCodexaNative } from "../core/providerRuntime/codexaNative.js";
import type { ProviderRoute } from "../core/providerRuntime/types.js";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../core/providers/types.js";
import { sanitizeTerminalOutput } from "../core/terminal/terminalSanitize.js";
import { resetLocalUsageRecords } from "../core/usage/localUsageTracker.js";
import type { ConversationStore } from "../core/workspace/conversationStore.js";
import { savePlan } from "../core/workspace/planStorage.js";
import type { SessionAction } from "../session/appSession.js";
import { extractAssistantActionRequired, isCurrentRun } from "../session/chatLifecycle.js";
import { createEventId, type PromptRunTiming } from "../session/eventIds.js";
import type { PersistedRunStatus } from "../session/persistedResponse.js";
import { cancelPlanFeedback, type PlanFlowState, resetPlanFlow } from "../session/planFlow.js";
import { useTranscriptExport } from "../session/transcriptExport.js";
import type { RunEvent, Screen, ShellEvent, TimelineEvent, UIState } from "../session/types.js";

import type { PromptQueue } from "../session/workbench.js";

import { FOCUS_IDS } from "../ui/input/focus.js";

import type { PromptRunLifecycle } from "./promptRunPrep.js";

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
  activeProviderRoute: ProviderRoute;
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
    activeProviderRoute,
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

      const lifecycle = activeRunLifecycleRef.current;
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
      const cleanup = cleanupRef.current;
      cleanupRef.current = null;
      activeRunLifecycleRef.current = null;
      activeRunTimingRef.current = null;
      activeRunIdRef.current = null;
      activeTurnIdRef.current = null;
      if (screenRef.current === "main") focusManager.focus(FOCUS_IDS.composer);
      cleanup?.();
      const safeMessage = message ? sanitizeTerminalOutput(message) : undefined;
      // When response is undefined, signal the reducer to preserve streamed content as-is.
      const safeResponse =
        response != null
          ? sanitizeTerminalOutput(response, { preserveTabs: false, tabSize: 2 })
          : undefined;
      const shouldParseActionRequired = lifecycle?.parseActionRequired ?? true;
      const parsed =
        status === "completed" && safeResponse?.trim()
          ? shouldParseActionRequired
            ? extractAssistantActionRequired(safeResponse)
            : { content: safeResponse, question: null as string | null }
          : { content: safeResponse, question: null as string | null };
      const safePersistedResponse =
        persistedResponse != null
          ? sanitizeTerminalOutput(persistedResponse, { preserveTabs: false, tabSize: 2 })
          : undefined;
      persistRunConversationMessage(runId, status, {
        renderedResponse: parsed.content,
        completeResponse: safePersistedResponse,
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
      if (status !== "completed" || parsed.question || lifecycle?.responsePresentation === "plan")
        promptQueue.paused = true;
      captureFinalRef.current?.(runId);
      saveWorkbenchRef.current?.();
      bumpWorkbench((value) => value + 1);
      perf.mark("finalize_done");
      perf.setMeta("content_length", parsed.content?.length ?? 0);
      perf.setMeta("status", status);
      perf.setMeta("elapsed_wall_ms", durationMs);
      const perfSession = perf.getSession();
      if (perfSession) perf.persistSession(perfSession);

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
    [activeProviderRoute.providerId, dispatchSession, focusManager, persistRunConversationMessage],
  );

  const cancelActiveRun = useCallback(
    (retainHistory = true) => {
      const runId = activeRunIdRef.current;
      if (runId === null) return false;
      toolApprovalResolverRef.current?.("deny");
      toolApprovalResolverRef.current = null;
      setToolApproval(null);
      if (screenRef.current === "tool-approval") setScreen("main");
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

      const cleanup = cleanupRef.current;
      const lifecycle = activeRunLifecycleRef.current;
      cleanupRef.current = null;
      activeRunLifecycleRef.current = null;
      activeRunTimingRef.current = null;
      activeRunIdRef.current = null;
      activeTurnIdRef.current = null;
      if (screenRef.current === "main") focusManager.focus(FOCUS_IDS.composer);
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
        if (uiState.kind === "SHELL_RUNNING") {
          dispatchSession({
            type: "UI_ACTION",
            action: { type: "SHELL_FINISHED", shellId: runId },
          });
        } else if (promptTurnId !== null) {
          dispatchSession({
            type: "UI_ACTION",
            action: { type: "RUN_CANCELED", turnId: promptTurnId },
          });
        }
        dispatchSession({ type: "REMOVE_ACTIVE_RUNTIME", runId, turnId: promptTurnId });
        return true;
      }

      if (uiState.kind === "SHELL_RUNNING") {
        dispatchSession({ type: "UI_ACTION", action: { type: "SHELL_FINISHED", shellId: runId } });
      } else if (promptTurnId !== null) {
        dispatchSession({
          type: "UI_ACTION",
          action: { type: "RUN_CANCELED", turnId: promptTurnId },
        });
      }

      return true;
    },
    [
      activeEvents,
      dispatchSession,
      finalizePromptRun,
      focusManager,
      persistRunConversationMessage,
      uiState.kind,
    ],
  );

  const handleCancel = useCallback(() => {
    if (submissionRef.current) pipelineGenerationRef.current++;
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
    if (recoveryRef.current) pendingQuitRef.current = quit;
    else quit();
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
