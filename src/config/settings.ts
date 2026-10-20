/**
 * @fileoverview Ubume Application Settings, Defaults & Path Resolution
 *
 * Defines core application identity constants, runtime defaults, configuration paths,
 * available modes, user preferences schemas, theme definitions, and workspace display formatters.
 */

import { homedir } from "node:os";
import { basename, join, parse, win32 } from "node:path";
import { getAppVersion } from "../core/version/channel.js";
import { isWindowsStylePath } from "../core/workspace/workspaceRoot.js";

// ─── Path Utilities ───────────────────────────────────────────────────────────

/** Performs a path join using the appropriate platform semantics (Windows vs POSIX). */
function smartJoin(base: string, ...parts: string[]): string {
  return isWindowsStylePath(base) ? win32.join(base, ...parts) : join(base, ...parts);
}

// ─── 1. Application Identity & Runtime Defaults ──────────────────────────────

/** Authoritative runtime version resolved dynamically from package.json at startup. */
export const APP_VERSION: string = getAppVersion();
export const APP_NAME = "Ubume";
export const DEFAULT_BACKEND = "codex-subprocess";
export const DEFAULT_MODEL = "gpt-5.4";
export const DEFAULT_MODE = "full-auto";
export const DEFAULT_REASONING_LEVEL = "high";
export const DEFAULT_LAYOUT_STYLE = "gemini-shell";
export const DEFAULT_THEME = "dark";
export const DEFAULT_WORKSPACE_DISPLAY_MODE = "dir";
export const DEFAULT_TERMINAL_TITLE_MODE = "dir";
export const DEFAULT_SHOW_BUSY_LOADER = true;
export const DEFAULT_STARTUP_ANIMATION = true;
export const DEFAULT_AUTH_PREFERENCE = "chatgpt-login-goal";
export const MAX_CHAT_LINES = 2000;

// ─── 2. Filesystem Paths & Environment Resolution ─────────────────────────────

/**
 * Resolves the user home directory respecting environment overrides (USERPROFILE, HOME).
 *
 * @param env - Optional environment object (defaults to process.env).
 */
export function getHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE ?? env.HOME ?? homedir();
}

/**
 * Resolves the root directory for Codex configuration files (~/.codex or CODEX_HOME).
 *
 * @param env - Optional environment object (defaults to process.env).
 */
export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(getHomeDir(env), ".codex");
}

/**
 * Resolves the path to the main Codex TOML configuration file (~/.codex/config.toml).
 */
export function getCodexConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return smartJoin(getCodexHome(env), "config.toml");
}

/**
 * Resolves the path to the trusted repository store file (~/.codex/ubume-trust.json).
 */
export function getUbumeTrustStoreFile(env: NodeJS.ProcessEnv = process.env): string {
  return smartJoin(getCodexHome(env), "ubume-trust.json");
}

/**
 * Resolves the legacy trust store file path (~/.codex/codexa-trust.json) for migration.
 */
export function getLegacyCodexaTrustStoreFile(env: NodeJS.ProcessEnv = process.env): string {
  return smartJoin(getCodexHome(env), "codexa-trust.json");
}

// Resolved per call from the live environment (like getProviderModelCacheFile): a module-level
// `homedir()` path is fixed at import time — and Bun's homedir() ignores runtime HOME changes —
// so HOME redirection (tests, sandboxes) would still read and write the real user file.
/** `~/.ubume-settings.json` for the current HOME/USERPROFILE. */
export function getSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHomeDir(env), ".ubume-settings.json");
}

/** Pre-rename `~/.codexa-settings.json`, read only as a migration source. */
export function getLegacySettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(getHomeDir(env), ".codexa-settings.json");
}

// ─── 3. Backends & Fallback Models ────────────────────────────────────────────

export const AVAILABLE_BACKENDS = [
  {
    id: "codex-subprocess",
    label: "Ubume Core",
    description: "Direct connection to the Ubume neural network.",
  },
] as const;

export type AvailableBackend = (typeof AVAILABLE_BACKENDS)[number]["id"];

/** Static model list used when runtime model discovery is unavailable. */
export const LEGACY_FALLBACK_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
] as const;

export type AvailableModel = string;

const AVAILABLE_REASONING_LEVELS = [
  { id: "none", label: "None" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
] as const;

export type ReasoningLevel = string;

// ─── 4. Modes & Mode Rotation ─────────────────────────────────────────────────

export const AVAILABLE_MODES = [
  { key: "suggest", label: "Read-only" },
  { key: "auto-edit", label: "Auto" },
  { key: "full-auto", label: "Full Access" },
] as const;

export type AvailableMode = (typeof AVAILABLE_MODES)[number]["key"];

const MODE_COMMAND_ALIASES = {
  default: DEFAULT_MODE,
  ask: "suggest",
  add: "auto-edit",
  auto: "auto-edit",
} as const;

type ModeCommandAlias = keyof typeof MODE_COMMAND_ALIASES;

/** Formats a user-friendly label for a mode key (e.g. 'suggest' -> 'Read-only'). */
export function formatModeLabel(mode: string): string {
  const found = AVAILABLE_MODES.find((m) => m.key === mode);
  return found?.label ?? mode.toUpperCase();
}

/** Resolves a CLI or slash-command mode argument into a canonical AvailableMode. */
export function resolveModeCommand(mode: string): AvailableMode | null {
  const normalized = mode.toLowerCase();
  const canonical = AVAILABLE_MODES.find((item) => item.key === normalized);
  if (canonical) {
    return canonical.key;
  }

  return MODE_COMMAND_ALIASES[normalized as ModeCommandAlias] ?? null;
}

export function formatModeCommandHelp(): string {
  return "plan, suggest, auto-edit, full-auto; aliases: default, ask, add, auto";
}

/**
 * Returns the next execution mode in the Ctrl+Y cycle order.
 * Cycle order: suggest -> auto-edit -> full-auto -> suggest.
 */
export function getNextMode(mode: AvailableMode): AvailableMode {
  const currentIndex = AVAILABLE_MODES.findIndex((item) => item.key === mode);
  if (currentIndex < 0) {
    return AVAILABLE_MODES[0].key;
  }

  return AVAILABLE_MODES[(currentIndex + 1) % AVAILABLE_MODES.length].key;
}

export interface RotatingModeState {
  mode: AvailableMode;
  planMode: boolean;
}

/**
 * Shift+Tab uses one predictable loop for planning and execution safety.
 * Plan is deliberately separate from `mode`: it forces a read-only planning
 * turn, while the selected execution mode is persisted for later runs.
 */
export function getNextRotatingMode(mode: AvailableMode, planMode: boolean): RotatingModeState {
  if (planMode) {
    return { mode: "suggest", planMode: false };
  }
  if (mode === "full-auto") {
    return { mode, planMode: true };
  }
  return { mode: getNextMode(mode), planMode: false };
}

export function formatBackendLabel(backend: string): string {
  const found = AVAILABLE_BACKENDS.find((item) => item.id === backend);
  return found?.label ?? backend;
}

export function formatReasoningLabel(reasoning: string): string {
  const found = AVAILABLE_REASONING_LEVELS.find((item) => item.id === reasoning);
  if (found) {
    return found.label;
  }

  return (
    reasoning
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ") || reasoning
  );
}

// ─── 5. UI Preferences & User Settings ────────────────────────────────────────

export const WORKSPACE_DISPLAY_MODES = ["dir", "name", "simple"] as const;
export const LEGACY_DIRECTORY_DISPLAY_MODES = ["normal", "simple"] as const;

export type WorkspaceDisplayMode = (typeof WORKSPACE_DISPLAY_MODES)[number];
export type LegacyDirectoryDisplayMode = (typeof LEGACY_DIRECTORY_DISPLAY_MODES)[number];
export type TerminalTitleMode = WorkspaceDisplayMode;

export const BUSY_LOADER_SETTING_VALUES = ["true", "false"] as const;
export type BusyLoaderSettingValue = (typeof BUSY_LOADER_SETTING_VALUES)[number];

export interface SettingOption<TValue extends string> {
  value: TValue;
  label: string;
}

export interface SettingDefinition<TKey extends string, TValue extends string> {
  key: TKey;
  label: string;
  description?: string;
  options: readonly SettingOption<TValue>[];
}

export interface UserSettingValues {
  workspaceDisplayMode: WorkspaceDisplayMode;
  terminalTitleMode: TerminalTitleMode;
  showBusyLoader: BusyLoaderSettingValue;
}

type UserSettingKey = keyof UserSettingValues;

type UserSettingDefinition = {
  [K in UserSettingKey]: SettingDefinition<K, UserSettingValues[K]>;
}[UserSettingKey];

export const USER_SETTING_DEFINITIONS: readonly UserSettingDefinition[] = [
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
] as const;

/** Rough token estimate: ~4 chars per token */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export const AUTH_PREFERENCES = [
  {
    id: "chatgpt-login-goal",
    label: "ChatGPT login goal",
    description:
      "Design toward account-style sign-in without claiming it works as a backend today.",
  },
  {
    id: "api-key-first",
    label: "API key first",
    description: "Prefer official API credentials when native OpenAI support is added.",
  },
  {
    id: "runner-managed",
    label: "Ubume managed",
    description: "Rely on the core neural bridge to manage authentication.",
  },
] as const;

export type AuthPreference = (typeof AUTH_PREFERENCES)[number]["id"];

export function formatAuthPreferenceLabel(preference: string): string {
  const found = AUTH_PREFERENCES.find((item) => item.id === preference);
  return found?.label ?? preference;
}

export interface HeaderConfig {
  showBrand: boolean;
  showWorkspace: boolean;
  showProvider: boolean;
  showModel: boolean;
  showReasoning: boolean;
  showContext: boolean;
  showAuthStatus: boolean;
}

export const HEADER_CONFIG_DEFAULTS: HeaderConfig = {
  showBrand: true,
  showWorkspace: true,
  showProvider: true,
  showModel: true,
  showReasoning: false,
  showContext: false,
  showAuthStatus: false,
};

// ─── 6. Themes ────────────────────────────────────────────────────────────────

export interface Theme {
  bg: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  borderFocused: string;
  text: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentMuted: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  command: string;
  prompt: string;
  model: string;
  provider: string;
  context: string;
  logoPrimary: string;
  logoSecondary: string;
  logoShadow: string;
}

export const AVAILABLE_THEMES = [
  { id: "dark", label: "Ubume Dark" },
  { id: "purple", label: "Midnight Purple" },
  { id: "mono", label: "Black & White" },
  { id: "black", label: "Codex the Black" },
  { id: "nordic", label: "Nordic Frost" },
  { id: "dracula", label: "Dracula Night" },
  { id: "gruvbox", label: "Gruvbox Hard" },
  { id: "ocean", label: "Deep Oceanic" },
  { id: "custom", label: "Customize..." },
] as const;

export function formatThemeLabel(themeId: string): string {
  const found = AVAILABLE_THEMES.find((item) => item.id === themeId);
  return found?.label ?? themeId;
}

// ─── 6b. Startup logo styles ──────────────────────────────────────────────────

/**
 * Selectable startup branding presentations. `normal` keeps the historical
 * large ASCII banner; `minimal` and `simple` are compact developer-style
 * headers built around the `</>` mark (see `ui/timeline/measure/startupBrandingRows.ts`).
 */
export const STARTUP_LOGO_STYLES = [
  {
    id: "normal",
    label: "Normal",
    description: "The classic large UBUME ASCII banner.",
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "An animated developer mark beside three compact metadata rows.",
  },
  {
    id: "simple",
    label: "Simple",
    description: "The shared animated developer mark with product info alongside it.",
  },
] as const;

export type StartupLogoStyle = (typeof STARTUP_LOGO_STYLES)[number]["id"];

/** Default for new and pre-existing configurations that predate the setting. */
export const DEFAULT_STARTUP_LOGO_STYLE: StartupLogoStyle = "normal";

export function formatStartupLogoStyleLabel(styleId: string): string {
  const found = STARTUP_LOGO_STYLES.find((item) => item.id === styleId);
  return found?.label ?? styleId;
}

/** Maps any stored value to a valid style, falling back to `normal` (see persistence). */
export function normalizeStartupLogoStyle(value: unknown): StartupLogoStyle {
  return typeof value === "string" && STARTUP_LOGO_STYLES.some((item) => item.id === value)
    ? (value as StartupLogoStyle)
    : DEFAULT_STARTUP_LOGO_STYLE;
}

/** Maps any stored startup-animation value to a boolean, defaulting to enabled. */
export function normalizeStartupAnimation(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_STARTUP_ANIMATION;
}

// ─── 7. Path & Display Formatters ─────────────────────────────────────────────

export function formatWorkspaceDisplayModeLabel(mode: WorkspaceDisplayMode): string {
  if (mode === "name") return "Name";
  if (mode === "simple") return "Simple";
  return "Dir";
}

export function formatTerminalTitleModeLabel(mode: TerminalTitleMode): string {
  return formatWorkspaceDisplayModeLabel(mode);
}

/** Maps legacy "normal" directory display setting to the modern "dir" equivalent. */
export function normalizeLegacyDirectoryDisplayMode(
  mode: LegacyDirectoryDisplayMode,
): WorkspaceDisplayMode {
  return mode === "simple" ? "simple" : "dir";
}

export function formatBusyLoaderSettingValue(enabled: boolean): BusyLoaderSettingValue {
  return enabled ? "true" : "false";
}

export function parseBusyLoaderSettingValue(value: string): boolean {
  return value === "true";
}

function formatWorkspaceLeaf(workspaceRoot: string): string {
  const trimmed = workspaceRoot.trim();
  if (!trimmed) {
    return trimmed;
  }

  const api = isWindowsStylePath(trimmed) ? win32 : { parse, basename };
  const { root } = api.parse(trimmed);
  let normalized = trimmed;

  // Strip trailing slashes, but stop at filesystem root
  while (normalized.length > root.length && /[\\/]+$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  if (!normalized) {
    return trimmed;
  }

  if (normalized === root) {
    return root || trimmed;
  }

  return api.basename(normalized) || normalized;
}

export function formatWorkspaceDisplayPath(
  workspaceRoot: string,
  workspaceDisplayMode: WorkspaceDisplayMode,
): string {
  if (workspaceDisplayMode === "name") {
    return APP_NAME;
  }

  return formatWorkspaceLeaf(workspaceRoot);
}

/**
 * Tilde-shortened absolute workspace path for the compact startup branding
 * (`minimal` / `simple` styles). Falls back to the raw path when the workspace
 * is not under the current home directory.
 */
export function formatWorkspaceBrandingPath(workspaceRoot: string | null | undefined): string {
  const trimmed = (workspaceRoot ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const home = getHomeDir();
  if (!home) {
    return trimmed;
  }

  if (trimmed === home) {
    return "~";
  }

  const startsWithHome =
    trimmed.startsWith(`${home}/`) || (isWindowsStylePath(home) && trimmed.startsWith(`${home}\\`));
  return startsWithHome ? `~${trimmed.slice(home.length)}` : trimmed;
}

export function formatTerminalTitlePath(
  workspaceRoot: string,
  terminalTitleMode: TerminalTitleMode,
): string {
  if (terminalTitleMode === "name" || terminalTitleMode === "simple") {
    return APP_NAME;
  }

  return formatWorkspaceLeaf(workspaceRoot);
}

/** Compact startup presentation choices; stored independently of runtime metadata. */
export const STARTUP_HEADER_LINES = [
  { id: "provider", label: "Provider" },
  { id: "model", label: "Model" },
  { id: "provider-model", label: "Provider + Model" },
  { id: "usage", label: "Usage" },
  { id: "hidden", label: "Hidden" },
] as const;
export type StartupHeaderMiddleLine = (typeof STARTUP_HEADER_LINES)[number]["id"];
export const STARTUP_LOGO_RENDERERS = [
  { id: "auto", label: "Auto" },
  { id: "kitty", label: "Kitty Graphics" },
  { id: "iterm2", label: "iTerm2 Images" },
  { id: "sixel", label: "Sixel" },
  { id: "solid", label: "Solid Text" },
] as const;
export type StartupLogoRendering = (typeof STARTUP_LOGO_RENDERERS)[number]["id"];
export function normalizeStartupHeaderMiddleLine(value: unknown): StartupHeaderMiddleLine {
  return STARTUP_HEADER_LINES.some((entry) => entry.id === value)
    ? (value as StartupHeaderMiddleLine)
    : "provider";
}
export function normalizeStartupLogoRendering(value: unknown): StartupLogoRendering {
  return STARTUP_LOGO_RENDERERS.some((entry) => entry.id === value)
    ? (value as StartupLogoRendering)
    : "auto";
}
