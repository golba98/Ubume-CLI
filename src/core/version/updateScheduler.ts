/**
 * Schedules update checks with injected timers: single-flight requests, a periodic interval
 * after successes, jittered exponential backoff after failures, and disposal that aborts in-
 * flight requests. Classifies only completed comparisons as verified results.
 */

import { APP_VERSION } from "../../config/settings.js";
import { traceUpdateCheck } from "../perf/debugLog.js";
import { errorMessage } from "../shared/values.js";
import { normalizeVersion, type UpdateCheckResult } from "./updateCheck.js";

export interface UpdateCheckPolicy {
  /** Delay before the next check after a successful (verified) check. */
  successIntervalMs: number;
  /** Delay before the first retry after a failed check; doubles per consecutive failure. */
  initialRetryDelayMs: number;
  /** Upper bound for the retry delay. */
  maxRetryDelayMs: number;
  /** Fraction of a delay that jitter may shave off (jitter never lengthens a delay). */
  jitterRatio: number;
}

export const DEFAULT_UPDATE_CHECK_POLICY: UpdateCheckPolicy = {
  successIntervalMs: 15 * 60_000,
  initialRetryDelayMs: 30_000,
  maxRetryDelayMs: 15 * 60_000,
  jitterRatio: 0.1,
};

/** Only a completed registry comparison counts; errors and unknown results never prove anything. */
export function isVerifiedUpdateResult(
  result: UpdateCheckResult | null | undefined,
): result is UpdateCheckResult {
  return result?.status === "up-to-date" || result?.status === "update-available";
}

/** Same user-visible outcome, ignoring when or from where it was checked. */
export function isEquivalentUpdateResult(
  a: UpdateCheckResult | null | undefined,
  b: UpdateCheckResult | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.status === b.status &&
    a.currentVersion === b.currentVersion &&
    a.latestVersion === b.latestVersion
  );
}

/**
 * Computes capped exponential failure backoff or the success interval, with jitter that only
 * shortens the delay.
 */
export function computeNextCheckDelay(
  policy: UpdateCheckPolicy,
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const base =
    consecutiveFailures <= 0
      ? policy.successIntervalMs
      : Math.min(
          policy.maxRetryDelayMs,
          policy.initialRetryDelayMs * 2 ** Math.min(consecutiveFailures - 1, 30),
        );
  const jitter = Math.min(Math.max(random(), 0), 1) * policy.jitterRatio;
  return Math.max(1, Math.round(base * (1 - jitter)));
}

/** setTimeout that never keeps an otherwise-finished process alive. */
export function scheduleUnrefTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

function clearUnrefTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

type CheckTrigger = "startup" | "scheduled" | "manual";

export interface UpdateCheckSchedulerDeps {
  check: (signal: AbortSignal) => Promise<UpdateCheckResult>;
  onResult: (result: UpdateCheckResult) => void;
  policy?: UpdateCheckPolicy;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  random?: () => number;
  trace?: (event: string, details?: Record<string, unknown>) => void;
}

export interface UpdateCheckSchedulerSnapshot {
  started: boolean;
  disposed: boolean;
  checking: boolean;
  lastVerified: UpdateCheckResult | null;
  lastFailure: UpdateCheckResult | null;
  consecutiveFailures: number;
  nextCheckAt: number | null;
}

export interface UpdateCheckScheduler {
  /** Run the startup check now and keep checking periodically until disposed. */
  start(): void;
  /** Check now, joining the in-flight request when one is already running. */
  checkNow(): Promise<UpdateCheckResult>;
  /** Stop polling, abort any in-flight request, and ignore late responses. */
  dispose(): void;
  getSnapshot(): UpdateCheckSchedulerSnapshot;
}

/**
 * Owns single-flight checks and retry timers until dispose. Disposal aborts current work and
 * prevents late results from publishing or rescheduling.
 */
export function createUpdateCheckScheduler(deps: UpdateCheckSchedulerDeps): UpdateCheckScheduler {
  const policy = deps.policy ?? DEFAULT_UPDATE_CHECK_POLICY;
  const setTimer = deps.setTimer ?? scheduleUnrefTimer;
  const clearTimer = deps.clearTimer ?? clearUnrefTimer;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const trace = deps.trace ?? traceUpdateCheck;

  let started = false;
  let disposed = false;
  let timer: unknown = null;
  let nextCheckAt: number | null = null;
  let inFlight: Promise<UpdateCheckResult> | null = null;
  let abortController: AbortController | null = null;
  let lastVerified: UpdateCheckResult | null = null;
  let lastFailure: UpdateCheckResult | null = null;
  let consecutiveFailures = 0;

  const failureResult = (message: string): UpdateCheckResult => ({
    status: "error",
    currentVersion: normalizeVersion(APP_VERSION),
    latestVersion: null,
    errorMessage: message,
    checkedAt: now(),
    source: "npm",
  });

  const clearPendingTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    nextCheckAt = null;
  };

  const scheduleNext = () => {
    clearPendingTimer();
    const delay = computeNextCheckDelay(policy, consecutiveFailures, random);
    nextCheckAt = now() + delay;
    timer = setTimer(() => {
      timer = null;
      nextCheckAt = null;
      void runCheck("scheduled");
    }, delay);
    trace("schedule", { delayMs: delay, consecutiveFailures });
  };

  const runCheck = (trigger: CheckTrigger): Promise<UpdateCheckResult> => {
    if (disposed) return Promise.resolve(failureResult("Update checking has stopped."));
    if (inFlight) return inFlight;

    clearPendingTimer();
    const controller = new AbortController();
    abortController = controller;
    trace("check:start", { trigger });

    const request = (async (): Promise<UpdateCheckResult> => {
      try {
        return await deps.check(controller.signal);
      } catch (err) {
        return failureResult(errorMessage(err));
      }
    })();

    inFlight = request.then((result) => {
      inFlight = null;
      if (abortController === controller) abortController = null;
      if (disposed) {
        trace("check:dropped", { trigger, status: result.status });
        return result;
      }

      if (isVerifiedUpdateResult(result)) {
        lastVerified = result;
        lastFailure = null;
        consecutiveFailures = 0;
      } else {
        lastFailure = result;
        consecutiveFailures += 1;
      }
      trace("check:done", {
        trigger,
        status: result.status,
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
        consecutiveFailures,
      });

      try {
        deps.onResult(result);
      } catch (err) {
        trace("onResult:error", { error: errorMessage(err) });
      }
      if (started) scheduleNext();
      return result;
    });
    return inFlight;
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      void runCheck("startup");
    },
    checkNow() {
      return runCheck("manual");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPendingTimer();
      abortController?.abort();
      abortController = null;
      trace("dispose");
    },
    getSnapshot() {
      return {
        started,
        disposed,
        checking: inFlight !== null,
        lastVerified,
        lastFailure,
        consecutiveFailures,
        nextCheckAt,
      };
    },
  };
}
