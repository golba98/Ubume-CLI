/**
 * Google (Antigravity) adapter: print-mode `agy -p /usage` and `/credits` JSON with per-model-
 * group quota buckets; rejects replies that ran a turn.
 */

import { buildSpawnSpec, resolveAgyExecutable } from "../executables/executableResolver.js";
import { type CommandResult, runCommand } from "../process/commandRunner.js";
import { LEGACY_GOOGLE_MESSAGE } from "../providerLauncher/providerIdentity.js";
import { errorMessage, isRecord } from "../shared/values.js";
import {
  cleanProviderText,
  completePercentPair,
  deriveLimitState,
  parseResetTime,
  percentFromFraction,
} from "./normalize.js";
import type {
  ProviderUsageSnapshot,
  UsageAdapter,
  UsageFact,
  UsageLimit,
  UsageLink,
  UsageRequestContext,
} from "./types.js";

const AGY_USAGE_TIMEOUT_MS = 20_000;
const AGY_USAGE_SOURCE = "Antigravity CLI print-mode /usage and /credits";
const AUTH_PATTERN = /auth|sign[ -]?in|log[ -]?in|unauthori[sz]ed|401|credential/i;

const WINDOW_MINUTES: Record<string, number> = { "5h": 300, weekly: 10080, daily: 1440 };

/** `agy -p /<command> --output-format json` body for a locally handled slash command. */
export interface AgyCommandBody {
  name: string;
  data: Record<string, unknown>;
}

/**
 * Validates an agy print-mode JSON reply for a local slash command. A reply that
 * ran a model turn is rejected so a prompt can never be mistaken for usage data.
 */
export function parseAgyCommandOutput(
  stdout: string,
  expectedName: string,
): { ok: true; body: AgyCommandBody } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, error: "Antigravity CLI returned non-JSON output." };
  }
  if (!isRecord(parsed)) return { ok: false, error: "Antigravity CLI returned an invalid reply." };
  if (typeof parsed.num_turns === "number" && parsed.num_turns > 0) {
    return { ok: false, error: "Antigravity CLI treated the usage command as a prompt." };
  }
  if (parsed.status !== "SUCCESS") {
    const detail = cleanProviderText(parsed.response ?? parsed.error, 200);
    return { ok: false, error: detail ?? `Antigravity CLI reported ${String(parsed.status)}.` };
  }
  const command = parsed.command;
  if (!isRecord(command) || command.name !== expectedName || !isRecord(command.data)) {
    return { ok: false, error: `Antigravity CLI did not return /${expectedName} data.` };
  }
  return { ok: true, body: { name: command.name, data: command.data } };
}

/**
 * Builds separate usage limits for AGY model groups, retaining unknown values rather than
 * inventing totals.
 */
export function parseAgyUsageData(data: Record<string, unknown>, now: number): UsageLimit[] {
  const limits: UsageLimit[] = [];
  const groups = Array.isArray(data.groups) ? data.groups : [];
  groups.forEach((group, groupIndex) => {
    if (!isRecord(group) || !Array.isArray(group.buckets)) return;
    const groupName = cleanProviderText(group.name, 60) ?? `Group ${groupIndex + 1}`;
    group.buckets.forEach((bucket, bucketIndex) => {
      if (!isRecord(bucket)) return;
      const bucketId = cleanProviderText(bucket.id, 60) ?? `${groupIndex}.${bucketIndex}`;
      const window = typeof bucket.window === "string" ? bucket.window : undefined;
      const remainingPercent = percentFromFraction(bucket.remaining_fraction);
      const name = cleanProviderText(bucket.name, 60) ?? "Quota";
      const limit: UsageLimit = {
        id: `agy.${bucketId}`,
        // agy names buckets "Weekly Limit Remaining"; the panel reports used and left itself.
        label: name.replace(/\s+remaining$/i, ""),
        group: groupName,
        windowMinutes: window ? WINDOW_MINUTES[window] : undefined,
        unit: "percent",
        ...completePercentPair({ remainingPercent }),
        resetsAt: parseResetTime(bucket.reset_time, now),
      };
      if (remainingPercent === undefined) {
        limit.note = cleanProviderText(bucket.description, 160) ?? "Quota unavailable.";
      }
      limit.state = deriveLimitState(limit);
      limits.push(limit);
    });
  });
  return limits;
}

/**
 * Normalizes AGY credit facts and supported HTTPS links without confusing zero credits with
 * missing data.
 */
export function parseAgyCreditsData(data: Record<string, unknown>): {
  fact?: UsageFact;
  link?: UsageLink;
} {
  const credits = data.remaining_credits;
  const link =
    typeof data.upgrade_uri === "string" && /^https:\/\/[^\s]+$/.test(data.upgrade_uri)
      ? { label: "G1 credits", url: data.upgrade_uri }
      : undefined;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return { link };
  return {
    fact: {
      id: "agy.credits",
      label: "G1 credits remaining",
      value: credits.toLocaleString("en-US"),
    },
    link,
  };
}

function classifyFailure(
  result: CommandResult,
  parseError?: string,
): ProviderUsageSnapshot["status"] {
  const text = `${result.stderr}\n${parseError ?? ""}`;
  if (/no quota summary is available/i.test(text)) return "unsupported";
  if (AUTH_PATTERN.test(text)) return "authentication_required";
  return "temporarily_unavailable";
}

async function runAgyCommand(
  executable: string,
  command: string,
  context: UsageRequestContext,
): Promise<{ result: CommandResult; parsed: ReturnType<typeof parseAgyCommandOutput> }> {
  const spec = buildSpawnSpec(executable, ["-p", `/${command}`, "--output-format", "json"]);
  const result = await runCommand({
    executable: spec.executable,
    args: spec.args,
    cwd: context.workspaceRoot,
    timeoutMs: AGY_USAGE_TIMEOUT_MS,
    signal: context.signal,
  }).result;
  if (result.status !== "completed") {
    return { result, parsed: { ok: false, error: result.userMessage } };
  }
  const parsed = parseAgyCommandOutput(result.stdout, command);
  if (!parsed.ok && result.exitCode !== 0) {
    const stderr = cleanProviderText(result.stderr, 200);
    return { result, parsed: { ok: false, error: stderr ?? parsed.error } };
  }
  return { result, parsed };
}

/**
 * Combines independent quota and credit results into an AGY usage snapshot with explicit
 * partial/failure states.
 */
export function buildAntigravityUsageSnapshot(
  context: UsageRequestContext,
  usage:
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; error: string; status: ProviderUsageSnapshot["status"] },
  credits: { ok: true; data: Record<string, unknown> } | { ok: false; error: string } | null,
): ProviderUsageSnapshot {
  const now = context.now();
  const snapshot: ProviderUsageSnapshot = {
    providerId: "google",
    providerLabel: "Google (Antigravity)",
    scopeKey: context.scopeKey,
    account: { authMethod: "Antigravity CLI sign-in" },
    billingMode: "subscription",
    status: "temporarily_unavailable",
    retrievedAt: now,
    freshness: "live",
    source: AGY_USAGE_SOURCE,
    limits: [],
    facts: [],
  };
  if (credits?.ok) {
    const { fact, link } = parseAgyCreditsData(credits.data);
    if (fact) snapshot.facts.push(fact);
    if (link) snapshot.links = [link];
  } else if (credits && !credits.ok) {
    snapshot.facts.push({
      id: "agy.credits",
      label: "G1 credits",
      value: "Unavailable",
      tone: "muted",
    });
  }
  if (!usage.ok) {
    return {
      ...snapshot,
      billingMode: "unknown",
      status: usage.status,
      message:
        usage.status === "authentication_required"
          ? `Antigravity CLI is not signed in. Run \`agy\` to sign in, then refresh. (${usage.error})`
          : usage.error,
    };
  }
  snapshot.limits = parseAgyUsageData(usage.data, now);
  snapshot.description = cleanProviderText(usage.data.description, 400);
  if (snapshot.limits.length === 0) {
    return { ...snapshot, status: "partial", message: "Antigravity reported no quota buckets." };
  }
  const allKnown = snapshot.limits.every((limit) => limit.remainingPercent !== undefined);
  return { ...snapshot, status: allKnown && (!credits || credits.ok) ? "available" : "partial" };
}

export const antigravityUsageAdapter: UsageAdapter = {
  id: "antigravity",
  async fetch(context) {
    if (context.googleMigrationRequired) {
      return buildAntigravityUsageSnapshot(
        context,
        { ok: false, error: LEGACY_GOOGLE_MESSAGE, status: "unsupported" },
        null,
      );
    }
    let executable: string;
    try {
      executable = await resolveAgyExecutable({
        cwd: context.workspaceRoot,
        configuredPath: context.providerConfig?.antigravityCommandPath,
      });
    } catch (error) {
      return buildAntigravityUsageSnapshot(
        context,
        {
          ok: false,
          error: `Antigravity CLI not found: ${errorMessage(error)}`,
          status: "temporarily_unavailable",
        },
        null,
      );
    }
    // Both are local print-mode commands; running them together halves the wait.
    const [usage, credits] = await Promise.all([
      runAgyCommand(executable, "usage", context),
      runAgyCommand(executable, "credits", context),
    ]);
    if (!usage.parsed.ok) {
      return buildAntigravityUsageSnapshot(
        context,
        {
          ok: false,
          error: usage.parsed.error,
          status: classifyFailure(usage.result, usage.parsed.error),
        },
        null,
      );
    }
    return buildAntigravityUsageSnapshot(
      context,
      { ok: true, data: usage.parsed.body.data },
      credits.parsed.ok
        ? { ok: true, data: credits.parsed.body.data }
        : { ok: false, error: credits.parsed.error },
    );
  },
};
