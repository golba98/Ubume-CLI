/** Event-loop and observable-condition synchronization for tests; no global timers are replaced. */
import { performance } from "node:perf_hooks";

/** Yields a bounded number of event-loop turns, including promise work queued by each turn.
 * This is not a guarantee that arbitrary asynchronous operations or Ink renders have finished.
 */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface WaitOptions {
  label: string;
  timeoutMs?: number;
  intervalMs?: number;
  diagnostics?: () => string;
}

/**
 * Waits for an observable state, reporting caller-owned diagnostics on timeout.
 * Predicate errors propagate immediately; this helper does not retry failed assertions.
 */
export async function waitFor(
  check: () => boolean,
  { label, timeoutMs = 5000, intervalMs = 25, diagnostics }: WaitOptions,
): Promise<void> {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  )
    throw new RangeError("waitFor requires a finite non-negative timeout and positive interval");
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const detail = diagnostics?.();
      throw new Error(`Timed out: ${label}${detail ? `\n${detail}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}
