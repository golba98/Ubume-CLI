/**
 * Composer submission: decides what Enter does with the composer's text.
 *
 * `handleSubmit` routes a submission through these steps, stopping at the
 * first one that consumes it (see `submitSteps.ts`):
 *
 * 1. Direct commands — `/codexa`, `/perf`, workbench views, `/send-now`,
 *    `/resume <id>`.
 * 2. Shell — `!command`.
 * 3. Slash commands — parsed by `commands/handler.ts`, applied by
 *    `commandDispatch.ts`.
 * 4. Prompts — attachments are expanded, then the text is either an answer to
 *    the assistant's pending question, queued behind an active run, sent to
 *    Codexa, intercepted for outside-workspace paths, or started as a plan or
 *    a normal run.
 *
 * Submissions and slash commands never overlap: `submissionRef` and the
 * pipeline generation counter let a cancel or `/clear` abandon a submission
 * that is still waiting for attachments or a previous run.
 */

import { useCallback, useRef } from "react";
import * as perf from "../../core/perf/profiler.js";
import { sanitizeTerminalInput } from "../../core/terminal/terminalSanitize.js";
import { findUserPrompt } from "../../session/appSession.js";
import { buildFollowUpPrompt } from "../../session/chatLifecycle.js";
import { createPromptRunTiming } from "../../session/eventIds.js";
import { startPlanGeneration } from "../../session/planFlow.js";
import { queuedPrompt } from "../../session/workbench.js";
import { selectImageAttachments } from "../../ui/input/pastedContent.js";
import type { UseAppInputContext } from "./appInputContext.js";
import {
  expandPromptAttachments,
  handleShellSubmission,
  interceptOutsideWorkspacePaths,
  matchDirectCommand,
  routeSlashCommand,
} from "./submitSteps.js";

export function useAppInput(context: UseAppInputContext) {
  // handleSubmit is stable; each submission reads the context from the latest
  // render once, at the moment Enter is pressed.
  const latestContext = useRef(context);
  latestContext.current = context;

  const handleSubmit = useCallback(async () => {
    const submitTiming = createPromptRunTiming();
    perf.mark("submit");
    const ctx = latestContext.current;
    if (ctx.submissionRef.current || ctx.recoveryRef.current) {
      return;
    }
    const value = sanitizeTerminalInput(ctx.getSessionState().inputValue).trim();
    if (!value) {
      return;
    }

    // --- Commands -------------------------------------------------------------
    // Matching is synchronous so that ordinary slash commands below still
    // dispatch inside the key event, as discrete (immediately rendered) updates.
    const directCommand = matchDirectCommand(ctx, value, submitTiming);
    if (directCommand) {
      await directCommand();
      return;
    }
    if (value.startsWith("!")) {
      await handleShellSubmission(ctx, value);
      return;
    }
    const command = routeSlashCommand(ctx, value);
    if (command) {
      return command.result;
    }

    // --- Prompts ----------------------------------------------------------------
    const generation = ctx.pipelineGenerationRef.current;
    const providerValue = await expandPromptAttachments(ctx, value);
    if (providerValue === null) {
      return;
    }
    const imageAttachments = selectImageAttachments(value, ctx.imageAttachmentRegistryRef.current);

    // An answer to the assistant's pending question resumes that turn.
    const { uiState } = ctx;
    if (uiState.kind === "AWAITING_USER_ACTION") {
      const originalUserEvent = findUserPrompt(
        [...ctx.staticEvents, ...ctx.activeEvents],
        uiState.turnId,
      );
      if (!originalUserEvent) {
        ctx.appendEvent(
          "error",
          "Follow-up unavailable",
          "The original turn could not be found, so the answer could not be resumed.",
        );
        ctx.dispatchSession({ type: "UI_ACTION", action: { type: "DISMISS_TRANSIENT" } });
        return;
      }
      if (ctx.busy) {
        return;
      }
      ctx.startPromptRun(
        value,
        buildFollowUpPrompt({
          originalPrompt: originalUserEvent.prompt,
          assistantQuestion: uiState.question,
          userAnswer: providerValue,
        }),
        { submitTiming, commitPrompt: true, imageAttachments },
      );
      return;
    }

    // A cancel or /clear while attachments were being read abandons the prompt.
    if (generation !== ctx.pipelineGenerationRef.current) {
      return;
    }

    // Prompts sent while a run is active wait in the queue.
    if (ctx.activeRunIdRef.current !== null) {
      ctx.promptQueue.push(queuedPrompt(value, providerValue, imageAttachments));
      ctx.dispatchSession({ type: "PUSH_HISTORY", value });
      ctx.resetComposer();
      ctx.saveWorkbenchRef.current?.();
      ctx.bumpWorkbench((version) => version + 1);
      return;
    }

    // Codexa is conversational-only: no workspace checks, no action parsing.
    if (ctx.activeRouteProvider?.id === "codexa-native") {
      ctx.startPromptRun(value, providerValue, {
        submitTiming,
        commitPrompt: true,
        parseActionRequired: false,
        imageAttachments,
      });
      return;
    }

    if (interceptOutsideWorkspacePaths(ctx, value, providerValue)) {
      return;
    }

    if (ctx.planMode) {
      const nextPlanState = startPlanGeneration(providerValue, ctx.mode);
      ctx.setPlanFlow(nextPlanState);
      ctx.runPlanGeneration(nextPlanState, value, submitTiming, true, imageAttachments);
      return;
    }
    ctx.startPromptRun(value, providerValue, {
      submitTiming,
      commitPrompt: true,
      imageAttachments,
    });
  }, []);

  return { handleSubmit };
}
