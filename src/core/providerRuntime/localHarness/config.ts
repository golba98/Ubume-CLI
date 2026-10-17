/**
 * Local Harness configuration, environment and fingerprints. Persisted route/transcript
 * identities exclude credentials; a separate process-local salted secret fingerprint detects
 * credential changes for process reuse.
 */

import { createHash, randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { ProviderChatRequest } from "../types.js";

export const HARNESS_VERSION = "0.1.2-rc.1";

export const PROFILE_NAME = "ubume-local";

export const HARNESS_MAX_RSS_BYTES = 1024 * 1024 * 1024;

export const HARNESS_HEAP_LIMIT_MIB = 768;

// pi-ai aborts a stream after this long without a chunk, including time to the
// first token. A Local server that stalls this long is overloaded (commonly RAM
// exhaustion paging model weights from disk), so the profile drops TIMEOUT from
// the Harness retry codes: re-sending the same request to a stalled server only
// adds more silent waits of the same length.
export const LOCAL_STREAM_IDLE_TIMEOUT_MS = 300_000;

export const INTERNAL_PROVIDER = "ubume-local";

const packageRequire = createRequire(import.meta.url);

export const PROCESS_FINGERPRINT_SALT = randomBytes(16);

export interface HarnessConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
  /** Reasoning effort to request, or null when the model has not opted in. */
  reasoningEffort: HarnessReasoningEffort | null;
}

export type HarnessReasoningEffort = "low" | "medium" | "high";

/**
 * Enables a supported effort only when the selected model explicitly opts in through
 * configuration.
 */
export function resolveHarnessReasoningEffort(
  request: ProviderChatRequest,
  model: string,
): HarnessReasoningEffort | null {
  if (request.localConfig?.models?.[model]?.supportsReasoningEffort !== true) return null;
  const level = (request.runtime as { reasoningLevel?: unknown }).reasoningLevel;
  return level === "low" || level === "medium" || level === "high" ? level : null;
}

export type HarnessSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * Makes planning read-only and normalizes legacy full-access settings to the Harness sandbox
 * vocabulary.
 */
export function resolveHarnessSandboxMode(request: ProviderChatRequest): HarnessSandboxMode {
  if (request.runIntent === "plan" || request.runtime.planMode) return "read-only";
  const mode = String(request.runtime.policy.sandboxMode);
  if (mode === "read-only") return "read-only";
  if (mode === "danger-full-access" || mode === "full-access") return "danger-full-access";
  return "workspace-write";
}

/** Stable SHA-256 of a JSON-serializable value, used for route and grant fingerprints. */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Endpoint URL with credentials, query and fragment removed, safe to show or hash. */
export function sanitizedEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "configured Local endpoint";
  }
}

/** Fingerprints canonical restored history for Harness session-resume compatibility. */
export function transcriptHash(request: ProviderChatRequest): string {
  return hashJson(request.conversationHistory ?? []);
}

/**
 * Hashes non-secret execution configuration and policy used to decide whether saved Harness
 * state can resume.
 */
export function routeFingerprint(config: HarnessConfig, request: ProviderChatRequest): string {
  return hashJson({
    baseUrl: sanitizedEndpoint(config.baseUrl),
    localBackend: request.route.localBackend ?? request.localConfig?.localBackend ?? "lm-studio",
    model: config.model,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    supportsVision: config.supportsVision,
    reasoningEffort: config.reasoningEffort,
    sandbox: resolveHarnessSandboxMode(request),
    writableRoots: request.runtime.policy.writableRoots,
  });
}

/**
 * Creates a process-salted credential-change fingerprint; it is not a persistent account
 * identity.
 */
export function secretFingerprint(value: string): string {
  // This only detects credential changes during this process. A process-local
  // salt and memory-hard KDF prevent an exposed fingerprint from becoming a
  // reusable offline API-key oracle.
  return scryptSync(value, PROCESS_FINGERPRINT_SALT, 32).toString("hex");
}

/**
 * Resolves the packaged Harness executable from its manifest; missing executable metadata
 * throws.
 */
export function resolveDshBin(): string {
  const packagePath = packageRequire.resolve("@deepseek-ai/dsh/package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { bin?: { dsh?: string } };
  if (!manifest.bin?.dsh)
    throw new Error("The installed @deepseek-ai/dsh package has no dsh executable.");
  return resolve(dirname(packagePath), manifest.bin.dsh);
}

/**
 * Resolves execution settings and validates required agent capabilities; Unsloth must already
 * have a resolved connection.
 */
export function resolveHarnessConfig(request: ProviderChatRequest): HarnessConfig {
  const resolved = request.resolvedLocalAgentConfig;
  const selectedBackend = request.route.localBackend ?? request.localConfig?.localBackend;
  if (selectedBackend === "unsloth" && !resolved) {
    throw new Error(
      "Local agent request failed: the selected Unsloth connection was not resolved before Harness startup.",
    );
  }
  const local = request.localConfig;
  const model =
    resolved?.modelId ??
    (request.route.modelId ||
      local?.pinnedModel ||
      local?.currentModel ||
      local?.defaultModel ||
      "");
  if (!model) throw new Error("Local agent request failed: no Local model is selected.");
  const modelConfig = local?.models?.[model];
  if (resolved?.supportsToolCalls === false || modelConfig?.supportsToolCalls === false) {
    throw new Error(
      `Local agent request failed.\n\nModel: ${model}\n\nThe selected model is configured without tool/function-calling support required by the Local agent harness.`,
    );
  }
  if (resolved?.supportsStreaming === false || modelConfig?.supportsStreaming === false) {
    throw new Error(
      `Local agent request failed.\n\nModel: ${model}\n\nThe selected model is configured without streaming support required by Ubume's Local agent harness.`,
    );
  }
  if (resolved?.supportsSystemPrompt === false || modelConfig?.supportsSystemPrompt === false) {
    throw new Error(
      `Local agent request failed.\n\nModel: ${model}\n\nThe selected model is configured without system-prompt support required by the Local agent harness.`,
    );
  }
  return {
    baseUrl: (
      resolved?.baseUrl ??
      local?.baseUrl ??
      process.env.UBUME_LOCAL_BASE_URL ??
      "http://localhost:1234/v1"
    ).replace(/\/+$/, ""),
    apiKey: resolved?.apiKey ?? local?.apiKey ?? process.env.UBUME_LOCAL_API_KEY ?? "lm-studio",
    model,
    contextWindow: resolved?.contextWindow ?? modelConfig?.contextLength ?? 32_768,
    maxTokens:
      resolved?.maxTokens ??
      modelConfig?.maxOutputTokens ??
      resolveDefaultMaxOutputTokens(resolved?.contextWindow ?? modelConfig?.contextLength),
    supportsVision: resolved?.supportsVision ?? modelConfig?.supportsVision === true,
    reasoningEffort: resolveHarnessReasoningEffort(request, model),
  };
}

export const MIN_DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export const MAX_DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/**
 * Output-token budget for a Local model that advertises no cap of its own.
 *
 * Reasoning models spend output tokens thinking before they answer; a flat
 * 8K budget on a 131K-context model was hit entirely inside the reasoning
 * channel, ending the turn with no answer at all. Scale with the context
 * window (a quarter of it), bounded so small windows keep the old default
 * and huge windows do not request absurd completions.
 */
export function resolveDefaultMaxOutputTokens(contextWindow: number | undefined): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0)
    return MIN_DEFAULT_MAX_OUTPUT_TOKENS;
  const scaled = Math.floor(contextWindow / 4);
  return Math.max(MIN_DEFAULT_MAX_OUTPUT_TOKENS, Math.min(MAX_DEFAULT_MAX_OUTPUT_TOKENS, scaled));
}

/**
 * Builds child-only connection, permission and memory settings without mutating process.env;
 * includes credentials and must not be logged verbatim.
 */
export function buildHarnessEnv(
  request: ProviderChatRequest,
  config: HarnessConfig,
  dshHome: string,
): NodeJS.ProcessEnv {
  const harnessSandboxMode = resolveHarnessSandboxMode(request);
  return {
    ...process.env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS?.trim(),
      `--max-old-space-size=${HARNESS_HEAP_LIMIT_MIB}`,
    ]
      .filter(Boolean)
      .join(" "),
    UBUME_DSH_MAX_RSS_BYTES: String(HARNESS_MAX_RSS_BYTES),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PERMISSION_MODE: harnessSandboxMode,
    UBUME_DSH_PERMISSION_PRESET: harnessSandboxMode,
    UBUME_DSH_APPROVAL_POLICY: harnessSandboxMode === "danger-full-access" ? "never" : "ask",
    UBUME_DSH_BASE_URL: config.baseUrl,
    UBUME_DSH_API_KEY: config.apiKey,
    UBUME_DSH_MODEL: config.model,
    UBUME_DSH_CONTEXT_WINDOW: String(config.contextWindow),
    UBUME_DSH_MAX_TOKENS: String(config.maxTokens),
    UBUME_DSH_VISION: config.supportsVision ? "1" : "0",
    ...(config.reasoningEffort ? { UBUME_DSH_REASONING_EFFORT: config.reasoningEffort } : {}),
  };
}
