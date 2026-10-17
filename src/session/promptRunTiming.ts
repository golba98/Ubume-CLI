/**
 * Prompt-run timing.
 *
 * A `PromptRunTiming` captures the moment a prompt was submitted, in both
 * epoch time (for display and persistence) and the monotonic clock (for
 * elapsed-time math that immune to wall-clock adjustments). The app records
 * one per submission and keeps the latest on the active run.
 */

export interface PromptRunTiming {
  submitEpochMs: number;
  submitMonotonicMs: number;
}

/** Captures the current instant as the timing of a newly submitted prompt. */
export function createPromptRunTiming(): PromptRunTiming {
  return {
    submitEpochMs: Date.now(),
    submitMonotonicMs: performance.now(),
  };
}
