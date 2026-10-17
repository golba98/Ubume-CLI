import type { ProviderContextUsage } from "../providers/types.js";

/**
 * Token usage Ubume observed from its own Local runs (exact counts reported by
 * the agent harness). Totals cover the current conversation and reset on `/clear`.
 */
export interface LocalUsageRecord {
  last?: { inputTokens: number; outputTokens: number; contextTokens: number; at: number };
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
}

const records = new Map<string, LocalUsageRecord>();

/**
 * Accumulates exact Local token counts; compaction re-emits and inexact estimates do not add
 * requests.
 */
export function recordLocalContextUsage(
  scopeKey: string,
  usage: ProviderContextUsage,
  at: number,
): void {
  // Compaction re-emits the previous usage; counting it again would double the totals.
  if (usage.compacted || !usage.exact) return;
  const record = records.get(scopeKey) ?? {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    requestCount: 0,
  };
  record.last = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    contextTokens: usage.contextTokens,
    at,
  };
  record.totalInputTokens += Math.max(0, usage.inputTokens);
  record.totalOutputTokens += Math.max(0, usage.outputTokens);
  record.requestCount += 1;
  records.set(scopeKey, record);
}

/** Returns the in-memory conversation totals for a usage scope, if observed. */
export function getLocalUsageRecord(scopeKey: string): LocalUsageRecord | undefined {
  return records.get(scopeKey);
}

/** Called when a new conversation starts (`/clear`). */
export function resetLocalUsageRecords(): void {
  records.clear();
}
