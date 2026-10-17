/**
 * Global Ctrl key handling: Ctrl+C interrupts and the two-press exit, plus
 * Ctrl+Q / Ctrl+L where the composer is not focused.
 *
 * Ctrl+C does the first applicable thing:
 * 1. A second press while a run is still stopping quits immediately.
 * 2. Stops the active run (the composer shows "stopping" until it has).
 * 3. Abandons a submission that is still being prepared.
 * 4. Clears a non-empty draft.
 * 5. Otherwise arms exit: the composer shows "Press Ctrl+C again to exit"
 *    for {@link EXIT_CONFIRM_WINDOW_MS}; pressing again inside that window
 *    quits, and a press after it re-arms.
 *
 * Every Ctrl+C pauses the prompt queue so nothing new starts on its own.
 * Ctrl+Q and Ctrl+L are handled here only on overlays and plan review; on the
 * main screen the composer owns those keys.
 */

import { useInput } from "ink";
import { useCallback, useEffect, useRef } from "react";
import type { SessionState } from "../../session/appSession.js";
import type { PlanFlowState } from "../../session/planFlow.js";
import type { Screen } from "../../session/types.js";
import type { PromptQueue } from "../../session/workbench.js";
import type { InterruptHint } from "../../ui/chrome/composer/composerModel.js";

/** How long the composer offers "Press Ctrl+C again to exit" before disarming. */
export const EXIT_CONFIRM_WINDOW_MS = 2000;

interface UseInterruptKeysContext {
  promptQueue: PromptQueue;
  handleQuit: () => void;
  handleCancel: () => void;
  handleRedraw: () => void;
  activeRunIdRef: React.RefObject<number | null>;
  stoppingRef: React.RefObject<Promise<void>>;
  isMountedRef: React.RefObject<boolean>;
  submissionRef: React.RefObject<boolean>;
  pipelineGenerationRef: React.RefObject<number>;
  getSessionState: () => SessionState;
  resetComposer: () => void;
  setInterruptHint: React.Dispatch<React.SetStateAction<InterruptHint | null>>;
  screen: Screen;
  planFlow: PlanFlowState;
}

export function useInterruptKeys(context: UseInterruptKeysContext) {
  const {
    promptQueue,
    handleQuit,
    handleCancel,
    handleRedraw,
    activeRunIdRef,
    stoppingRef,
    isMountedRef,
    submissionRef,
    pipelineGenerationRef,
    getSessionState,
    resetComposer,
    setInterruptHint,
    screen,
    planFlow,
  } = context;

  // The composer shows the exit hint exactly while the next Ctrl+C would quit.
  const exitArmedRef = useRef(false);
  const exitArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (exitArmTimerRef.current) {
        clearTimeout(exitArmTimerRef.current);
      }
    },
    [],
  );

  const disarmExit = useCallback(() => {
    if (exitArmTimerRef.current) {
      clearTimeout(exitArmTimerRef.current);
    }
    exitArmTimerRef.current = null;
    if (!exitArmedRef.current) {
      return;
    }
    exitArmedRef.current = false;
    if (isMountedRef.current) {
      setInterruptHint((hint) => (hint === "confirm-exit" ? null : hint));
    }
  }, [isMountedRef, setInterruptHint]);

  const armExit = useCallback(() => {
    exitArmedRef.current = true;
    setInterruptHint("confirm-exit");
    exitArmTimerRef.current = setTimeout(disarmExit, EXIT_CONFIRM_WINDOW_MS);
  }, [disarmExit, setInterruptHint]);

  // True from the first Ctrl+C on a run until that run has fully stopped.
  const interruptCleanupRef = useRef(false);

  const handleInterrupt = useCallback(() => {
    promptQueue.paused = true;
    if (interruptCleanupRef.current) {
      handleQuit();
      return;
    }

    const exitArmed = exitArmedRef.current;
    disarmExit();

    if (activeRunIdRef.current !== null) {
      interruptCleanupRef.current = true;
      setInterruptHint("stopping");
      handleCancel();
      void stoppingRef.current.finally(() => {
        interruptCleanupRef.current = false;
        if (isMountedRef.current) {
          setInterruptHint(null);
        }
      });
      return;
    }
    if (submissionRef.current) {
      pipelineGenerationRef.current++;
      return;
    }
    if (getSessionState().inputValue) {
      resetComposer();
      return;
    }
    if (exitArmed) {
      handleQuit();
    } else {
      armExit();
    }
  }, [armExit, disarmExit, getSessionState, handleCancel, handleQuit, promptQueue, resetComposer]);

  useInput((input, key) => {
    if (!key.ctrl) {
      return;
    }
    if (input === "c") {
      handleInterrupt();
      return;
    }
    const composerHidden =
      screen !== "main" ||
      planFlow.kind === "awaiting_action" ||
      planFlow.kind === "collecting_feedback";
    if (!composerHidden) {
      return;
    }
    if (input === "q") {
      handleQuit();
    } else if (input === "l") {
      handleRedraw();
    }
  });
}
