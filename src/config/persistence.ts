/**
 * @fileoverview User Preferences and Runtime Persistence
 *
 * Manages persisting and loading UI preferences, authentication settings, header
 * configuration, update check intervals, and interactive execution modes.
 *
 * Persistence destinations:
 * - App settings: `~/.ubume-settings.json` (with automatic migration from `~/.codexa-settings.json`).
 * - Runtime execution mode: `~/.codex/config.toml` (`[ubume]` table, seeded once from a
 *   pre-rename `[codexa]` table, which is left in place).
 */

import { existsSync, readFileSync } from "node:fs";
import { writeJsonFileAtomic, writeTextFileAtomic, writeTextFileIfAbsent } from "./atomicFile.js";
import { mergeRuntimeIntoTomlConfig, parseTomlDocument } from "./layeredConfig.js";
import { normalizeRuntimeConfig, type RuntimeConfig } from "./runtimeConfig.js";
import type { AvailableMode, StartupLogoStyle, Theme } from "./settings.js";
import {
  AUTH_PREFERENCES,
  type AuthPreference,
  DEFAULT_AUTH_PREFERENCE,
  DEFAULT_LAYOUT_STYLE,
  DEFAULT_SHOW_BUSY_LOADER,
  DEFAULT_TERMINAL_TITLE_MODE,
  DEFAULT_THEME,
  DEFAULT_WORKSPACE_DISPLAY_MODE,
  getCodexConfigFile,
  getLegacySettingsFile,
  getSettingsFile,
  HEADER_CONFIG_DEFAULTS,
  type HeaderConfig,
  LEGACY_DIRECTORY_DISPLAY_MODES,
  normalizeLegacyDirectoryDisplayMode,
  normalizeStartupAnimation,
  normalizeStartupHeaderMiddleLine,
  normalizeStartupLogoRendering,
  normalizeStartupLogoStyle,
  type StartupHeaderMiddleLine,
  type StartupLogoRendering,
  type TerminalTitleMode,
  WORKSPACE_DISPLAY_MODES,
  type WorkspaceDisplayMode,
} from "./settings.js";
import { serializeTomlDocument } from "./tomlSerialize.js";

export interface UiSettings {
  layoutStyle: string;
  theme: string;
  startupLogoStyle: StartupLogoStyle;
  startupAnimation: boolean;
  startupHeaderMiddleLine?: StartupHeaderMiddleLine;
  startupLogoRendering?: StartupLogoRendering;
  workspaceDisplayMode: WorkspaceDisplayMode;
  terminalTitleMode: TerminalTitleMode;
  showBusyLoader: boolean;
  customTheme?: Partial<Theme>;
}

export interface AuthSettings {
  preference: AuthPreference;
}

export interface UpdateCheckSettings {
  enabled: boolean;
  intervalHours: number;
  skippedUpdateVersion?: string | null;
}

export const DEFAULT_UPDATE_CHECK_SETTINGS: UpdateCheckSettings = {
  enabled: true,
  intervalHours: 6,
};

export interface AppSettings {
  ui: UiSettings;
  auth: AuthSettings;
  header: HeaderConfig;
  updateCheck: UpdateCheckSettings;
}

// ─── Extraction & Normalization Helpers ────────────────────────────────────────

/**
 * Returns the first string value found under either camelCase or snake_case key.
 */
function pickStr(src: Record<string, unknown>, camel: string, snake: string): string | undefined {
  const camelVal = src[camel];
  if (typeof camelVal === "string") return camelVal;
  const snakeVal = src[snake];
  if (typeof snakeVal === "string") return snakeVal;
  return undefined;
}

/**
 * Returns the first boolean value found under either camelCase or snake_case key.
 */
function pickBool(src: Record<string, unknown>, camel: string, snake: string): boolean | undefined {
  const camelVal = src[camel];
  if (typeof camelVal === "boolean") return camelVal;
  const snakeVal = src[snake];
  if (typeof snakeVal === "boolean") return snakeVal;
  return undefined;
}

function normalizeAuthPreference(value: unknown): AuthPreference {
  return typeof value === "string" && AUTH_PREFERENCES.some((item) => item.id === value)
    ? (value as AuthPreference)
    : DEFAULT_AUTH_PREFERENCE;
}

function normalizeUiSettings(input: Partial<UiSettings> | null | undefined): UiSettings {
  return {
    layoutStyle: input?.layoutStyle ?? DEFAULT_LAYOUT_STYLE,
    theme: input?.theme ?? DEFAULT_THEME,
    startupLogoStyle: normalizeStartupLogoStyle(input?.startupLogoStyle),
    startupAnimation: normalizeStartupAnimation(input?.startupAnimation),
    startupHeaderMiddleLine: normalizeStartupHeaderMiddleLine(input?.startupHeaderMiddleLine),
    startupLogoRendering: normalizeStartupLogoRendering(input?.startupLogoRendering),
    workspaceDisplayMode: input?.workspaceDisplayMode ?? DEFAULT_WORKSPACE_DISPLAY_MODE,
    terminalTitleMode: input?.terminalTitleMode ?? DEFAULT_TERMINAL_TITLE_MODE,
    showBusyLoader:
      typeof input?.showBusyLoader === "boolean" ? input.showBusyLoader : DEFAULT_SHOW_BUSY_LOADER,
    customTheme: input?.customTheme,
  };
}

function normalizeHeaderConfig(input: Partial<HeaderConfig> | null | undefined): HeaderConfig {
  return {
    showBrand:
      typeof input?.showBrand === "boolean" ? input.showBrand : HEADER_CONFIG_DEFAULTS.showBrand,
    showWorkspace:
      typeof input?.showWorkspace === "boolean"
        ? input.showWorkspace
        : HEADER_CONFIG_DEFAULTS.showWorkspace,
    showProvider:
      typeof input?.showProvider === "boolean"
        ? input.showProvider
        : HEADER_CONFIG_DEFAULTS.showProvider,
    showModel:
      typeof input?.showModel === "boolean" ? input.showModel : HEADER_CONFIG_DEFAULTS.showModel,
    showReasoning:
      typeof input?.showReasoning === "boolean"
        ? input.showReasoning
        : HEADER_CONFIG_DEFAULTS.showReasoning,
    showContext:
      typeof input?.showContext === "boolean"
        ? input.showContext
        : HEADER_CONFIG_DEFAULTS.showContext,
    showAuthStatus:
      typeof input?.showAuthStatus === "boolean"
        ? input.showAuthStatus
        : HEADER_CONFIG_DEFAULTS.showAuthStatus,
  };
}

function normalizeUpdateCheckSettings(
  input: Partial<UpdateCheckSettings> | null | undefined,
): UpdateCheckSettings {
  return {
    enabled:
      typeof input?.enabled === "boolean" ? input.enabled : DEFAULT_UPDATE_CHECK_SETTINGS.enabled,
    intervalHours:
      typeof input?.intervalHours === "number" && input.intervalHours > 0
        ? input.intervalHours
        : DEFAULT_UPDATE_CHECK_SETTINGS.intervalHours,
    skippedUpdateVersion: input?.skippedUpdateVersion ?? null,
  };
}

/**
 * Returns default AppSettings with fallback values for all settings categories.
 */
export function getDefaultSettings(): AppSettings {
  return {
    ui: normalizeUiSettings(null),
    auth: {
      preference: DEFAULT_AUTH_PREFERENCE,
    },
    header: normalizeHeaderConfig(null),
    updateCheck: normalizeUpdateCheckSettings(null),
  };
}

function parseLegacyRuntime(data: Record<string, unknown>): RuntimeConfig {
  return normalizeRuntimeConfig({
    provider:
      typeof data.backend === "string" ? (data.backend as RuntimeConfig["provider"]) : undefined,
    model: typeof data.model === "string" ? (data.model as RuntimeConfig["model"]) : undefined,
    mode: typeof data.mode === "string" ? (data.mode as RuntimeConfig["mode"]) : undefined,
    reasoningLevel:
      typeof data.reasoning_level === "string"
        ? (data.reasoning_level as RuntimeConfig["reasoningLevel"])
        : undefined,
  });
}

/**
 * Extracts legacy flat runtime settings from settings data for migration to TOML.
 */
export function extractLegacyRuntime(data: unknown): RuntimeConfig | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.runtime === "object" && record.runtime !== null) {
    return normalizeRuntimeConfig(record.runtime as Partial<RuntimeConfig>);
  }

  const hasFlatRuntimeKeys = ["backend", "model", "mode", "reasoning_level"].some(
    (key) => key in record,
  );
  return hasFlatRuntimeKeys ? parseLegacyRuntime(record) : null;
}

function stripLegacyRuntime(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    return {};
  }

  const record = { ...(data as Record<string, unknown>) };
  delete record.runtime;
  delete record.backend;
  delete record.model;
  delete record.mode;
  delete record.reasoning_level;
  return record;
}

function parseTerminalTitleMode(
  uiSource: Record<string, unknown>,
  fallback: TerminalTitleMode,
): TerminalTitleMode {
  const direct = uiSource.terminalTitleMode ?? uiSource.terminal_title_mode;
  if (
    typeof direct === "string" &&
    WORKSPACE_DISPLAY_MODES.includes(direct as WorkspaceDisplayMode)
  ) {
    return direct as TerminalTitleMode;
  }

  return fallback;
}

function parseWorkspaceDisplayMode(
  uiSource: Record<string, unknown>,
  fallback: WorkspaceDisplayMode,
): WorkspaceDisplayMode {
  const direct = uiSource.workspaceDisplayMode ?? uiSource.workspace_display_mode;
  if (
    typeof direct === "string" &&
    WORKSPACE_DISPLAY_MODES.includes(direct as WorkspaceDisplayMode)
  ) {
    return direct as WorkspaceDisplayMode;
  }

  const legacy = uiSource.directoryDisplayMode ?? uiSource.directory_display_mode;
  if (typeof legacy === "string") {
    if (WORKSPACE_DISPLAY_MODES.includes(legacy as WorkspaceDisplayMode)) {
      return legacy as WorkspaceDisplayMode;
    }
    if (
      LEGACY_DIRECTORY_DISPLAY_MODES.includes(
        legacy as (typeof LEGACY_DIRECTORY_DISPLAY_MODES)[number],
      )
    ) {
      return normalizeLegacyDirectoryDisplayMode(
        legacy as (typeof LEGACY_DIRECTORY_DISPLAY_MODES)[number],
      );
    }
  }

  return fallback;
}

/**
 * Parses and sanitizes raw JSON settings into typed AppSettings.
 */
export function parseSettingsData(data: unknown): AppSettings {
  const defaults = getDefaultSettings();
  if (!data || typeof data !== "object") {
    return defaults;
  }

  const record = data as Record<string, unknown>;
  const uiSource =
    typeof record.ui === "object" && record.ui !== null
      ? (record.ui as Record<string, unknown>)
      : record;
  const authSource =
    typeof record.auth === "object" && record.auth !== null
      ? (record.auth as Record<string, unknown>)
      : record;

  const headerSource =
    typeof record.header === "object" && record.header !== null
      ? (record.header as Record<string, unknown>)
      : {};

  const updateCheckSource =
    typeof record.updateCheck === "object" && record.updateCheck !== null
      ? (record.updateCheck as Record<string, unknown>)
      : typeof record.update_check === "object" && record.update_check !== null
        ? (record.update_check as Record<string, unknown>)
        : {};

  return {
    ui: normalizeUiSettings({
      layoutStyle: pickStr(uiSource, "layoutStyle", "layout_style") ?? defaults.ui.layoutStyle,
      theme: pickStr(uiSource, "theme", "theme") ?? defaults.ui.theme,
      startupLogoStyle: normalizeStartupLogoStyle(
        uiSource.startupLogoStyle ?? uiSource.startup_logo_style,
      ),
      startupHeaderMiddleLine: normalizeStartupHeaderMiddleLine(
        uiSource.startupHeaderMiddleLine ?? uiSource.startup_header_middle_line,
      ),
      startupLogoRendering: normalizeStartupLogoRendering(
        uiSource.startupLogoRendering ?? uiSource.startup_logo_rendering,
      ),
      startupAnimation: normalizeStartupAnimation(
        uiSource.startupAnimation ?? uiSource.startup_animation,
      ),
      workspaceDisplayMode: parseWorkspaceDisplayMode(uiSource, defaults.ui.workspaceDisplayMode),
      terminalTitleMode: parseTerminalTitleMode(uiSource, defaults.ui.terminalTitleMode),
      showBusyLoader:
        pickBool(uiSource, "showBusyLoader", "show_busy_loader") ?? defaults.ui.showBusyLoader,
      customTheme: (uiSource.customTheme ?? uiSource.custom_theme) as Partial<Theme> | undefined,
    }),
    auth: {
      preference: normalizeAuthPreference(authSource.preference ?? authSource.auth_preference),
    },
    header: normalizeHeaderConfig({
      showBrand: pickBool(headerSource, "showBrand", "show_brand"),
      showWorkspace: pickBool(headerSource, "showWorkspace", "show_workspace"),
      showProvider: pickBool(headerSource, "showProvider", "show_provider"),
      showModel: pickBool(headerSource, "showModel", "show_model"),
      showReasoning: pickBool(headerSource, "showReasoning", "show_reasoning"),
      showContext: pickBool(headerSource, "showContext", "show_context"),
      showAuthStatus: pickBool(headerSource, "showAuthStatus", "show_auth_status"),
    }),
    updateCheck: normalizeUpdateCheckSettings({
      enabled: pickBool(updateCheckSource, "enabled", "enabled"),
      intervalHours:
        typeof updateCheckSource.intervalHours === "number"
          ? updateCheckSource.intervalHours
          : typeof updateCheckSource.interval_hours === "number"
            ? updateCheckSource.interval_hours
            : undefined,
      skippedUpdateVersion:
        typeof updateCheckSource.skippedUpdateVersion === "string"
          ? updateCheckSource.skippedUpdateVersion
          : typeof updateCheckSource.skipped_update_version === "string"
            ? updateCheckSource.skipped_update_version
            : null,
    }),
  };
}

/**
 * Serializes AppSettings into canonical disk JSON representation (snake_case).
 */
export function serializeSettings(settings: AppSettings): Record<string, unknown> {
  return {
    ui: {
      layout_style: settings.ui.layoutStyle,
      theme: settings.ui.theme,
      startup_logo_style: settings.ui.startupLogoStyle,
      startup_animation: settings.ui.startupAnimation,
      startup_header_middle_line: normalizeStartupHeaderMiddleLine(
        settings.ui.startupHeaderMiddleLine,
      ),
      startup_logo_rendering: normalizeStartupLogoRendering(settings.ui.startupLogoRendering),
      workspace_display_mode: settings.ui.workspaceDisplayMode,
      terminal_title_mode: settings.ui.terminalTitleMode,
      show_busy_loader: settings.ui.showBusyLoader,
      custom_theme: settings.ui.customTheme,
    },
    auth: {
      preference: settings.auth.preference,
    },
    header: {
      show_brand: settings.header.showBrand,
      show_workspace: settings.header.showWorkspace,
      show_provider: settings.header.showProvider,
      show_model: settings.header.showModel,
      show_reasoning: settings.header.showReasoning,
      show_context: settings.header.showContext,
      show_auth_status: settings.header.showAuthStatus,
    },
    update_check: {
      enabled: settings.updateCheck.enabled,
      interval_hours: settings.updateCheck.intervalHours,
      ...(settings.updateCheck.skippedUpdateVersion != null
        ? { skipped_update_version: settings.updateCheck.skippedUpdateVersion }
        : {}),
    },
  };
}

function maybeMigrateLegacyRuntime(rawData: unknown): void {
  const legacyRuntime = extractLegacyRuntime(rawData);
  if (!legacyRuntime) {
    return;
  }

  try {
    const codexConfigFile = getCodexConfigFile();
    const existingConfig = existsSync(codexConfigFile)
      ? parseTomlDocument(readFileSync(codexConfigFile, "utf-8"))
      : {};
    const mergedConfig = mergeRuntimeIntoTomlConfig(existingConfig, legacyRuntime);
    writeTextFileAtomic(codexConfigFile, serializeTomlDocument(mergedConfig));
    writeJsonFileAtomic(getSettingsFile(), stripLegacyRuntime(rawData));
  } catch {
    // Best-effort migration only; keep legacy JSON intact if anything fails.
  }
}

/**
 * Loads user settings from `~/.ubume-settings.json`.
 * Migrates from `~/.codexa-settings.json` and migrates flat runtime settings if present.
 */
export function loadSettings(): AppSettings {
  try {
    let text = "";
    const settingsFile = getSettingsFile();
    const legacySettingsFile = getLegacySettingsFile();
    if (existsSync(settingsFile)) {
      text = readFileSync(settingsFile, "utf-8");
    } else if (existsSync(legacySettingsFile)) {
      text = readFileSync(legacySettingsFile, "utf-8");
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          return getDefaultSettings();
        if (!writeTextFileIfAbsent(settingsFile, JSON.stringify(parsed, null, 2))) {
          text = readFileSync(settingsFile, "utf8");
        }
      } catch {
        // Best-effort migration only
      }
    } else {
      return getDefaultSettings();
    }
    const rawData = JSON.parse(text);
    maybeMigrateLegacyRuntime(rawData);
    const settings = parseSettingsData(rawData);
    savedSettingsBaseline = serializeSettings(settings);
    return settings;
  } catch {
    return getDefaultSettings();
  }
}

/**
 * What this process last loaded or saved. Other Ubume instances share the settings file, so a
 * save writes only the fields that changed since then and keeps their newer values for the rest.
 */
let savedSettingsBaseline: Record<string, unknown> | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Applies `next`'s changes relative to `base` onto `disk`, keeping disk-only keys. */
function mergeChangedSettings(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  disk: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...disk };
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const before = base[key];
    const after = next[key];
    if (sameJson(before, after)) {
      if (!(key in disk) && after !== undefined) merged[key] = after;
      continue;
    }
    if (isPlainObject(before) && isPlainObject(after) && isPlainObject(disk[key]))
      merged[key] = mergeChangedSettings(before, after, disk[key] as Record<string, unknown>);
    else if (after === undefined) delete merged[key];
    else merged[key] = after;
  }
  return merged;
}

function readSettingsFileObject(): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getSettingsFile(), "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persists user settings to `~/.ubume-settings.json` atomically. Fields this process did not
 * change keep whatever another Ubume instance saved in the meantime.
 */
export function saveSettings(settings: AppSettings): void {
  try {
    const next = serializeSettings(settings);
    const disk = savedSettingsBaseline ? readSettingsFileObject() : null;
    const payload =
      savedSettingsBaseline && disk
        ? mergeChangedSettings(savedSettingsBaseline, next, disk)
        : next;
    writeJsonFileAtomic(getSettingsFile(), payload);
    savedSettingsBaseline = next;
  } catch {
    // Silently ignore — settings are best-effort
  }
}

/**
 * Persists the interactive execution mode choice to the `[ubume]` table of `~/.codex/config.toml`
 * without replacing unrelated configuration keys. A pre-rename `[codexa]` table seeds `[ubume]`
 * the first time and is otherwise left untouched.
 */
export function saveRuntimeModePreference(mode: AvailableMode, planMode: boolean): void {
  try {
    const codexConfigFile = getCodexConfigFile();
    const current = existsSync(codexConfigFile)
      ? parseTomlDocument(readFileSync(codexConfigFile, "utf-8"))
      : {};
    const source = current.ubume ?? current.codexa;
    const existing =
      source && typeof source === "object" && !Array.isArray(source)
        ? { ...(source as Record<string, unknown>) }
        : {};
    current.ubume = { ...existing, mode, plan_mode: planMode };
    writeTextFileAtomic(codexConfigFile, serializeTomlDocument(current));
  } catch {
    // Runtime preference persistence is best-effort and must not crash the TUI.
  }
}
