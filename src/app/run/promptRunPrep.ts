/**
 * Pure helpers for preparing and finishing a prompt run: the per-turn
 * runtime config, the conversation history sent to the provider, and which
 * final response text to render.
 */

import type { PartialRuntimeConfig } from "../../config/runtimeConfig.js";
import {
  mergeRuntimeConfig,
  type RuntimeConfig,
  resolveRuntimeConfig,
} from "../../config/runtimeConfig.js";
import {
  isClearlySafeGeneratedCleanupRequest,
  resolveExecutionMode,
} from "../../core/codex/codexPrompt.js";
import type { ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import type { ModelContextMetadata } from "../../core/providerRuntime/contextMetadata.js";
import type { ProviderImageAttachment, ProviderRoute } from "../../core/providerRuntime/types.js";
import type {
  ConversationMessage,
  ConversationRecord,
} from "../../core/workspace/conversationStore.js";
import {
  selectConversationContext,
  toProviderConversationHistory,
} from "../../session/conversation.js";
import type { PromptRunTiming } from "../../session/eventIds.js";

/**
 * Options and callbacks for one prompt run. Normal prompts use the defaults;
 * plan generation, approved-plan execution, queued prompts, follow-up answers
 * and Codexa replays each set the fields they need.
 */
export interface PromptRunLifecycle {
  // History and attachments
  historyOverride?: readonly ConversationMessage[];
  imageAttachments?: readonly ProviderImageAttachment[];

  // Run behavior
  parseActionRequired?: boolean;
  disableModeAutoUpgrade?: boolean;
  runtimeOverride?: PartialRuntimeConfig;
  responsePresentation?: "assistant" | "plan";
  approvedPlan?: string;
  runIntent?: "normal" | "plan" | "approved-execution";

  // Submission handling
  submitTiming?: PromptRunTiming;
  commitPrompt?: boolean;
  preserveInput?: boolean;
  queuedPromptIds?: readonly string[];

  // Completion callbacks
  onCompleted?: (result: { response: string; turnId: number; runId: number }) => void;
  onFailed?: (result: { message: string; turnId: number; runId: number }) => void;
  onCanceled?: (result: { turnId: number; runId: number }) => void;
}

/**
 * The response text to render when a run completes, or `undefined` to keep
 * what was already streamed (avoiding a visible re-render). Streamed text
 * "covers" the response when it matches after whitespace normalization, or
 * is a prefix of more than 80% of it. Plan runs prefer the trailing plan
 * section captured since the last tool call.
 */
export function chooseFinalResponse(
  streamedAssistantContent: string,
  safeResponse: string,
  planSectionContent: string,
  responsePresentation: PromptRunLifecycle["responsePresentation"],
): string | undefined {
  const normalizeWs = (text: string) => text.replace(/\s+/g, " ").trim();
  const streamedNorm = normalizeWs(streamedAssistantContent);
  const responseNorm = normalizeWs(safeResponse);
  return responsePresentation === "plan"
    ? planSectionContent.trim()
      ? planSectionContent
      : safeResponse
    : streamedNorm &&
        (streamedNorm === responseNorm ||
          (responseNorm.startsWith(streamedNorm) &&
            streamedNorm.length / responseNorm.length > 0.8))
      ? undefined
      : safeResponse;
}

/** Adds `codex login` recovery steps to an authentication failure message. */
export function formatCodexAuthFailure(safeMessage: string, codexAuthFailure: boolean): string {
  return codexAuthFailure
    ? [
        "Ubume reported an authentication/session error.",
        "Recovery:",
        "  codex login",
        "",
        `Raw error: ${safeMessage}`,
      ].join("\n")
    : safeMessage;
}

// 50ms keeps assistant text live while avoiding frame-wide terminal repaint
// churn during streaming/action updates.
export const LIVE_UPDATE_FLUSH_MS = 50;

/** Flush interval when only progress/tool updates are pending (no assistant text). */
export const PROGRESS_ONLY_FLUSH_MS = 175;

/**
 * Resolves the runtime config for one turn: lifecycle overrides, the active
 * route's model and reasoning, and the execution mode. Prompts that look like
 * edits may auto-upgrade a read-only mode (unless the lifecycle disables it);
 * clearly safe cleanup prompts run with low reasoning. Codexa always runs in
 * `suggest` mode.
 */
export function preparePromptRun(
  runtimeConfig: RuntimeConfig,
  lifecycle: PromptRunLifecycle,
  safeProviderPrompt: string,
  activeProviderRoute: ProviderRoute,
  providerWorkspaceConfig: ProviderWorkspaceConfig,
) {
  const requestedRuntime = mergeRuntimeConfig(runtimeConfig, lifecycle.runtimeOverride ?? {});
  const requestedMode = requestedRuntime.mode;

  const executionModeDecision =
    activeProviderRoute.providerId === "codexa-native"
      ? { mode: "suggest" as const, autoUpgraded: false }
      : lifecycle.disableModeAutoUpgrade
        ? { mode: requestedMode, autoUpgraded: false }
        : resolveExecutionMode(requestedMode, safeProviderPrompt);
  const effectiveMode = executionModeDecision.mode;

  const runtimeConfigForTurn = {
    ...requestedRuntime,
    mode: effectiveMode,
    model: activeProviderRoute.modelId,
    reasoningLevel: activeProviderRoute.reasoning ?? requestedRuntime.reasoningLevel,
    ...(providerWorkspaceConfig.providers?.openai?.codexCommandPath
      ? { codexCommandPath: providerWorkspaceConfig.providers.openai.codexCommandPath }
      : {}),
  };
  let runtimeForTurn = resolveRuntimeConfig(runtimeConfigForTurn);

  const fastCleanupRun =
    activeProviderRoute.providerId !== "codexa-native" &&
    isClearlySafeGeneratedCleanupRequest(safeProviderPrompt) &&
    effectiveMode !== "suggest" &&
    runtimeForTurn.policy.sandboxMode !== "read-only";

  if (fastCleanupRun && ["medium", "high", "xhigh"].includes(runtimeForTurn.reasoningLevel)) {
    runtimeForTurn = resolveRuntimeConfig({
      ...runtimeConfigForTurn,
      reasoningLevel: "low",
    });
  }

  return { runtimeForTurn, fastCleanupRun, executionModeDecision, effectiveMode };
}

/**
 * The conversation history to send with a prompt. Local, Mistral and Codexa
 * receive the full history (they compact their own context window); other
 * providers receive the most recent messages that fit the model's context.
 * Codexa receives its raw generation output instead of rendered replies.
 */
export function selectProviderHistory(
  activeConversation: ConversationRecord | null,
  activeProviderRoute: ProviderRoute,
  activeContextMetadata: ModelContextMetadata | null,
) {
  const storedConversation = toProviderConversationHistory(
    (activeConversation?.messages ?? []).map((message) =>
      activeProviderRoute.providerId === "codexa-native" && message.generationMetadata
        ? { ...message, content: message.generationMetadata.rawOutput }
        : message,
    ),
    {
      includeActivitySummaries:
        activeProviderRoute.providerId !== "local" &&
        activeProviderRoute.providerId !== "mistral" &&
        activeProviderRoute.providerId !== "codexa-native",
    },
  );
  // Local models own request-window compaction so they can create a semantic
  // checkpoint before sliding old messages out. Other providers retain the
  // existing tail-selection behavior.
  const conversationHistory =
    activeProviderRoute.providerId === "local" ||
    activeProviderRoute.providerId === "mistral" ||
    activeProviderRoute.providerId === "codexa-native"
      ? [...storedConversation]
      : selectConversationContext(
          storedConversation,
          activeContextMetadata?.contextLength
            ? activeContextMetadata.contextLength * 4
            : undefined,
        );

  return conversationHistory;
}

/**
 * Runs `finish` after the live updates just flushed have rendered: deferred
 * by one tick when something was flushed, immediately otherwise.
 */
export function finishAfterLiveFlush(flushedLiveUpdates: boolean, finish: () => void): void {
  if (flushedLiveUpdates) {
    setTimeout(finish, 0);
  } else {
    finish();
  }
}
