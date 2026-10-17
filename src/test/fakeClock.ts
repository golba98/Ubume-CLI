/** Injected timers for scheduler tests; this does not replace global timers. */
import { settle } from "./async.js";

export { settle } from "./async.js";

export interface FakeTimer {
  id: number;
  at: number;
  ms: number;
  fn: () => void;
}

export interface FakeClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Returns detached timer records in insertion order. */
  pending(): FakeTimer[];
  advance(ms: number): Promise<void>;
}

/**
 * Deterministic setTimer/clearTimer/now trio for code that takes injected timers
 * (e.g. the update-check scheduler). `advance` fires due timers in order and
 * yields between callbacks so their async work can progress. Newly scheduled timers are also
 * eligible within the advance window; equal deadlines retain insertion order.
 */
export function createFakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, FakeTimer>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      timers.set(id, { id, at: now + ms, ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pending: () => [...timers.values()].map((timer) => ({ ...timer })),
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.values()]
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
        await settle();
      }
      now = target;
    },
  };
}
