/**
 * Probes Codex authentication and converts results into run gating, labels, guidance, and
 * likely-auth-failure classification.
 */

import { formatCodexLaunchError, resolveCodexExecutable } from "../executables/codexExecutable.js";
import { buildSpawnSpec } from "../executables/executableResolver.js";
import { runCommand } from "../process/commandRunner.js";

export type CodexAuthState = "checking" | "authenticated" | "unauthenticated" | "unknown";

export interface CodexAuthProbeResult {
  state: CodexAuthState;
  checkedAt: number;
  rawSummary: string;
  recommendedAction: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
}

const JSON_STATUS_FLAGS = ["authenticated", "is_authenticated", "logged_in", "signed_in"] as const;

const UNAUTHENTICATED_PATTERNS = [
  "not logged in",
  "not signed in",
  "no active session",
  "login required",
  "sign in required",
  "unauthenticated",
  "authentication required",
  "run `codex login`",
  "run codex login",
  "please login",
  "please log in",
  "session expired",
  "token expired",
] as const;

const AUTH_FAILURE_PHRASES = [
  ...UNAUTHENTICATED_PATTERNS,
  "invalid token",
  "invalid grant",
] as const;

// Status codes only count with HTTP context: bare "401"/"403" substrings match
// line numbers, durations, and ids in ordinary command output.
const AUTH_FAILURE_STATUS_PATTERNS = [
  /\b(?:http|status|code|error)\W{0,3}40[13]\b/i,
  /\b40[13]\s+(?:unauthorized|forbidden)\b/i,
  /\b(?:unauthorized|forbidden)\s*\(?40[13]\)?/i,
] as const;

/** Formats authentication state for display without probing the CLI. */
export function getAuthStateLabel(state: CodexAuthState): string {
  switch (state) {
    case "authenticated":
      return "Authenticated";
    case "unauthenticated":
      return "Signed out";
    case "checking":
      return "Checking";
    default:
      return "Unknown";
  }
}

/** Returns manual Codex sign-in instructions; does not change authentication. */
export function getLoginGuidance(): string {
  return [
    "Sign in to the Ubume neural network to continue.",
    "Run this in your terminal:",
    "  codex login",
    "",
    "If you were previously using API-key auth and want ChatGPT subscription auth:",
    "  codex logout",
    "  codex",
  ].join("\n");
}

/** Returns manual sign-out instructions; does not invoke logout. */
export function getLogoutGuidance(): string {
  return [
    "You are managing your Ubume sign-out state.",
    "Run this in your terminal:",
    "  codex logout",
    "",
    "After logging out, use /auth status in this UI to refresh state.",
  ].join("\n");
}

/** Formats a completed probe, including recovery guidance for unknown or signed-out states. */
export function getAuthStatusMessage(result: CodexAuthProbeResult): string {
  if (result.state === "authenticated") {
    return [
      "Ubume authentication looks healthy.",
      "State: Authenticated",
      `Summary: ${result.rawSummary}`,
    ].join("\n");
  }

  if (result.state === "unauthenticated") {
    return [
      "Ubume is currently signed out.",
      "State: Signed out",
      `Summary: ${result.rawSummary}`,
      "Recovery:",
      "  codex login",
    ].join("\n");
  }

  if (result.state === "checking") {
    return "Authentication check is currently running.";
  }

  return [
    "Ubume auth state is unknown. This can happen on unsupported neural versions.",
    `Summary: ${result.rawSummary}`,
    `Recommended action: ${result.recommendedAction}`,
  ].join("\n");
}

interface RunGateDecision {
  allowRun: boolean;
  blockMessage?: string;
  warningMessage?: string;
}

interface RunGateDecisionOptions {
  warnOnUnknown?: boolean;
}

/** Blocks signed-out runs; unknown/checking states remain runnable with an optional warning. */
export function getRunGateDecision(
  authState: CodexAuthState,
  options: RunGateDecisionOptions = {},
): RunGateDecision {
  if (authState === "unauthenticated") {
    return {
      allowRun: false,
      blockMessage: [
        "Run blocked: Ubume is signed out.",
        "Sign in first with your ChatGPT subscription:",
        "  codex login",
      ].join("\n"),
    };
  }

  if (authState === "unknown" || authState === "checking") {
    if (options.warnOnUnknown === false) {
      return { allowRun: true };
    }

    return {
      allowRun: true,
      warningMessage:
        "Auth state is unknown. Run is allowed, but if this fails, use `codex login` and try again.",
    };
  }

  return { allowRun: true };
}

/**
 * Interprets probe output, retaining the successful-exit compatibility rule and returning
 * unknown for ambiguous failures.
 */
export function inferAuthStateFromProbe(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): CodexAuthState {
  if (exitCode === 0) return "authenticated";

  const jsonState = inferAuthStateFromJson(stdout);
  if (jsonState) return jsonState;

  const output = `${stdout}\n${stderr}`.toLowerCase();

  if (UNAUTHENTICATED_PATTERNS.some((pattern) => output.includes(pattern))) {
    return "unauthenticated";
  }

  return "unknown";
}

/**
 * Recognizes explicit authentication failures; bare status-code digits are not sufficient
 * evidence.
 */
export function isLikelyAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    AUTH_FAILURE_PHRASES.some((phrase) => lower.includes(phrase)) ||
    AUTH_FAILURE_STATUS_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * Tries JSON then text login-status probes with bounded attempts. Missing or failing CLIs yield
 * an unknown state and manual recovery guidance.
 */
export async function probeCodexAuthStatus(
  options: { codexCommandPath?: string; cwd?: string; signal?: AbortSignal } = {},
): Promise<CodexAuthProbeResult> {
  const attempts: string[][] = [
    ["login", "status", "--json"],
    ["login", "status"],
  ];

  const summaries: string[] = [];

  for (let index = 0; index < attempts.length; index += 1) {
    const args = attempts[index]!;
    if (options.signal?.aborted) break;
    const result = await runCodexCommand(args, options);
    const summary = summarizeAttempt(args, result);
    summaries.push(summary);

    if (result.error) {
      if (isCodexUnavailableError(result.error)) {
        return {
          state: "unknown",
          checkedAt: Date.now(),
          rawSummary: summary,
          recommendedAction:
            "Set CODEX_EXECUTABLE to a working Codex command/path, restart Ubume, then run /auth status again.",
        };
      }

      continue;
    }

    const inferred = inferAuthStateFromProbe(result.exitCode, result.stdout, result.stderr);

    if (inferred === "authenticated" || inferred === "unauthenticated") {
      return {
        state: inferred,
        checkedAt: Date.now(),
        rawSummary: summary,
        recommendedAction: inferred === "authenticated" ? "None" : "Run `codex login` and retry.",
      };
    }
  }

  return {
    state: "unknown",
    checkedAt: Date.now(),
    rawSummary: summaries.join(" | "),
    recommendedAction: "If runs fail, sign in with `codex login`, then retry `/auth status`.",
  };
}

function inferAuthStateFromJson(raw: string): CodexAuthState | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;

    for (const key of JSON_STATUS_FLAGS) {
      const value = payload[key];
      if (typeof value === "boolean") {
        return value ? "authenticated" : "unauthenticated";
      }
    }

    const status = payload.status;
    if (typeof status === "string") {
      const lower = status.toLowerCase();
      // "unauthenticated" also contains "auth"; signed-out evidence takes precedence.
      if (lower.includes("unauth")) return "unauthenticated";
      if (lower.includes("signed_out")) return "unauthenticated";
      if (lower.includes("auth")) return "authenticated";
    }
  } catch {
    return null;
  }

  return null;
}

/** `configuredPath` is the provider's configured executable; it is never replaced by PATH. */
async function runCodexCommand(
  args: string[],
  options: { codexCommandPath?: string; cwd?: string; signal?: AbortSignal },
): Promise<CommandResult> {
  try {
    const cwd = options.cwd ?? process.cwd();
    const executable = await resolveCodexExecutable({
      configuredPath: options.codexCommandPath,
      cwd,
    });
    if (options.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", timedOut: false };
    const spec = buildSpawnSpec(executable, args);
    const runner = runCommand({
      ...spec,
      cwd,
      signal: options.signal,
      timeoutMs: 6000,
      capture: { maxChars: 64 * 1024 },
    });
    const result = await runner.result;
    await runner.stopped;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.status === "timeout",
      ...(result.status === "spawn_error"
        ? { error: Object.assign(new Error(result.debugMessage), { code: result.errorCode }) }
        : {}),
    };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    return {
      exitCode: null,
      stdout: "",
      stderr: formatCodexLaunchError(errno),
      timedOut: false,
      error: errno,
    };
  }
}

function summarizeAttempt(args: string[], result: CommandResult): string {
  const status =
    result.error?.code ?? (result.timedOut ? "timeout" : `exit:${result.exitCode ?? "null"}`);

  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join(" | ");
  const output = combined.length > 140 ? `${combined.slice(0, 137)}...` : combined || "no output";

  return `[${args.join(" ")}] ${status} - ${output}`;
}

function isCodexUnavailableError(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM";
}
