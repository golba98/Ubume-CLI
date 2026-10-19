/**
 * Seeds startup model capabilities from Codex and Ubume last-good cache files without blocking
 * live discovery. Persists and loads last-good model discovery results per provider.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReasoningLabel, getCodexHome, getHomeDir } from "../../config/settings.js";
import type { ProviderId } from "../providerLauncher/types.js";
import type { ProviderModel } from "../providerRuntime/types.js";
import { isRecord } from "../shared/values.js";
import type {
  CodexModelCapabilities,
  CodexModelCapability,
  ReasoningEffortCapability,
} from "./codexModelCapabilities.js";

// Persistent last-good model discovery results, one entry per provider.
// Lets pickers open instantly with the previous session's discovered models
// while a background refresh runs. Corrupt or missing cache degrades to null.
// Resolved per call from env (matching claudeCodeDiscovery) so HOME
// redirection in tests holds — Bun's homedir() ignores runtime HOME changes.
function getProviderModelCacheFile(): string {
  const home = getHomeDir();
  const ubumePath = join(home, ".ubume-model-cache.json");
  if (existsSync(ubumePath)) return ubumePath;
  const legacyPath = join(home, ".codexa-model-cache.json");
  if (existsSync(legacyPath)) return legacyPath;
  return ubumePath;
}

const CACHE_VERSION = 1;

export interface CachedProviderModels {
  discoveredAt: number;
  backendKind?: "antigravity-cli-auth";
  models: readonly ProviderModel[];
}

interface ProviderModelCacheFile {
  legacyGoogleCli?: CachedProviderModels;
  version: number;
  providers: Partial<Record<ProviderId, CachedProviderModels>>;
}

function readCacheFile(cacheFile: string): ProviderModelCacheFile | null {
  try {
    if (!existsSync(cacheFile)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as ProviderModelCacheFile).version !== CACHE_VERSION ||
      typeof (parsed as ProviderModelCacheFile).providers !== "object" ||
      (parsed as ProviderModelCacheFile).providers === null
    ) {
      return null;
    }
    return parsed as ProviderModelCacheFile;
  } catch {
    return null;
  }
}

function isValidEntry(entry: unknown): entry is CachedProviderModels {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry as CachedProviderModels;
  return (
    typeof candidate.discoveredAt === "number" &&
    Array.isArray(candidate.models) &&
    candidate.models.every(
      (model) =>
        typeof model === "object" &&
        model !== null &&
        typeof model.id === "string" &&
        typeof model.modelId === "string" &&
        typeof model.label === "string",
    )
  );
}

function isAgyCacheEntry(entry: CachedProviderModels): boolean {
  return (
    entry.backendKind === "antigravity-cli-auth" ||
    (entry.models.length > 0 &&
      entry.models.every(
        (model) =>
          isRecord(model.raw) &&
          (model.raw.provider === "antigravity" || model.raw.provider === "google") &&
          isRecord(model.raw.selectors),
      ))
  );
}

/**
 * Reads a validated last-good inventory or null. Legacy Google data and unverified custom Vibe
 * execution entries are not treated as current inventory.
 */
export function loadCachedProviderModels(
  providerId: ProviderId | "antigravity",
  cacheFile = getProviderModelCacheFile(),
): CachedProviderModels | null {
  const cache = readCacheFile(cacheFile);
  const entry = (cache?.providers as Record<string, CachedProviderModels> | undefined)?.[
    providerId
  ];
  if (!entry || !isValidEntry(entry) || (providerId === "google" && !isAgyCacheEntry(entry))) {
    return null;
  }
  if (providerId === "mistral")
    return {
      ...entry,
      models: entry.models.filter(
        (model) => model.source === "config" || model.mistralExecutionClass !== "custom-vibe",
      ),
    };
  return entry;
}

/**
 * Best-effort atomic cache persistence with credential-field redaction and Google compatibility
 * preservation; write failures do not fail discovery.
 */
export function saveCachedProviderModels(
  providerId: ProviderId,
  entry: CachedProviderModels,
  cacheFile = join(getHomeDir(), ".ubume-model-cache.json"),
): void {
  try {
    const source =
      !existsSync(cacheFile) && cacheFile === join(getHomeDir(), ".ubume-model-cache.json")
        ? getProviderModelCacheFile()
        : cacheFile;
    const cache = readCacheFile(source) ?? { version: CACHE_VERSION, providers: {} };
    if (providerId === "google") {
      const previous = cache.providers.google;
      if (previous && isValidEntry(previous) && !isAgyCacheEntry(previous))
        cache.legacyGoogleCli ??= previous;
      entry = { ...entry, backendKind: "antigravity-cli-auth" };
    }
    cache.providers[providerId] = JSON.parse(
      JSON.stringify(entry, (key, value) =>
        /^(?:authorization|api_?key|access_?token|refresh_?token|credentials|cookie|password|secret)$/i.test(
          key,
        )
          ? undefined
          : value,
      ),
    );
    const temporary = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, cacheFile);
  } catch {
    // Persistence is best-effort; discovery still works without it.
  }
}

// The codex CLI maintains its own model catalog cache with slugs, labels and
// reasoning levels. Reading it seeds Ubume's OpenAI model list instantly —
// no subprocess — and stays current because the codex CLI refreshes the file
// on its own runs.
// Resolved per call from env (matching claudeCodeDiscovery) so HOME
// redirection in tests holds — Bun's homedir() ignores runtime HOME changes.
// CODEX_HOME relocates the codex CLI's state, including this cache.
function getCodexModelsCacheFile(): string {
  const codexHome = getCodexHome();
  return join(codexHome, "models_cache.json");
}

interface CodexSeed {
  fetchedAt: number;
  models: readonly ProviderModel[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseReasoningLevels(raw: unknown): readonly ReasoningEffortCapability[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const levels = raw
    .map((entry): ReasoningEffortCapability | null => {
      if (!isRecord(entry)) {
        return null;
      }
      const id = asString(entry.effort);
      if (!id) {
        return null;
      }
      return { id, label: formatReasoningLabel(id), description: asString(entry.description) };
    })
    .filter((entry): entry is ReasoningEffortCapability => entry !== null);
  return levels.length > 0 ? levels : null;
}

function parseSeedModel(raw: unknown): ProviderModel | null {
  if (!isRecord(raw)) {
    return null;
  }
  // Models with visibility "hide" are internal codex routes (e.g. auto-review).
  if (asString(raw.visibility) === "hide") {
    return null;
  }
  const modelId = asString(raw.slug);
  if (!modelId) {
    return null;
  }
  return {
    id: modelId,
    modelId,
    label: asString(raw.display_name) ?? modelId,
    description: asString(raw.description),
    defaultReasoningLevel: asString(raw.default_reasoning_level),
    supportedReasoningLevels: parseReasoningLevels(raw.supported_reasoning_levels),
    source: "discovered",
  };
}

/**
 * Reads Codex's own model cache without starting a process; malformed or missing data returns
 * null.
 */
export function loadCodexSeedModels(cacheFile = getCodexModelsCacheFile()): CodexSeed | null {
  try {
    if (!existsSync(cacheFile)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
      return null;
    }
    const models = parsed.models
      .map(parseSeedModel)
      .filter((model): model is ProviderModel => model !== null);
    if (models.length === 0) {
      return null;
    }
    const fetchedAtRaw = asString(parsed.fetched_at);
    const fetchedAt = fetchedAtRaw ? Date.parse(fetchedAtRaw) : Number.NaN;
    return { fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0, models };
  } catch {
    return null;
  }
}

// Freshest locally known OpenAI models without spawning a subprocess:
// codex's own cache file vs Ubume's persisted last-good discovery.
/**
 * Selects the freshest Codex or Ubume disk seed for startup without proving live availability.
 */
export function loadSeededOpenAiModels(
  options: { codexCacheFile?: string; providerCacheFile?: string } = {},
): CachedProviderModels | null {
  const seed = loadCodexSeedModels(options.codexCacheFile);
  const persisted =
    options.providerCacheFile === undefined
      ? loadCachedProviderModels("openai")
      : loadCachedProviderModels("openai", options.providerCacheFile);
  if (seed && (!persisted || seed.fetchedAt >= persisted.discoveredAt)) {
    return { discoveredAt: seed.fetchedAt, models: seed.models };
  }
  return persisted;
}

function toCapability(model: ProviderModel, index: number): CodexModelCapability {
  return {
    id: model.id,
    model: model.modelId,
    label: model.label,
    description: model.description,
    available: true,
    hidden: false,
    isDefault: index === 0,
    defaultReasoningLevel: model.defaultReasoningLevel,
    supportedReasoningLevels: model.supportedReasoningLevels,
    reasoningLevelCount: model.supportedReasoningLevels
      ? model.supportedReasoningLevels.length
      : null,
    source: "runtime",
    raw: model,
  };
}

// Capabilities for the OpenAI picker sourced purely from local caches.
// Returns null when nothing is cached yet (first ever launch).
/**
 * Converts startup disk seeds into capability records; callers must separately establish live
 * verification.
 */
export function loadSeededCodexCapabilities(
  options: { codexCacheFile?: string; providerCacheFile?: string } = {},
): CodexModelCapabilities | null {
  const seeded = loadSeededOpenAiModels(options);
  if (!seeded) {
    return null;
  }
  return {
    status: "ready",
    source: "runtime",
    models: seeded.models.map(toCapability),
    discoveredAt: seeded.discoveredAt,
    executable: null,
    error: null,
  };
}
