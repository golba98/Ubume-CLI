/**
 * Mistral API inventory and Vibe connection resolution. Reads optional user/project
 * configuration and credentials without echoing them; API-discovered models do not by themselves
 * prove Vibe execution support.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parseTomlDocument } from "../../config/layeredConfig.js";
import { getHomeDir } from "../../config/settings.js";
import { resolveVibeExecutable } from "../executables/executableResolver.js";
import { runCommand } from "../process/commandRunner.js";
import type { ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import { isRecord } from "../shared/values.js";
import type { ProviderModel, ProviderModelDiscoveryResult } from "./types.js";

export interface MistralConnection {
  baseUrl: string;
  apiKey: string | null;
  providerName: string;
  apiKeyEnv: string;
  configuredModels: unknown[];
}

/**
 * Reads optional user/project Vibe configuration and resolves credentials with
 * workspace/environment precedence; never logs credential contents.
 */
export function resolveMistralConnection(
  cwd: string,
  config?: ProviderWorkspaceOverride,
  env = process.env,
): MistralConnection {
  const home = env.VIBE_HOME || join(getHomeDir(), ".vibe");
  let document: Record<string, unknown> = {};
  let project = resolve(cwd);
  while (!existsSync(join(project, ".vibe", "config.toml")) && dirname(project) !== project)
    project = dirname(project);
  for (const path of [join(home, "config.toml"), join(project, ".vibe", "config.toml")]) {
    try {
      document = { ...document, ...parseTomlDocument(readFileSync(path, "utf8")) };
    } catch {
      /* Optional configuration. */
    }
  }
  const provider = Array.isArray(document.providers)
    ? document.providers.find((item) => isRecord(item) && item.name === "mistral")
    : undefined;
  const keyName =
    isRecord(provider) && typeof provider.api_key_env_var === "string"
      ? provider.api_key_env_var
      : "MISTRAL_API_KEY";
  let values: Record<string, string | undefined> = {};
  for (const path of [join(home, ".env"), join(project, ".vibe", ".env")]) {
    if (existsSync(path)) {
      try {
        values = { ...values, ...parseEnv(readFileSync(path, "utf8")) };
      } catch {
        /* Never echo credential files. */
      }
    }
  }
  const baseUrl =
    config?.baseUrl ||
    env.MISTRAL_BASE_URL ||
    (isRecord(provider) && typeof provider.api_base === "string"
      ? provider.api_base
      : "https://api.mistral.ai/v1");
  return {
    baseUrl: baseUrl.replace(/\/+$/, "").endsWith("/v1")
      ? baseUrl.replace(/\/+$/, "")
      : `${baseUrl.replace(/\/+$/, "")}/v1`,
    apiKey: config?.apiKey || env[keyName] || values[keyName] || null,
    providerName: "mistral",
    apiKeyEnv: keyName,
    configuredModels: Array.isArray(document.models) ? document.models : [],
  };
}

const MISTRAL_REASONING_LEVELS = [
  { id: "none", label: "None", description: "Vibe Low maps to Mistral reasoning_effort=none." },
  { id: "high", label: "High", description: "Vibe High maps to Mistral reasoning_effort=high." },
] as const;

/**
 * Normalizes active chat-capable API models; API discovery alone leaves custom Vibe execution
 * unverified.
 */
export function parseMistralModels(body: unknown): ProviderModel[] {
  const items = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : null;
  if (!items) throw new Error("Malformed Mistral model inventory.");
  const models = new Map<string, ProviderModel>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    const capabilities = isRecord(item.capabilities) ? item.capabilities : {};
    if (capabilities.completion_chat !== true || item.archived === true) continue;
    const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
    const levels = capabilities.reasoning === true ? MISTRAL_REASONING_LEVELS : null;
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.filter((value) => typeof value === "string")
      : [];
    const native = item.id;
    models.set(native, {
      id: native,
      modelId: native,
      providerId: "mistral",
      deployment: "remote",
      available: true,
      mistralExecutionClass: "custom-vibe",
      executionVerified: false,
      label: (typeof item.name === "string" ? item.name : native)
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase()),
      description: null,
      source: "discovered",
      defaultReasoningLevel: levels ? "high" : null,
      supportedReasoningLevels: levels,
      capabilities: {
        chat: true,
        tools: bool(capabilities.function_calling),
        vision: bool(capabilities.vision),
        reasoning: bool(capabilities.reasoning),
      },
      contextWindow:
        typeof item.max_context_length === "number" && item.max_context_length > 0
          ? item.max_context_length
          : null,
      reasoningControl: levels
        ? { kind: "levels", levels, default: "high", transport: "parameter" }
        : { kind: capabilities.reasoning === false ? "unsupported" : "unknown" },
      raw: { ...item, aliases, variantIds: [native, ...aliases] },
    });
  }
  if (
    items.length &&
    !items.some((item) => isRecord(item) && typeof item.id === "string" && item.id.trim())
  )
    throw new Error("Malformed Mistral model entries.");
  const labels = new Map<string, number>();
  for (const model of models.values()) labels.set(model.label, (labels.get(model.label) ?? 0) + 1);
  return [...models.values()].map((model) =>
    (labels.get(model.label) ?? 0) > 1
      ? { ...model, label: `${model.label} (${model.modelId})` }
      : model,
  );
}

/**
 * Fetches the API inventory using resolved Vibe credentials; authentication/transport failures
 * return unverified diagnostics.
 */
export async function fetchMistralModels(options: {
  cwd: string;
  providerConfig?: ProviderWorkspaceOverride;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ProviderModelDiscoveryResult> {
  const connection = resolveMistralConnection(options.cwd, options.providerConfig);
  const result = {
    providerId: "mistral" as const,
    backendKind: "mistral-vibe-cli-auth" as const,
    models: [] as ProviderModel[],
  };
  if (!connection.apiKey && !options.fetchImpl) {
    try {
      const executable = await resolveVibeExecutable({ cwd: options.cwd });
      const firstLine = executable ? (readFileSync(executable, "utf8").split("\n")[0] ?? "") : "";
      const interpreter = firstLine.match(/^#!(\/\S+)$/)?.[1];
      if (interpreter) {
        const child = runCommand({
          executable: interpreter,
          args: [
            "-c",
            "import sys; from vibe.utils.api_keys import resolve_api_key; sys.stdout.write(resolve_api_key(sys.argv[1]) or '')",
            connection.apiKeyEnv,
          ],
          cwd: options.cwd,
          timeoutMs: 3000,
          signal: options.signal,
        });
        const key = await child.result;
        if (key.exitCode === 0 && key.status === "completed")
          connection.apiKey = key.stdout.trim() || null;
      }
    } catch {
      /* Missing keyring integration is an authentication-required state. */
    }
  }
  if (!connection.apiKey)
    return {
      ...result,
      status: "not-configured",
      freshness: "unverified",
      refreshState: "auth-required",
      message:
        "Mistral API credentials are required for live model discovery; Vibe authentication is unchanged.",
    };
  try {
    const response = await (options.fetchImpl ?? fetch)(`${connection.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${connection.apiKey}` },
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      return {
        ...result,
        status: "not-configured",
        freshness: "unverified",
        refreshState:
          response.status === 401 || response.status === 403 ? "auth-required" : "failed",
        message: `Mistral model discovery failed (HTTP ${response.status}).`,
        diagnostics: {
          httpStatus: response.status,
          retryAfterMs: Math.min(
            300_000,
            Math.max(0, Number(response.headers.get("retry-after")) || 5) * 1000,
          ),
        },
      };
    return {
      ...result,
      status: "ready",
      models: parseMistralModels(await response.json()).map((model) => ({
        ...model,
        raw: {
          ...(isRecord(model.raw) ? model.raw : {}),
          vibeAliases: connection.configuredModels
            .filter(
              (item) =>
                isRecord(item) &&
                item.provider === "mistral" &&
                item.name === model.modelId &&
                typeof item.alias === "string",
            )
            .map((item) => (item as Record<string, unknown>).alias),
        },
      })),
      freshness: "verified",
    };
  } catch {
    return {
      ...result,
      status: "not-configured",
      freshness: "unverified",
      refreshState: "failed",
      message: "Mistral model discovery failed or timed out; check credentials and endpoint.",
    };
  }
}
