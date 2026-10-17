/**
 * Workspace provider configuration parsing, compatibility migration and persistence. Pure
 * setters return merged values; save uses a same-directory temporary file and rename. Caller
 * orchestration owns concurrent updates and execution leases.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getProviderRuntime, isProviderRoutableInUbume } from "../providerRuntime/registry.js";
import { isRecord } from "../shared/values.js";
import { resolveUbumeWorkspaceDataDir } from "../workspace/appData.js";
import { normalizeWorkspaceRoot } from "../workspace/workspaceRoot.js";
import { resolveLocalBackend } from "./localBackend.js";
import { resolveProviderIdentity } from "./providerIdentity.js";
import { isKnownProviderId } from "./registry.js";
import type {
  LocalBackendId,
  ProviderActiveRoute,
  ProviderId,
  ProviderLaunchCommand,
  ProviderModelWorkspaceOverride,
  ProviderWorkspaceConfig,
  ProviderWorkspaceOverride,
} from "./types.js";

/**
 * Resolves providers.json in workspace app data; readOnly avoids triggering legacy data
 * migration.
 */
export function getProviderWorkspaceConfigFile(
  workspaceRoot: string,
  options: { readOnly?: boolean } = {},
): string {
  return join(
    resolveUbumeWorkspaceDataDir(normalizeWorkspaceRoot(workspaceRoot), options),
    "providers.json",
  );
}

/** Names the historical workspace-local provider file without creating it. */
export function getLegacyProviderWorkspaceConfigFile(workspaceRoot: string): string {
  return join(normalizeWorkspaceRoot(workspaceRoot), ".codexa", "providers.json");
}

function parseLaunchCommand(value: unknown): ProviderWorkspaceOverride["command"] | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.executable !== "string") return undefined;
  return {
    executable: value.executable,
    args: Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : [],
  };
}

function parseProviderOverride(value: unknown): ProviderWorkspaceOverride | undefined {
  if (!isRecord(value)) return undefined;
  const override: ProviderWorkspaceOverride = {};
  if (isRecord(value.codexaNative)) {
    override.codexaNative = value.codexaNative as ProviderWorkspaceOverride["codexaNative"];
  }
  if ((value.backendKind ?? value.backend_kind) === "antigravity-cli-auth")
    override.backendKind = "antigravity-cli-auth";

  // Accept both camelCase and snake_case field names for compatibility with
  // config files written by different tool versions.
  if (typeof value.currentModel === "string") {
    override.currentModel = value.currentModel;
  } else if (typeof value.current_model === "string") {
    override.currentModel = value.current_model;
  }

  if (typeof value.currentReasoning === "string") {
    override.currentReasoning = value.currentReasoning;
  } else if (typeof value.current_reasoning === "string") {
    override.currentReasoning = value.current_reasoning;
  }

  if (typeof value.enabled === "boolean") {
    override.enabled = value.enabled;
  }

  const providerType = value.type;
  if (providerType === "openai-compatible") {
    override.type = providerType;
  }

  const baseUrl = value.baseUrl ?? value.base_url;
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    override.baseUrl = baseUrl.trim();
  }

  if (value.deployment === "local" || value.deployment === "remote")
    override.deployment = value.deployment;

  const apiKey = value.apiKey ?? value.api_key;
  if (typeof apiKey === "string" && apiKey.trim()) {
    override.apiKey = apiKey.trim();
  }

  const pinnedModel = value.pinnedModel ?? value.pinned_model;
  if (typeof pinnedModel === "string" && pinnedModel.trim()) {
    override.pinnedModel = pinnedModel.trim();
  }

  const defaultModel = value.defaultModel ?? value.default_model;
  if (typeof defaultModel === "string" && defaultModel.trim()) {
    override.defaultModel = defaultModel.trim();
  }

  const localBackend = value.localBackend ?? value.local_backend;
  if (localBackend === "lm-studio" || localBackend === "unsloth") {
    override.localBackend = localBackend;
  }

  if (isRecord(value.models)) {
    const models: Record<string, ProviderModelWorkspaceOverride> = {};
    for (const [modelId, modelValue] of Object.entries(value.models)) {
      if (!modelId.trim() || !isRecord(modelValue)) continue;
      const entry: ProviderModelWorkspaceOverride = {};
      if (typeof modelValue.reasoningPreference === "string")
        entry.reasoningPreference = modelValue.reasoningPreference;

      const rawContextLength = modelValue.contextLength ?? modelValue.context_length;
      if (
        typeof rawContextLength === "number" &&
        Number.isInteger(rawContextLength) &&
        rawContextLength > 0
      ) {
        entry.contextLength = rawContextLength;
      }

      const rawMaxOutput = modelValue.maxOutputTokens ?? modelValue.max_output_tokens;
      if (typeof rawMaxOutput === "number" && Number.isInteger(rawMaxOutput) && rawMaxOutput > 0) {
        entry.maxOutputTokens = rawMaxOutput;
      }

      for (const [camelKey, snakeKey] of [
        ["supportsReasoningEffort", "supports_reasoning_effort"],
        ["supportsStreaming", "supports_streaming"],
        ["supportsToolCalls", "supports_tool_calls"],
        ["supportsSystemPrompt", "supports_system_prompt"],
        ["supportsVision", "supports_vision"],
      ] as const) {
        const raw = modelValue[camelKey] ?? modelValue[snakeKey];
        if (typeof raw === "boolean") {
          (entry as Record<string, unknown>)[camelKey] = raw;
        }
      }

      if (Object.keys(entry).length > 0) {
        models[modelId] = entry;
      }
    }
    if (Object.keys(models).length > 0) {
      override.models = models;
    }
  }

  const command = parseLaunchCommand(value.command);
  if (command !== undefined) {
    override.command = command;
  }

  const claudeCommandPath = value.claudeCommandPath ?? value.claude_command_path;
  if (typeof claudeCommandPath === "string" && claudeCommandPath.trim()) {
    override.claudeCommandPath = claudeCommandPath.trim();
  }

  const antigravityCommandPath = value.antigravityCommandPath ?? value.antigravity_command_path;
  if (typeof antigravityCommandPath === "string" && antigravityCommandPath.trim()) {
    override.antigravityCommandPath = antigravityCommandPath.trim();
  }

  const codexCommandPath = value.codexCommandPath ?? value.codex_command_path;
  if (typeof codexCommandPath === "string" && codexCommandPath.trim()) {
    override.codexCommandPath = codexCommandPath.trim();
  }

  return override;
}

function parseActiveRoute(value: unknown): ProviderActiveRoute | undefined {
  if (!isRecord(value)) return undefined;

  const providerId = resolveProviderIdentity(
    value.providerId ?? value.provider_id,
    value.backendKind ?? value.backend_kind,
  );
  const modelId = value.modelId ?? value.model_id;
  const reasoning = typeof value.reasoning === "string" ? value.reasoning.trim() : undefined;
  const localBackend = value.localBackend ?? value.local_backend;

  if (
    typeof providerId !== "string" ||
    !isKnownProviderId(providerId) ||
    !isProviderRoutableInUbume(providerId)
  )
    return undefined;
  if (typeof modelId !== "string" || !modelId.trim()) return undefined;

  return {
    providerId,
    modelId: modelId.trim(),
    backendKind: getProviderRuntime(providerId).backendKind,
    ...(reasoning ? { reasoning } : {}),
    ...(providerId === "local"
      ? { localBackend: localBackend === "unsloth" ? ("unsloth" as const) : ("lm-studio" as const) }
      : {}),
  };
}

/**
 * Normalizes supported fields and legacy identities while retaining blocked Google migration
 * data instead of silently routing elsewhere.
 */
export function parseProviderWorkspaceConfig(data: unknown): ProviderWorkspaceConfig {
  if (!isRecord(data)) return {};
  const config: ProviderWorkspaceConfig = {};
  const preserved = isRecord(data.legacyProviderData) ? { ...data.legacyProviderData } : {};
  const providers: Partial<Record<ProviderId, ProviderWorkspaceOverride>> = {};
  const rawProviders = isRecord(data.providers) ? data.providers : {};
  const rawGoogle = rawProviders.google;
  const rawAntigravity = rawProviders.antigravity;
  const googleIsAgy =
    isRecord(rawGoogle) &&
    ((rawGoogle.backendKind ?? rawGoogle.backend_kind) === "antigravity-cli-auth" ||
      (typeof (rawGoogle.antigravityCommandPath ?? rawGoogle.antigravity_command_path) ===
        "string" &&
        Boolean(
          String(rawGoogle.antigravityCommandPath ?? rawGoogle.antigravity_command_path).trim(),
        )));
  for (const [id, value] of Object.entries(rawProviders)) {
    if (id === "google" || id === "antigravity" || !isKnownProviderId(id)) continue;
    const override = parseProviderOverride(value);
    if (override) providers[id] = override;
  }
  if (rawAntigravity !== undefined && preserved.antigravity === undefined)
    preserved.antigravity = rawAntigravity;
  if (
    rawGoogle !== undefined &&
    (!googleIsAgy || (isRecord(rawGoogle) && rawGoogle.command !== undefined)) &&
    preserved.google === undefined
  )
    preserved.google = rawGoogle;
  const historicalOverride = parseProviderOverride(rawAntigravity);
  const canonicalOverride = googleIsAgy ? parseProviderOverride(rawGoogle) : undefined;
  const googleOverride = canonicalOverride
    ? {
        ...historicalOverride,
        ...canonicalOverride,
        ...(historicalOverride?.models || canonicalOverride.models
          ? {
              models: { ...historicalOverride?.models, ...canonicalOverride.models },
            }
          : {}),
      }
    : historicalOverride;
  if (googleOverride) {
    const { command, ...agyOverride } = googleOverride;
    if (!googleIsAgy && command && !agyOverride.antigravityCommandPath)
      agyOverride.antigravityCommandPath =
        typeof command === "string" ? command : command.executable;
    providers.google = { ...agyOverride, backendKind: "antigravity-cli-auth" };
  }
  if (Object.keys(providers).length) config.providers = providers;

  const defaultProvider =
    data.workspaceDefaultProviderId ??
    data.workspace_default_provider_id ??
    data.defaultProviderId ??
    data.default_provider_id;
  const defaultId = resolveProviderIdentity(defaultProvider, undefined, true);
  if (defaultId && isKnownProviderId(defaultId)) config.workspaceDefaultProviderId = defaultId;

  const rawRoute = data.activeRoute ?? data.active_route;
  const activeRoute = parseActiveRoute(rawRoute);
  const legacyRoute =
    isRecord(rawRoute) &&
    (rawRoute.providerId ?? rawRoute.provider_id) === "google" &&
    !activeRoute;
  config.googleMigrationRequired =
    data.googleMigrationRequired === true ||
    legacyRoute ||
    (defaultProvider === "google" &&
      rawGoogle !== undefined &&
      !googleIsAgy &&
      !googleOverride &&
      !activeRoute);
  if (!config.googleMigrationRequired) delete config.googleMigrationRequired;
  if (legacyRoute && preserved.activeRoute === undefined) preserved.activeRoute = rawRoute;
  if (activeRoute) {
    config.activeRoute = activeRoute;
    if (activeRoute.providerId === "local") {
      providers.local = {
        ...providers.local,
        localBackend: activeRoute.localBackend ?? "lm-studio",
      };
      config.providers = providers;
    }
  } else if (legacyRoute) {
    // Keep the selected identity blocked rather than falling back to Codex.
    config.workspaceDefaultProviderId = "google";
  }
  if (Object.keys(preserved).length) config.legacyProviderData = preserved;
  return config;
}

function serializeLaunchCommand(
  command: string | ProviderLaunchCommand | null | undefined,
): unknown {
  if (command === undefined || command === null || typeof command === "string") {
    return command;
  }
  return {
    executable: command.executable,
    args: command.args,
  };
}

/**
 * Produces the persisted compatibility representation, retaining provider/model overrides and
 * separate default/active route state.
 */
export function serializeProviderWorkspaceConfig(
  config: ProviderWorkspaceConfig,
): Record<string, unknown> {
  const providers = Object.fromEntries(
    Object.entries(config.providers ?? {}).map(([id, override]) => [
      id,
      {
        ...(id === "google" ? { backend_kind: "antigravity-cli-auth" } : {}),
        ...(override.currentModel !== undefined ? { current_model: override.currentModel } : {}),
        ...(override.currentReasoning !== undefined
          ? { current_reasoning: override.currentReasoning }
          : {}),
        ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
        ...(override.codexaNative !== undefined ? { codexaNative: override.codexaNative } : {}),
        ...(override.type !== undefined ? { type: override.type } : {}),
        ...(override.baseUrl !== undefined ? { base_url: override.baseUrl } : {}),
        ...(override.deployment ? { deployment: override.deployment } : {}),
        ...(override.apiKey !== undefined ? { api_key: override.apiKey } : {}),
        ...(override.pinnedModel !== undefined ? { pinned_model: override.pinnedModel } : {}),
        ...(override.defaultModel !== undefined ? { default_model: override.defaultModel } : {}),
        ...(override.localBackend !== undefined ? { local_backend: override.localBackend } : {}),
        ...(override.models !== undefined
          ? {
              models: Object.fromEntries(
                Object.entries(override.models).map(([modelId, model]) => [
                  modelId,
                  {
                    ...(model.contextLength !== undefined
                      ? { contextLength: model.contextLength }
                      : {}),
                    ...(model.maxOutputTokens !== undefined
                      ? { maxOutputTokens: model.maxOutputTokens }
                      : {}),
                    ...(model.supportsStreaming !== undefined
                      ? { supportsStreaming: model.supportsStreaming }
                      : {}),
                    ...(model.supportsToolCalls !== undefined
                      ? { supportsToolCalls: model.supportsToolCalls }
                      : {}),
                    ...(model.supportsSystemPrompt !== undefined
                      ? { supportsSystemPrompt: model.supportsSystemPrompt }
                      : {}),
                    ...(model.supportsVision !== undefined
                      ? { supportsVision: model.supportsVision }
                      : {}),
                    ...(model.reasoningPreference !== undefined
                      ? { reasoningPreference: model.reasoningPreference }
                      : {}),
                    ...(model.supportsReasoningEffort !== undefined
                      ? { supportsReasoningEffort: model.supportsReasoningEffort }
                      : {}),
                  },
                ]),
              ),
            }
          : {}),
        ...(override.command !== undefined
          ? { command: serializeLaunchCommand(override.command) }
          : {}),
        ...(override.claudeCommandPath !== undefined
          ? { claude_command_path: override.claudeCommandPath }
          : {}),
        ...(override.antigravityCommandPath !== undefined
          ? { antigravity_command_path: override.antigravityCommandPath }
          : {}),
        ...(override.codexCommandPath !== undefined
          ? { codex_command_path: override.codexCommandPath }
          : {}),
      },
    ]),
  );

  return {
    ...(config.legacyProviderData ? { legacyProviderData: config.legacyProviderData } : {}),
    ...(config.googleMigrationRequired ? { googleMigrationRequired: true } : {}),
    ...(config.workspaceDefaultProviderId
      ? { workspaceDefaultProviderId: config.workspaceDefaultProviderId }
      : {}),
    ...(config.activeRoute
      ? {
          activeRoute: {
            providerId: config.activeRoute.providerId,
            modelId: config.activeRoute.modelId,
            backendKind:
              config.activeRoute.backendKind ??
              getProviderRuntime(config.activeRoute.providerId).backendKind,
            ...(config.activeRoute.reasoning ? { reasoning: config.activeRoute.reasoning } : {}),
            ...(config.activeRoute.providerId === "local"
              ? {
                  localBackend:
                    config.activeRoute.localBackend ??
                    config.providers?.local?.localBackend ??
                    "lm-studio",
                }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
  };
}

/**
 * Reads current then legacy configuration when absent; malformed/unreadable files return an
 * empty configuration.
 */
export function loadProviderWorkspaceConfig(
  workspaceRoot: string,
  options: { readOnly?: boolean } = {},
): ProviderWorkspaceConfig {
  const filePath = getProviderWorkspaceConfigFile(workspaceRoot, options);
  if (existsSync(filePath)) {
    try {
      return parseProviderWorkspaceConfig(JSON.parse(readFileSync(filePath, "utf-8")));
    } catch {
      return {};
    }
  }

  const legacyFilePath = getLegacyProviderWorkspaceConfigFile(workspaceRoot);
  if (!existsSync(legacyFilePath)) return {};
  try {
    return parseProviderWorkspaceConfig(JSON.parse(readFileSync(legacyFilePath, "utf-8")));
  } catch {
    return {};
  }
}

/**
 * Writes mode-0600 JSON via temporary-file rename. I/O failures throw; the caller owns
 * serialization of competing updates.
 */
export function saveProviderWorkspaceConfig(
  workspaceRoot: string,
  config: ProviderWorkspaceConfig,
): void {
  const filePath = getProviderWorkspaceConfigFile(workspaceRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(serializeProviderWorkspaceConfig(config), null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmpFile, filePath);
}

/** Returns a new workspace default preference without changing the active route. */
export function setProviderWorkspaceDefault(
  config: ProviderWorkspaceConfig,
  providerId: ProviderId,
): ProviderWorkspaceConfig {
  return {
    ...config,
    workspaceDefaultProviderId: providerId,
  };
}

/**
 * Merges a provider's preferred model without altering other provider settings or activating a
 * route.
 */
export function setProviderDefaultModel(
  config: ProviderWorkspaceConfig,
  providerId: ProviderId,
  modelId: string,
): ProviderWorkspaceConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: {
        ...config.providers?.[providerId],
        currentModel: modelId,
      },
    },
  };
}

/**
 * Merges provider reasoning and, when a current model exists, its per-model preference. Existing
 * capabilities and other models are retained.
 */
export function setProviderDefaultReasoning(
  config: ProviderWorkspaceConfig,
  providerId: ProviderId,
  reasoning: string,
): ProviderWorkspaceConfig {
  const provider = config.providers?.[providerId];
  const currentModel = provider?.currentModel;
  return {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: {
        ...provider,
        currentReasoning: reasoning,
        ...(currentModel
          ? {
              models: {
                ...provider.models,
                [currentModel]: {
                  ...provider.models?.[currentModel],
                  reasoningPreference: reasoning,
                },
              },
            }
          : {}),
      },
    },
  };
}

/**
 * Records a routable selection; Local routes synchronize backend preference using the shared
 * precedence rule.
 */
export function setProviderActiveRoute(
  config: ProviderWorkspaceConfig,
  activeRoute: ProviderActiveRoute,
): ProviderWorkspaceConfig {
  if (!isProviderRoutableInUbume(activeRoute.providerId)) {
    return config;
  }

  if (activeRoute.providerId !== "local") {
    return {
      ...config,
      googleMigrationRequired: undefined,
      activeRoute,
    };
  }

  const localBackend = resolveLocalBackend(config, activeRoute.localBackend);
  return {
    ...config,
    activeRoute: { ...activeRoute, localBackend },
    providers: {
      ...config.providers,
      local: {
        ...config.providers?.local,
        localBackend,
      },
    },
  };
}

/** Merges the saved Local backend preference without changing the active route. */
export function setLocalBackendPreference(
  config: ProviderWorkspaceConfig,
  localBackend: LocalBackendId,
): ProviderWorkspaceConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      local: {
        ...config.providers?.local,
        localBackend,
      },
    },
  };
}
