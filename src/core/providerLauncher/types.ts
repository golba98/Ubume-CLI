import type { ModelCapabilityProfile } from "../providerRuntime/capabilityProfile.js";
import type { CodexaNativeOptions } from "../providerRuntime/codexaNativeConfig.js";
import type { ProviderBackendKind } from "../providerRuntime/types.js";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "local"
  | "codexa-native"
  | "codexa-cupy";

export type LocalBackendId = "lm-studio" | "unsloth";

export type ProviderBackendType =
  | "codex-cli-auth"
  | "claude-code-auth"
  | "mistral-vibe-cli-auth"
  | "antigravity-cli-auth"
  | "openai-api-key"
  | "anthropic-api-key"
  | "local-openai-compatible"
  | "codexa-native-pytorch"
  | "codexa-cupy"
  | "unavailable";

export type ProviderLaunchAction = "launch" | "set-default" | "cancel";
export type ProviderRouteAction =
  | "use-in-ubume"
  | "select-model"
  | "refresh-models"
  | "run-diagnostics";
export type ProviderPickerAction = ProviderLaunchAction | ProviderRouteAction;
export type ProviderRouteMode = "in-ubume" | "launch-only";

export interface ProviderLaunchCommand {
  executable: string;
  args: string[];
}

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  currentModel: string;
  contextLengthLabel?: string;
  contextLengthSource?: string;
  capabilityProfile?: ModelCapabilityProfile;
  backendType: ProviderBackendType;
  routeMode: ProviderRouteMode;
  enabled: boolean;
  statusLabel: string;
  launchCommand: ProviderLaunchCommand | null;
  isDefault: boolean;
  isActiveRoute: boolean;
  routeUnavailableReason: string | null;
  routeDiagnostics?: Record<string, string | number | boolean | null>;
}

export interface ProviderWorkspaceConfig {
  workspaceDefaultProviderId?: ProviderId;
  activeRoute?: ProviderActiveRoute;
  providers?: Partial<Record<ProviderId, ProviderWorkspaceOverride>>;
  migrationNotice?: ProviderWorkspaceMigrationNotice;
  /** Inactive original records, retained on saves and never used for execution. */
  legacyProviderData?: Record<string, unknown>;
  googleMigrationRequired?: boolean;
}

export interface ProviderWorkspaceMigrationNotice {
  deprecatedProviderId: string;
  revertedProviderId: ProviderId;
}

export interface ProviderActiveRoute {
  providerId: ProviderId;
  modelId: string;
  backendKind?: ProviderBackendKind;
  reasoning?: string;
  localBackend?: LocalBackendId;
}

export interface ProviderWorkspaceOverride {
  codexaNative?: CodexaNativeOptions;
  backendKind?: "antigravity-cli-auth";
  currentModel?: string;
  currentReasoning?: string;
  enabled?: boolean;
  type?: "openai-compatible";
  baseUrl?: string;
  deployment?: "local" | "remote";
  apiKey?: string;
  pinnedModel?: string;
  defaultModel?: string;
  localBackend?: LocalBackendId;
  models?: Record<string, ProviderModelWorkspaceOverride>;
  command?: string | ProviderLaunchCommand | null;
  claudeCommandPath?: string;
  codexCommandPath?: string;
  antigravityCommandPath?: string;
}

export interface ProviderModelWorkspaceOverride {
  reasoningPreference?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsToolCalls?: boolean;
  supportsSystemPrompt?: boolean;
  supportsVision?: boolean;
  /** Opt in to sending the active reasoning level as OpenAI `reasoning_effort` (Local harness). */
  supportsReasoningEffort?: boolean;
}
