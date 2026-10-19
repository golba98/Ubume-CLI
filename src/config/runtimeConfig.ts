/**
 * @fileoverview Ubume Runtime Configuration & Policy Management
 *
 * Defines the runtime configuration schemas, security policies, sandbox modes,
 * approval policies, mode inheritance resolution, writable root path management,
 * configuration diffing, and runtime status formatters.
 *
 * ## Security & Policy Hierarchy
 * - **Sandbox Modes**:
 *   - `inherit`: Inherited from the active mode (`suggest` -> `read-only`, `auto-edit` / `full-auto` -> `workspace-write`).
 *   - `read-only`: Read-only access to filesystem.
 *   - `workspace-write`: Write access permitted only within the workspace root and explicit writable roots.
 *   - `danger-full-access`: Unrestricted host filesystem access.
 *
 * - **Approval Policies**:
 *   - `inherit`: Inherited from the active mode (resolves to `on-request`).
 *   - `untrusted`: Ask before running any tool unless the repo is trusted.
 *   - `on-request`: Ask user approval when tool execution requires confirmation.
 *   - `never`: Fully automated execution without prompting for tool confirmation.
 */

import { join, posix, win32 } from "node:path";
import type { ProjectInstructionsLoadResult } from "../core/workspace/projectInstructions.js";
import {
  AVAILABLE_BACKENDS,
  AVAILABLE_MODES,
  type AvailableBackend,
  type AvailableMode,
  type AvailableModel,
  DEFAULT_BACKEND,
  DEFAULT_MODE,
  DEFAULT_MODEL,
  DEFAULT_REASONING_LEVEL,
  formatBackendLabel,
  formatModeLabel,
  formatReasoningLabel,
  type ReasoningLevel,
} from "./settings.js";

// ─── Available Option Definitions ─────────────────────────────────────────────

export const AVAILABLE_APPROVAL_POLICIES = [
  { id: "inherit", label: "Inherit" },
  { id: "untrusted", label: "Untrusted" },
  { id: "on-request", label: "On request" },
  { id: "never", label: "Never" },
] as const;

export const AVAILABLE_SANDBOX_MODES = [
  { id: "inherit", label: "Inherit" },
  { id: "read-only", label: "Read only" },
  { id: "workspace-write", label: "Workspace write" },
  { id: "danger-full-access", label: "Danger full access" },
] as const;

export const AVAILABLE_NETWORK_ACCESS_VALUES = [
  { id: "inherit", label: "Inherit" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
] as const;

export const AVAILABLE_SERVICE_TIERS = [
  { id: "flex", label: "Flex" },
  { id: "fast", label: "Fast" },
] as const;

export const AVAILABLE_PERSONALITIES = [
  { id: "none", label: "None" },
  { id: "friendly", label: "Friendly" },
  { id: "pragmatic", label: "Pragmatic" },
] as const;

export type RuntimeApprovalPolicy = (typeof AVAILABLE_APPROVAL_POLICIES)[number]["id"];
export type ResolvedApprovalPolicy = Exclude<RuntimeApprovalPolicy, "inherit">;
export type RuntimeSandboxMode = (typeof AVAILABLE_SANDBOX_MODES)[number]["id"];
export type ResolvedSandboxMode = Exclude<RuntimeSandboxMode, "inherit">;
export type RuntimeNetworkAccess = (typeof AVAILABLE_NETWORK_ACCESS_VALUES)[number]["id"];
export type RuntimeServiceTier = (typeof AVAILABLE_SERVICE_TIERS)[number]["id"];
export type RuntimePersonality = (typeof AVAILABLE_PERSONALITIES)[number]["id"];

// ─── Configuration Interfaces ─────────────────────────────────────────────────

export interface RuntimePolicyConfig {
  approvalPolicy: RuntimeApprovalPolicy;
  sandboxMode: RuntimeSandboxMode;
  networkAccess: RuntimeNetworkAccess;
  writableRoots: string[];
  serviceTier: RuntimeServiceTier;
  personality: RuntimePersonality;
  allowExternalFileImport: boolean;
  attachmentDir: string;
}

export interface RuntimeConfig {
  provider: AvailableBackend;
  model: AvailableModel;
  reasoningLevel: ReasoningLevel;
  mode: AvailableMode;
  planMode: boolean;
  antigravityCommandPath?: string;
  codexCommandPath?: string;
  policy: RuntimePolicyConfig;
}

export interface PartialRuntimeConfig extends Partial<Omit<RuntimeConfig, "policy">> {
  policy?: Partial<RuntimePolicyConfig>;
}

export interface ResolvedRuntimePolicy {
  approvalPolicy: ResolvedApprovalPolicy;
  sandboxMode: ResolvedSandboxMode;
  networkAccess: boolean;
  writableRoots: string[];
  serviceTier: RuntimeServiceTier;
  personality: RuntimePersonality;
  allowExternalFileImport: boolean;
  attachmentDir: string;
}

export interface ResolvedRuntimeConfig {
  provider: AvailableBackend;
  model: AvailableModel;
  reasoningLevel: ReasoningLevel;
  mode: AvailableMode;
  planMode: boolean;
  antigravityCommandPath?: string;
  codexCommandPath?: string;
  policy: ResolvedRuntimePolicy;
}

interface RuntimeStatusContext {
  workspaceRoot: string;
  tokensUsed?: number | null;
  projectInstructions?: ProjectInstructionsLoadResult | null;
}

export interface RuntimeSummary {
  providerLabel: string;
  model: AvailableModel;
  modelLabel?: string;
  reasoningLabel: string;
  contextLabel?: string;
  modeLabel: string;
  sandboxLabel: string;
  approvalLabel: string;
  networkLabel: string;
  writableRootsLabel: string;
}

// ─── Default Configurations ───────────────────────────────────────────────────

const DEFAULT_RUNTIME_POLICY: RuntimePolicyConfig = {
  approvalPolicy: "inherit",
  sandboxMode: "inherit",
  networkAccess: "inherit",
  writableRoots: [],
  serviceTier: "flex",
  personality: "none",
  allowExternalFileImport: true,
  attachmentDir: "attachments",
};

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  provider: DEFAULT_BACKEND,
  model: DEFAULT_MODEL,
  reasoningLevel: DEFAULT_REASONING_LEVEL,
  mode: DEFAULT_MODE,
  planMode: false,
  policy: DEFAULT_RUNTIME_POLICY,
};

// ─── Path & Normalization Helpers ─────────────────────────────────────────────

function detectPathApi(value: string): typeof win32 | typeof posix {
  return /^[a-zA-Z]:[\\/]|^\\\\|\\/.test(value) ? win32 : posix;
}

function toPlatformKey(path: string): string {
  const isWindows =
    process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
  return isWindows ? path.toLowerCase() : path;
}

function stripTrailingSeparators(value: string, pathApi: typeof win32 | typeof posix): string {
  const parsed = pathApi.parse(value);
  if (value === parsed.root) {
    return value;
  }
  return value.replace(/[\\/]+$/, "");
}

function normalizePathValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const pathApi = detectPathApi(trimmed);
  return stripTrailingSeparators(pathApi.normalize(trimmed), pathApi);
}

function dedupeWritableRoots(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = normalizePathValue(value);
    if (!trimmed) continue;
    const key = toPlatformKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

function isAvailableId<T extends string>(
  values: readonly { id: T }[],
  candidate: unknown,
): candidate is T {
  return typeof candidate === "string" && values.some((value) => value.id === candidate);
}

function normalizeRuntimeString(candidate: unknown, fallback: string): string {
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : fallback;
}

function normalizeRuntimePolicy(
  input: Partial<RuntimePolicyConfig> | null | undefined,
): RuntimePolicyConfig {
  return {
    approvalPolicy: isAvailableId(AVAILABLE_APPROVAL_POLICIES, input?.approvalPolicy)
      ? input!.approvalPolicy
      : DEFAULT_RUNTIME_POLICY.approvalPolicy,
    sandboxMode: isAvailableId(AVAILABLE_SANDBOX_MODES, input?.sandboxMode)
      ? input!.sandboxMode
      : DEFAULT_RUNTIME_POLICY.sandboxMode,
    networkAccess: isAvailableId(AVAILABLE_NETWORK_ACCESS_VALUES, input?.networkAccess)
      ? input!.networkAccess
      : DEFAULT_RUNTIME_POLICY.networkAccess,
    writableRoots: dedupeWritableRoots(
      input?.writableRoots ?? DEFAULT_RUNTIME_POLICY.writableRoots,
    ),
    serviceTier: isAvailableId(AVAILABLE_SERVICE_TIERS, input?.serviceTier)
      ? input!.serviceTier
      : DEFAULT_RUNTIME_POLICY.serviceTier,
    personality: isAvailableId(AVAILABLE_PERSONALITIES, input?.personality)
      ? input!.personality
      : DEFAULT_RUNTIME_POLICY.personality,
    allowExternalFileImport:
      typeof input?.allowExternalFileImport === "boolean"
        ? input.allowExternalFileImport
        : DEFAULT_RUNTIME_POLICY.allowExternalFileImport,
    attachmentDir: normalizeRuntimeString(
      input?.attachmentDir,
      DEFAULT_RUNTIME_POLICY.attachmentDir,
    ),
  };
}

/**
 * Normalizes a partial runtime configuration into a fully resolved RuntimeConfig,
 * filling in defaults for any unspecified fields.
 */
export function normalizeRuntimeConfig(
  input: PartialRuntimeConfig | null | undefined,
): RuntimeConfig {
  const provider = isAvailableId(AVAILABLE_BACKENDS, input?.provider)
    ? input!.provider
    : DEFAULT_RUNTIME_CONFIG.provider;
  const model = normalizeRuntimeString(input?.model, DEFAULT_RUNTIME_CONFIG.model);
  const mode = isAvailableId(
    AVAILABLE_MODES.map((item) => ({ id: item.key })),
    input?.mode,
  )
    ? input!.mode
    : DEFAULT_RUNTIME_CONFIG.mode;
  const reasoningInput = normalizeRuntimeString(
    input?.reasoningLevel,
    DEFAULT_RUNTIME_CONFIG.reasoningLevel,
  );

  return {
    provider,
    model,
    mode,
    planMode:
      typeof input?.planMode === "boolean" ? input.planMode : DEFAULT_RUNTIME_CONFIG.planMode,
    ...(typeof input?.antigravityCommandPath === "string" && input.antigravityCommandPath.trim()
      ? { antigravityCommandPath: input.antigravityCommandPath.trim() }
      : {}),
    // Executable paths must survive normalization; dropping one makes the adapter fall back
    // to CODEX_EXECUTABLE/PATH and silently run a different binary than configured.
    ...(typeof input?.codexCommandPath === "string" && input.codexCommandPath.trim()
      ? { codexCommandPath: input.codexCommandPath.trim() }
      : {}),
    reasoningLevel: reasoningInput || DEFAULT_REASONING_LEVEL,
    policy: normalizeRuntimePolicy(input?.policy),
  };
}

/**
 * Merges a partial runtime config onto a base configuration, deeply merging policies.
 */
export function mergeRuntimeConfig(
  base: RuntimeConfig,
  override: PartialRuntimeConfig | null | undefined,
): RuntimeConfig {
  if (!override) {
    return normalizeRuntimeConfig(base);
  }

  return normalizeRuntimeConfig({
    ...base,
    ...override,
    policy: {
      ...base.policy,
      ...override.policy,
    },
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

/**
 * Computes the minimal diff between a base RuntimeConfig and a target RuntimeConfig.
 * Only properties that differ are included in the returned partial.
 */
export function diffRuntimeConfig(
  base: RuntimeConfig,
  target: RuntimeConfig,
): PartialRuntimeConfig {
  const normalizedBase = normalizeRuntimeConfig(base);
  const normalizedTarget = normalizeRuntimeConfig(target);
  const policyPatch: Partial<RuntimePolicyConfig> = {};

  if (normalizedBase.policy.approvalPolicy !== normalizedTarget.policy.approvalPolicy) {
    policyPatch.approvalPolicy = normalizedTarget.policy.approvalPolicy;
  }

  if (normalizedBase.policy.sandboxMode !== normalizedTarget.policy.sandboxMode) {
    policyPatch.sandboxMode = normalizedTarget.policy.sandboxMode;
  }

  if (normalizedBase.policy.networkAccess !== normalizedTarget.policy.networkAccess) {
    policyPatch.networkAccess = normalizedTarget.policy.networkAccess;
  }

  if (!arraysEqual(normalizedBase.policy.writableRoots, normalizedTarget.policy.writableRoots)) {
    policyPatch.writableRoots = normalizedTarget.policy.writableRoots;
  }

  if (normalizedBase.policy.serviceTier !== normalizedTarget.policy.serviceTier) {
    policyPatch.serviceTier = normalizedTarget.policy.serviceTier;
  }

  if (normalizedBase.policy.personality !== normalizedTarget.policy.personality) {
    policyPatch.personality = normalizedTarget.policy.personality;
  }

  return {
    ...(normalizedBase.provider !== normalizedTarget.provider
      ? { provider: normalizedTarget.provider }
      : {}),
    ...(normalizedBase.model !== normalizedTarget.model ? { model: normalizedTarget.model } : {}),
    ...(normalizedBase.reasoningLevel !== normalizedTarget.reasoningLevel
      ? { reasoningLevel: normalizedTarget.reasoningLevel }
      : {}),
    ...(normalizedBase.mode !== normalizedTarget.mode ? { mode: normalizedTarget.mode } : {}),
    ...(normalizedBase.planMode !== normalizedTarget.planMode
      ? { planMode: normalizedTarget.planMode }
      : {}),
    ...(normalizedBase.antigravityCommandPath !== normalizedTarget.antigravityCommandPath
      ? { antigravityCommandPath: normalizedTarget.antigravityCommandPath }
      : {}),
    ...(normalizedBase.codexCommandPath !== normalizedTarget.codexCommandPath
      ? { codexCommandPath: normalizedTarget.codexCommandPath }
      : {}),
    ...(Object.keys(policyPatch).length > 0 ? { policy: policyPatch } : {}),
  };
}

// ─── Mode Inheritance Resolution ──────────────────────────────────────────────

function resolveInheritedApprovalPolicy(mode: AvailableMode): ResolvedApprovalPolicy {
  switch (mode) {
    case "suggest":
    case "auto-edit":
    case "full-auto":
    default:
      return "on-request";
  }
}

function resolveInheritedSandboxMode(mode: AvailableMode): ResolvedSandboxMode {
  switch (mode) {
    case "suggest":
      return "read-only";
    case "auto-edit":
    case "full-auto":
    default:
      return "workspace-write";
  }
}

/**
 * Resolves a RuntimeConfig with inherited policies into a fully concrete ResolvedRuntimeConfig.
 * Inherited sandbox mode and approval policy are computed based on the selected `mode`.
 */
export function resolveRuntimeConfig(config: RuntimeConfig): ResolvedRuntimeConfig {
  const normalized = normalizeRuntimeConfig(config);
  const sandboxMode =
    normalized.policy.sandboxMode === "inherit"
      ? resolveInheritedSandboxMode(normalized.mode)
      : normalized.policy.sandboxMode;
  const approvalPolicy =
    normalized.policy.approvalPolicy === "inherit"
      ? resolveInheritedApprovalPolicy(normalized.mode)
      : normalized.policy.approvalPolicy;

  return {
    provider: normalized.provider,
    model: normalized.model,
    mode: normalized.mode,
    planMode: normalized.planMode,
    ...(normalized.antigravityCommandPath
      ? { antigravityCommandPath: normalized.antigravityCommandPath }
      : {}),
    ...(normalized.codexCommandPath ? { codexCommandPath: normalized.codexCommandPath } : {}),
    reasoningLevel: normalized.reasoningLevel || DEFAULT_REASONING_LEVEL,
    policy: {
      approvalPolicy,
      sandboxMode,
      networkAccess: normalized.policy.networkAccess === "enabled",
      writableRoots: dedupeWritableRoots(normalized.policy.writableRoots),
      serviceTier: normalized.policy.serviceTier,
      personality: normalized.policy.personality,
      allowExternalFileImport: normalized.policy.allowExternalFileImport,
      attachmentDir: normalized.policy.attachmentDir,
    },
  };
}

// ─── Writable Roots Manipulation ──────────────────────────────────────────────

export function addWritableRoot(config: RuntimeConfig, root: string): RuntimeConfig {
  const nextRoots = dedupeWritableRoots([...config.policy.writableRoots, root]);
  return {
    ...config,
    policy: {
      ...config.policy,
      writableRoots: nextRoots,
    },
  };
}

export function removeWritableRoot(config: RuntimeConfig, root: string): RuntimeConfig {
  const target = normalizePathValue(root);
  const targetKey = toPlatformKey(target);
  return {
    ...config,
    policy: {
      ...config.policy,
      writableRoots: config.policy.writableRoots.filter((value) => {
        const key = toPlatformKey(normalizePathValue(value));
        return key !== targetKey;
      }),
    },
  };
}

export function clearWritableRoots(config: RuntimeConfig): RuntimeConfig {
  return {
    ...config,
    policy: {
      ...config.policy,
      writableRoots: [],
    },
  };
}

// ─── Formatters & Summaries ───────────────────────────────────────────────────

function labelForId(items: ReadonlyArray<{ id: string; label: string }>, id: string): string {
  return items.find((item) => item.id === id)?.label ?? id;
}

export function formatApprovalPolicyLabel(
  value: RuntimeApprovalPolicy | ResolvedApprovalPolicy,
): string {
  return labelForId(AVAILABLE_APPROVAL_POLICIES, value);
}

export function formatSandboxModeLabel(value: RuntimeSandboxMode | ResolvedSandboxMode): string {
  return labelForId(AVAILABLE_SANDBOX_MODES, value);
}

export function formatNetworkAccessLabel(value: RuntimeNetworkAccess | boolean): string {
  if (typeof value === "boolean") {
    return value ? "Enabled" : "Disabled";
  }
  return labelForId(AVAILABLE_NETWORK_ACCESS_VALUES, value);
}

export function formatServiceTierLabel(value: RuntimeServiceTier): string {
  return labelForId(AVAILABLE_SERVICE_TIERS, value);
}

export function formatPersonalityLabel(value: RuntimePersonality): string {
  return labelForId(AVAILABLE_PERSONALITIES, value);
}

export function buildRuntimeSummary(runtime: ResolvedRuntimeConfig): RuntimeSummary {
  return {
    providerLabel: formatBackendLabel(runtime.provider),
    model: runtime.model,
    reasoningLabel: formatReasoningLabel(runtime.reasoningLevel),
    modeLabel: formatModeLabel(runtime.mode),
    sandboxLabel: formatSandboxModeLabel(runtime.policy.sandboxMode),
    approvalLabel: formatApprovalPolicyLabel(runtime.policy.approvalPolicy),
    networkLabel: runtime.policy.networkAccess ? "Net: on" : "Net: off",
    writableRootsLabel: `Roots: ${runtime.policy.writableRoots.length}`,
  };
}

function formatWritableRootsBlock(roots: readonly string[]): string {
  return roots.length > 0 ? roots.map((value) => `    - ${value}`).join("\n") : "    - none";
}

export function formatPermissionsStatus(
  runtime: RuntimeConfig,
  resolvedRuntime: ResolvedRuntimeConfig,
  workspaceRoot: string,
): string {
  const configuredRoots = formatWritableRootsBlock(runtime.policy.writableRoots);
  const effectiveRoots = formatWritableRootsBlock(resolvedRuntime.policy.writableRoots);

  return [
    "Permissions status:",
    `  Approval policy: configured ${formatApprovalPolicyLabel(runtime.policy.approvalPolicy)}; effective ${formatApprovalPolicyLabel(resolvedRuntime.policy.approvalPolicy)}`,
    `  Sandbox mode: configured ${formatSandboxModeLabel(runtime.policy.sandboxMode)}; effective ${formatSandboxModeLabel(resolvedRuntime.policy.sandboxMode)}`,
    `  Network access: configured ${formatNetworkAccessLabel(runtime.policy.networkAccess)}; effective ${formatNetworkAccessLabel(resolvedRuntime.policy.networkAccess)}`,
    `  Workspace root: ${workspaceRoot}`,
    "  Writable roots:",
    "    Configured:",
    configuredRoots,
    "    Effective:",
    effectiveRoots,
  ].join("\n");
}

export function formatRuntimeStatus(
  runtime: ResolvedRuntimeConfig,
  context: RuntimeStatusContext,
): string {
  const writableRoots =
    runtime.policy.writableRoots.length > 0
      ? runtime.policy.writableRoots.map((value) => `  - ${value}`).join("\n")
      : "  - none";

  const lines = [
    "Runtime status:",
    `  Provider: ${formatBackendLabel(runtime.provider)}`,
    `  Model: ${runtime.model}`,
    `  Reasoning: ${formatReasoningLabel(runtime.reasoningLevel)}`,
    `  Mode: ${formatModeLabel(runtime.mode)}`,
    `  Plan mode: ${runtime.planMode ? "Enabled" : "Disabled"}`,
    `  Approval policy: ${formatApprovalPolicyLabel(runtime.policy.approvalPolicy)}`,
    `  Sandbox mode: ${formatSandboxModeLabel(runtime.policy.sandboxMode)}`,
    `  Network access: ${formatNetworkAccessLabel(runtime.policy.networkAccess)}`,
    `  Service tier: ${formatServiceTierLabel(runtime.policy.serviceTier)}`,
    `  Personality: ${formatPersonalityLabel(runtime.policy.personality)}`,
    `  Workspace root: ${context.workspaceRoot}`,
    "  Writable roots:",
    writableRoots,
  ];

  if (typeof context.tokensUsed === "number") {
    lines.push(`  Tokens used: ~${context.tokensUsed.toLocaleString("en-US")}`);
  }

  if (context.projectInstructions) {
    const pi = context.projectInstructions;
    if (pi.status === "loaded") {
      lines.push("  Project instructions: loaded");
      lines.push(`  Source: ${pi.instructions.path}`);
    } else if (pi.status === "error") {
      lines.push(`  Project instructions: error — ${pi.message}`);
      lines.push(`  Source: ${pi.path}`);
    } else {
      lines.push("  Project instructions: none");
    }
  }

  return lines.join("\n");
}

export function buildCodexConfigOverrides(runtime: ResolvedRuntimeConfig): string[] {
  const overrides = [
    `model_reasoning_effort=${runtime.reasoningLevel}`,
    `approval_policy=${runtime.policy.approvalPolicy}`,
  ];

  if (runtime.policy.networkAccess) {
    overrides.push(
      `sandbox_workspace_write.network_access=${JSON.stringify(runtime.policy.networkAccess)}`,
    );
  }

  if (runtime.policy.writableRoots.length > 0) {
    overrides.push(
      `sandbox_workspace_write.writable_roots=${JSON.stringify(runtime.policy.writableRoots)}`,
    );
  }

  if (runtime.policy.serviceTier !== "flex") {
    overrides.push(`service_tier=${runtime.policy.serviceTier}`);
  }

  if (runtime.policy.personality !== "none") {
    overrides.push(`personality=${runtime.policy.personality}`);
  }

  return overrides;
}

export function resolveWritableRootCommandPath(pathValue: string, workspaceRoot: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) return trimmed;
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed)) {
    return normalizePathValue(trimmed);
  }
  return normalizePathValue(join(workspaceRoot, trimmed));
}
