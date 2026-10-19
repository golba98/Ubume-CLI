/**
 * Process-local provider discovery cache with connection-scoped identities and generation-
 * guarded refreshes. A failed refresh retains unverified prior models; only current entries
 * publish results. This is separate from selection evidence and disk caches.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCodexHome, getHomeDir } from "../../config/settings.js";
import { resolveLocalBackend } from "../providerLauncher/localBackend.js";
import type {
  LocalBackendId,
  ProviderId,
  ProviderWorkspaceConfig,
  ProviderWorkspaceOverride,
} from "../providerLauncher/types.js";
import type {
  ProviderModel,
  ProviderModelDiscoveryResult,
  ProviderRuntime,
} from "../providerRuntime/types.js";

export interface CatalogContext {
  cwd: string;
  providerConfig?: ProviderWorkspaceOverride;
  localConfig?: ProviderWorkspaceOverride | null;
  localBackend?: "lm-studio" | "unsloth";
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

/** Connection identities never contain credential material and are never logged. */
const salt = randomBytes(32);
/**
 * Hashes workspace, connection and auth-change evidence into a process-local identity without
 * exposing credentials in the key.
 */
export function catalogContextKey(provider: ProviderId, context: CatalogContext): string {
  const config = context.providerConfig ?? context.localConfig;
  const {
    currentModel: _model,
    currentReasoning: _reasoning,
    models: _models,
    ...connection
  } = config ?? {};
  const home = getHomeDir();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const paths =
    provider === "mistral"
      ? [
          join(process.env.VIBE_HOME || join(home, ".vibe"), "config.toml"),
          join(process.env.VIBE_HOME || join(home, ".vibe"), ".env"),
          join(context.cwd, ".vibe", "config.toml"),
          join(context.cwd, ".vibe", ".env"),
        ]
      : provider === "google"
        ? [join(home, ".gemini", "antigravity-cli", "settings.json")]
        : provider === "anthropic"
          ? [
              join(claudeDir, ".credentials.json"),
              join(claudeDir, "settings.json"),
              join(context.cwd, ".claude", "settings.json"),
              join(context.cwd, ".claude", "settings.local.json"),
              process.platform === "win32"
                ? join(
                    process.env.ProgramFiles ?? "C:\\Program Files",
                    "ClaudeCode",
                    "managed-settings.json",
                  )
                : process.platform === "darwin"
                  ? "/Library/Application Support/ClaudeCode/managed-settings.json"
                  : "/etc/claude-code/managed-settings.json",
            ]
          : provider === "openai"
            ? [join(getCodexHome(), "auth.json")]
            : [];
  const fileIdentity = paths.map((path) => {
    try {
      return createHash("sha256").update(salt).update(readFileSync(path)).digest("hex");
    } catch {
      return "missing";
    }
  });
  return createHash("sha256")
    .update(salt)
    .update(
      JSON.stringify({
        provider,
        cwd: context.cwd,
        config: connection,
        fileIdentity,
        auth: [
          process.env.MISTRAL_API_KEY,
          process.env.MISTRAL_BASE_URL,
          provider === "mistral" ? process.env : undefined,
          process.env.VIBE_EXECUTABLE,
          process.env.VIBE_HOME,
          process.env.CLAUDE_EXECUTABLE,
          process.env.CODEX_EXECUTABLE,
          process.env.AGY_EXECUTABLE,
          provider === "google" ? home : undefined,
          provider === "google" ? process.env.PATH : undefined,
          process.env.ANTHROPIC_BASE_URL,
          process.env.ANTHROPIC_API_KEY,
          provider === "anthropic"
            ? [
                process.env.CLAUDE_CONFIG_DIR,
                process.env.CLAUDE_CODE_EFFORT_LEVEL,
                process.env.CLAUDE_CODE_USE_BEDROCK,
                process.env.CLAUDE_CODE_USE_VERTEX,
                process.env.CLAUDE_CODE_USE_FOUNDRY,
                ...["FABLE", "OPUS", "SONNET", "HAIKU"].map(
                  (family) => process.env[`ANTHROPIC_DEFAULT_${family}_MODEL`],
                ),
              ]
            : undefined,
          process.env.CODEX_HOME,
          process.env.UBUME_LOCAL_BASE_URL,
          process.env.OPENAI_BASE_URL,
          process.env.OPENAI_API_BASE,
          process.env.OPENAI_API_KEY,
          process.env.UBUME_LOCAL_API_KEY,
          process.env.UNSLOTH_STUDIO_URL,
          process.env.UNSLOTH_API_KEY,
        ],
        localBackend: context.localBackend,
      }),
    )
    .digest("hex");
}

/**
 * Connection identity for a provider as configured in `config`.
 *
 * Model evidence (validation, rejection, retry delays) is scoped to this key,
 * so every hook that records or reads evidence must derive it the same way.
 * For Local, the backend follows {@link resolveLocalBackend}; pass the active
 * route's backend when the key describes a concrete route.
 */
export function providerConnectionKey(
  providerId: ProviderId,
  options: { cwd: string; config: ProviderWorkspaceConfig; routeLocalBackend?: LocalBackendId },
): string {
  const { cwd, config, routeLocalBackend } = options;
  return catalogContextKey(providerId, {
    cwd,
    providerConfig: config.providers?.[providerId],
    ...(providerId === "local"
      ? { localBackend: resolveLocalBackend(config, routeLocalBackend) }
      : {}),
  });
}

interface Entry {
  key: string;
  generation: number;
  snapshot?: ProviderModelDiscoveryResult;
  controller?: AbortController;
  pending?: Promise<ProviderModelDiscoveryResult>;
  retryAt?: number;
}

/** One owner for catalog freshness and request ordering; adapters remain provider-specific. */
export class ModelCatalog {
  private entries = new Map<ProviderId, Entry>();
  private listeners = new Set<
    (providerId: ProviderId, snapshot: ProviderModelDiscoveryResult) => void
  >();
  /**
   * Subscribes to published snapshots; the returned function removes this listener.
   */
  subscribe(
    listener: (providerId: ProviderId, snapshot: ProviderModelDiscoveryResult) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(providerId: ProviderId, snapshot: ProviderModelDiscoveryResult): void {
    for (const listener of this.listeners) listener(providerId, snapshot);
  }
  constructor(
    private now: () => number = Date.now,
    private timeoutMs = 20_000,
  ) {}
  /** Resource counts for diagnostics; never exposes connection identities or model data. */
  getDiagnostics(): { entries: number; pending: number; listeners: number } {
    return {
      entries: this.entries.size,
      pending: [...this.entries.values()].filter((entry) => entry.pending).length,
      listeners: this.listeners.size,
    };
  }
  /**
   * Reads the currently published snapshot without contacting the provider.
   */
  get(provider: ProviderId): ProviderModelDiscoveryResult | undefined {
    return this.entries.get(provider)?.snapshot;
  }
  /**
   * Updates one current model; expected identity prevents late request evidence from changing
   * a replacement descriptor.
   */
  amendModel(
    provider: ProviderId,
    id: string,
    amend: (model: ProviderModel) => ProviderModel,
    expected?: ProviderModel,
  ): boolean {
    const entry = this.entries.get(provider);
    const model = entry?.snapshot?.models.find((item) => item.modelId === id);
    if (!entry?.snapshot || !model || (expected && model !== expected)) return false;
    entry.snapshot = {
      ...entry.snapshot,
      models: entry.snapshot.models.map((item) => (item === model ? amend(item) : item)),
    };
    this.emit(provider, entry.snapshot);
    return true;
  }
  /**
   * Aborts this provider refresh and forgets its entry; late work cannot publish into a
   * replacement.
   */
  invalidate(provider: ProviderId): void {
    this.entries.get(provider)?.controller?.abort();
    this.entries.delete(provider);
  }
  /**
   * Aborts refreshes and clears entries. Subscribers own their unsubscribe callbacks.
   */
  dispose(): void {
    for (const entry of this.entries.values()) entry.controller?.abort();
    this.entries.clear();
  }
  /**
   * Coalesces discovery for the same connection, applies TTL/backoff, and publishes only the
   * owning generation. Aborted/timed-out/failed refresh work resolves to an unverified snapshot.
   * Concurrent callers share the initiating context's abort signal and request lifetime.
   */
  refresh(
    runtime: ProviderRuntime,
    context: CatalogContext,
  ): Promise<ProviderModelDiscoveryResult> {
    const id = runtime.providerId;
    const key = catalogContextKey(id, context);
    let entry = this.entries.get(id);
    const changedConnection = entry != null && entry.key !== key;
    if (entry?.key !== key) {
      entry?.controller?.abort();
      entry = { key, generation: 0 };
      this.entries.set(id, entry);
    }
    if (entry.pending) return entry.pending;
    if (!context.forceRefresh && entry.snapshot && (entry.retryAt ?? 0) > this.now())
      return Promise.resolve(entry.snapshot);
    const ttl = id === "local" ? 30_000 : 300_000;
    if (
      !context.forceRefresh &&
      entry.snapshot?.freshness === "verified" &&
      this.now() - (entry.snapshot.verifiedAt ?? 0) < ttl
    )
      return Promise.resolve(entry.snapshot);
    const controller = new AbortController();
    entry.controller = controller;
    const generation = ++entry.generation;
    const initial = runtime.discoverModels();
    const previous = entry.snapshot ?? (changedConnection ? { ...initial, models: [] } : initial);
    entry.snapshot = { ...previous, freshness: "unverified", refreshState: "loading" };
    this.emit(id, entry.snapshot);
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    const work = async (): Promise<ProviderModelDiscoveryResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectOnAbort: (() => void) | undefined;
      try {
        const result = await Promise.race([
          runtime.refreshModels
            ? runtime.refreshModels({ ...context, signal: controller.signal })
            : Promise.resolve(runtime.discoverModels()),
          new Promise<never>((_, reject) => {
            rejectOnAbort = () => reject(new Error("Model discovery canceled."));
            controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
            timer = setTimeout(() => {
              reject(new Error("Model discovery timed out."));
              controller.abort();
            }, this.timeoutMs);
            if (controller.signal.aborted) reject(new Error("Model discovery canceled."));
          }),
        ]);
        const failed =
          (result.models.length > 0 &&
            result.models.every((model) => model.source === "fallback")) ||
          result.status !== "ready" ||
          result.freshness === "unverified" ||
          result.diagnostics?.refreshFailed === true;
        const snapshot: ProviderModelDiscoveryResult = failed
          ? {
              ...result,
              models: previous.models.length ? previous.models : result.models,
              freshness: "unverified",
              refreshState: result.refreshState ?? "failed",
              verifiedAt: previous.verifiedAt,
            }
          : {
              ...result,
              freshness: "verified",
              refreshState: result.models.length ? "refreshed" : "empty",
              verifiedAt: this.now(),
              models: [
                ...new Map(
                  result.models.map((model) => [
                    model.modelId,
                    { ...model, providerId: id, verifiedAt: this.now() },
                  ]),
                ).values(),
              ],
            };
        if (this.entries.get(id) === entry && entry.generation === generation) {
          entry.snapshot = snapshot;
          this.emit(id, snapshot);
          entry.retryAt = failed
            ? this.now() + (Number(result.diagnostics?.retryAfterMs) || 5000)
            : undefined;
        }
        return snapshot;
      } catch {
        const snapshot: ProviderModelDiscoveryResult = {
          ...previous,
          freshness: "unverified",
          refreshState: "failed",
          message: controller.signal.aborted
            ? "Model discovery canceled or timed out; cached models are unverified."
            : "Model discovery failed; cached models are unverified.",
        };
        if (this.entries.get(id) === entry && entry.generation === generation) {
          entry.snapshot = snapshot;
          this.emit(id, snapshot);
          entry.retryAt = this.now() + 5000;
        }
        return snapshot;
      } finally {
        clearTimeout(timer);
        if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
        context.signal?.removeEventListener("abort", abort);
        if (this.entries.get(id) === entry && entry.generation === generation) {
          entry.pending = undefined;
          entry.controller = undefined;
        }
      }
    };
    entry.pending = work();
    return entry.pending;
  }
}

export const providerCatalog = new ModelCatalog();
