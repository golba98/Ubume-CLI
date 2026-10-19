/**
 * @fileoverview Ubume CLI — Configuration Subsystem Public Facade
 *
 * Re-exports the complete configuration public API, including atomic file I/O,
 * application settings, runtime configuration & policies, 5-layer configuration
 * resolution, launch argument parsing, trust management, and TOML serialization.
 */

// Atomic File Persistence
export {
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "./atomicFile.js";

// Build Information
export {
  APP_VERSION as BUILD_VERSION,
  BUILD_COMMIT,
} from "./buildInfo.js";

// Launch Arguments
export {
  type LaunchArgs,
  type LaunchArgsParseResult,
  parseLaunchArgs,
} from "./launchArgs.js";

// Layered Configuration Resolution
export {
  applyLayeredRuntimeOverride,
  type ConfigLayerReport,
  type ConfigLayerStatus,
  formatLayeredConfigStatus,
  type LayeredConfigDiagnostics,
  type LayeredConfigResult,
  mergeRuntimeIntoTomlConfig,
  parseTomlDocument,
  type ResolveLayeredConfigOptions,
  RUNTIME_FIELD_PATHS,
  type RuntimeFieldPath,
  resolveLayeredConfig,
} from "./layeredConfig.js";

// Settings & Preferences Persistence
export {
  type AppSettings,
  type AuthSettings,
  DEFAULT_UPDATE_CHECK_SETTINGS,
  extractLegacyRuntime,
  getDefaultSettings,
  loadSettings,
  parseSettingsData,
  saveRuntimeModePreference,
  saveSettings,
  serializeSettings,
  type UiSettings,
  type UpdateCheckSettings,
} from "./persistence.js";

// Runtime Configuration & Policies
export {
  AVAILABLE_APPROVAL_POLICIES,
  AVAILABLE_NETWORK_ACCESS_VALUES,
  AVAILABLE_PERSONALITIES,
  AVAILABLE_SANDBOX_MODES,
  AVAILABLE_SERVICE_TIERS,
  addWritableRoot,
  buildCodexConfigOverrides,
  buildRuntimeSummary,
  clearWritableRoots,
  DEFAULT_RUNTIME_CONFIG,
  diffRuntimeConfig,
  formatApprovalPolicyLabel,
  formatNetworkAccessLabel,
  formatPermissionsStatus,
  formatPersonalityLabel,
  formatRuntimeStatus,
  formatSandboxModeLabel,
  formatServiceTierLabel,
  mergeRuntimeConfig,
  normalizeRuntimeConfig,
  type PartialRuntimeConfig,
  type ResolvedApprovalPolicy,
  type ResolvedRuntimeConfig,
  type ResolvedRuntimePolicy,
  type ResolvedSandboxMode,
  type RuntimeApprovalPolicy,
  type RuntimeConfig,
  type RuntimeNetworkAccess,
  type RuntimePersonality,
  type RuntimePolicyConfig,
  type RuntimeSandboxMode,
  type RuntimeServiceTier,
  type RuntimeSummary,
  removeWritableRoot,
  resolveRuntimeConfig,
  resolveWritableRootCommandPath,
} from "./runtimeConfig.js";

// Application Settings, Defaults & Paths
export {
  APP_NAME,
  APP_VERSION,
  AUTH_PREFERENCES,
  type AuthPreference,
  AVAILABLE_BACKENDS,
  AVAILABLE_MODES,
  AVAILABLE_THEMES,
  type AvailableBackend,
  type AvailableMode,
  type AvailableModel,
  BUSY_LOADER_SETTING_VALUES,
  type BusyLoaderSettingValue,
  DEFAULT_AUTH_PREFERENCE,
  DEFAULT_BACKEND,
  DEFAULT_LAYOUT_STYLE,
  DEFAULT_MODE,
  DEFAULT_MODEL,
  DEFAULT_REASONING_LEVEL,
  DEFAULT_SHOW_BUSY_LOADER,
  DEFAULT_TERMINAL_TITLE_MODE,
  DEFAULT_THEME,
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
  getLegacySettingsFile,
  getNextMode,
  getNextRotatingMode,
  getSettingsFile,
  getUbumeTrustStoreFile,
  HEADER_CONFIG_DEFAULTS,
  type HeaderConfig,
  LEGACY_DIRECTORY_DISPLAY_MODES,
  LEGACY_FALLBACK_MODELS,
  type LegacyDirectoryDisplayMode,
  MAX_CHAT_LINES,
  normalizeLegacyDirectoryDisplayMode,
  parseBusyLoaderSettingValue,
  type ReasoningLevel,
  type RotatingModeState,
  resolveModeCommand,
  type SettingDefinition,
  type SettingOption,
  type TerminalTitleMode,
  type Theme,
  USER_SETTING_DEFINITIONS,
  type UserSettingValues,
  WORKSPACE_DISPLAY_MODES,
  type WorkspaceDisplayMode,
} from "./settings.js";

// TOML Serialization
export {
  formatTomlKey,
  formatTomlPath,
  serializeTomlDocument,
} from "./tomlSerialize.js";

// Trust Store
export {
  isProjectTrusted,
  setProjectTrust,
} from "./trustStore.js";
