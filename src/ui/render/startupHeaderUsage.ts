/** Read-only presentation of data already held by the session and usage service. */
import type { ModelSpec } from "../../core/providerRuntime/contextMetadata.js";
import type { UsageViewState } from "../../core/usage/usageService.js";
import { getTokenBarDisplay } from "../chrome/composer/composerModel.js";

export function startupHeaderUsage(
  tokensUsed: number,
  spec: ModelSpec,
  usage: UsageViewState,
  scopeKey: string,
  providerId: string,
): string {
  const context = getTokenBarDisplay(tokensUsed, spec);
  if (
    context.percentage !== null &&
    spec.status === "verified" &&
    Number.isFinite(spec.contextWindow) &&
    spec.contextWindow > 0 &&
    Number.isFinite(tokensUsed) &&
    tokensUsed >= 0
  ) {
    return `Context: ~${context.percentage}% used (estimate)`;
  }
  const snapshot =
    usage.scopeKey === scopeKey &&
    usage.snapshot?.scopeKey === scopeKey &&
    usage.snapshot.providerId === providerId
      ? usage.snapshot
      : null;
  if (
    snapshot &&
    usage.origin !== "stale" &&
    (snapshot.status === "available" || snapshot.status === "partial")
  ) {
    const limit = snapshot.limits.find(
      (limit) => Number.isFinite(limit.usedPercent) || Number.isFinite(limit.remainingPercent),
    );
    if (limit) {
      const used = limit.usedPercent ?? 100 - limit.remainingPercent!;
      if (used >= 0 && used <= 100)
        return `${limit.label}: ${Math.round(used)}% used${usage.origin === "cached" ? " (cached)" : ""}`;
    }
  }
  return "Usage unavailable";
}
