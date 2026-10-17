import { useCallback, useEffect, useRef } from "react";
import { APP_VERSION } from "../../config/settings.js";
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
import type { Screen } from "../../session/types.js";

interface UseUpdateCheckContext {
  startupUpdateEnabled: React.RefObject<boolean>;
  updateCheckResult: UpdateCheckResult | null;
  setUpdateCheckResult: React.Dispatch<React.SetStateAction<UpdateCheckResult | null>>;
  returnFromUpdateOverlay: () => void;
  screenRef: React.RefObject<Screen>;
  /** Test seam — replaces the registry check, timers, or policy. */
  schedulerDeps?: Partial<Omit<UpdateCheckSchedulerDeps, "onResult">>;
}

function loadCachedUpdateForRunningVersion(): UpdateCheckResult | null {
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
  const {
    startupUpdateEnabled,
    updateCheckResult,
    setUpdateCheckResult,
    returnFromUpdateOverlay,
    screenRef,
    schedulerDeps,
  } = context;

  // The scheduler lives for the whole mount; read current values through refs
  // so its callbacks never act on a stale closure.
  const updateCheckResultRef = useRef(updateCheckResult);
  updateCheckResultRef.current = updateCheckResult;
  const returnFromUpdateOverlayRef = useRef(returnFromUpdateOverlay);
  returnFromUpdateOverlayRef.current = returnFromUpdateOverlay;
  const schedulerDepsRef = useRef(schedulerDeps);
  const schedulerRef = useRef<UpdateCheckScheduler | null>(null);

  // Check npm on every interactive startup before enabling the composer.
  // After that, keep checking periodically (with backoff on failures) so a
  // release published while Ubume is running is still detected. Background
  // results only update state; they never open the prompt or move focus.
  useEffect(() => {
    const publish = (next: UpdateCheckResult) => {
      updateCheckResultRef.current = next;
      setUpdateCheckResult(next);
    };
    // Only the startup gate is closed here; a late result must never close an
    // overlay the user opened after startup.
    const leaveStartupOverlay = () => {
      if (screenRef.current === "update-prompt") returnFromUpdateOverlayRef.current();
    };

    const scheduler = createUpdateCheckScheduler({
      check: (signal) => checkForUpdates({ enabled: true }, { signal }),
      ...schedulerDepsRef.current,
      onResult: (result) => {
        if (isVerifiedUpdateResult(result)) {
          if (!isEquivalentUpdateResult(updateCheckResultRef.current, result)) publish(result);
          saveUpdateCheckCache({
            lastChecked: result.checkedAt,
            currentVersion: result.currentVersion,
            latestVersion: result.latestVersion,
            updateAvailable: result.status === "update-available",
          });
          if (result.status !== "update-available") leaveStartupOverlay();
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
        leaveStartupOverlay();
      },
    });
    schedulerRef.current = scheduler;
    if (startupUpdateEnabled.current) scheduler.start();

    return () => {
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Explicit `/update` checks share the scheduler's single in-flight request. */
  const requestUpdateCheck = useCallback(
    (): Promise<UpdateCheckResult> =>
      schedulerRef.current?.checkNow() ?? checkForUpdates({ enabled: true }),
    [],
  );

  return { requestUpdateCheck };
}
