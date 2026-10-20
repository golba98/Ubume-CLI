import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeRuntimeIntoTomlConfig, parseTomlDocument } from "./layeredConfig.js";
import {
  extractLegacyRuntime,
  getDefaultSettings,
  parseSettingsData,
  saveRuntimeModePreference,
  serializeSettings,
} from "./persistence.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtimeConfig.js";

test("extracts legacy flat runtime settings for migration", () => {
  const runtime = extractLegacyRuntime({
    backend: "codex-subprocess",
    model: "gpt-5.4-mini",
    mode: "suggest",
    reasoning_level: "medium",
  });

  assert.equal(runtime?.model, "gpt-5.4-mini");
  assert.equal(runtime?.mode, "suggest");
  assert.equal(runtime?.reasoningLevel, "medium");
});

test("keeps UI and auth settings separate from runtime persistence", () => {
  const initial = {
    ui: {
      layoutStyle: "gemini-shell",
      theme: "purple",
      startupLogoStyle: "minimal" as const,
      startupAnimation: false,
      workspaceDisplayMode: "simple" as const,
      terminalTitleMode: "name" as const,
      showBusyLoader: false,
      customTheme: { text: "#fff" },
    },
    auth: {
      preference: "runner-managed" as const,
    },
    header: {
      showBrand: true,
      showWorkspace: true,
      showProvider: true,
      showModel: true,
      showReasoning: false,
      showContext: false,
      showAuthStatus: false,
    },
    updateCheck: {
      enabled: true,
      intervalHours: 6,
    },
  };

  const serialized = serializeSettings(initial);
  const parsed = parseSettingsData(serialized);

  assert.equal("runtime" in serialized, false);
  assert.equal(parsed.ui.theme, "purple");
  assert.equal(parsed.ui.startupLogoStyle, "minimal");
  assert.equal(parsed.ui.startupAnimation, false);
  assert.equal(parsed.ui.workspaceDisplayMode, "simple");
  assert.equal(parsed.ui.terminalTitleMode, "name");
  assert.equal(parsed.ui.showBusyLoader, false);
  assert.equal(parsed.auth.preference, "runner-managed");
});

test("startup logo style round-trips snake_case and survives legacy configurations", () => {
  // Pre-logo-style settings files must load with the Normal banner default.
  const legacy = parseSettingsData({
    ui: {
      layout_style: "gemini-shell",
      theme: "purple",
      workspace_display_mode: "dir",
      terminal_title_mode: "dir",
      show_busy_loader: true,
    },
  });
  assert.equal(legacy.ui.startupLogoStyle, "normal");

  const snakeCase = parseSettingsData({ ui: { startup_logo_style: "simple" } });
  assert.equal(snakeCase.ui.startupLogoStyle, "simple");

  // Invalid or corrupted values fall back to the default instead of failing.
  assert.equal(
    parseSettingsData({ ui: { startup_logo_style: "hologram" } }).ui.startupLogoStyle,
    "normal",
  );
  assert.equal(parseSettingsData({ ui: { startup_logo_style: 42 } }).ui.startupLogoStyle, "normal");

  const serialized = serializeSettings(snakeCase);
  assert.equal((serialized.ui as Record<string, unknown>).startup_logo_style, "simple");

  // Startup animation round-trips and defaults to enabled for legacy files.
  const animationOn = parseSettingsData({ ui: { startup_animation: true } });
  assert.equal(animationOn.ui.startupAnimation, true);
  assert.equal(legacy.ui.startupAnimation, true, "legacy files default to enabled");
  assert.equal(
    parseSettingsData({ ui: { startup_animation: "yes" } }).ui.startupAnimation,
    true,
    "corrupt values fall back to the enabled default",
  );
  assert.equal(
    (serializeSettings(animationOn).ui as Record<string, unknown>).startup_animation,
    true,
  );
});

test("falls back to defaults for missing UI or auth preferences", () => {
  const parsed = parseSettingsData({});
  const defaults = getDefaultSettings();

  assert.equal(parsed.ui.layoutStyle, defaults.ui.layoutStyle);
  assert.equal(parsed.ui.theme, defaults.ui.theme);
  assert.equal(parsed.ui.startupLogoStyle, defaults.ui.startupLogoStyle);
  assert.equal(parsed.ui.workspaceDisplayMode, defaults.ui.workspaceDisplayMode);
  assert.equal(parsed.ui.terminalTitleMode, defaults.ui.terminalTitleMode);
  assert.equal(parsed.ui.showBusyLoader, defaults.ui.showBusyLoader);
  assert.equal(parsed.auth.preference, defaults.auth.preference);
});

test("maps legacy directory display settings into workspace display mode", () => {
  assert.equal(
    parseSettingsData({ directory_display_mode: "normal" }).ui.workspaceDisplayMode,
    "dir",
  );
  assert.equal(
    parseSettingsData({ directoryDisplayMode: "simple" }).ui.workspaceDisplayMode,
    "simple",
  );
});

test("parses workspace display and busy loader from camel and snake case", () => {
  assert.equal(
    parseSettingsData({
      workspace_display_mode: "name",
      terminal_title_mode: "simple",
      show_busy_loader: false,
    }).ui.workspaceDisplayMode,
    "name",
  );
  assert.equal(
    parseSettingsData({
      workspaceDisplayMode: "dir",
      terminalTitleMode: "name",
      showBusyLoader: true,
    }).ui.showBusyLoader,
    true,
  );
  assert.equal(parseSettingsData({ terminalTitleMode: "name" }).ui.terminalTitleMode, "name");
});

test("merges legacy runtime fields into TOML without overwriting existing values", () => {
  const merged = mergeRuntimeIntoTomlConfig(
    {
      model: "gpt-5.4",
      ubume: {
        mode: "suggest",
      },
    },
    {
      ...DEFAULT_RUNTIME_CONFIG,
      model: "gpt-5.4-mini",
      mode: "full-auto",
      policy: {
        ...DEFAULT_RUNTIME_CONFIG.policy,
        networkAccess: "enabled",
        writableRoots: ["C:\\safe"],
        personality: "pragmatic",
      },
    },
  );

  assert.equal(merged.model, "gpt-5.4");
  assert.deepEqual(merged.ubume, { mode: "suggest" });
  assert.deepEqual(merged.sandbox_workspace_write, {
    network_access: true,
    writable_roots: ["C:\\safe"],
  });
  assert.equal(merged.personality, "pragmatic");
});

test("persists Auto and Plan choices while preserving unrelated Codex config", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-mode-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    writeFileSync(
      join(root, "config.toml"),
      'model = "kept-model"\n[ubume]\nbackend = "openai-native"\n',
      "utf-8",
    );
    saveRuntimeModePreference("auto-edit", false);
    let parsed = parseTomlDocument(readFileSync(join(root, "config.toml"), "utf-8"));
    assert.equal(parsed.model, "kept-model");
    assert.deepEqual(parsed.ubume, {
      backend: "openai-native",
      mode: "auto-edit",
      plan_mode: false,
    });

    saveRuntimeModePreference("auto-edit", true);
    parsed = parseTomlDocument(readFileSync(join(root, "config.toml"), "utf-8"));
    assert.equal((parsed.ubume as Record<string, unknown>).plan_mode, true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("mode persistence seeds [ubume] from a pre-rename [codexa] table without rewriting it", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-mode-legacy-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    writeFileSync(
      join(root, "config.toml"),
      '[codexa]\nbackend = "codex-subprocess"\nmode = "suggest"\n',
      "utf-8",
    );
    saveRuntimeModePreference("auto-edit", false);
    let parsed = parseTomlDocument(readFileSync(join(root, "config.toml"), "utf-8"));
    assert.deepEqual(parsed.codexa, { backend: "codex-subprocess", mode: "suggest" });
    assert.deepEqual(parsed.ubume, {
      backend: "codex-subprocess",
      mode: "auto-edit",
      plan_mode: false,
    });

    // Repeating the save only updates [ubume]; the legacy table is never written again.
    saveRuntimeModePreference("full-auto", true);
    parsed = parseTomlDocument(readFileSync(join(root, "config.toml"), "utf-8"));
    assert.deepEqual(parsed.codexa, { backend: "codex-subprocess", mode: "suggest" });
    assert.deepEqual(parsed.ubume, {
      backend: "codex-subprocess",
      mode: "full-auto",
      plan_mode: true,
    });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime mode persistence failures do not escape into the TUI", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-mode-failure-"));
  const previous = process.env.CODEX_HOME;
  const blockedHome = join(root, "not-a-directory");
  writeFileSync(blockedHome, "blocked", "utf-8");
  process.env.CODEX_HOME = blockedHome;
  try {
    assert.doesNotThrow(() => saveRuntimeModePreference("full-auto", false));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes update check settings and header options robustly", () => {
  const parsed = parseSettingsData({
    update_check: {
      enabled: false,
      interval_hours: -1,
      skipped_update_version: "v1.2.3",
    },
    header: {
      show_brand: false,
      show_model: true,
      show_context: true,
    },
  });

  assert.equal(parsed.updateCheck.enabled, false);
  // Interval fell back to default since -1 is not > 0
  assert.equal(parsed.updateCheck.intervalHours, 6);
  assert.equal(parsed.updateCheck.skippedUpdateVersion, "v1.2.3");

  assert.equal(parsed.header.showBrand, false);
  assert.equal(parsed.header.showModel, true);
  assert.equal(parsed.header.showContext, true);
  // Unspecified header fields keep their defaults
  assert.equal(parsed.header.showWorkspace, true);
});

test("loadSettings recovers safely from corrupt JSON", () => {
  const defaults = getDefaultSettings();
  const parsed = parseSettingsData("INVALID_JSON_STRING");
  assert.deepEqual(parsed, defaults);
});

test("startup header and renderer choices survive serialization and safely migrate old files", () => {
  const defaults = parseSettingsData({});
  assert.equal(defaults.ui.startupHeaderMiddleLine, "provider");
  assert.equal(defaults.ui.startupLogoRendering, "auto");
  for (const middle of ["provider", "model", "provider-model", "usage", "hidden"]) {
    for (const rendering of ["auto", "kitty", "iterm2", "sixel", "solid"]) {
      const parsed = parseSettingsData({
        ui: {
          startup_header_middle_line: middle,
          startup_logo_rendering: rendering,
          theme: "purple",
          startup_logo_style: "simple",
          startup_animation: false,
        },
      });
      const restarted = parseSettingsData(serializeSettings(parsed));
      assert.equal(restarted.ui.startupHeaderMiddleLine, middle);
      assert.equal(restarted.ui.startupLogoRendering, rendering);
      assert.equal(restarted.ui.theme, "purple");
      assert.equal(restarted.ui.startupLogoStyle, "simple");
      assert.equal(restarted.ui.startupAnimation, false);
    }
  }
  for (const value of [null, 123, "old-mode", {}, false]) {
    const invalid = parseSettingsData({
      ui: { startupHeaderMiddleLine: value, startupLogoRendering: value },
    });
    assert.equal(invalid.ui.startupHeaderMiddleLine, "provider");
    assert.equal(invalid.ui.startupLogoRendering, "auto");
  }
});
