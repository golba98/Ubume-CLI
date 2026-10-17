/**
 * Pure normalization of usage values, reset times, provider text and scope identities. Missing
 * values remain unknown rather than becoming zero or an unlimited quota.
 */

import type { ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import type { ProviderRoute } from "../providerRuntime/types.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import type { UsageLimit } from "./types.js";

// Reset times further than this from now are treated as malformed rather than shown.
const MAX_RESET_DISTANCE_MS = 400 * 24 * 60 * 60 * 1000;
// Epoch values below this are seconds; above it they are already milliseconds.
const EPOCH_MS_THRESHOLD = 100_000_000_000;

/** A finite number in [0, 100], or undefined when the value is missing or out of range. */
export function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return value;
}

/** Converts a 0–1 fraction to a percentage; out-of-range fractions are rejected. */
export function percentFromFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value * 100;
}

/** Percentage of a verified, positive total. */
export function percentOfTotal(part: number | undefined, total: number | undefined) {
  if (part === undefined || total === undefined || !(total > 0) || part < 0 || part > total) {
    return undefined;
  }
  return (part / total) * 100;
}

/**
 * Parses a provider reset time (epoch seconds, epoch milliseconds or ISO 8601)
 * into epoch milliseconds. Unparseable or implausible values return undefined.
 */
export function parseResetTime(value: unknown, now: number): number | undefined {
  let ms: number;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    ms = value < EPOCH_MS_THRESHOLD ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return parseResetTime(Number(trimmed), now);
    ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return undefined;
  } else {
    return undefined;
  }
  return Math.abs(ms - now) > MAX_RESET_DISTANCE_MS ? undefined : ms;
}

/** Formats a positive usage-window duration; missing/invalid durations remain undefined. */
export function windowLabel(minutes: number | undefined): string | undefined {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  if (minutes === 10080) return "Weekly limit";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

/**
 * Completes the used/remaining percentage pair. Both sides are derived only
 * from a percentage the source reported, so the denominator is always 100%.
 */
export function completePercentPair(
  limit: Pick<UsageLimit, "usedPercent" | "remainingPercent">,
): Pick<UsageLimit, "usedPercent" | "remainingPercent"> {
  if (limit.usedPercent !== undefined) {
    return { usedPercent: limit.usedPercent, remainingPercent: 100 - limit.usedPercent };
  }
  if (limit.remainingPercent !== undefined) {
    return { usedPercent: 100 - limit.remainingPercent, remainingPercent: limit.remainingPercent };
  }
  return {};
}

/** Keeps an explicit state or derives exhaustion only from supplied usage values. */
export function deriveLimitState(limit: UsageLimit): UsageLimit["state"] {
  if (limit.state) return limit.state;
  if (limit.remainingPercent !== undefined && limit.remainingPercent <= 0) return "exhausted";
  if (limit.remaining !== undefined && limit.remaining <= 0 && limit.total !== undefined) {
    return "exhausted";
  }
  return limit.usedPercent !== undefined || limit.remainingPercent !== undefined ? "ok" : undefined;
}

/** Strips terminal control sequences and collapses whitespace in provider text. */
export function cleanProviderText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = sanitizeTerminalOutput(value).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Sanitizes and title-cases a short provider plan name; blank/non-string values remain unknown.
 */
export function formatPlanName(value: unknown): string | undefined {
  const text = cleanProviderText(value, 40);
  if (!text) return undefined;
  return text
    .split(/[\s_-]+/)
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Identifies whose usage a snapshot describes: provider, billing route and the
 * executable or endpoint in use. Never includes credentials.
 */
export function buildUsageScopeKey(
  route: Pick<ProviderRoute, "providerId" | "backendKind" | "localBackend">,
  providerConfig?: ProviderWorkspaceOverride,
): string {
  const parts: string[] = [route.providerId, route.backendKind];
  switch (route.providerId) {
    case "openai":
      parts.push(providerConfig?.codexCommandPath ?? "");
      break;
    case "anthropic":
      parts.push(providerConfig?.claudeCommandPath ?? "", providerConfig?.baseUrl ?? "");
      break;
    case "google":
      parts.push(providerConfig?.antigravityCommandPath ?? "");
      break;
    case "local":
      parts.push(
        route.localBackend ?? providerConfig?.localBackend ?? "",
        providerConfig?.baseUrl ?? "",
      );
      break;
    default:
      break;
  }
  return parts.join("|");
}
