import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import {
  DEFAULT_MODE,
  DEFAULT_SHOW_BUSY_LOADER,
  DEFAULT_TERMINAL_TITLE_MODE,
  DEFAULT_WORKSPACE_DISPLAY_MODE,
  estimateTokens,
  formatAuthPreferenceLabel,
  formatBackendLabel,
  formatBusyLoaderSettingValue,
  formatModeCommandHelp,
  formatModeLabel,
  formatReasoningLabel,
  formatTerminalTitleModeLabel,
  formatTerminalTitlePath,
  formatThemeLabel,
  formatWorkspaceDisplayModeLabel,
  formatWorkspaceDisplayPath,
  getCodexConfigFile,
  getCodexHome,
  getHomeDir,
  getLegacyCodexaTrustStoreFile,
  getNextMode,
  getNextRotatingMode,
  getUbumeTrustStoreFile,
  resolveModeCommand,
  USER_SETTING_DEFINITIONS,
} from "./settings.js";

test("formats codex-style mode labels", () => {
  assert.equal(formatModeLabel("suggest"), "Read-only");
  assert.equal(formatModeLabel("auto-edit"), "Auto");
  assert.equal(formatModeLabel("full-auto"), "Full Access");
});

test("resolves mode command aliases and help text", () => {
  assert.equal(resolveModeCommand("suggest"), "suggest");
  assert.equal(resolveModeCommand("ask"), "suggest");
  assert.equal(resolveModeCommand("auto"), "auto-edit");
  assert.equal(resolveModeCommand("add"), "auto-edit");
  assert.equal(resolveModeCommand("default"), "full-auto");
  assert.equal(resolveModeCommand("unknown"), null);
  assert.ok(formatModeCommandHelp().includes("suggest"));
});

test("cycles modes in the same order as Ctrl+Y", () => {
  assert.equal(getNextMode("suggest"), "auto-edit");
  assert.equal(getNextMode("auto-edit"), "full-auto");
  assert.equal(getNextMode("full-auto"), "suggest");
});

test("Shift+Tab rotation includes plan and every safety mode", () => {
  assert.deepEqual(getNextRotatingMode("full-auto", false), { mode: "full-auto", planMode: true });
  assert.deepEqual(getNextRotatingMode("full-auto", true), { mode: "suggest", planMode: false });
  assert.deepEqual(getNextRotatingMode("suggest", false), { mode: "auto-edit", planMode: false });
  assert.deepEqual(getNextRotatingMode("auto-edit", false), { mode: "full-auto", planMode: false });
});

test("defaults to full-auto mode", () => {
  assert.equal(DEFAULT_MODE, "full-auto");
});

test("defaults workspace display mode and busy loader", () => {
  assert.equal(DEFAULT_WORKSPACE_DISPLAY_MODE, "dir");
  assert.equal(DEFAULT_TERMINAL_TITLE_MODE, "dir");
  assert.equal(DEFAULT_SHOW_BUSY_LOADER, true);
  assert.equal(formatWorkspaceDisplayModeLabel("dir"), "Dir");
  assert.equal(formatWorkspaceDisplayModeLabel("name"), "Name");
  assert.equal(formatWorkspaceDisplayModeLabel("simple"), "Simple");
  assert.equal(formatTerminalTitleModeLabel("dir"), "Dir");
  assert.equal(formatBusyLoaderSettingValue(true), "true");
  assert.equal(formatBusyLoaderSettingValue(false), "false");
});

test("defines user settings through reusable schemas", () => {
  assert.deepEqual(USER_SETTING_DEFINITIONS, [
    {
      key: "workspaceDisplayMode",
      label: "Workspace display",
      description: "Controls how the workspace label is displayed in the Ubume header.",
      options: [
        { value: "dir", label: "Dir" },
        { value: "name", label: "Name" },
        { value: "simple", label: "Simple" },
      ],
    },
    {
      key: "terminalTitleMode",
      label: "Terminal title",
      description: "Controls how the terminal tab/window title is displayed.",
      options: [
        { value: "dir", label: "Dir" },
        { value: "name", label: "Name" },
        { value: "simple", label: "Simple" },
      ],
    },
    {
      key: "showBusyLoader",
      label: "Busy loader",
      description:
        "Controls whether the footer shows a subtle loading animation while Ubume is busy.",
      options: [
        { value: "true", label: "True" },
        { value: "false", label: "False" },
      ],
    },
  ]);
});

test("formats workspace display paths without changing root semantics", () => {
  assert.equal(formatWorkspaceDisplayPath("", "simple"), "");
  assert.equal(
    formatWorkspaceDisplayPath("C:\\Development\\1-JavaScript\\13-Custom CLI", "dir"),
    "13-Custom CLI",
  );
  assert.equal(
    formatWorkspaceDisplayPath("C:\\Development\\1-JavaScript\\13-Custom CLI", "name"),
    "Ubume",
  );
  assert.equal(
    formatWorkspaceDisplayPath("C:\\Development\\1-JavaScript\\13-Custom CLI", "simple"),
    "13-Custom CLI",
  );
  assert.equal(formatWorkspaceDisplayPath("C:\\", "simple"), "C:\\");
  assert.equal(formatWorkspaceDisplayPath("C:\\Workspace\\", "simple"), "Workspace");
});

test("formats terminal title labels with the same workspace semantics", () => {
  assert.equal(
    formatTerminalTitlePath("C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal", "dir"),
    "13-Custom-CLI-Normal",
  );
  assert.equal(
    formatTerminalTitlePath("C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal", "name"),
    "Ubume",
  );
  assert.equal(
    formatTerminalTitlePath("C:\\Development\\1-JavaScript\\13-Custom-CLI-Normal", "simple"),
    "Ubume",
  );
});

test("resolves CODEX_HOME-derived paths from the live environment", () => {
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "C:\\Temp\\codex-home";

  try {
    assert.equal(getCodexHome(), "C:\\Temp\\codex-home");
    assert.equal(getCodexConfigFile(), "C:\\Temp\\codex-home\\config.toml");
    assert.equal(getUbumeTrustStoreFile(), "C:\\Temp\\codex-home\\ubume-trust.json");
    assert.equal(getLegacyCodexaTrustStoreFile(), "C:\\Temp\\codex-home\\codexa-trust.json");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
});

test("home resolution honors injected Windows and POSIX environments", () => {
  assert.equal(
    getHomeDir({ USERPROFILE: "C:\\Users\\tester", HOME: "/ignored" }),
    "C:\\Users\\tester",
  );
  assert.equal(getHomeDir({ HOME: "/home/tester" }), "/home/tester");
  assert.equal(getHomeDir({}), homedir());

  // Test getCodexHome with explicit env argument
  assert.equal(getCodexHome({ CODEX_HOME: "/custom/codex" }), "/custom/codex");
  assert.equal(getCodexHome({ HOME: "/custom/home" }), "/custom/home/.codex");
});

test("formats labels for backend, reasoning, theme, and estimates tokens", () => {
  assert.equal(formatBackendLabel("codex-subprocess"), "Ubume Core");
  assert.equal(formatBackendLabel("custom-backend"), "custom-backend");
  assert.equal(formatReasoningLabel("high"), "High");
  assert.equal(formatReasoningLabel("xhigh"), "XHigh");
  assert.equal(formatReasoningLabel("custom-level"), "Custom Level");
  assert.equal(formatThemeLabel("dark"), "Ubume Dark");
  assert.equal(formatThemeLabel("custom-id"), "custom-id");
  assert.equal(formatAuthPreferenceLabel("chatgpt-login-goal"), "ChatGPT login goal");
  assert.equal(estimateTokens(100), 25);
  assert.equal(estimateTokens(0), 0);
});
