/**
 * Committing a startup-logo-style choice: switch the active branding, persist
 * it, and show a short notice in the header. Mirrors `useThemeCommit` so the
 * two appearance settings share one commit/persist shape; both write through
 * `buildSettingsPayload`, keeping `~/.ubume-settings.json` the single source
 * of truth for appearance preferences.
 */

import { useCallback } from "react";
import type { loadSettings } from "../../config/persistence.js";
import { saveSettings } from "../../config/persistence.js";
import {
  formatStartupLogoStyleLabel,
  type HeaderConfig,
  type StartupLogoStyle,
  type Theme,
} from "../../config/settings.js";
import type { ThemeSelectionState } from "../../ui/theme.js";
import { buildSettingsPayload } from "./useSettings.js";

/** How long the "Startup logo set" notice stays visible. */
const LOGO_NOTICE_MS = 1800;

interface UseStartupLogoCommitContext {
  // Persisted UI preferences
  initialSettings: React.RefObject<ReturnType<typeof loadSettings>>;
  themeSelection: ThemeSelectionState;
  workspaceDisplayMode: "dir" | "name" | "simple";
  terminalTitleMode: "dir" | "name" | "simple";
  showBusyLoader: boolean;
  startupAnimation: boolean;
  customTheme: Partial<Theme> | undefined;
  authPreference: "chatgpt-login-goal" | "api-key-first" | "runner-managed";
  headerConfig: HeaderConfig;

  // Startup logo commit actions
  setStartupLogoStyle: React.Dispatch<React.SetStateAction<StartupLogoStyle>>;
  setThemeNotice: React.Dispatch<React.SetStateAction<string | null>>;
  themeNoticeTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  /** Requests an atomic home-screen repaint (see App's appearance repaint effect). */
  requestHomeRepaint: () => void;
}

export function useStartupLogoCommit(context: UseStartupLogoCommitContext) {
  const {
    initialSettings,
    themeSelection,
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader,
    startupAnimation,
    customTheme,
    authPreference,
    headerConfig,
    setStartupLogoStyle,
    setThemeNotice,
    themeNoticeTimerRef,
    requestHomeRepaint,
  } = context;

  const commitStartupLogoStyle = useCallback(
    (style: StartupLogoStyle) => {
      // Persist synchronously as well as through the normal settings effect, so
      // the choice survives an immediate exit after the selection.
      saveSettings(
        buildSettingsPayload(
          initialSettings.current,
          {
            theme: themeSelection.committedTheme,
            workspaceDisplayMode,
            terminalTitleMode,
            showBusyLoader,
            startupLogoStyle: style,
            startupAnimation,
            customTheme,
          },
          authPreference,
          headerConfig,
        ),
      );
      setStartupLogoStyle(style);
      setThemeNotice(`Startup logo set to ${formatStartupLogoStyleLabel(style)}.`);
      // The flushed startup banner cannot re-render through React alone; ask
      // the clear-frame boundary for an atomic home repaint (pristine home only).
      requestHomeRepaint();
      if (themeNoticeTimerRef.current) {
        clearTimeout(themeNoticeTimerRef.current);
      }
      themeNoticeTimerRef.current = setTimeout(() => {
        setThemeNotice(null);
        themeNoticeTimerRef.current = null;
      }, LOGO_NOTICE_MS);
    },
    [
      authPreference,
      customTheme,
      headerConfig,
      requestHomeRepaint,
      showBusyLoader,
      startupAnimation,
      terminalTitleMode,
      themeSelection.committedTheme,
      workspaceDisplayMode,
    ],
  );

  return { commitStartupLogoStyle };
}
