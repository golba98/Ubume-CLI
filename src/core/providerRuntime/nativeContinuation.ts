import { createHash } from "node:crypto";
import { isSafeNativeSessionId } from "../externalSessions/types.js";
import type { CommandResult } from "../process/commandRunner.js";
import type { NativeSessionReference } from "../workspace/conversationStore.js";
import { classifyProviderFailure } from "./failures.js";
import type { ProviderChatRequest } from "./types.js";

function historyHash(history: ProviderChatRequest["conversationHistory"]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        (history ?? []).map(({ role, content, submittedContent }) => ({
          role,
          content: submittedContent ?? content,
        })),
      ),
    )
    .digest("hex");
}

/** Only explicit native missing-session diagnostics permit a fresh-session retry. */
export function isMissingNativeSession(
  result: Pick<CommandResult, "status" | "stderr">,
  providerError?: string,
): boolean {
  if (result.status !== "failed" && result.status !== "completed") return false;
  const message = providerError ?? result.stderr;
  if (classifyProviderFailure(message).kind !== "unknown") return false;
  return /no conversation found with (?:session )?id|(?:session|conversation)[^\n]{0,100}(?:not found|does not exist|unsupported)|(?:not found|does not exist)[^\n]{0,100}(?:session|conversation)/i.test(
    message,
  );
}

/** Only a completed turn from this exact dialogue/model can supply native context. */
export function nativeContinuation(
  request: ProviderChatRequest,
  source: NativeSessionReference["source"],
) {
  return [...(request.nativeSessions ?? [])]
    .reverse()
    .find(
      (reference) =>
        isSafeNativeSessionId(reference.sessionId) &&
        (reference.source === source ||
          (reference.source === "google" && source === "antigravity")) &&
        reference.modelId === request.route.modelId &&
        reference.throughMessageCount === (request.conversationHistory?.length ?? 0) &&
        reference.transcriptHash === historyHash(request.conversationHistory),
    );
}

export function completedNativeSession(
  request: ProviderChatRequest,
  source: NativeSessionReference["source"],
  sessionId: string,
  response: string,
): NativeSessionReference {
  return {
    source,
    sessionId,
    modelId: request.route.modelId,
    throughMessageCount: (request.conversationHistory?.length ?? 0) + 2,
    transcriptHash: historyHash([
      ...(request.conversationHistory ?? []),
      { role: "user", content: request.prompt },
      { role: "assistant", content: response },
    ]),
  };
}
