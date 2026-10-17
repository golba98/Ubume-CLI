import { spawn } from "node:child_process";
import type { useFocusManager } from "ink";
import { startTransition, useCallback } from "react";
import { runShellCommand, summarizeCommandResult } from "../../core/process/commandRunner.js";
import { errorMessage } from "../../core/shared/values.js";
import {
  sanitizeTerminalInput,
  sanitizeTerminalLines,
  sanitizeTerminalOutput,
} from "../../core/terminal/terminalSanitize.js";
import { assertFileRecoveryReady } from "../../core/workspace/checkpoints.js";
import type { LaunchContext } from "../../core/workspace/launchContext.js";
import {
  createWorkspaceRelaunchPlan,
  guardWorkspaceRelaunch,
} from "../../core/workspace/launchContext.js";
import { acquireOwnership, type OwnershipLease } from "../../core/workspace/ownership.js";
import { getShellWorkspaceGuardMessage } from "../../core/workspace/workspaceGuard.js";
import type { SessionAction } from "../../session/appSession.js";
import { createEventId, type PromptRunTiming } from "../../session/eventIds.js";
import type { ShellEvent } from "../../session/types.js";
import { FOCUS_IDS } from "../../ui/input/focus.js";
import type { PromptRunLifecycle } from "./promptRunPrep.js";
import { createShellLineBatcher } from "./shellLineBatcher.js";

interface UsePromptExecutionContext {
  workspaceRoot: string;
  allowedWritableRoots: string[];
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  pipelineGenerationRef: React.RefObject<number>;
  activeRunIdRef: React.RefObject<number | null>;
  recoveryRef: React.RefObject<boolean>;
  dispatchSession: (action: SessionAction) => void;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
  activeTurnIdRef: React.RefObject<number | null>;
  processStoppedRef: React.RefObject<Promise<void>>;
  stoppingRef: React.RefObject<Promise<void>>;
  cleanupRef: React.RefObject<(() => void) | null>;
  focusManager: ReturnType<typeof useFocusManager>;
  busy: boolean;
  launchContext: LaunchContext;
  exit: (errorOrResult?: Error | unknown) => void;
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
    busy,
    launchContext,
    exit,
  } = context;

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
        lease = acquireOwnership(workspaceRoot, "execution");
        try {
          await assertFileRecoveryReady(workspaceRoot);
        } catch (error) {
          lease.release();
          throw error;
        }
      } catch (error) {
        appendEvent("error", "Workspace busy", (error as Error).message);
        return;
      }
      if (
        generation !== pipelineGenerationRef.current ||
        activeRunIdRef.current !== null ||
        recoveryRef.current
      ) {
        lease.release();
        return;
      }
      const shellId = createEventId();
      const startTime = Date.now();

      const initialEvent: ShellEvent = {
        id: shellId,
        createdAt: startTime,
        type: "shell",
        command: safeCommand,
        lines: [],
        stderrLines: [],
        summary: `Executing shell: ${safeCommand}`,
        status: "running",
        exitCode: null,
        durationMs: null,
      };

      dispatchSession({ type: "SET_ACTIVE_EVENTS", events: [initialEvent] });
      activeRunLifecycleRef.current = null;
      activeRunTimingRef.current = null;
      activeRunIdRef.current = shellId;
      activeTurnIdRef.current = null;
      dispatchSession({ type: "UI_ACTION", action: { type: "SHELL_STARTED", shellId } });

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
      const flushShellLines = shellLines.flush;

      let runner: ReturnType<typeof runShellCommand>;
      try {
        runner = runShellCommand(
          safeCommand,
          { cwd: workspaceRoot },
          {
            onStdout: (text) => {
              const lines = sanitizeTerminalLines(text.split(/\r?\n/));
              if (lines.length > 0) {
                shellLines.enqueue("stdout", lines);
              }
            },
            onStderr: (text) => {
              const lines = sanitizeTerminalLines(text.split(/\r?\n/));
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
      processStoppedRef.current = (runner.stopped ?? runner.result.then(() => undefined)).finally(
        () => lease.release(),
      );
      stoppingRef.current = processStoppedRef.current;
      cleanupRef.current = () => {
        stoppingRef.current = processStoppedRef.current;
        shellLines.cancel();
        runner.cancel();
      };

      void runner.result.then((result) => {
        if (activeRunIdRef.current !== shellId) return;
        flushShellLines();
        activeRunIdRef.current = null;
        cleanupRef.current = null;
        focusManager.focus(FOCUS_IDS.composer);

        const finalEvent: ShellEvent = {
          ...initialEvent,
          lines: sanitizeTerminalLines(result.stdout.split(/\r?\n/)),
          stderrLines: sanitizeTerminalLines(result.stderr.split(/\r?\n/)),
          summary: sanitizeTerminalOutput(summarizeCommandResult(safeCommand, result)),
          status: result.status === "completed" ? "completed" : "failed",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        };

        dispatchSession({ type: "FINALIZE_SHELL", shellId, finalEvent });
      });
    },
    [allowedWritableRoots, appendEvent, dispatchSession, focusManager, workspaceRoot],
  );

  const handleWorkspaceRelaunch = useCallback(
    (targetPath: string) => {
      const gate = guardWorkspaceRelaunch(busy);
      if (!gate.allowed) {
        appendEvent(
          "system",
          "Busy",
          gate.message ?? "Finish the current run before relaunching into another workspace.",
        );
        return;
      }

      const relaunchResult = createWorkspaceRelaunchPlan(targetPath, launchContext);
      if (!relaunchResult.ok) {
        appendEvent("error", "Workspace relaunch failed", relaunchResult.message);
        return;
      }

      try {
        const child = spawn(relaunchResult.plan.executable, relaunchResult.plan.args, {
          cwd: relaunchResult.plan.cwd,
          env: relaunchResult.plan.env,
          stdio: "inherit",
        });

        let launched = false;
        child.once("error", (error) => {
          if (launched) return;
          appendEvent("error", "Workspace relaunch failed", error.message);
        });
        child.once("spawn", () => {
          launched = true;
          exit();
        });
      } catch (error) {
        const message = errorMessage(error, "Unknown relaunch failure");
        appendEvent("error", "Workspace relaunch failed", message);
      }
    },
    [appendEvent, appendEvent, busy, exit, launchContext],
  );

  return { handleShellExecute, handleWorkspaceRelaunch };
}
