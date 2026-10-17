/**
 * Codex adapter: `account/read` and `account/rateLimits/read` over the app-server; maps windows,
 * buckets, credits and API-key/signed-out states.
 */

import { describeAppServerError, withCodexAppServer } from "../codex/codexAppServerClient.js";
import { resolveCodexExecutable } from "../executables/codexExecutable.js";
import { isRecord } from "../shared/values.js";
import {
  cleanProviderText,
  completePercentPair,
  deriveLimitState,
  formatPlanName,
  normalizePercent,
  parseResetTime,
  windowLabel,
} from "./normalize.js";
import type {
  ProviderUsageSnapshot,
  UsageAdapter,
  UsageFact,
  UsageLimit,
  UsageRequestContext,
} from "./types.js";

const CODEX_USAGE_TIMEOUT_MS = 15_000;
const CODEX_USAGE_SOURCE = "codex app-server (account/read, account/rateLimits/read)";
export const CODEX_USAGE_LINK = { label: "Usage", url: "https://chatgpt.com/settings/usage" };

type CodexAccount =
  | { kind: "chatgpt"; email?: string; plan?: string }
  | { kind: "apiKey" }
  | { kind: "other"; type: string }
  | { kind: "none"; requiresAuth: boolean };

/**
 * Normalizes structured account/read data into subscription, API-key, unknown-method or signed-
 * out account identity.
 */
export function parseCodexAccount(result: unknown): CodexAccount {
  if (!isRecord(result)) return { kind: "none", requiresAuth: false };
  const account = result.account;
  if (!isRecord(account)) return { kind: "none", requiresAuth: result.requiresOpenaiAuth === true };
  if (account.type === "chatgpt") {
    return {
      kind: "chatgpt",
      email: cleanProviderText(account.email, 120),
      plan: formatPlanName(account.planType),
    };
  }
  if (account.type === "apiKey") return { kind: "apiKey" };
  return { kind: "other", type: cleanProviderText(account.type, 40) ?? "unknown" };
}

function parseWindow(
  raw: unknown,
  slot: "primary" | "secondary",
  bucket: { id: string; group?: string },
  now: number,
): UsageLimit | null {
  if (!isRecord(raw)) return null;
  const windowMinutes =
    typeof raw.windowDurationMins === "number" && raw.windowDurationMins > 0
      ? raw.windowDurationMins
      : undefined;
  const usedPercent = normalizePercent(raw.usedPercent);
  const limit: UsageLimit = {
    id: `codex.${bucket.id}.${slot}`,
    label: windowLabel(windowMinutes) ?? (slot === "primary" ? "Primary limit" : "Secondary limit"),
    group: bucket.group,
    windowMinutes,
    unit: "percent",
    ...completePercentPair({ usedPercent }),
    resetsAt: parseResetTime(raw.resetsAt, now),
  };
  if (raw.resetsAt !== null && raw.resetsAt !== undefined && limit.resetsAt === undefined) {
    limit.note = "Reset time unavailable (invalid value from Codex).";
  }
  if (usedPercent === undefined) limit.note = "Usage percentage unavailable.";
  limit.state = deriveLimitState(limit);
  return limit;
}

const REACHED_TYPE_MESSAGES: Record<string, string> = {
  rate_limit_reached: "Codex reports this usage limit has been reached.",
  workspace_owner_credits_depleted: "Workspace credits are depleted.",
  workspace_member_credits_depleted: "Workspace credits are depleted.",
  workspace_owner_usage_limit_reached: "The workspace usage limit has been reached.",
  workspace_member_usage_limit_reached: "The workspace usage limit has been reached.",
};

export interface ParsedCodexRateLimits {
  limits: UsageLimit[];
  facts: UsageFact[];
  plan?: string;
  notes: string[];
}

/** Normalizes Codex quota buckets, credit facts and notes; unrecognized shapes return null. */
export function parseCodexRateLimits(result: unknown, now: number): ParsedCodexRateLimits | null {
  if (!isRecord(result)) return null;
  const byId = isRecord(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : null;
  const snapshots: Array<[string, Record<string, unknown>]> = byId
    ? Object.entries(byId).filter((entry): entry is [string, Record<string, unknown>] =>
        isRecord(entry[1]),
      )
    : isRecord(result.rateLimits)
      ? [[String(result.rateLimits.limitId ?? "codex"), result.rateLimits]]
      : [];
  if (snapshots.length === 0) return null;

  const multiple = snapshots.length > 1;
  const limits: UsageLimit[] = [];
  const facts: UsageFact[] = [];
  const notes: string[] = [];
  let plan: string | undefined;

  for (const [limitId, snapshot] of snapshots) {
    const id = cleanProviderText(limitId, 60) ?? "codex";
    const group = multiple
      ? (cleanProviderText(snapshot.limitName, 60) ?? cleanProviderText(snapshot.limitId, 60) ?? id)
      : undefined;
    for (const slot of ["primary", "secondary"] as const) {
      const limit = parseWindow(snapshot[slot], slot, { id, group }, now);
      if (limit) limits.push(limit);
    }
    plan ??= formatPlanName(snapshot.planType);
    const reached =
      typeof snapshot.rateLimitReachedType === "string"
        ? REACHED_TYPE_MESSAGES[snapshot.rateLimitReachedType]
        : undefined;
    if (reached && !notes.includes(reached)) notes.push(reached);
    if (snapshot.spendControlReached === true) notes.push("Spend control limit reached.");

    const credits = snapshot.credits;
    if (isRecord(credits) && !facts.some((fact) => fact.id === "codex.credits")) {
      const balance = cleanProviderText(credits.balance, 30);
      const value =
        credits.unlimited === true
          ? "Unlimited (reported by Codex)"
          : balance !== undefined
            ? balance
            : credits.hasCredits === false
              ? "None"
              : "Unavailable";
      facts.push({ id: "codex.credits", label: "Credits balance", value });
    }
  }

  if (result.ordinaryUsageAllowed === false) {
    notes.unshift("Codex reports included usage is currently blocked for this account.");
  }
  return { limits, facts, plan, notes };
}

function baseSnapshot(context: UsageRequestContext): ProviderUsageSnapshot {
  return {
    providerId: "openai",
    providerLabel: "OpenAI / Codex",
    scopeKey: context.scopeKey,
    billingMode: "unknown",
    status: "temporarily_unavailable",
    freshness: "live",
    source: CODEX_USAGE_SOURCE,
    limits: [],
    facts: [],
    links: [CODEX_USAGE_LINK],
  };
}

/**
 * Combines account and rate-limit outcomes without interpreting API-key billing as subscription
 * allowance.
 */
export function buildCodexUsageSnapshot(
  context: UsageRequestContext,
  accountResult: unknown,
  rateLimits: { ok: true; result: unknown } | { ok: false; error: string },
): ProviderUsageSnapshot {
  const now = context.now();
  const snapshot: ProviderUsageSnapshot = { ...baseSnapshot(context), retrievedAt: now };
  const account = parseCodexAccount(accountResult);

  if (account.kind === "none") {
    return {
      ...snapshot,
      status: "authentication_required",
      message: "Codex is not signed in. Run `codex login`, then refresh.",
    };
  }
  if (account.kind === "apiKey") {
    return {
      ...snapshot,
      billingMode: "api",
      account: { authMethod: "API key" },
      status: "unsupported",
      message:
        "Codex is using an API key. ChatGPT plan usage windows do not apply, and Codex does not expose API billing usage.",
    };
  }
  if (account.kind === "other") {
    snapshot.account = { authMethod: account.type };
  } else {
    snapshot.billingMode = "subscription";
    snapshot.account = { label: account.email, plan: account.plan, authMethod: "ChatGPT" };
  }

  if (!rateLimits.ok) {
    return { ...snapshot, status: "temporarily_unavailable", message: rateLimits.error };
  }
  const parsed = parseCodexRateLimits(rateLimits.result, now);
  if (!parsed) {
    return {
      ...snapshot,
      status: "temporarily_unavailable",
      message: "Codex returned rate-limit data in an unrecognised shape.",
    };
  }
  if (snapshot.account && !snapshot.account.plan && parsed.plan)
    snapshot.account.plan = parsed.plan;
  const complete = parsed.limits.some((limit) => limit.usedPercent !== undefined);
  return {
    ...snapshot,
    status: complete ? "available" : "partial",
    limits: parsed.limits,
    facts: parsed.facts,
    message:
      parsed.notes.join(" ") ||
      (parsed.limits.length === 0
        ? "Codex reported no usage windows for this account."
        : undefined),
  };
}

export const codexUsageAdapter: UsageAdapter = {
  id: "codex",
  async fetch(context) {
    let executable: string;
    try {
      executable = await resolveCodexExecutable({
        configuredPath: context.providerConfig?.codexCommandPath,
      });
    } catch (error) {
      return {
        ...baseSnapshot(context),
        message: `Codex CLI not found: ${describeAppServerError(error)}`,
      };
    }
    try {
      return await withCodexAppServer(
        executable,
        {
          timeoutMs: CODEX_USAGE_TIMEOUT_MS,
          signal: context.signal,
          operation: "Codex usage check",
        },
        async (client) => {
          const accountResult = await client.request("account/read", { refreshToken: false });
          const rateLimits = await client
            .request("account/rateLimits/read", { excludeResetCreditDetails: true })
            .then(
              (result) => ({ ok: true as const, result }),
              (error: unknown) => ({ ok: false as const, error: describeAppServerError(error) }),
            );
          return buildCodexUsageSnapshot(context, accountResult, rateLimits);
        },
      );
    } catch (error) {
      return { ...baseSnapshot(context), message: describeAppServerError(error) };
    }
  },
};
