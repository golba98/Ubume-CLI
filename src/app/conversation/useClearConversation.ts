/**
 * `/clear`: ends the current conversation and returns to an empty home
 * screen.
 *
 * The active run is canceled and the conversation saved first; the next
 * prompt then starts a new conversation. The transcript is swapped through
 * the clear-frame boundary (`armTranscriptReplacement`), which physically
 * clears the terminal in the same write as the fresh home frame.
 *
 * Like conversation switches, `/clear` holds `recoveryRef` while it runs so
 * queued prompts and quits wait, and runs a quit requested meanwhile after.
 */

import { useCallback } from "react";
import * as renderDebug from "../../core/perf/renderDebug.js";
import { closeLocalHarnessSession } from "../../core/providerRuntime/localHarness/runtime.js";
import { createStartupStaticEvents } from "../../session/eventIds.js";
import { type PlanFlowState, resetPlanFlow } from "../../session/planFlow.js";
import type { TimelineEvent } from "../../session/types.js";
import { resetTimelineMeasureCaches } from "../../ui/timeline/timelineMeasure.js";
import type { useAppState } from "../state/useAppState.js";
import { finishRecovery, resetConversationScratchState } from "./conversationPersistence.js";

type AppState = ReturnType<typeof useAppState>;

interface UseClearConversationContext
  extends Pick<
    AppState,
    | "submissionRef"
    | "recoveryRef"
    | "pipelineGenerationRef"
    | "stoppingRef"
    | "activeConversationRef"
    | "preserveSavedRouteRef"
    | "routeChoiceRequiredRef"
    | "conversationStore"
    | "promptQueue"
    | "checkpointsRef"
    | "restoredFileBoundaryRef"
    | "pastedContentRegistryRef"
    | "imageAttachmentRegistryRef"
    | "fileAttachmentRegistryRef"
    | "bumpWorkbench"
    | "setConversationRouteOverride"
    | "activeTurnIdRef"
    | "activeRunLifecycleRef"
    | "activeRunTimingRef"
    | "providerWorkspaceConfig"
    | "pendingQuitRef"
  > {
  armTranscriptReplacement: (source: string) => {
    clearGeneration: number;
    clearBoundaryArmed: boolean;
    finish: () => void;
  };
  cancelActiveRun: (retainHistory?: boolean) => boolean;
  saveActiveConversation: () => void;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  resetToHomeScreen: (seedEvents?: TimelineEvent[]) => void;
}

export function useClearConversation(context: UseClearConversationContext) {
  const {
    submissionRef,
    recoveryRef,
    pipelineGenerationRef,
    stoppingRef,
    activeConversationRef,
    preserveSavedRouteRef,
    routeChoiceRequiredRef,
    conversationStore,
    promptQueue,
    checkpointsRef,
    restoredFileBoundaryRef,
    pastedContentRegistryRef,
    imageAttachmentRegistryRef,
    fileAttachmentRegistryRef,
    bumpWorkbench,
    setConversationRouteOverride,
    activeTurnIdRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    providerWorkspaceConfig,
    pendingQuitRef,
    armTranscriptReplacement,
    cancelActiveRun,
    saveActiveConversation,
    setPlanFlow,
    resetToHomeScreen,
  } = context;

  const handleClear = useCallback(async () => {
    if (submissionRef.current || recoveryRef.current) {
      return;
    }
    // Abandon any submission still waiting on attachments or a stopping run.
    pipelineGenerationRef.current++;
    recoveryRef.current = true;
    const replacement = armTranscriptReplacement(
      "src/app/conversation/useClearConversation.ts:handleClear",
    );
    try {
      cancelActiveRun(true);
      await stoppingRef.current;
      saveActiveConversation();

      // Detach the finished conversation.
      const harnessSessionId =
        activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
      stoppingRef.current = stoppingRef.current
        .then(() => closeLocalHarnessSession(harnessSessionId))
        .then(() => undefined);
      activeConversationRef.current = null;
      preserveSavedRouteRef.current = false;
      routeChoiceRequiredRef.current = null;
      conversationStore.release();

      // Reset per-conversation scratch state.
      resetConversationScratchState({ promptQueue, checkpointsRef, restoredFileBoundaryRef });
      pastedContentRegistryRef.current.clear();
      imageAttachmentRegistryRef.current.clear();
      fileAttachmentRegistryRef.current.clear();
      bumpWorkbench((value) => value + 1);
      setConversationRouteOverride(null);
      activeTurnIdRef.current = null;
      activeRunLifecycleRef.current = null;
      activeRunTimingRef.current = null;
      setPlanFlow(resetPlanFlow());

      // Row caches are keyed by transcript item keys; drop them with the transcript.
      resetTimelineMeasureCaches();
      renderDebug.traceEvent("terminal", "clearReactStateRequested", {
        clearGeneration: replacement.clearGeneration,
        clearPending: replacement.clearBoundaryArmed,
      });
      resetToHomeScreen(
        createStartupStaticEvents({
          providerWorkspaceConfig,
        }),
      );
      replacement.finish();
    } finally {
      finishRecovery({ recoveryRef, bumpWorkbench, pendingQuitRef });
    }
  }, [
    armTranscriptReplacement,
    cancelActiveRun,
    providerWorkspaceConfig,
    resetToHomeScreen,
    saveActiveConversation,
  ]);

  return { handleClear };
}
