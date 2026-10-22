import type { ConversationRecord } from "../core/workspace/conversationStore.js";

export type ContinuationMode = "native-candidate" | "reconstructed" | "read-only";

/** A saved identifier is a candidate, never evidence that a provider has reconnected. */
export function assessContinuation(record: ConversationRecord, available = true): ContinuationMode {
  if (!available) return "read-only";
  const provider = record.metadata.providerId;
  const source =
    provider === "openai"
      ? "codex"
      : provider === "anthropic"
        ? "claude"
        : provider === "mistral"
          ? "vibe"
          : provider === "google" || provider === "antigravity"
            ? "antigravity"
            : null;
  if (
    (provider === "local" && record.metadata.localHarnessSession) ||
    record.metadata.nativeSessions?.some(
      (reference) =>
        (reference.source === source ||
          (source === "antigravity" && reference.source === "google")) &&
        reference.modelId === record.metadata.modelId &&
        reference.throughMessageCount === record.messages.length &&
        reference.transcriptHash,
    )
  )
    return "native-candidate";
  return "reconstructed";
}

export function describeContinuation(record: ConversationRecord): string {
  return assessContinuation(record) === "native-candidate"
    ? "Saved native context will be validated on the next prompt; incompatible state uses reconstructed conversation context."
    : "History restored. The next prompt reconstructs context from saved dialogue; native provider state has not been restored.";
}
