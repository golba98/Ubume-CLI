/**
 * Appearance commit hooks: `useThemeCommit` and `useStartupLogoCommit` are the
 * two write paths for the appearance settings (from `/theme`, `/preferences →
 * Color Theme`, and `/preferences → Startup Logo`). Both must persist through
 * the same settings payload (so neither path can drop the other's value) and
 * both must request the atomic home repaint that recolors the flushed banner.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type React from "react";
import type { AppSettings, loadSettings as loadSettingsType } from "../../config/persistence.js";
import { loadSettings } from "../../config/persistence.js";
import { useStartupLogoCommit } from "./useStartupLogoCommit.js";
import { useThemeCommit } from "./useThemeCommit.js";

interface CommitApi {
  repaintCommittedTheme: (themeName: string) => void;
  commitStartupLogoStyle: (style: "normal" | "minimal" | "simple") => void;
}

function createInitialSettings(): ReturnType<typeof loadSettingsType> {
  return loadSettings();
}

function buildHarness(root: string) {
  const initialSettings: React.RefObject<AppSettings> = { current: createInitialSettings() };
  const state = {
    themeSelection: { committedTheme: "dark", previewTheme: null },
    startupLogoStyle: "normal" as "normal" | "minimal" | "simple",
    setStartupLogoStyle: (
      value:
        | ("normal" | "minimal" | "simple")
        | ((current: "normal" | "minimal" | "simple") => "normal" | "minimal" | "simple"),
    ) => {
      state.startupLogoStyle = typeof value === "function" ? value(state.startupLogoStyle) : value;
    },
    setThemeSelection: (
      updater: (current: { committedTheme: string }) => { committedTheme: string },
    ) => {
      state.themeSelection = updater(state.themeSelection) as typeof state.themeSelection;
    },
    themeNotice: null as string | null,
    setThemeNotice: (value: string | null | ((current: string | null) => string | null)) => {
      state.themeNotice = typeof value === "function" ? value(state.themeNotice) : value;
    },
  };
  const calls: string[] = [];
  const noop = () => {};

  function Harness() {
    const themeApi = useThemeCommit({
      initialSettings,
      workspaceDisplayMode: "dir",
      terminalTitleMode: "dir",
      showBusyLoader: true,
      startupLogoStyle: state.startupLogoStyle,
      startupAnimation: true,
      customTheme: undefined,
      authPreference: "chatgpt-login-goal",
      headerConfig: initialSettings.current.header,
      setThemeSelection: state.setThemeSelection as never,
      setThemeNotice: state.setThemeNotice,
      themeNoticeTimerRef: { current: null },
      requestHomeRepaint: () => calls.push("homeRepaint"),
    });
    const logoApi = useStartupLogoCommit({
      initialSettings,
      themeSelection: state.themeSelection,
      workspaceDisplayMode: "dir",
      terminalTitleMode: "dir",
      showBusyLoader: true,
      startupAnimation: true,
      customTheme: undefined,
      authPreference: "chatgpt-login-goal",
      headerConfig: initialSettings.current.header,
      setStartupLogoStyle: state.setStartupLogoStyle,
      setThemeNotice: state.setThemeNotice,
      themeNoticeTimerRef: { current: null },
      requestHomeRepaint: () => calls.push("homeRepaint"),
    });
    api = { ...themeApi, ...logoApi };
    return null;
  }

  let api: CommitApi | undefined;
  const output = new PassThrough();
  output.on("data", noop);
  const terminal = render(<Harness />, {
    stdout: output as never,
    stderr: output as never,
    stdin: new PassThrough() as never,
    debug: true,
    patchConsole: false,
  });

  return {
    api: () => api!,
    state,
    calls,
    // Commits read sibling state from the last render; a re-render between
    // commits mirrors the real app, where the first commit re-renders before
    // the second picker is ever opened.
    rerender: () => {
      terminal.rerender(<Harness />);
    },
    cleanup: () => {
      terminal.unmount();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("theme and startup-logo commits persist one shared appearance payload and request the home repaint", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-appearance-commit-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const harness = buildHarness(root);

  try {
    // /theme or /preferences → Color Theme: same commit path.
    harness.api().repaintCommittedTheme("purple");
    expect(harness.state.themeSelection.committedTheme).toBe("purple");
    expect(harness.state.themeNotice).toContain("Theme switched to");
    expect(harness.calls.includes("homeRepaint")).toBe(true);

    const afterTheme = JSON.parse(readFileSync(join(root, ".ubume-settings.json"), "utf8")) as {
      ui: { theme: string; startup_logo_style: string };
    };
    expect(afterTheme.ui.theme).toBe("purple");
    expect(afterTheme.ui.startup_logo_style).toBe("normal");

    harness.rerender();

    // /preferences → Startup Logo: applies immediately and persists.
    harness.api().commitStartupLogoStyle("minimal");
    expect(harness.state.startupLogoStyle).toBe("minimal");
    expect(harness.state.themeNotice).toContain("Startup logo set to Minimal");
    expect(harness.calls.filter((call) => call === "homeRepaint").length).toBe(2);

    const settingsFile = JSON.parse(readFileSync(join(root, ".ubume-settings.json"), "utf8")) as {
      ui: { theme: string; startup_logo_style: string; startup_animation: boolean };
    };
    expect(settingsFile.ui.theme).toBe("purple");
    expect(settingsFile.ui.startup_logo_style).toBe("minimal");
    expect(settingsFile.ui.startup_animation).toBe(true);

    // The settings file round-trips both appearance values on reload.
    const reloaded = loadSettings();
    expect(reloaded.ui.theme).toBe("purple");
    expect(reloaded.ui.startupLogoStyle).toBe("minimal");
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    harness.cleanup();
  }
});
