/**
 * The steps `useAppInput.handleSubmit` runs for a composer submission.
 *
 * Each step receives the app input context as it was when the submission
 * started. Steps that may consume the submission return `true` when they
 * did, so `handleSubmit` stops there.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { handleCommand } from "../../commands/handler.js";
import { estimateTokens } from "../../config/settings.js";
import * as perf from "../../core/perf/profiler.js";
import { unloadCodexaNative } from "../../core/providerRuntime/codexaNative.js";
import { resolveUbumeAttachmentDir } from "../../core/workspace/appData.js";
import { isImageFile } from "../../core/workspace/attachments.js";
import { expandFileAttachments } from "../../core/workspace/workspaceFiles.js";
import {
  findOutsideWorkspacePaths,
  formatSkippedDependencyPath,
  getPromptWorkspaceGuardMessage,
} from "../../core/workspace/workspaceGuard.js";
import type { PromptRunTiming } from "../../session/eventIds.js";
import {
  assertAttachedContent,
  expandPastedContent,
  selectImageAttachments,
} from "../../ui/input/pastedContent.js";
import type { PendingImportFile } from "../../ui/panels/AttachmentImportPanel.js";
import type { WorkbenchView } from "../../ui/panels/WorkbenchPanel.js";
import type { UseAppInputContext } from "./appInputContext.js";
import { dispatchCommand } from "./commandDispatch.js";

const WORKBENCH_COMMANDS = ["/queue", "/transcript", "/diff", "/rewind"];

const CODEXA_HELP =
  "/codexa settings · /codexa unload · /codexa replay. Experimental native model; no tools. Interactive exploration is not the frozen benchmark.";

/**
 * `/codexa [settings|unload|replay]`: controls for the experimental Codexa
 * native model. Only available while Codexa is the active route and idle.
 */
async function handleCodexaCommand(
  ctx: UseAppInputContext,
  value: string,
  submitTiming: PromptRunTiming,
): Promise<void> {
  ctx.resetComposer();
  if (ctx.activeRouteProvider?.id !== "codexa-native") {
    ctx.appendEvent("error", "Codexa", "Select Codexa Native first using /providers and /model.");
    return;
  }
  if (ctx.busy) {
    ctx.appendEvent("system", "Codexa", "Cancel or finish the current response first.");
    return;
  }

  const action = value.slice("/codexa".length).trim();
  switch (action) {
    case "settings":
      ctx.openSettingsPanel();
      return;

    case "unload":
      await unloadCodexaNative();
      ctx.appendEvent(
        "system",
        "Codexa",
        "Model unloaded; the next message reloads the selected checkpoint.",
      );
      return;

    case "replay": {
      // Re-run the last prompt against the raw model outputs that preceded it.
      const messages = ctx.activeConversationRef.current?.messages ?? [];
      const index = messages.findLastIndex((message) => message.role === "user");
      const lastPrompt = messages[index];
      if (!lastPrompt) {
        ctx.appendEvent("error", "Codexa", "There is no previous user prompt to replay.");
        return;
      }
      const prompt = lastPrompt.submittedContent ?? lastPrompt.content;
      ctx.startPromptRun(prompt, prompt, {
        submitTiming,
        commitPrompt: true,
        parseActionRequired: false,
        historyOverride: messages.slice(0, index).map((message) => ({
          ...message,
          content: message.generationMetadata?.rawOutput ?? message.content,
        })),
      });
      return;
    }

    default:
      ctx.appendEvent("system", "Codexa", CODEXA_HELP);
  }
}

/**
 * Matches commands that bypass the slash-command parser: `/codexa`, `/perf`,
 * the workbench views, `/send-now` and `/resume <id>`. Returns the action to
 * run, or `null` when `value` is not one of them.
 */
export function matchDirectCommand(
  ctx: UseAppInputContext,
  value: string,
  submitTiming: PromptRunTiming,
): (() => void | Promise<void>) | null {
  if (value === "/codexa" || value.startsWith("/codexa ")) {
    return () => handleCodexaCommand(ctx, value, submitTiming);
  }

  if (value === "/perf") {
    return () => {
      const session = perf.getSession();
      const summary = session
        ? perf.buildSummary(session)
        : "No perf data recorded yet. Set UBUME_PERF=1 and send a prompt first.";
      ctx.appendEvent("system", "Perf report", summary);
      ctx.dispatchSession({ type: "PUSH_HISTORY", value });
      ctx.resetComposer();
    };
  }

  if (WORKBENCH_COMMANDS.includes(value)) {
    return () => {
      ctx.resetComposer();
      ctx.openWorkbench(value.slice(1) as WorkbenchView);
    };
  }

  if (value === "/send-now") {
    return async () => {
      ctx.resetComposer();
      await ctx.handleSendNow();
    };
  }

  if (value.startsWith("/resume ")) {
    return () => {
      if (!ctx.busy) {
        ctx.resetComposer();
        void ctx.resumeConversation(value.slice("/resume ".length).trim());
      }
    };
  }

  return null;
}

/**
 * `!command` runs in the workspace shell. It waits for a previous run to
 * stop, and is dropped if the submission was canceled meanwhile.
 */
export async function handleShellSubmission(ctx: UseAppInputContext, value: string): Promise<void> {
  if (ctx.busy) {
    return;
  }
  const shellCommand = value.slice(1).trim();
  if (!shellCommand) {
    return;
  }
  ctx.submissionRef.current = true;
  const generation = ctx.pipelineGenerationRef.current;
  try {
    await ctx.stoppingRef.current;
    const stillWanted =
      generation === ctx.pipelineGenerationRef.current && ctx.activeRunIdRef.current === null;
    if (!stillWanted) {
      return;
    }
    ctx.dispatchSession({ type: "PUSH_HISTORY", value });
    ctx.resetComposer();
    await ctx.handleShellExecute(shellCommand);
  } finally {
    ctx.submissionRef.current = false;
  }
}

/**
 * Parses `/` and `?` commands. Returns `null` when `value` is not a command;
 * otherwise clears the composer (commands never enter prompt history) and
 * returns the dispatched handler's result.
 */
export function routeSlashCommand(
  ctx: UseAppInputContext,
  value: string,
): { result: void | Promise<void> } | null {
  const commandResult = handleCommand(value, {
    config: ctx.layeredRuntimeConfig,
    runtime: ctx.runtimeConfig,
    resolvedRuntime: ctx.resolvedRuntimeConfig,
    settings: {
      workspaceDisplayMode: ctx.workspaceDisplayMode,
      terminalTitleMode: ctx.terminalTitleMode,
      showBusyLoader: ctx.showBusyLoader,
    },
    workspace: ctx.workspaceCommandContext,
    tokensUsed: estimateTokens(ctx.conversationChars),
    modelCapabilities: ctx.activeRouteModelCapabilities,
    routeStatusMessage: ctx.routeStatusMessage,
    activeRouteProviderLabel: ctx.activeRouteProvider?.displayName ?? "OpenAI",
    projectInstructions: ctx.projectInstructionsLoad,
  });
  if (commandResult === null) {
    return null;
  }
  ctx.resetComposer();
  return { result: dispatchCommand({ ...ctx, commandResult }) };
}

/**
 * Expands pasted-content and file-attachment placeholders into the text sent
 * to the provider, and checks every attached image still exists.
 *
 * Returns `null` (after reporting why) when the prompt cannot be sent, or
 * when the submission was canceled while attachments were being read.
 */
export async function expandPromptAttachments(
  ctx: UseAppInputContext,
  value: string,
): Promise<string | null> {
  ctx.submissionRef.current = true;
  const generation = ctx.pipelineGenerationRef.current;
  try {
    assertAttachedContent(
      value,
      ctx.pastedContentRegistryRef.current,
      ctx.imageAttachmentRegistryRef.current,
      ctx.fileAttachmentRegistryRef.current,
    );

    const providerValue = await expandFileAttachments(
      expandPastedContent(value, ctx.pastedContentRegistryRef.current),
      ctx.fileAttachmentRegistryRef.current,
      ctx.workspaceRoot,
    );

    for (const attachment of selectImageAttachments(
      value,
      ctx.imageAttachmentRegistryRef.current,
    )) {
      if (!existsSync(attachment.path)) {
        throw new Error(`Image attachment is missing: ${attachment.name}`);
      }
    }

    if (generation !== ctx.pipelineGenerationRef.current) {
      return null;
    }

    await ctx.stoppingRef.current;
    return providerValue;
  } catch (error) {
    ctx.appendEvent("error", "Prompt unavailable", (error as Error).message);
    return null;
  } finally {
    ctx.submissionRef.current = false;
  }
}

/**
 * Handles paths outside the workspace that the prompt mentions.
 *
 * Skipped dependency sources are reported. When outside paths remain, the
 * prompt either goes to the import-confirmation panel (if external imports
 * are allowed) or is blocked by the workspace guard.
 *
 * Returns `true` when the prompt must not be started now.
 */
export function interceptOutsideWorkspacePaths(
  ctx: UseAppInputContext,
  value: string,
  providerValue: string,
): boolean {
  const { violations, skippedExternalPaths } = findOutsideWorkspacePaths(
    providerValue,
    ctx.workspaceRoot,
    ctx.allowedWritableRoots,
    { context: "prompt" },
  );
  for (const skipped of skippedExternalPaths) {
    ctx.appendEvent(
      "system",
      "Dependency skipped",
      `Skipped external dependency source: ${formatSkippedDependencyPath(skipped)}`,
    );
  }
  if (violations.length === 0) {
    return false;
  }

  const policy = ctx.runtimeConfig.policy;
  if (policy.allowExternalFileImport) {
    const files: PendingImportFile[] = violations.map((violation) => ({
      srcPath: violation.normalizedPath,
      rawPath: violation.rawPath,
      destFilename: path.basename(violation.normalizedPath),
      isImage: isImageFile(violation.normalizedPath),
    }));
    ctx.setPendingImport({
      prompt: value,
      providerPrompt: providerValue,
      files,
      attachmentsDir: resolveUbumeAttachmentDir(ctx.workspaceRoot, policy.attachmentDir),
    });
    ctx.setScreen("import-confirmation");
    return true;
  }

  const guardMessage = getPromptWorkspaceGuardMessage(
    providerValue,
    ctx.workspaceRoot,
    ctx.allowedWritableRoots,
  );
  if (guardMessage) {
    ctx.appendEvent("error", "Workspace boundary", guardMessage);
    return true;
  }
  return false;
}
