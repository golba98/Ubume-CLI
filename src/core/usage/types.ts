/**
 * Usage adapter and snapshot contracts consumed by the usage service and UI. Unknown quota
 * values are optional; freshness describes the data source separately from the service cache
 * origin.
 */

import type { LocalBackendId, ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import type { ContextConfidence } from "../providerRuntime/contextMetadata.js";
import type { ProviderRoute } from "../providerRuntime/types.js";

/**
 * Outcome of one usage retrieval. `unsupported` means the provider exposes no
 * supported programmatic usage interface; it never means "unlimited".
 */
export type UsageStatus =
  | "available"
  | "partial"
  | "unsupported"
  | "authentication_required"
  | "temporarily_unavailable";

export type UsageBillingMode = "subscription" | "api" | "local" | "unknown";

/**
 * One independent allowance window or quota bucket. Every numeric field is
 * optional: `undefined` means the source did not report it (never zero), and a
 * percentage exists only when the source reported one or a verified total.
 */
export interface UsageLimit {
  id: string;
  label: string;
  /** Groups buckets that share a scope, e.g. a model family or a metered limit id. */
  group?: string;
  windowMinutes?: number;
  unit: "percent" | "tokens" | "requests";
  used?: number;
  remaining?: number;
  total?: number;
  usedPercent?: number;
  remainingPercent?: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
  state?: "ok" | "exhausted" | "disabled";
  note?: string;
}

/** A non-quota fact such as a credit balance, plan add-on state or context size. */
export interface UsageFact {
  id: string;
  label: string;
  value: string;
  tone?: "muted" | "warning" | "error" | "success";
}

export interface UsageLink {
  label: string;
  url: string;
}

export interface ProviderUsageSnapshot {
  providerId: string;
  providerLabel: string;
  scopeKey: string;
  account?: { label?: string; plan?: string; authMethod?: string };
  billingMode: UsageBillingMode;
  status: UsageStatus;
  /** Epoch ms when the data was retrieved (live) or observed (passive capture). */
  retrievedAt?: number;
  /** `observed` data was captured passively from earlier traffic, not queried now. */
  freshness: "live" | "observed";
  /** Human-readable interface that produced the data, e.g. "codex app-server". */
  source: string;
  limits: UsageLimit[];
  facts: UsageFact[];
  /** Status or action text, shown before the limits. */
  message?: string;
  /** Background explanation from the provider, shown after the limits. */
  description?: string;
  links?: UsageLink[];
}

/** Ubume-owned runtime facts used by the Local adapter; no network involved. */
export interface LocalUsageFacts {
  modelId: string;
  localBackend?: LocalBackendId;
  isLocalInference: boolean;
  contextWindow: number | null;
  contextConfidence: ContextConfidence | null;
}

export interface UsageRequestContext {
  route: ProviderRoute;
  providerConfig?: ProviderWorkspaceOverride;
  workspaceRoot: string;
  scopeKey: string;
  signal: AbortSignal;
  now: () => number;
  localFacts?: LocalUsageFacts;
  /** True when the saved Google record still needs the Antigravity migration. */
  googleMigrationRequired?: boolean;
}

export interface UsageAdapter {
  /** Short stable id used in tests and diagnostics. */
  id: string;
  /** Reads only data Ubume already holds, so the refresh cooldown does not apply. */
  passive?: boolean;
  fetch(context: UsageRequestContext): Promise<ProviderUsageSnapshot>;
}
