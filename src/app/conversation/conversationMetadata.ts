/**
 * Pure transformations of saved conversations used when saving, finishing a
 * run, and resuming. No React, filesystem or provider calls.
 */

import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type {
  ConversationMessage,
  ConversationMetadata,
} from "../../core/workspace/conversationStore.js";
import {
  buildPersistedAssistantMessage,
  type PersistedRunStatus,
} from "../../session/persistedResponse.js";
import type { TimelineEvent } from "../../session/types.js";
import type { ActiveRunCapture } from "../run/providerRunSession.js";

/** How many submitted prompts a resumed chat restores into composer history. */
const RESTORED_HISTORY_LIMIT = 50;

/** Records the route a conversation is running on in its metadata. */
export function withRouteMetadata(
  metadata: ConversationMetadata,
  route: ProviderRoute,
): ConversationMetadata {
  return {
    ...metadata,
    providerId: route.providerId,
    modelId: route.modelId,
    backendKind: route.backendKind,
    ...(route.localBackend ? { localBackend: route.localBackend } : {}),
    ...(route.reasoning ? { reasoning: route.reasoning } : {}),
  };
}

/** Approximate conversation size used for context-window estimates. */
export function conversationCharCount(messages: readonly ConversationMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

/**
 * When a chat was saved mid-run (its last message is the user's prompt and
 * its last run event was still running), returns an assistant message with
 * the partial streamed text, marked as interrupted. Otherwise `null`.
 */
export function interruptedRunMessage(
  savedEvents: readonly TimelineEvent[],
  messages: readonly ConversationMessage[],
): ConversationMessage | null {
  if (messages.at(-1)?.role !== "user") {
    return null;
  }
  const newestFirst = [...savedEvents].reverse();
  const partial = newestFirst.find((event) => event.type === "assistant");
  const lastRun = newestFirst.find((event) => event.type === "run");
  const interrupted =
    lastRun?.type === "run" &&
    lastRun.status === "running" &&
    partial?.type === "assistant" &&
    partial.turnId === lastRun.turnId;
  if (!interrupted) {
    return null;
  }
  const partialText = partial.contentChunks.join("") || partial.content;
  return {
    role: "assistant",
    content: `${partialText}\n\n[Run interrupted before session closed]`,
  };
}

/** Composer history for a resumed chat without a saved session: newest prompts first. */
export function promptHistoryFromMessages(messages: readonly ConversationMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .reverse()
    .slice(0, RESTORED_HISTORY_LIMIT);
}

/**
 * Builds the assistant message to save for a finished run from what the run
 * streamed and the final response.
 *
 * Codexa can produce a run with no displayable text but with raw generation
 * output; that output is saved so the conversation keeps the model's reply.
 * Returns `null` when there is nothing to save.
 */
export function buildRunAssistantMessage(
  capture: ActiveRunCapture | null,
  status: PersistedRunStatus,
  response: { renderedResponse?: string; completeResponse?: string; errorMessage?: string },
): ConversationMessage | null {
  const message = buildPersistedAssistantMessage({
    status,
    ...response,
    streamedText: capture?.text ?? "",
    toolCommands: capture ? [...capture.tools.values()] : [],
    fileActivity: capture ? [...capture.files.values()] : [],
  });
  const generationMetadata = capture?.generationMetadata;
  if (message) {
    return generationMetadata ? { ...message, generationMetadata } : message;
  }
  if (generationMetadata?.providerId === "codexa-native") {
    return { role: "assistant", content: generationMetadata.rawOutput, generationMetadata };
  }
  return null;
}
