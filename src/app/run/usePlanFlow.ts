/**
 * Plan mode: generate a plan, let the user review it, then run it.
 *
 * The plan state machine itself lives in `session/planFlow.ts`
 * (`idle → generating → awaiting_action → executing`, with
 * `collecting_feedback` for revisions). This hook connects it to prompt runs:
 *
 * - Plan generation runs read-only (`suggest`) with action parsing off and the
 *   response rendered as a plan block; the plan is saved to the app-data dir.
 * - Approving runs the plan in `auto-edit` and turns plan mode off for the
 *   session.
 * - It also submits the `--prompt` initial prompt once at startup, and drains
 *   the prompt queue whenever the app becomes idle.
 */

import { useCallback, useEffect, useRef } from "react";
import type { LaunchArgs } from "../../config/launchArgs.js";
import { saveRuntimeModePreference } from "../../config/persistence.js";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import { formatModeLabel } from "../../config/settings.js";
import { buildPlanExecutionPrompt, buildPlanningPrompt } from "../../core/codex/codexPrompt.js";
import type { ProviderImageAttachment } from "../../core/providerRuntime/types.js";
import { sanitizeTerminalInput } from "../../core/terminal/terminalSanitize.js";
import { getPromptWorkspaceGuardMessage } from "../../core/workspace/workspaceGuard.js";
import type { SessionAction, SessionState } from "../../session/appSession.js";
import { createPromptRunTiming, type PromptRunTiming } from "../../session/eventIds.js";
import {
  approvePlanExecution,
  beginPlanFeedback,
  finishPlanGeneration,
  type PlanFlowState,
  resetPlanFlow,
  startPlanGeneration,
  submitPlanFeedback,
} from "../../session/planFlow.js";
import type { Screen, UIState } from "../../session/types.js";

import type { PromptQueue } from "../../session/workbench.js";

import type { PlanActionValue } from "../../ui/panels/PlanActionPicker.js";

import type { PromptRunLifecycle } from "./promptRunPrep.js";

interface UsePlanFlowContext {
  startPromptRun: (
    displayPrompt: string,
    providerPrompt: string,
    lifecycle?: PromptRunLifecycle,
  ) => boolean;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  savePlanFile: (planContent: string) => string | null;
  updateRuntimeConfig: (updater: (current: RuntimeConfig) => RuntimeConfig) => void;
  planFlow: PlanFlowState;
  initialPromptSubmittedRef: React.RefObject<boolean>;
  busy: boolean;
  launchArgs: LaunchArgs;
  workspaceRoot: string;
  allowedWritableRoots: string[];
  planMode: boolean;
  mode: "suggest" | "auto-edit" | "full-auto";
  dispatchSession: (action: SessionAction) => void;
  screen: Screen;
  uiState: UIState;
  recoveryRef: React.RefObject<boolean>;
  pipelineGenerationRef: React.RefObject<number>;
  promptQueue: PromptQueue;
  stoppingRef: React.RefObject<Promise<void>>;
  activeRunIdRef: React.RefObject<number | null>;
  submissionRef: React.RefObject<boolean>;
  screenRef: React.RefObject<Screen>;
  getSessionState: () => SessionState;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  workbenchVersion: number;
}

export function usePlanFlow(context: UsePlanFlowContext) {
  const {
    startPromptRun,
    setPlanFlow,
    appendEvent,
    savePlanFile,
    updateRuntimeConfig,
    planFlow,
    initialPromptSubmittedRef,
    busy,
    launchArgs,
    workspaceRoot,
    allowedWritableRoots,
    planMode,
    mode,
    dispatchSession,
    screen,
    uiState,
    recoveryRef,
    pipelineGenerationRef,
    promptQueue,
    stoppingRef,
    activeRunIdRef,
    submissionRef,
    screenRef,
    getSessionState,
    saveWorkbenchRef,
    bumpWorkbench,
    workbenchVersion,
  } = context;

  /**
   * Starts a read-only planning run for `state`. Any outcome other than a
   * non-empty plan resets plan mode's flow to idle. Returns whether the run
   * started.
   */
  const runPlanGeneration = useCallback(
    (
      state: Extract<PlanFlowState, { kind: "generating" }>,
      displayPrompt: string,
      submitTiming?: PromptRunTiming,
      commitPrompt = false,
      imageAttachments: readonly ProviderImageAttachment[] = [],
      preserveInput = false,
      queuedPromptIds?: readonly string[],
    ) => {
      const started = startPromptRun(
        displayPrompt,
        buildPlanningPrompt({
          task: state.originalPrompt,
          constraints: state.constraints,
          currentPlan: state.currentPlan,
          pendingFeedback: state.pendingFeedback,
        }),
        {
          runtimeOverride: {
            mode: "suggest",
            planMode: false,
          },
          disableModeAutoUpgrade: true,
          parseActionRequired: false,
          responsePresentation: "plan",
          runIntent: "plan",
          submitTiming,
          commitPrompt,
          preserveInput,
          queuedPromptIds,
          imageAttachments,
          onCompleted: ({ response }) => {
            const nextPlan = response.trim();
            if (!nextPlan) {
              setPlanFlow(resetPlanFlow());
              appendEvent(
                "error",
                "Plan generation failed",
                "Plan mode expected a concrete plan, but the response was empty.",
              );
              return;
            }
            const planFilePath = savePlanFile(nextPlan);
            setPlanFlow((current) => finishPlanGeneration(current, nextPlan, planFilePath));
          },
          onFailed: () => {
            setPlanFlow(resetPlanFlow());
          },
          onCanceled: () => {
            setPlanFlow(resetPlanFlow());
          },
        },
      );

      if (!started) {
        setPlanFlow(resetPlanFlow());
      }

      return started;
    },
    [appendEvent, savePlanFile, startPromptRun],
  );

  /**
   * Runs an approved plan in auto-edit mode. If the run cannot start, the
   * review state is restored so the user can try again.
   */
  const startApprovedPlanExecution = useCallback(
    (state: Extract<PlanFlowState, { kind: "awaiting_action" }>) => {
      const submitTiming = createPromptRunTiming();
      setPlanFlow(approvePlanExecution(state));
      const started = startPromptRun(
        state.originalPrompt,
        buildPlanExecutionPrompt({
          task: state.originalPrompt,
          approvedPlan: state.currentPlan,
          constraints: state.constraints,
        }),
        {
          // The approved plan is sent to the provider without duplicating its transcript block.
          runIntent: "approved-execution",
          submitTiming,
          runtimeOverride: {
            mode: "auto-edit",
            planMode: false,
          },
          onCompleted: () => {
            setPlanFlow(resetPlanFlow());
          },
          onFailed: () => {
            setPlanFlow(resetPlanFlow());
          },
          onCanceled: () => {
            setPlanFlow(resetPlanFlow());
          },
        },
      );

      if (!started) {
        setPlanFlow(state);
        return;
      }

      // Approving the plan ends plan mode for the session, not just for this
      // run: otherwise the footer keeps showing PLAN and the next prompt plans
      // again. The run itself already carries the override above. Not routed
      // through setPlanModeWithNotice, which would reset planFlow mid-run.
      updateRuntimeConfig((current) => ({
        ...current,
        mode: "auto-edit",
        planMode: false,
      }));
      saveRuntimeModePreference("auto-edit", false);
      appendEvent(
        "system",
        "Plan mode",
        `Plan approved. Plan mode off · ${formatModeLabel("auto-edit")}.`,
      );
    },
    [appendEvent, startPromptRun, updateRuntimeConfig],
  );

  // Ignores repeated picker actions until the plan flow state has moved on, so
  // a double Enter cannot start the same plan twice.
  const planActionInFlightRef = useRef(false);
  useEffect(() => {
    planActionInFlightRef.current = false;
  }, [planFlow]);
  const handlePlanAction = useCallback(
    (action: PlanActionValue) => {
      if (planFlow.kind !== "awaiting_action" || planActionInFlightRef.current) {
        return;
      }
      planActionInFlightRef.current = true;

      switch (action) {
        case "implement":
          startApprovedPlanExecution(planFlow);
          return;
        case "revise": {
          const feedback =
            "Redo the plan. Review the original task and constraints, correct gaps and mistakes, and produce a complete revised plan.";
          const nextState = submitPlanFeedback(beginPlanFeedback(planFlow, "revise"), feedback);
          if (nextState.kind === "generating") {
            setPlanFlow(nextState);
            if (!runPlanGeneration(nextState, feedback, createPromptRunTiming())) {
              setPlanFlow(planFlow);
              planActionInFlightRef.current = false;
            }
          }
          return;
        }
        case "cancel":
          setPlanFlow(resetPlanFlow());
          appendEvent("system", "Plan review", "Plan review canceled. No changes were made.");
          return;
        default:
          return;
      }
    },
    [appendEvent, planFlow, runPlanGeneration, startApprovedPlanExecution],
  );

  const handlePlanFeedbackSubmit = useCallback(
    (value: string) => {
      if (planFlow.kind !== "collecting_feedback") {
        return;
      }

      const feedback = sanitizeTerminalInput(value).trim();
      if (!feedback) {
        appendEvent(
          "system",
          "Plan review",
          "Add a short revision note or constraint before submitting.",
        );
        return;
      }

      const nextState = submitPlanFeedback(planFlow, feedback);
      if (nextState.kind !== "generating") {
        return;
      }

      setPlanFlow(nextState);
      runPlanGeneration(nextState, feedback, createPromptRunTiming());
    },
    [appendEvent, planFlow, runPlanGeneration],
  );

  // Submit `--prompt` once, as soon as the app is idle.
  useEffect(() => {
    if (initialPromptSubmittedRef.current || busy) {
      return;
    }

    const initialPrompt = sanitizeTerminalInput(launchArgs.initialPrompt ?? "").trim();
    if (!initialPrompt) {
      return;
    }

    initialPromptSubmittedRef.current = true;

    const workspaceGuardMessage = getPromptWorkspaceGuardMessage(
      initialPrompt,
      workspaceRoot,
      allowedWritableRoots,
    );
    if (workspaceGuardMessage) {
      appendEvent("error", "Workspace boundary", workspaceGuardMessage);
      return;
    }

    if (planMode) {
      const nextPlanState = startPlanGeneration(initialPrompt, mode);
      setPlanFlow(nextPlanState);
      runPlanGeneration(nextPlanState, initialPrompt, createPromptRunTiming(), true);
      return;
    }

    startPromptRun(initialPrompt, initialPrompt, {
      submitTiming: createPromptRunTiming(),
      commitPrompt: true,
    });
  }, [
    allowedWritableRoots,
    appendEvent,
    busy,
    dispatchSession,
    launchArgs.initialPrompt,
    mode,
    planMode,
    runPlanGeneration,
    startPromptRun,
    workspaceRoot,
  ]);

  // Queued prompts start through the latest callbacks and settings, which a
  // drain that is already waiting on a previous run would otherwise miss.
  const queueDispatchRef = useRef({ startPromptRun, runPlanGeneration, planMode, mode, planFlow });
  queueDispatchRef.current = { startPromptRun, runPlanGeneration, planMode, mode, planFlow };

  // Drain the prompt queue whenever the app becomes idle on the main screen.
  // Readiness is checked twice: here (from render state) to decide whether to
  // start draining, and again inside `drain` after the previous run has fully
  // stopped, from refs and live session state. The generation counter makes a
  // cancel or clear in between abandon the drain.
  useEffect(() => {
    const idle =
      !busy &&
      screen === "main" &&
      planFlow.kind === "idle" &&
      uiState.kind === "IDLE" &&
      !recoveryRef.current;
    if (!idle) {
      return;
    }
    const generation = pipelineGenerationRef.current;
    void promptQueue
      .drain(
        (item) => {
          const current = queueDispatchRef.current;
          if (current.planMode) {
            const nextPlan = startPlanGeneration(item.submitted, current.mode);
            setPlanFlow(nextPlan);
            return current.runPlanGeneration(
              nextPlan,
              item.display,
              createPromptRunTiming(),
              true,
              item.images,
              true,
              [item.id],
            );
          }
          return current.startPromptRun(item.display, item.submitted, {
            commitPrompt: true,
            preserveInput: true,
            queuedPromptIds: [item.id],
            imageAttachments: item.images,
          });
        },
        async () => {
          await stoppingRef.current;
          return (
            generation === pipelineGenerationRef.current &&
            activeRunIdRef.current === null &&
            !submissionRef.current &&
            !recoveryRef.current &&
            screenRef.current === "main" &&
            getSessionState().uiState.kind === "IDLE" &&
            queueDispatchRef.current.planFlow.kind === "idle"
          );
        },
      )
      .then((started) => {
        if (started) {
          saveWorkbenchRef.current?.();
          bumpWorkbench((value) => value + 1);
        }
      })
      .catch((error) => {
        appendEvent("error", "Queue paused", (error as Error).message);
        saveWorkbenchRef.current?.();
        bumpWorkbench((value) => value + 1);
      });
  }, [
    busy,
    screen,
    planFlow.kind,
    uiState.kind,
    workbenchVersion,
    promptQueue,
    startPromptRun,
    planMode,
    mode,
    runPlanGeneration,
  ]);
  return { runPlanGeneration, handlePlanAction, handlePlanFeedbackSubmit };
}
