/**
 * Per-scope usage retrieval with request coalescing, cooldowns and last-good fallback. The
 * creator owns this in-memory cache; adapters own transport cleanup and receive the initiating
 * request signal.
 */

import { errorMessage } from "../shared/values.js";
import type { ProviderUsageSnapshot, UsageAdapter, UsageRequestContext } from "./types.js";

export const DEFAULT_USAGE_COOLDOWN_MS = 30_000;
const MAX_USAGE_COOLDOWN_MS = 600_000;

/** `UBUME_USAGE_COOLDOWN_SECONDS` (0–600) overrides the default 30 s refresh cooldown. */
export function resolveUsageCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UBUME_USAGE_COOLDOWN_SECONDS?.trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return DEFAULT_USAGE_COOLDOWN_MS;
  return Math.min(MAX_USAGE_COOLDOWN_MS, Math.round(Number(raw) * 1000));
}

/**
 * - `live`: retrieved by the most recent request.
 * - `cached`: reused within the cooldown instead of asking the provider again.
 * - `stale`: the latest request failed; this is the last successful snapshot.
 */
export type UsageOrigin = "live" | "cached" | "stale";

export interface UsageViewState {
  scopeKey: string;
  snapshot: ProviderUsageSnapshot | null;
  origin: UsageOrigin | null;
  inFlight: boolean;
  /** Message from the most recent failed attempt, if it failed. */
  lastError?: string;
  /** Epoch ms after which a manual refresh contacts the provider again. */
  nextRefreshAt: number;
}

interface ScopeEntry {
  /** Last snapshot that carried real data (not a transport failure). */
  good?: ProviderUsageSnapshot;
  /** Latest result, including failures. */
  latest?: ProviderUsageSnapshot;
  attemptedAt?: number;
  lastError?: string;
  inFlight?: Promise<UsageViewState>;
}

export interface UsageServiceOptions {
  now?: () => number;
  cooldownMs?: number;
}

/** Retrieval failures that keep an earlier good snapshot on screen. */
function isFailure(snapshot: ProviderUsageSnapshot): boolean {
  return snapshot.status === "temporarily_unavailable";
}

/**
 * Creates an independent per-scope cache. Concurrent requests share the initiating adapter call
 * and signal; adapters own cancellation cleanup, and failures can retain the last good snapshot.
 */
export function createUsageService(options: UsageServiceOptions = {}) {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? resolveUsageCooldownMs();
  const entries = new Map<string, ScopeEntry>();

  const viewFor = (scopeKey: string, origin: UsageOrigin | null): UsageViewState => {
    const entry = entries.get(scopeKey) ?? {};
    const failed = entry.latest !== undefined && isFailure(entry.latest);
    const shown = failed && entry.good ? entry.good : entry.latest;
    return {
      scopeKey,
      snapshot: shown ?? null,
      origin: shown ? (failed && entry.good ? "stale" : origin) : null,
      inFlight: entry.inFlight !== undefined,
      lastError: failed ? entry.lastError : undefined,
      nextRefreshAt: (entry.attemptedAt ?? Number.NEGATIVE_INFINITY) + cooldownMs,
    };
  };

  return {
    cooldownMs,

    /** Current state for a scope without contacting the provider. */
    peek(scopeKey: string): UsageViewState {
      const entry = entries.get(scopeKey);
      return viewFor(scopeKey, entry?.latest ? "cached" : null);
    },

    /**
     * Returns usage for one scope. Within the cooldown the last result is reused
     * (labelled `cached`); concurrent callers share one in-flight request.
     */
    request(
      adapter: UsageAdapter,
      context: Omit<UsageRequestContext, "now" | "signal"> & { signal?: AbortSignal },
    ): Promise<UsageViewState> {
      const { scopeKey } = context;
      const entry = entries.get(scopeKey) ?? {};
      entries.set(scopeKey, entry);
      if (entry.inFlight) return entry.inFlight;
      if (
        !adapter.passive &&
        entry.latest &&
        entry.attemptedAt !== undefined &&
        now() - entry.attemptedAt < cooldownMs
      ) {
        return Promise.resolve(viewFor(scopeKey, "cached"));
      }
      entry.attemptedAt = now();
      const signal = context.signal ?? new AbortController().signal;
      const promise = adapter
        .fetch({ ...context, signal, now })
        .catch(
          (error): ProviderUsageSnapshot => ({
            providerId: context.route.providerId,
            providerLabel: context.route.providerId,
            scopeKey,
            billingMode: "unknown",
            status: "temporarily_unavailable",
            freshness: "live",
            source: adapter.id,
            limits: [],
            facts: [],
            message: errorMessage(error, "Usage check failed."),
          }),
        )
        .then((snapshot) => {
          entry.latest = snapshot;
          if (isFailure(snapshot)) {
            entry.lastError = snapshot.message ?? "Usage check failed.";
          } else {
            entry.good = snapshot;
            entry.lastError = undefined;
          }
          entry.inFlight = undefined;
          return viewFor(scopeKey, "live");
        });
      entry.inFlight = promise;
      return promise;
    },

    /** Forget everything (tests). */
    reset(): void {
      entries.clear();
    },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;
