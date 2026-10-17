/**
 * Normalizes selectable Codex models, reasoning levels, defaults, lookup, and display
 * formatting.
 */

import {
  DEFAULT_MODEL,
  formatReasoningLabel,
  LEGACY_FALLBACK_MODELS,
} from "../../config/settings.js";
import { withCodexAppServer } from "../codex/codexAppServerClient.js";
import { resolveCodexExecutable } from "../executables/codexExecutable.js";
import type { ProviderModel, ReasoningControl } from "../providerRuntime/types.js";
import { isRecord } from "../shared/values.js";
import { loadSeededCodexCapabilities, saveCachedProviderModels } from "./modelCache.js";
import { catalogContextKey } from "./modelCatalog.js";
import { reconcileReasoning } from "./reasoningControl.js";

export type ModelCapabilitySource = "runtime" | "fallback";
export type ModelCapabilityStatus = "ready" | "fallback";

export interface ReasoningEffortCapability {
  id: string;
  label: string;
  description: string | null;
}

export interface CodexModelCapability {
  id: string;
  model: string;
  label: string;
  description: string | null;
  available: boolean;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: readonly ReasoningEffortCapability[] | null;
  reasoningLevelCount: number | null;
  reasoningControl?: ReasoningControl;
  reasoningPreference?: string;
  source: ModelCapabilitySource;
  raw: unknown;
}

export interface CodexModelCapabilities {
  status: ModelCapabilityStatus;
  source: ModelCapabilitySource;
  models: readonly CodexModelCapability[];
  discoveredAt: number;
  executable: string | null;
  error: string | null;
}

interface DiscoverCodexModelCapabilitiesOptions {
  executable?: string;
  signal?: AbortSignal;
  includeHidden?: boolean;
  timeoutMs?: number;
  now?: () => number;
}

interface GetCodexModelCapabilitiesOptions extends DiscoverCodexModelCapabilitiesOptions {
  forceRefresh?: boolean;
  ttlMs?: number;
  resolveExecutable?: typeof resolveCodexExecutable;
  discover?: typeof discoverCodexModelCapabilities;
  seed?: typeof loadSeededCodexCapabilities;
  persist?: typeof persistCodexModelCapabilities;
}

interface ModelListResponse {
  data?: unknown;
  nextCursor?: unknown;
}

const verifiedCapabilityResults = new WeakSet<CodexModelCapabilities>();
/**
 * Checks process-local evidence of successful live discovery; a cached runtime-shaped seed alone
 * is not verified.
 */
export function isVerifiedCodexModelCapabilities(value: CodexModelCapabilities): boolean {
  return verifiedCapabilityResults.has(value);
}

interface CapabilityCacheEntry {
  expiresAt: number;
  pending?: boolean;
  promise: Promise<CodexModelCapabilities>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_LIMIT = 100;

const capabilityCache = new Map<string, CapabilityCacheEntry>();

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown model capability discovery error";
  }
}

function createReasoningEffortCapability(raw: unknown): ReasoningEffortCapability | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id, label: formatReasoningLabel(id), description: null } : null;
  }

  if (!isRecord(raw)) {
    return null;
  }

  const id = normalizeString(raw.reasoningEffort ?? raw.reasoning_effort ?? raw.id);
  if (!id) {
    return null;
  }

  return {
    id,
    label: formatReasoningLabel(id),
    description: normalizeString(raw.description),
  };
}

function normalizeRuntimeModel(raw: unknown): CodexModelCapability | null {
  if (!isRecord(raw)) {
    return null;
  }

  // Accept both "model" and "id" fields — Codex runtime has used both across versions.
  const model = normalizeString(raw.model ?? raw.id);
  const id = normalizeString(raw.id ?? raw.model) ?? model;
  if (!model || !id) {
    return null;
  }

  // Accept both camelCase and snake_case reasoning effort fields.
  const rawReasoning = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
    : Array.isArray(raw.supported_reasoning_efforts)
      ? raw.supported_reasoning_efforts
      : null;
  const supportedReasoningLevels = rawReasoning
    ? rawReasoning
        .map(createReasoningEffortCapability)
        .filter((item): item is ReasoningEffortCapability => Boolean(item))
    : null;
  const defaultReasoningLevel = normalizeString(
    raw.defaultReasoningEffort ?? raw.default_reasoning_effort,
  );

  return {
    id,
    model,
    label: normalizeString(raw.displayName ?? raw.display_name) ?? model,
    description: normalizeString(raw.description),
    available: true,
    hidden: normalizeBoolean(raw.hidden),
    isDefault: normalizeBoolean(raw.isDefault ?? raw.is_default),
    defaultReasoningLevel,
    supportedReasoningLevels,
    reasoningLevelCount: supportedReasoningLevels ? supportedReasoningLevels.length : null,
    source: "runtime",
    raw,
  };
}

function dedupeModels(models: CodexModelCapability[]): CodexModelCapability[] {
  const seen = new Set<string>();
  const deduped: CodexModelCapability[] = [];

  for (const model of models) {
    const key = model.model.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(model);
  }

  return deduped;
}

/** Normalizes and deduplicates app-server model pages; throws when no usable models remain. */
export function normalizeCodexModelListResponses(
  responses: readonly ModelListResponse[],
  options: { discoveredAt?: number; executable?: string | null } = {},
): CodexModelCapabilities {
  const models = dedupeModels(
    responses.flatMap((response) => {
      const rawModels = Array.isArray(response.data) ? response.data : [];
      return rawModels
        .map(normalizeRuntimeModel)
        .filter((item): item is CodexModelCapability => Boolean(item));
    }),
  );

  if (models.length === 0) {
    throw new Error("Codex model discovery returned no usable models.");
  }

  return {
    status: "ready",
    source: "runtime",
    models,
    discoveredAt: options.discoveredAt ?? Date.now(),
    executable: options.executable ?? null,
    error: null,
  };
}

/**
 * Builds the static, unavailable fallback inventory without implying successful runtime
 * discovery.
 */
export function createFallbackModelCapabilities(
  error: unknown = null,
  options: { discoveredAt?: number; executable?: string | null } = {},
): CodexModelCapabilities {
  return {
    status: "fallback",
    source: "fallback",
    models: LEGACY_FALLBACK_MODELS.map((model) => ({
      id: model,
      model,
      label: model,
      description: null,
      available: false,
      hidden: false,
      isDefault: model === DEFAULT_MODEL,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
      reasoningLevelCount: null,
      source: "fallback",
      raw: null,
    })),
    discoveredAt: options.discoveredAt ?? Date.now(),
    executable: options.executable ?? null,
    error: error ? getErrorMessage(error) : null,
  };
}

function asModelListResponse(value: unknown): ModelListResponse {
  if (!isRecord(value)) {
    throw new Error("Codex model/list returned a non-object result.");
  }

  return {
    data: value.data,
    nextCursor: value.nextCursor ?? value.next_cursor, // accept both field name styles
  };
}

async function requestModelListFromAppServer(
  executable: string,
  options: Required<Pick<DiscoverCodexModelCapabilitiesOptions, "includeHidden" | "timeoutMs">> &
    Pick<DiscoverCodexModelCapabilitiesOptions, "signal">,
): Promise<ModelListResponse[]> {
  return withCodexAppServer(
    executable,
    { timeoutMs: options.timeoutMs, signal: options.signal, operation: "Codex model discovery" },
    async (client) => {
      const responses: ModelListResponse[] = [];
      let cursor: string | null = null;
      do {
        const response = asModelListResponse(
          await client.request("model/list", {
            includeHidden: options.includeHidden,
            limit: MODEL_LIST_LIMIT,
            cursor,
          }),
        );
        responses.push(response);
        cursor = normalizeString(response.nextCursor);
      } while (cursor);
      return responses;
    },
  );
}

async function discoverCodexModelCapabilities(
  options: DiscoverCodexModelCapabilitiesOptions = {},
): Promise<CodexModelCapabilities> {
  const executable = options.executable ?? (await resolveCodexExecutable());
  const includeHidden = options.includeHidden ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const discoveredAt = options.now?.() ?? Date.now();
  const responses = await requestModelListFromAppServer(executable, {
    includeHidden,
    timeoutMs,
    signal: options.signal,
  });

  return normalizeCodexModelListResponses(responses, {
    discoveredAt,
    executable,
  });
}

// Persist a successful live discovery so the next launch can seed the model
// picker without spawning the codex app-server. Best-effort by design.
function persistCodexModelCapabilities(capabilities: CodexModelCapabilities): void {
  const models: ProviderModel[] = capabilities.models
    .filter((capability) => !capability.hidden)
    .map((capability) => ({
      id: capability.id,
      modelId: capability.model,
      label: capability.label,
      description: capability.description,
      defaultReasoningLevel: capability.defaultReasoningLevel,
      supportedReasoningLevels: capability.supportedReasoningLevels,
      source: "discovered",
    }));
  saveCachedProviderModels("openai", { discoveredAt: capabilities.discoveredAt, models });
}

// Cache chain: TTL-based in-memory cache → live discovery → seeded local caches
// (codex's own models_cache.json / Ubume's last-good discovery) → static
// fallback model list. Failed discoveries are evicted from the in-memory cache
// so retries are possible even when a seed satisfied the request.
/**
 * Shares live discovery per connection and TTL, then degrades to disk seeds or static fallback
 * on failure. Failed live attempts are evicted so later calls can retry.
 */
export async function getCodexModelCapabilities(
  options: GetCodexModelCapabilitiesOptions = {},
): Promise<CodexModelCapabilities> {
  const now = options.now?.() ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const seed = options.seed ?? loadSeededCodexCapabilities;
  const persist = options.persist ?? persistCodexModelCapabilities;
  let executable: string | null = null;
  let liveDiscoverySucceeded = false;

  try {
    executable =
      options.executable ?? (await (options.resolveExecutable ?? resolveCodexExecutable)());
    const cacheKey = `${executable}|hidden:${options.includeHidden ?? false}|${catalogContextKey("openai", { cwd: process.cwd() })}`;
    const cached = capabilityCache.get(cacheKey);
    if (cached && (cached.pending || (!options.forceRefresh && cached.expiresAt > now))) {
      return cached.promise;
    }

    const discover = options.discover ?? discoverCodexModelCapabilities;
    const promise = discover({
      executable,
      includeHidden: options.includeHidden,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      now: () => now,
    })
      .then((discovered) => {
        liveDiscoverySucceeded = true;
        verifiedCapabilityResults.add(discovered);
        try {
          persist(discovered);
        } catch {
          // Persistence must never fail a successful discovery.
        }
        return discovered;
      })
      .catch((error) => {
        try {
          const seeded = seed();
          if (seeded) {
            verifiedCapabilityResults.delete(seeded);
            return seeded;
          }
        } catch {
          // Seed read failures fall through to the static list.
        }
        return createFallbackModelCapabilities(error, { discoveredAt: now, executable });
      });

    capabilityCache.set(cacheKey, {
      expiresAt: now + ttlMs,
      promise,
      pending: true,
    });

    const result = await promise;
    const entry = capabilityCache.get(cacheKey);
    if (entry?.promise === promise) entry.pending = false;
    if (!liveDiscoverySucceeded) {
      capabilityCache.delete(cacheKey);
    }

    return result;
  } catch (error) {
    try {
      const seeded = seed();
      if (seeded) {
        return seeded;
      }
    } catch {
      // Seed read failures fall through to the static list.
    }
    return createFallbackModelCapabilities(error, { discoveredAt: now, executable });
  }
}

/**
 * Forgets in-memory capability results; does not delete disk seeds or cancel an already-running
 * discovery.
 */
export function clearCodexModelCapabilityCache(): void {
  capabilityCache.clear();
}

/** Filters hidden entries without asserting that their discovery is fresh or verified. */
export function getSelectableModelCapabilities(
  capabilities: CodexModelCapabilities,
): readonly CodexModelCapability[] {
  return capabilities.models.filter((model) => !model.hidden);
}

/**
 * Looks up a model by case-insensitive native id or capability id, returning null when absent.
 */
export function findModelCapability(
  capabilities: CodexModelCapabilities | null | undefined,
  model: string,
): CodexModelCapability | null {
  if (!capabilities) {
    return null;
  }

  const normalized = model.toLowerCase();
  return (
    capabilities.models.find(
      (candidate) =>
        candidate.model.toLowerCase() === normalized || candidate.id.toLowerCase() === normalized,
    ) ?? null
  );
}

function isModelSelectable(
  capabilities: CodexModelCapabilities | null | undefined,
  model: string,
): boolean {
  const found = findModelCapability(capabilities, model);
  return Boolean(found && !found.hidden);
}

/**
 * Keeps a selectable current model, otherwise uses the advertised default or first visible
 * model.
 */
export function getPreferredModelFromCapabilities(
  capabilities: CodexModelCapabilities,
  currentModel: string,
): string {
  if (isModelSelectable(capabilities, currentModel)) {
    return currentModel;
  }

  const selectable = getSelectableModelCapabilities(capabilities);
  return (
    selectable.find((model) => model.isDefault)?.model ??
    selectable[0]?.model ??
    currentModel ??
    DEFAULT_MODEL
  );
}

/**
 * Reconciles supported controls while retaining the current preference when reasoning metadata
 * is unknown.
 */
export function normalizeReasoningForModelCapabilities(
  model: string,
  currentReasoning: string,
  capabilities: CodexModelCapabilities | null | undefined,
): string {
  const capability = findModelCapability(capabilities, model);
  if (capability?.reasoningControl)
    return reconcileReasoning(capability.reasoningControl, currentReasoning);
  const supported = capability?.supportedReasoningLevels;
  if (!supported || supported.length === 0) {
    return currentReasoning;
  }

  if (supported.some((item) => item.id === currentReasoning)) {
    return currentReasoning;
  }

  if (
    capability.defaultReasoningLevel &&
    supported.some((item) => item.id === capability.defaultReasoningLevel)
  ) {
    return capability.defaultReasoningLevel;
  }

  return supported[0]!.id;
}

/** Formats visible model/reasoning metadata and reports runtime versus fallback provenance. */
export function formatModelCapabilitiesList(
  capabilities: CodexModelCapabilities,
  currentModel: string,
): string {
  const list = getSelectableModelCapabilities(capabilities)
    .map((model, index) => {
      const active = model.model === currentModel || model.id === currentModel ? "  *" : "";
      const reasoning =
        model.reasoningLevelCount === null
          ? "reasoning metadata unknown"
          : `${model.reasoningLevelCount} reasoning ${model.reasoningLevelCount === 1 ? "level" : "levels"}`;
      return `  ${index + 1}. ${model.label} (${model.model}) - ${reasoning}${active}`;
    })
    .join("\n");

  const source =
    capabilities.status === "ready"
      ? "Detected from Codex runtime."
      : `Fallback list; runtime discovery failed${capabilities.error ? `: ${capabilities.error}` : "."}`;

  return `${source}\n${list || "  - none"}`;
}
