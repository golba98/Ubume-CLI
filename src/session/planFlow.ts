/**
 * Plan-mode flow: the state machine behind `/plan`.
 *
 * A plan moves through a fixed lifecycle — generating, awaiting the user's
 * action, optionally collecting feedback (which re-enters generating), and
 * finally executing. Transitions are pure and total: applying one in the
 * wrong state returns the state unchanged. The original prompt, execution
 * mode and accumulated constraints travel with the plan through every stage.
 */

import type { AvailableMode } from "../config/settings.js";

export type PlanFeedbackMode = "revise" | "constraints";

export interface PlanFeedbackRequest {
  mode: PlanFeedbackMode;
  text: string;
}

interface PlanFlowContext {
  originalPrompt: string;
  executionMode: AvailableMode;
  constraints: string[];
  planFilePath: string | null;
}

export type PlanFlowState =
  | { kind: "idle" }
  | (PlanFlowContext & {
      kind: "generating";
      currentPlan: string | null;
      pendingFeedback: PlanFeedbackRequest | null;
    })
  | (PlanFlowContext & {
      kind: "awaiting_action";
      currentPlan: string;
    })
  | (PlanFlowContext & {
      kind: "collecting_feedback";
      currentPlan: string;
      mode: PlanFeedbackMode;
    })
  | (PlanFlowContext & {
      kind: "executing";
      currentPlan: string;
    });

type PlanGeneratingState = Extract<PlanFlowState, { kind: "generating" }>;

/** The fields every plan keeps across its whole flow, from generation to execution. */
function planContextFields(state: PlanFlowContext): PlanFlowContext {
  return {
    originalPrompt: state.originalPrompt,
    executionMode: state.executionMode,
    constraints: state.constraints,
    planFilePath: state.planFilePath,
  };
}

export function createInitialPlanFlowState(): PlanFlowState {
  return { kind: "idle" };
}

/**
 * The mode an approved plan executes under. Plan mode is orthogonal to the
 * execution mode, so a session in `suggest` (read-only sandbox) can enter plan
 * mode; approving the plan is an explicit request to write, so lift it to
 * `auto-edit`. Write-capable modes are kept as-is.
 */
export function resolvePlanExecutionMode(mode: AvailableMode): AvailableMode {
  return mode === "suggest" ? "auto-edit" : mode;
}

/** Starts a fresh plan generation for `originalPrompt`. */
export function startPlanGeneration(
  originalPrompt: string,
  executionMode: AvailableMode,
): PlanGeneratingState {
  return {
    kind: "generating",
    originalPrompt,
    executionMode: resolvePlanExecutionMode(executionMode),
    constraints: [],
    planFilePath: null,
    currentPlan: null,
    pendingFeedback: null,
  };
}

/** Finishes generation with a concrete plan and the file it was saved to. */
export function finishPlanGeneration(
  state: PlanFlowState,
  currentPlan: string,
  planFilePath: string | null,
): PlanFlowState {
  if (state.kind !== "generating") {
    return state;
  }

  return {
    ...planContextFields(state),
    kind: "awaiting_action",
    currentPlan,
    planFilePath,
  };
}

/** Opens the feedback composer for the reviewed plan (`revise` or `constraints`). */
export function beginPlanFeedback(state: PlanFlowState, mode: PlanFeedbackMode): PlanFlowState {
  if (state.kind !== "awaiting_action") {
    return state;
  }

  return {
    ...planContextFields(state),
    kind: "collecting_feedback",
    currentPlan: state.currentPlan,
    mode,
  };
}

/**
 * Submits feedback on the plan. A constraint is recorded and carried into the
 * next generation pass; a revision is handed to the model as pending feedback.
 */
export function submitPlanFeedback(state: PlanFlowState, text: string): PlanFlowState {
  if (state.kind !== "collecting_feedback") {
    return state;
  }

  return {
    ...planContextFields(state),
    kind: "generating",
    constraints: state.mode === "constraints" ? [...state.constraints, text] : state.constraints,
    currentPlan: state.currentPlan,
    pendingFeedback: {
      mode: state.mode,
      text,
    },
  };
}

/** Cancels the feedback composer, returning to the plan's action picker. */
export function cancelPlanFeedback(state: PlanFlowState): PlanFlowState {
  if (state.kind !== "collecting_feedback") {
    return state;
  }

  return {
    ...planContextFields(state),
    kind: "awaiting_action",
    currentPlan: state.currentPlan,
  };
}

/** Approves the plan; the run executes it in the plan's execution mode. */
export function approvePlanExecution(state: PlanFlowState): PlanFlowState {
  if (state.kind !== "awaiting_action") {
    return state;
  }

  return {
    ...planContextFields(state),
    kind: "executing",
    currentPlan: state.currentPlan,
  };
}

/** Resets the flow to idle (after execution, a failed run, or /plan off). */
export function resetPlanFlow(): PlanFlowState {
  return createInitialPlanFlowState();
}
