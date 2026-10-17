/**
 * Pure helpers for finishing a run (`useRunLifecycle.finalizePromptRun`).
 */

import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { extractAssistantActionRequired } from "../../session/chatLifecycle.js";
import type { PromptRunLifecycle } from "./promptRunPrep.js";

export type RunStatus = "completed" | "failed" | "canceled";

/** Sanitizes response text for display; `undefined` stays undefined. */
export function sanitizeResponseText(text: string | null | undefined): string | undefined {
  return text != null
    ? sanitizeTerminalOutput(text, { preserveTabs: false, tabSize: 2 })
    : undefined;
}

/**
 * Splits a completed response into displayed content and an optional
 * follow-up question the assistant asked the user.
 *
 * Only non-empty completed responses are parsed, and only when the run asked
 * for action parsing (Codexa runs do not). `content` may be `undefined`,
 * which tells the reducer to keep the already-streamed text.
 */
export function parseFinalResponse(
  status: RunStatus,
  safeResponse: string | undefined,
  parseActionRequired: boolean,
): { content: string | undefined; question: string | null } {
  if (status !== "completed" || !safeResponse?.trim() || !parseActionRequired) {
    return { content: safeResponse, question: null };
  }
  return extractAssistantActionRequired(safeResponse);
}

/**
 * Whether the prompt queue should stop draining after this run: on any
 * failure or cancellation, when the assistant asked a question, and after a
 * plan (which waits for the user's review).
 */
export function shouldPauseQueueAfterRun(
  status: RunStatus,
  question: string | null,
  lifecycle: PromptRunLifecycle | null,
): boolean {
  return status !== "completed" || Boolean(question) || lifecycle?.responsePresentation === "plan";
}
