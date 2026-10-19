/**
 * Update checks for the interactive session.
 *
 * Owns the update scheduler: a non-blocking startup check, periodic background checks, and
 * on-demand `/update check` requests that share the scheduler's in-flight
 * request. A failed check never clears an update that was already detected.
 */

import { useCallback, useEffect, useRef } from "react";
import { APP_VERSION } from "../../config/settings.js";
import * as benchTrace from "../../core/perf/benchTrace.js";
import {
  checkForUpdates,
  isCacheForRunningVersion,
  loadUpdateCheckCache,
  saveUpdateCheckCache,
  type UpdateCheckResult,
} from "../../core/version/updateCheck.js";
import {
  createUpdateCheckScheduler,
  isEquivalentUpdateResult,
  isVerifiedUpdateResult,
  type UpdateCheckScheduler,
  type UpdateCheckSchedulerDeps,
} from "../../core/version/updateScheduler.js";

interface UseUpdateCheckContext {
  // Update result state
  startupUpdateEnabled: React.RefObject<boolean>;
  updateCheckResult: UpdateCheckResult | null;
  setUpdateCheckResult: React.Dispatch<React.SetStateAction<UpdateCheckResult | null>>;

  // Test seam
  /** Test seam — replaces the registry check, timers, or policy. */
  schedulerDeps?: Partial<Omit<UpdateCheckSchedulerDeps, "onResult">>;
}

/**
 * A cached "update available" result, but only if it was recorded for the
 * version that is running now (an upgrade makes older cache entries moot).
 */
export function loadCachedUpdateForRunningVersion(): UpdateCheckResult | null {
  const cache = loadUpdateCheckCache();
  if (!cache?.updateAvailable || !cache.latestVersion) return null;
  if (!isCacheForRunningVersion(cache, APP_VERSION)) return null;
  return {
    status: "update-available",
    currentVersion: cache.currentVersion,
    latestVersion: cache.latestVersion,
    checkedAt: cache.lastChecked,
    source: "cache",
  };
}

export function useUpdateCheck(context: UseUpdateCheckContext) {
  const { startupUpdateEnabled, updateCheckResult, setUpdateCheckResult, schedulerDeps } = context;

  // The scheduler lives for the whole mount; read current values through refs
  // so its callbacks never act on a stale closure.
  const updateCheckResultRef = useRef(updateCheckResult);
  updateCheckResultRef.current = updateCheckResult;
  const schedulerDepsRef = useRef(schedulerDeps);
  const schedulerRef = useRef<UpdateCheckScheduler | null>(null);

  // Check npm on every eligible interactive startup without taking composer focus.
  // Manual checks share this scheduler; results never navigate away from the user's screen.
  useEffect(() => {
    const publish = (next: UpdateCheckResult) => {
      updateCheckResultRef.current = next;
      setUpdateCheckResult(next);
    };
    const scheduler = createUpdateCheckScheduler({
      check: (signal) => checkForUpdates({ enabled: true }, { signal }),
      ...schedulerDepsRef.current,
      onResult: (result) => {
        benchTrace.startupMarkOnce("update-check-result", { status: result.status });
        if (isVerifiedUpdateResult(result)) {
          if (!isEquivalentUpdateResult(updateCheckResultRef.current, result)) {
            publish(result);
          }
          saveUpdateCheckCache({
            lastChecked: result.checkedAt,
            currentVersion: result.currentVersion,
            latestVersion: result.latestVersion,
            updateAvailable: result.status === "update-available",
          });
          return;
        }

        // A failed check is never proof of being current, and it must not hide
        // an update that was already detected.
        if (updateCheckResultRef.current?.status === "update-available") return;
        // A previously confirmed update is still useful when npm is briefly
        // unreachable, but it must never suppress the next fresh check.
        const cached = updateCheckResultRef.current ? null : loadCachedUpdateForRunningVersion();
        if (cached) {
          publish(cached);
          return;
        }
      },
    });
    schedulerRef.current = scheduler;
    if (startupUpdateEnabled.current) {
      benchTrace.startupMarkOnce("update-check-start");
      scheduler.start();
    }

    return () => {
      scheduler.dispose();
      if (schedulerRef.current === scheduler) {
        schedulerRef.current = null;
      }
    };
    // Runs once: the scheduler lives for the whole mount and reads current
    // values through refs, so it never needs the changing values as deps.
  }, []);

  /** Explicit `/update` checks share the scheduler's single in-flight request. */
  const requestUpdateCheck = useCallback(
    (): Promise<UpdateCheckResult> =>
      schedulerRef.current?.checkNow() ?? checkForUpdates({ enabled: true }),
    [],
  );

  return { requestUpdateCheck };
}
