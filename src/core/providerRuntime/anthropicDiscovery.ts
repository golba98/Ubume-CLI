/**
 * Direct Anthropic API inventory discovery, distinct from Claude Code discovery. Fetches
 * paginated models with configured credentials and returns unverified diagnostics on
 * transport/auth failures.
 */

import type { ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import { isRecord } from "../shared/values.js";
import type { ProviderModel, ProviderModelDiscoveryResult } from "./types.js";

/** Resolves the configured/environment API base and appends /v1 when missing. */
export function anthropicApiBase(config?: ProviderWorkspaceOverride): string {
  const base = (
    config?.baseUrl ||
    process.env.ANTHROPIC_BASE_URL ||
    "https://api.anthropic.com"
  ).replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

/**
 * Normalizes non-retired API models and advertised capabilities; malformed inventory shapes
 * throw.
 */
export function parseAnthropicModels(body: unknown): ProviderModel[] {
  if (!isRecord(body) || !Array.isArray(body.data))
    throw new Error("Malformed Claude model inventory.");
  const models = new Map<string, ProviderModel>();
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    if (item.lifecycle === "retired") continue;
    const capabilities = isRecord(item.capabilities) ? item.capabilities : {};
    const effort = isRecord(capabilities.effort) ? capabilities.effort : null;
    const levels =
      effort?.supported === true
        ? Object.entries(effort)
            .filter(
              ([id, value]) => id !== "supported" && isRecord(value) && value.supported === true,
            )
            .map(([id]) => ({
              id,
              label: id === "xhigh" ? "Extra High" : `${id[0]?.toUpperCase()}${id.slice(1)}`,
              description: null,
            }))
        : [];
    const preferred = levels.find((level) => level.id === "high")?.id ?? levels[0]?.id ?? "";
    const supported = (key: string): boolean | null =>
      isRecord(capabilities[key]) && typeof capabilities[key].supported === "boolean"
        ? capabilities[key].supported
        : null;
    models.set(item.id, {
      id: item.id,
      modelId: item.id,
      providerId: "anthropic",
      deployment: "remote",
      available: true,
      label:
        typeof item.display_name === "string" && item.display_name.trim()
          ? item.display_name.trim()
          : item.id,
      description: null,
      source: "discovered",
      ...(typeof item.line === "string" ? { family: item.line } : {}),
      contextWindow:
        typeof item.max_input_tokens === "number" && item.max_input_tokens > 0
          ? item.max_input_tokens
          : null,
      capabilities: {
        chat: null,
        tools: null,
        vision: supported("image_input"),
        reasoning: supported("thinking"),
      },
      defaultReasoningLevel: preferred || null,
      supportedReasoningLevels: levels.length ? levels : null,
      reasoningControl: levels.length
        ? { kind: "levels", levels, default: preferred, transport: "parameter" }
        : { kind: effort?.supported === false ? "unsupported" : "unknown" },
      raw: item,
    });
  }
  if (
    body.data.length &&
    !body.data.some((item) => isRecord(item) && typeof item.id === "string" && item.id.trim())
  )
    throw new Error("Malformed Claude model entries.");
  return [...models.values()];
}

/**
 * Fetches a bounded, paginated API inventory with abort support; missing credentials and
 * failures return unverified results.
 */
export async function fetchAnthropicModels(options: {
  providerConfig?: ProviderWorkspaceOverride;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ProviderModelDiscoveryResult> {
  const initial = {
    providerId: "anthropic" as const,
    backendKind: "anthropic-api-key" as const,
    models: [] as ProviderModel[],
  };
  const key = options.providerConfig?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key)
    return {
      ...initial,
      status: "not-configured",
      freshness: "unverified",
      refreshState: "auth-required",
      message: "Claude API credentials are required.",
    };
  try {
    const models = new Map<string, ProviderModel>();
    const cursors = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      const url = new URL(`${anthropicApiBase(options.providerConfig)}/models`);
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("after_id", cursor);
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: options.signal ?? AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        return {
          ...initial,
          status: "not-configured",
          freshness: "unverified",
          refreshState: [401, 403].includes(response.status) ? "auth-required" : "failed",
          message: `Claude model discovery failed (HTTP ${response.status}).`,
        };
      const body: unknown = await response.json();
      for (const model of parseAnthropicModels(body)) models.set(model.modelId, model);
      if (!isRecord(body) || body.has_more !== true)
        return {
          ...initial,
          status: "ready",
          freshness: "verified",
          complete: true,
          models: [...models.values()],
        };
      if (typeof body.last_id !== "string" || !body.last_id || cursors.has(body.last_id))
        throw new Error("Invalid Claude pagination.");
      cursor = body.last_id;
      cursors.add(cursor);
    }
    throw new Error("Claude inventory pagination limit exceeded.");
  } catch {
    return {
      ...initial,
      status: "not-configured",
      freshness: "unverified",
      refreshState: "failed",
      message: "Claude model discovery failed; check API authentication and connectivity.",
    };
  }
}
