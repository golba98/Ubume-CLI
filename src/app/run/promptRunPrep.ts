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
import type { ConversationRecord } from "../../core/workspace/conversationStore.js";
import {
  selectConversationContext,
  toProviderConversationHistory,
} from "../../session/conversation.js";
import type { PromptRunTiming } from "../../session/eventIds.js";

export interface PromptRunLifecycle {
  historyOverride?: readonly import("../../core/workspace/conversationStore.js").ConversationMessage[];
  parseActionRequired?: boolean;
  disableModeAutoUpgrade?: boolean;
  runtimeOverride?: PartialRuntimeConfig;
  responsePresentation?: "assistant" | "plan";
  approvedPlan?: string;
  submitTiming?: PromptRunTiming;
  commitPrompt?: boolean;
  preserveInput?: boolean;
  queuedPromptIds?: readonly string[];
  runIntent?: "normal" | "plan" | "approved-execution";
  imageAttachments?: readonly ProviderImageAttachment[];
  onCompleted?: (result: { response: string; turnId: number; runId: number }) => void;
  onFailed?: (result: { message: string; turnId: number; runId: number }) => void;
  onCanceled?: (result: { turnId: number; runId: number }) => void;
}

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

export const PROGRESS_ONLY_FLUSH_MS = 175;

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

export function createShellLineBatcher(emit: (stdout: string[], stderr: string[]) => void) {
  let pendingStdout: string[] = [];
  let pendingStderr: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const flush = () => {
    cancel();
    const stdout = pendingStdout;
    const stderr = pendingStderr;
    pendingStdout = [];
    pendingStderr = [];
    if (stdout.length === 0 && stderr.length === 0) return;
    emit(stdout, stderr);
  };
  const enqueue = (stream: "stdout" | "stderr", lines: string[]) => {
    (stream === "stdout" ? pendingStdout : pendingStderr).push(...lines);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, LIVE_UPDATE_FLUSH_MS);
  };
  return { enqueue, flush, cancel };
}

export function finishAfterLiveFlush(flushedLiveUpdates: boolean, finish: () => void): void {
  if (flushedLiveUpdates) setTimeout(finish, 0);
  else finish();
}
