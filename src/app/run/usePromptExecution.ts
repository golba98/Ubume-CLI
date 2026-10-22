/**
 * `!command` shell execution in the locked workspace.
 *
 * A shell command is a run like a prompt: it holds the workspace execution
 * lease, occupies `activeRunIdRef` (so Ctrl+C and queueing treat it as the
 * active run), streams batched output into a shell event, and finalizes that
 * event when the process exits.
 */

import type { useFocusManager } from "ink";
import { startTransition, useCallback } from "react";
import { runShellCommand, summarizeCommandResult } from "../../core/process/commandRunner.js";
import {
  sanitizeTerminalInput,
  sanitizeTerminalLines,
  sanitizeTerminalOutput,
} from "../../core/terminal/terminalSanitize.js";
import { assertFileRecoveryReady } from "../../core/workspace/checkpoints.js";
import { acquireOwnership, type OwnershipLease } from "../../core/workspace/ownership.js";
import { getShellWorkspaceGuardMessage } from "../../core/workspace/workspaceGuard.js";
import type { SessionAction } from "../../session/appSession.js";
import { createEventId, type PromptRunTiming } from "../../session/eventIds.js";
import type { ShellEvent } from "../../session/types.js";
import { FOCUS_IDS } from "../../ui/input/focus.js";
import type { PromptRunLifecycle } from "./promptRunPrep.js";
import { createShellLineBatcher } from "./shellLineBatcher.js";

/** Splits process output into sanitized display lines. */
function outputLines(text: string): string[] {
  return sanitizeTerminalLines(text.split(/\r?\n/));
}

/** The transcript event shown while a shell command runs. */
function runningShellEvent(shellId: number, command: string, startTime: number): ShellEvent {
  return {
    id: shellId,
    createdAt: startTime,
    type: "shell",
    command,
    lines: [],
    stderrLines: [],
    summary: `Executing shell: ${command}`,
    status: "running",
    exitCode: null,
    durationMs: null,
  };
}

/** The finished shell event, rebuilt from the process's complete output. */
function finishedShellEvent(
  running: ShellEvent,
  result: Awaited<ReturnType<typeof runShellCommand>["result"]>,
): ShellEvent {
  return {
    ...running,
    lines: outputLines(result.stdout),
    stderrLines: outputLines(result.stderr),
    summary: sanitizeTerminalOutput(summarizeCommandResult(running.command, result)),
    status: result.status === "completed" ? "completed" : "failed",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

/**
 * Takes the workspace execution lease and checks no file restoration is
 * pending. Throws (with the lease released) when the workspace is busy.
 */
async function acquireExecutionLease(workspaceRoot: string): Promise<OwnershipLease> {
  const lease = acquireOwnership(workspaceRoot, "execution");
  try {
    await assertFileRecoveryReady(workspaceRoot);
    return lease;
  } catch (error) {
    lease.release();
    throw error;
  }
}

interface UsePromptExecutionContext {
  // Workspace and guard
  workspaceRoot: string;
  allowedWritableRoots: string[];

  // Active-run identity and lifecycle
  activeRunIdRef: React.RefObject<number | null>;
  activeTurnIdRef: React.RefObject<number | null>;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
  processStoppedRef: React.RefObject<Promise<void>>;
  stoppingRef: React.RefObject<Promise<void>>;
  cleanupRef: React.RefObject<(() => void) | null>;
  pipelineGenerationRef: React.RefObject<number>;
  recoveryRef: React.RefObject<boolean>;

  // Session dispatch and UI
  dispatchSession: (action: SessionAction) => void;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  focusManager: ReturnType<typeof useFocusManager>;
}

export function usePromptExecution(context: UsePromptExecutionContext) {
  const {
    workspaceRoot,
    allowedWritableRoots,
    appendEvent,
    pipelineGenerationRef,
    activeRunIdRef,
    recoveryRef,
    dispatchSession,
    activeRunLifecycleRef,
    activeRunTimingRef,
    activeTurnIdRef,
    processStoppedRef,
    stoppingRef,
    cleanupRef,
    focusManager,
  } = context;

  /**
   * Runs `command` in the workspace shell. Commands that would write outside
   * the workspace are refused, and the command is dropped if a cancel, a run
   * or a conversation switch happened while the lease was being acquired.
   */
  const handleShellExecute = useCallback(
    async (command: string) => {
      const safeCommand = sanitizeTerminalInput(command).trim();
      const guardMessage = getShellWorkspaceGuardMessage(
        safeCommand,
        workspaceRoot,
        allowedWritableRoots,
      );
      if (guardMessage) {
        appendEvent("error", "Shell command blocked", guardMessage);
        return;
      }

      const generation = pipelineGenerationRef.current;
      let lease: OwnershipLease;
      try {
        lease = await acquireExecutionLease(workspaceRoot);
      } catch (error) {
        appendEvent("error", "Workspace busy", (error as Error).message);
        return;
      }
      const superseded =
        generation !== pipelineGenerationRef.current ||
        activeRunIdRef.current !== null ||
        recoveryRef.current;
      if (superseded) {
        lease.release();
        return;
      }

      // --- Start: show the running event and become the active run.
      const shellId = createEventId();
      const initialEvent = runningShellEvent(shellId, safeCommand, Date.now());
      dispatchSession({ type: "SET_ACTIVE_EVENTS", events: [initialEvent] });
      activeRunLifecycleRef.current = null;
      activeRunTimingRef.current = null;
      activeRunIdRef.current = shellId;
      activeTurnIdRef.current = null;
      dispatchSession({ type: "UI_ACTION", action: { type: "SHELL_STARTED", shellId } });

      // --- Stream: batch output lines into low-priority transcript updates.
      const shellLines = createShellLineBatcher((stdoutLines, stderrLines) => {
        startTransition(() => {
          if (stdoutLines.length > 0) {
            dispatchSession({
              type: "UPDATE_SHELL_LINES",
              shellId,
              stream: "stdout",
              lines: stdoutLines,
            });
          }
          if (stderrLines.length > 0) {
            dispatchSession({
              type: "UPDATE_SHELL_LINES",
              shellId,
              stream: "stderr",
              lines: stderrLines,
            });
          }
        });
      });

      let runner: ReturnType<typeof runShellCommand>;
      try {
        runner = runShellCommand(
          safeCommand,
          { cwd: workspaceRoot },
          {
            onStdout: (text) => {
              const lines = outputLines(text);
              if (lines.length > 0) {
                shellLines.enqueue("stdout", lines);
              }
            },
            onStderr: (text) => {
              const lines = outputLines(text);
              if (lines.length > 0) {
                shellLines.enqueue("stderr", lines);
              }
            },
          },
        );
      } catch (error) {
        lease.release();
        activeRunIdRef.current = null;
        dispatchSession({ type: "UI_ACTION", action: { type: "DISMISS_TRANSIENT" } });
        appendEvent("error", "Shell command failed", (error as Error).message);
        return;
      }
      // The lease is held until the process has actually exited.
      processStoppedRef.current = (runner.stopped ?? runner.result.then(() => undefined)).finally(
        () => lease.release(),
      );
      stoppingRef.current = processStoppedRef.current;
      cleanupRef.current = () => {
        stoppingRef.current = processStoppedRef.current;
        shellLines.cancel();
        runner.cancel();
      };

      // --- Finish: unless canceled meanwhile, replace the event with the result.
      void runner.result.then((result) => {
        if (activeRunIdRef.current !== shellId) {
          return;
        }
        shellLines.flush();
        activeRunIdRef.current = null;
        cleanupRef.current = null;
        focusManager.focus(FOCUS_IDS.composer);
        dispatchSession({
          type: "FINALIZE_SHELL",
          shellId,
          finalEvent: finishedShellEvent(initialEvent, result),
        });
      });
    },
    [allowedWritableRoots, appendEvent, dispatchSession, focusManager, workspaceRoot],
  );

  return { handleShellExecute };
}
