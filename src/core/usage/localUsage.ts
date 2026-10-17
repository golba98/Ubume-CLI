/**
 * Local adapter: model, context window (percentage only when verified/configured), harness token
 * counts, and N/A vs remote-endpoint quota.
 */

import { getLocalUsageRecord } from "./localUsageTracker.js";
import { percentOfTotal } from "./normalize.js";
import type {
  ProviderUsageSnapshot,
  UsageAdapter,
  UsageFact,
  UsageLimit,
  UsageRequestContext,
} from "./types.js";

const BACKEND_LABELS: Record<string, string> = {
  "lm-studio": "LM Studio",
  unsloth: "Unsloth Studio",
};

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Local runtime facts only: Ubume's own observations of the active Local route.
 * Account quota does not apply to loopback inference; a remote endpoint is never
 * treated as unlimited.
 */
export function buildLocalUsageSnapshot(context: UsageRequestContext): ProviderUsageSnapshot {
  const facts = context.localFacts;
  const providerId = context.route.providerId;
  const providerLabel =
    providerId === "local"
      ? `Local · ${BACKEND_LABELS[facts?.localBackend ?? context.route.localBackend ?? "lm-studio"] ?? "OpenAI-compatible"}`
      : `Local (${providerId})`;
  const isLocal = facts?.isLocalInference ?? false;
  const record = getLocalUsageRecord(context.scopeKey);
  const factRows: UsageFact[] = [
    { id: "local.model", label: "Model", value: facts?.modelId ?? context.route.modelId },
    isLocal
      ? { id: "local.quota", label: "Account quota", value: "N/A — local inference", tone: "muted" }
      : {
          id: "local.quota",
          label: "Account quota",
          value: "Unavailable — remote endpoint; Ubume cannot read its billing",
          tone: "warning",
        },
  ];
  const limits: UsageLimit[] = [];
  const window = facts?.contextWindow ?? null;
  const trustedWindow =
    window !== null &&
    window > 0 &&
    (facts?.contextConfidence === "verified" || facts?.contextConfidence === "configured");

  if (record?.last) {
    const usedPercent = trustedWindow
      ? percentOfTotal(Math.min(record.last.contextTokens, window), window)
      : undefined;
    limits.push({
      id: "local.context",
      label: "Context window (last request)",
      unit: "tokens",
      used: record.last.contextTokens,
      total: trustedWindow ? window : undefined,
      usedPercent,
      remainingPercent: usedPercent === undefined ? undefined : 100 - usedPercent,
      note: trustedWindow
        ? undefined
        : window
          ? `Context size ${formatCount(window)} is an estimate; no percentage shown.`
          : "Context size unknown.",
    });
    factRows.push(
      {
        id: "local.last",
        label: "Last request",
        value: `${formatCount(record.last.inputTokens)} in · ${formatCount(record.last.outputTokens)} out`,
      },
      {
        id: "local.totals",
        label: "This conversation",
        value: `${formatCount(record.totalInputTokens)} in · ${formatCount(record.totalOutputTokens)} out · ${record.requestCount} request${record.requestCount === 1 ? "" : "s"}`,
      },
    );
  } else {
    factRows.push({
      id: "local.context",
      label: "Context window",
      value: window
        ? `${formatCount(window)} tokens${trustedWindow ? "" : " (estimated)"}`
        : "Unknown",
    });
    factRows.push({
      id: "local.totals",
      label: "Token usage",
      value: "No Local requests in this conversation yet",
      tone: "muted",
    });
  }

  return {
    providerId,
    providerLabel,
    scopeKey: context.scopeKey,
    billingMode: isLocal ? "local" : "unknown",
    status: isLocal ? "available" : "partial",
    retrievedAt: record?.last?.at,
    freshness: "observed",
    source: "Ubume Local runtime (harness token counts)",
    limits,
    facts: factRows,
    message: isLocal
      ? undefined
      : "This Local route points at a non-loopback endpoint that may be metered; check its provider for usage.",
  };
}

export const localUsageAdapter: UsageAdapter = {
  id: "local",
  passive: true,
  fetch: async (context) => buildLocalUsageSnapshot(context),
};
