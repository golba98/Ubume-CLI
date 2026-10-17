/**
 * Passive store for rate-limit headers that providers attach to responses Ubume
 * already receives. Nothing here issues a request; entries are labelled as
 * observations with the time they were seen.
 */

export interface ObservedRateLimitWindow {
  limit?: number;
  remaining?: number;
  /** Raw reset value from the header; parsed at display time. */
  reset?: string;
}

export interface ObservedRateLimits {
  observedAt: number;
  windows: Record<string, ObservedRateLimitWindow>;
}

export const ANTHROPIC_RATE_LIMIT_KINDS = [
  "requests",
  "tokens",
  "input-tokens",
  "output-tokens",
] as const;

type HeaderReader = { get(name: string): string | null };

function readCount(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Reads the documented `anthropic-ratelimit-*` response headers. */
export function parseAnthropicRateLimitHeaders(
  headers: HeaderReader,
  observedAt: number,
): ObservedRateLimits | null {
  const windows: Record<string, ObservedRateLimitWindow> = {};
  for (const kind of ANTHROPIC_RATE_LIMIT_KINDS) {
    const limit = readCount(headers.get(`anthropic-ratelimit-${kind}-limit`));
    const remaining = readCount(headers.get(`anthropic-ratelimit-${kind}-remaining`));
    const reset = headers.get(`anthropic-ratelimit-${kind}-reset`)?.trim() || undefined;
    if (limit === undefined && remaining === undefined) continue;
    windows[kind] = { limit, remaining, reset };
  }
  return Object.keys(windows).length > 0 ? { observedAt, windows } : null;
}

const observed = new Map<string, ObservedRateLimits>();

/** Stores a non-null passive observation by usage scope without making a request. */
export function recordObservedRateLimits(scopeKey: string, value: ObservedRateLimits | null): void {
  if (value) observed.set(scopeKey, value);
}

/** Reads the most recent passive observation for a scope without contacting its provider. */
export function getObservedRateLimits(scopeKey: string): ObservedRateLimits | undefined {
  return observed.get(scopeKey);
}

/**
 * Clears passive rate-limit observations between tests.
 */
export function resetObservedRateLimitsForTests(): void {
  observed.clear();
}
