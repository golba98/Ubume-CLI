/**
 * Committing a theme choice: switch the theme, save it, and show a short
 * "Theme switched" notice in the header.
 */

import { useCallback } from "react";
import type { loadSettings } from "../../config/persistence.js";
import { saveSettings } from "../../config/persistence.js";
import { formatThemeLabel, type HeaderConfig, type Theme } from "../../config/settings.js";
import { commitThemeSelection, type ThemeSelectionState } from "../../ui/theme.js";
import { buildSettingsPayload } from "./useSettings.js";

/** How long the "Theme switched" notice stays visible. */
const THEME_NOTICE_MS = 1800;

interface UseThemeCommitContext {
  // Persisted UI preferences
  initialSettings: React.RefObject<ReturnType<typeof loadSettings>>;
  workspaceDisplayMode: "dir" | "name" | "simple";
  terminalTitleMode: "dir" | "name" | "simple";
  showBusyLoader: boolean;
  customTheme: Partial<Theme> | undefined;
  authPreference: "chatgpt-login-goal" | "api-key-first" | "runner-managed";
  headerConfig: HeaderConfig;

  // Theme commit actions
  setThemeSelection: React.Dispatch<React.SetStateAction<ThemeSelectionState>>;
  setThemeNotice: React.Dispatch<React.SetStateAction<string | null>>;
  themeNoticeTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
}

export function useThemeCommit(context: UseThemeCommitContext) {
  const {
    initialSettings,
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader,
    customTheme,
    authPreference,
    headerConfig,
    setThemeSelection,
    setThemeNotice,
    themeNoticeTimerRef,
  } = context;

  const repaintCommittedTheme = useCallback(
    (themeName: string) => {
      // Persist the committed value synchronously as well as through the normal
      // settings effect. This matters when the terminal is closed immediately
      // after choosing a theme, before React gets another effect pass.
      saveSettings(
        buildSettingsPayload(
          initialSettings.current,
          {
            theme: themeName,
            workspaceDisplayMode,
            terminalTitleMode,
            showBusyLoader,
            customTheme,
          },
          authPreference,
          headerConfig,
        ),
      );
      setThemeSelection((currentTheme) => commitThemeSelection(currentTheme, themeName));
      setThemeNotice(`Theme switched to ${formatThemeLabel(themeName)}.`);
      if (themeNoticeTimerRef.current) {
        clearTimeout(themeNoticeTimerRef.current);
      }
      themeNoticeTimerRef.current = setTimeout(() => {
        setThemeNotice(null);
        themeNoticeTimerRef.current = null;
      }, THEME_NOTICE_MS);
    },
    [
      authPreference,
      customTheme,
      headerConfig,
      showBusyLoader,
      terminalTitleMode,
      workspaceDisplayMode,
    ],
  );

  return { repaintCommittedTheme };
}
