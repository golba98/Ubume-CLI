import type { StartupHeaderMiddleLine, StartupLogoRendering } from "../../config/settings.js";
/**
 * App-wide effects that are not about focus or rendering:
 *
 * - Keep `baseRuntimeConfigRef` equal to the reloaded layered config, so
 *   runtime patches (`updateRuntimeConfig`) diff against the right base.
 * - Save UI preferences to `~/.ubume-settings.json` whenever one changes.
 *   Embedded/test runs (`providerOverride`) never write the user's settings.
 * - On unmount: mark the app unmounted, run the active run's cleanup, shut
 *   down the Local harness and clear theme timers.
 *
 * App calls this immediately before `useFocusRouting`, the position these
 * effects held when they lived there, so effect order is unchanged.
 */

import { useEffect } from "react";
import type { LayeredConfigResult } from "../../config/layeredConfig.js";
import type { loadSettings } from "../../config/persistence.js";
import { saveSettings } from "../../config/persistence.js";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import type { HeaderConfig, StartupLogoStyle, Theme } from "../../config/settings.js";
import { shutdownLocalHarness } from "../../core/providerRuntime/localHarness/lazyRuntime.js";
import type { BackendProvider } from "../../core/providers/types.js";
import type { ThemeSelectionState } from "../../ui/theme.js";
import { buildSettingsPayload } from "../settings/useSettings.js";

interface UseAppLifecycleEffectsContext {
  // Runtime config base
  baseRuntimeConfigRef: React.RefObject<RuntimeConfig>;
  baseLayeredConfig: LayeredConfigResult;
  providerOverride: BackendProvider | undefined;

  // Persisted UI preferences
  initialSettings: React.RefObject<ReturnType<typeof loadSettings>>;
  themeSelection: ThemeSelectionState;
  workspaceDisplayMode: "dir" | "name" | "simple";
  terminalTitleMode: "dir" | "name" | "simple";
  showBusyLoader: boolean;
  startupLogoStyle: StartupLogoStyle;
  startupAnimation: boolean;
  startupHeaderMiddleLine?: StartupHeaderMiddleLine;
  startupLogoRendering?: StartupLogoRendering;
  customTheme: Partial<Theme> | undefined;
  authPreference: "chatgpt-login-goal" | "api-key-first" | "runner-managed";
  headerConfig: HeaderConfig;

  // Unmount cleanup
  isMountedRef: React.RefObject<boolean>;
  cleanupRef: React.RefObject<(() => void) | null>;
  themePreviewTimerRef: React.RefObject<NodeJS.Timeout | null>;
  themeNoticeTimerRef: React.RefObject<NodeJS.Timeout | null>;
}

export function useAppLifecycleEffects(context: UseAppLifecycleEffectsContext) {
  const {
    baseRuntimeConfigRef,
    baseLayeredConfig,
    providerOverride,
    initialSettings,
    themeSelection,
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader,
    startupLogoStyle,
    startupAnimation,
    startupHeaderMiddleLine,
    startupLogoRendering,
    customTheme,
    authPreference,
    headerConfig,
    isMountedRef,
    cleanupRef,
    themePreviewTimerRef,
    themeNoticeTimerRef,
  } = context;

  useEffect(() => {
    baseRuntimeConfigRef.current = baseLayeredConfig.runtime;
  }, [baseLayeredConfig.runtime]);

  useEffect(() => {
    if (providerOverride) {
      return;
    }
    saveSettings(
      buildSettingsPayload(
        initialSettings.current,
        {
          theme: themeSelection.committedTheme,
          workspaceDisplayMode,
          terminalTitleMode,
          showBusyLoader,
          startupLogoStyle,
          startupAnimation,
          startupHeaderMiddleLine,
          startupLogoRendering,
          customTheme,
        },
        authPreference,
        headerConfig,
      ),
    );
  }, [
    authPreference,
    customTheme,
    showBusyLoader,
    startupAnimation,
    startupHeaderMiddleLine,
    startupLogoRendering,
    startupLogoStyle,
    terminalTitleMode,
    themeSelection.committedTheme,
    workspaceDisplayMode,
    providerOverride,
  ]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cleanupRef.current?.();
      void shutdownLocalHarness();
      if (themePreviewTimerRef.current) {
        clearTimeout(themePreviewTimerRef.current);
        themePreviewTimerRef.current = null;
      }
      if (themeNoticeTimerRef.current) {
        clearTimeout(themeNoticeTimerRef.current);
        themeNoticeTimerRef.current = null;
      }
    };
  }, []);
}
