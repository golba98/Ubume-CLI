/**
 * Claude Code adapter: `claude auth status` plus the experimental `get_usage` SDK control
 * request on a hook-free, tool-free, non-persisted stream-json host.
 */

import {
  buildClaudeSpawnSpec,
  resolveClaudeExecutable,
} from "../executables/executableResolver.js";
import { runCommand } from "../process/commandRunner.js";
import { errorMessage, isRecord } from "../shared/values.js";
import {
  cleanProviderText,
  completePercentPair,
  deriveLimitState,
  formatPlanName,
  normalizePercent,
  parseResetTime,
} from "./normalize.js";
import type {
  ProviderUsageSnapshot,
  UsageAdapter,
  UsageFact,
  UsageLimit,
  UsageRequestContext,
} from "./types.js";

const CLAUDE_USAGE_TIMEOUT_MS = 15_000;
const CLAUDE_AUTH_TIMEOUT_MS = 10_000;
const CLAUDE_USAGE_SOURCE = "Claude Code SDK control request get_usage (experimental)";
export const CLAUDE_USAGE_LINK = { label: "Usage", url: "https://claude.ai/settings/usage" };

/**
 * Starts Claude Code as an SDK host that never receives a user message: no tools,
 * no MCP servers, no hooks, no persisted session. Only control requests are sent.
 */
export const CLAUDE_USAGE_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--tools",
  "",
  "--settings",
  JSON.stringify({ disableAllHooks: true }),
];

/** Windows Claude Code exposes; key order is display order. */
const CLAUDE_WINDOWS: ReadonlyArray<{ key: string; label: string; minutes?: number }> = [
  { key: "five_hour", label: "Session limit (5-hour)", minutes: 300 },
  { key: "seven_day", label: "Weekly limit (all models)", minutes: 10080 },
  { key: "seven_day_opus", label: "Weekly limit (Opus)", minutes: 10080 },
  { key: "seven_day_sonnet", label: "Weekly limit (Sonnet)", minutes: 10080 },
  { key: "seven_day_oauth_apps", label: "Weekly limit (OAuth apps)", minutes: 10080 },
];

export interface ClaudeAuthIdentity {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

/** Reads structured Claude identity without returning raw credentials. */
export function parseClaudeAuthIdentity(stdout: string): ClaudeAuthIdentity | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (!isRecord(parsed)) return null;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: cleanProviderText(parsed.authMethod, 40),
      email: cleanProviderText(parsed.email, 120),
      subscriptionType: cleanProviderText(parsed.subscriptionType, 40),
    };
  } catch {
    return null;
  }
}

function parseWindow(
  raw: unknown,
  id: string,
  label: string,
  minutes: number | undefined,
  now: number,
  group?: string,
): UsageLimit | null {
  if (!isRecord(raw)) return null;
  const usedPercent = normalizePercent(raw.utilization);
  const limit: UsageLimit = {
    id: `claude.${id}`,
    label,
    group,
    windowMinutes: minutes,
    unit: "percent",
    ...completePercentPair({ usedPercent }),
    resetsAt: parseResetTime(raw.resets_at, now),
  };
  if (usedPercent === undefined) limit.note = "Utilisation unavailable.";
  else if (raw.resets_at && limit.resetsAt === undefined) limit.note = "Reset time unavailable.";
  limit.state = deriveLimitState(limit);
  return limit;
}

export interface ParsedClaudeUsage {
  subscriptionType?: string;
  rateLimitsAvailable: boolean;
  limits: UsageLimit[];
  facts: UsageFact[];
  /** True when `rate_limits` existed but no recognised window could be read. */
  shapeDrift: boolean;
}

/** Parses the documented fields of a `get_usage` reply; unknown keys are ignored. */
export function parseClaudeGetUsage(response: unknown, now: number): ParsedClaudeUsage | null {
  if (!isRecord(response) || typeof response.rate_limits_available !== "boolean") return null;
  const parsed: ParsedClaudeUsage = {
    subscriptionType: cleanProviderText(response.subscription_type, 40),
    rateLimitsAvailable: response.rate_limits_available,
    limits: [],
    facts: [],
    shapeDrift: false,
  };
  const rateLimits = response.rate_limits;
  if (!isRecord(rateLimits)) return parsed;

  for (const window of CLAUDE_WINDOWS) {
    const limit = parseWindow(
      rateLimits[window.key],
      window.key,
      window.label,
      window.minutes,
      now,
    );
    if (limit) parsed.limits.push(limit);
  }
  if (Array.isArray(rateLimits.model_scoped)) {
    rateLimits.model_scoped.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const name = cleanProviderText(entry.display_name, 40) ?? `Model bucket ${index + 1}`;
      const limit = parseWindow(
        entry,
        `model_scoped.${index}`,
        `Weekly limit (${name})`,
        10080,
        now,
        "Model-specific limits",
      );
      if (limit) parsed.limits.push(limit);
    });
  }

  const extra = rateLimits.extra_usage;
  if (isRecord(extra) && typeof extra.is_enabled === "boolean") {
    const utilization = normalizePercent(extra.utilization);
    parsed.facts.push({
      id: "claude.extra_usage",
      label: "Extra usage",
      value: extra.is_enabled
        ? utilization !== undefined
          ? `On · ${Math.round(utilization)}% of monthly limit used`
          : "On"
        : "Off",
      tone: extra.is_enabled ? undefined : "muted",
    });
  }
  parsed.shapeDrift = parsed.limits.length === 0;
  return parsed;
}

/**
 * Combines Claude authentication and usage outcomes while preserving unsupported and temporarily
 * unavailable states.
 */
export function buildClaudeUsageSnapshot(
  context: UsageRequestContext,
  identity: ClaudeAuthIdentity | null,
  usage: { ok: true; response: unknown } | { ok: false; error: string; unsupported?: boolean },
): ProviderUsageSnapshot {
  const now = context.now();
  const snapshot: ProviderUsageSnapshot = {
    providerId: "anthropic",
    providerLabel: "Claude Code",
    scopeKey: context.scopeKey,
    billingMode: "unknown",
    status: "temporarily_unavailable",
    retrievedAt: now,
    freshness: "live",
    source: CLAUDE_USAGE_SOURCE,
    limits: [],
    facts: [],
    links: [CLAUDE_USAGE_LINK],
  };
  if (identity && !identity.loggedIn) {
    return {
      ...snapshot,
      status: "authentication_required",
      message: "Claude Code is not signed in. Run `claude auth login`, then refresh.",
    };
  }
  if (identity) {
    snapshot.account = {
      label: identity.email,
      plan: formatPlanName(identity.subscriptionType),
      authMethod: identity.authMethod,
    };
  }
  if (!usage.ok) {
    return {
      ...snapshot,
      status: usage.unsupported ? "unsupported" : "temporarily_unavailable",
      message: usage.error,
    };
  }
  const parsed = parseClaudeGetUsage(usage.response, now);
  if (!parsed) {
    return {
      ...snapshot,
      status: "temporarily_unavailable",
      message:
        "Claude Code returned usage data in an unrecognised shape (get_usage is experimental and may have changed).",
    };
  }
  if (parsed.subscriptionType) {
    snapshot.account = { ...snapshot.account, plan: formatPlanName(parsed.subscriptionType) };
  }
  if (!parsed.rateLimitsAvailable) {
    return {
      ...snapshot,
      billingMode: parsed.subscriptionType ? "subscription" : "api",
      status: "unsupported",
      facts: parsed.facts,
      message:
        "Plan usage limits do not apply to this Claude Code login (API key, Bedrock, Vertex or a token without the profile scope).",
      links: [{ label: "Billing", url: "https://platform.claude.com/settings/billing" }],
    };
  }
  snapshot.billingMode = "subscription";
  if (parsed.shapeDrift) {
    return {
      ...snapshot,
      status: parsed.facts.length > 0 ? "partial" : "temporarily_unavailable",
      facts: parsed.facts,
      message:
        "Claude Code reported plan limits without any recognised usage window (get_usage is experimental and may have changed).",
    };
  }
  const complete = parsed.limits.some((limit) => limit.usedPercent !== undefined);
  return {
    ...snapshot,
    status: complete ? "available" : "partial",
    limits: parsed.limits,
    facts: parsed.facts,
  };
}

interface ControlExchange {
  ok: boolean;
  response?: unknown;
  error?: string;
  unsupported?: boolean;
}

/** Sends `initialize` then `get_usage` over Claude Code's stream-json control protocol. */
export async function requestClaudeGetUsage(
  executable: string,
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ControlExchange> {
  const spec = buildClaudeSpawnSpec(executable, [...CLAUDE_USAGE_ARGS]);
  const line = (requestId: string, request: Record<string, unknown>) =>
    `${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`;
  let buffer = "";
  // Assigned from the stdout callback, so declared without a narrowed initial type.
  let exchange = null as ControlExchange | null;
  const runner = runCommand(
    {
      executable: spec.executable,
      args: spec.args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS,
      signal: options.signal,
      stdinData: line("ubume-init", { subtype: "initialize" }),
      keepStdinOpen: true,
      // The control protocol is parsed from the stream; only a short stderr is reported.
      capture: { maxChars: 64 * 1024 },
    },
    {
      onStdout: (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          let message: unknown;
          try {
            message = JSON.parse(raw);
          } catch {
            continue;
          }
          if (!isRecord(message) || message.type !== "control_response") continue;
          const response = message.response;
          if (!isRecord(response)) continue;
          if (response.request_id === "ubume-init") {
            if (response.subtype === "success") {
              runner.child.stdin?.write(
                line("ubume-usage", { subtype: "get_usage", skip_behaviors: true }),
              );
            } else {
              const error = cleanProviderText(response.error, 200) ?? "unknown error";
              exchange = { ok: false, error: `Claude Code initialize failed: ${error}` };
              runner.child.stdin?.end();
            }
          } else if (response.request_id === "ubume-usage") {
            if (response.subtype === "success") {
              exchange = { ok: true, response: response.response };
            } else {
              const error = cleanProviderText(response.error, 200) ?? "unknown error";
              const unsupported = /not supported|unknown|unrecognized|invalid.*subtype/i.test(
                error,
              );
              exchange = {
                ok: false,
                error: unsupported
                  ? `This Claude Code version does not support usage requests (${error}).`
                  : `Claude Code usage request failed: ${error}`,
                unsupported,
              };
            }
            runner.child.stdin?.end();
          }
        }
      },
    },
  );
  const result = await runner.result;
  if (exchange) return exchange;
  if (result.status === "canceled") return { ok: false, error: "Usage check canceled." };
  if (result.status === "timeout") {
    return { ok: false, error: "Claude Code did not answer the usage request in time." };
  }
  if (result.status === "spawn_error") return { ok: false, error: result.userMessage };
  const stderr = cleanProviderText(result.stderr, 200);
  return {
    ok: false,
    error: stderr
      ? `Claude Code exited before reporting usage: ${stderr}`
      : `Claude Code exited before reporting usage (exit ${result.exitCode ?? "unknown"}).`,
  };
}

async function readClaudeIdentity(
  executable: string,
  options: { cwd: string; signal?: AbortSignal },
): Promise<ClaudeAuthIdentity | null> {
  const spec = buildClaudeSpawnSpec(executable, ["auth", "status"]);
  const result = await runCommand({
    executable: spec.executable,
    args: spec.args,
    cwd: options.cwd,
    timeoutMs: CLAUDE_AUTH_TIMEOUT_MS,
    signal: options.signal,
  }).result;
  // `claude auth status` exits 1 when signed out but still prints JSON.
  if (result.status !== "completed" && result.status !== "failed") return null;
  return (
    parseClaudeAuthIdentity(result.stdout) ?? (result.exitCode === 1 ? { loggedIn: false } : null)
  );
}

export const claudeCodeUsageAdapter: UsageAdapter = {
  id: "claude-code",
  async fetch(context) {
    let executable: string;
    try {
      executable = await resolveClaudeExecutable({
        cwd: context.workspaceRoot,
        configuredPath: context.providerConfig?.claudeCommandPath,
      });
    } catch (error) {
      return buildClaudeUsageSnapshot(context, null, {
        ok: false,
        error: `Claude Code CLI not found: ${errorMessage(error)}`,
      });
    }
    const options = { cwd: context.workspaceRoot, signal: context.signal };
    const identity = await readClaudeIdentity(executable, options);
    if (identity && !identity.loggedIn) {
      return buildClaudeUsageSnapshot(context, identity, { ok: false, error: "Not signed in." });
    }
    const usage = await requestClaudeGetUsage(executable, options);
    return buildClaudeUsageSnapshot(
      context,
      identity,
      usage.ok
        ? { ok: true, response: usage.response }
        : { ok: false, error: usage.error ?? "Usage unavailable.", unsupported: usage.unsupported },
    );
  },
};
