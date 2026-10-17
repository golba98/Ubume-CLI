/**
 * Local setup diagnostics behind `ubume providers` and `ubume doctor`.
 *
 * Nothing here submits a model prompt. Without `--probe`, the checks only inspect the
 * filesystem and run `--version` / `git rev-parse`. With `--probe`, they also run each
 * provider CLI's own auth-status command, request the Local endpoint's `/models`, and
 * call `git ls-remote`. Every subprocess and network call has an 8-second timeout and
 * runs with Git's credential prompts disabled, so diagnostics cannot hang waiting for a
 * human.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHomeDir } from "../config/settings.js";
import { buildSpawnSpec, findExecutable } from "../core/executables/executableResolver.js";
import { runCommand } from "../core/process/commandRunner.js";
import { getProviderOrder } from "../core/providerLauncher/registry.js";
import type { ProviderId, ProviderWorkspaceConfig } from "../core/providerLauncher/types.js";
import { resolveLocalProviderConfig } from "../core/providerRuntime/local.js";
import { getProviderRuntime, isProviderRoutableInUbume } from "../core/providerRuntime/registry.js";
import type { ProviderBackendKind } from "../core/providerRuntime/types.js";
import { resolveUbumeWorkspaceDataDir } from "../core/workspace/appData.js";

// Compatibility re-export: redact moved to redact.ts.
export { redact } from "./redact.js";

const DIAGNOSTIC_TIMEOUT_MS = 8000;

/** One `doctor` result row. A `fail` anywhere makes `doctor` exit 1. */
export interface DiagnosticCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skipped";
  message: string;
}

/** One `ubume providers` row. The field names are part of the `--json` contract. */
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  backendKind: ProviderBackendKind;
  routable: boolean;
  /** Resolved absolute path, or null when the executable is not found. */
  executable: string | null;
  configured: boolean;
  /** Describes which credentials are present locally; they are never verified here. */
  auth: string;
}

/**
 * The CLI command a provider is launched with: the configured override, else the
 * provider's `*_EXECUTABLE` environment variable, else the conventional binary name.
 * Returns null for providers that need no executable (Local).
 */
export function providerExecutable(id: ProviderId, config: ProviderWorkspaceConfig): string | null {
  const override = config.providers?.[id];
  switch (id) {
    case "openai":
      return override?.codexCommandPath ?? process.env.CODEX_EXECUTABLE ?? "codex";
    case "anthropic":
      return override?.claudeCommandPath ?? process.env.CLAUDE_EXECUTABLE ?? "claude";
    case "google":
      return override?.antigravityCommandPath ?? process.env.AGY_EXECUTABLE ?? "agy";
    case "mistral":
      return typeof override?.command === "string"
        ? override.command
        : (override?.command?.executable ?? process.env.VIBE_EXECUTABLE ?? "vibe");
    default:
      return null;
  }
}

/** Runs a short, non-interactive diagnostic subprocess and waits for it to be torn down. */
async function diagnosticCommand(executable: string, args: string[], cwd: string) {
  const runner = runCommand({
    ...buildSpawnSpec(executable, args),
    cwd,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  const result = await runner.result;
  await runner.stopped;
  return result;
}

function isProviderConfigured(
  id: ProviderId,
  config: ProviderWorkspaceConfig,
  command: string | null,
  executable: string | null,
): boolean {
  if (id === "local")
    return !!(config.providers?.local?.baseUrl || process.env.UBUME_LOCAL_BASE_URL);
  // Claude Code can run from an API key alone, without a local executable.
  if (id === "anthropic") return !!executable || !!process.env.ANTHROPIC_API_KEY;
  if (command) return !!executable;
  return getProviderRuntime(id).isRouteConfigured?.() ?? false;
}

function describeLocalAuth(id: ProviderId): string {
  if (id === "anthropic" && process.env.ANTHROPIC_API_KEY) return "API key present (unverified)";
  if (id === "openai") {
    const codexHome = process.env.CODEX_HOME ?? join(getHomeDir(), ".codex");
    if (existsSync(join(codexHome, "auth.json"))) return "Auth file present (unverified)";
  }
  return "Not checked; use doctor --probe";
}

/**
 * Lists every provider in display order with its local availability. Only the
 * filesystem and environment are inspected; nothing is spawned or contacted.
 */
export function listProviderStatus(config: ProviderWorkspaceConfig, cwd: string): ProviderStatus[] {
  return getProviderOrder().map((id) => {
    const runtime = getProviderRuntime(id);
    const command = providerExecutable(id, config);
    const executable = command ? findExecutable(command, cwd) : null;
    return {
      id,
      label: runtime.label,
      backendKind: runtime.backendKind,
      routable: isProviderRoutableInUbume(id) && config.providers?.[id]?.enabled !== false,
      executable,
      configured: isProviderConfigured(id, config, command, executable),
      auth: describeLocalAuth(id),
    };
  });
}

function storageCheck(workspace: string): DiagnosticCheck {
  const storage = resolveUbumeWorkspaceDataDir(workspace, { readOnly: true });
  // The data dir may not exist yet. Check that the nearest existing ancestor is
  // writable, without creating anything.
  let parent = storage;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  try {
    accessSync(parent, constants.R_OK | constants.W_OK);
    return {
      name: "storage",
      status: "pass",
      message: `${storage} (nearest existing directory is accessible)`,
    };
  } catch {
    return {
      name: "storage",
      status: "fail",
      message: `Session storage is unavailable: ${storage}`,
    };
  }
}

/**
 * Runs the auth or connectivity probe for the selected provider (only with `--probe`).
 * Returns zero or more checks: Local can report a pass and then a failure if the
 * connection fails while it is being released.
 */
async function probeProviderAuth(
  provider: ProviderStatus,
  config: ProviderWorkspaceConfig,
  workspace: string,
): Promise<DiagnosticCheck[]> {
  if (provider.id === "openai" || provider.id === "anthropic") {
    if (provider.id === "anthropic" && process.env.ANTHROPIC_API_KEY && !provider.executable) {
      return [
        {
          name: "auth:anthropic",
          status: "skipped",
          message: "API key present; no non-inference auth endpoint available.",
        },
      ];
    }
    if (!provider.executable) return [];

    const auth = await diagnosticCommand(
      provider.executable,
      provider.id === "openai" ? ["login", "status"] : ["auth", "status", "--json"],
      workspace,
    );
    let loggedIn = auth.exitCode === 0;
    if (provider.id === "anthropic") {
      try {
        loggedIn = loggedIn && JSON.parse(auth.stdout).loggedIn !== false;
      } catch {
        /* Older CLI returns plain text. */
      }
    }
    return [
      {
        name: `auth:${provider.id}`,
        status: loggedIn ? "pass" : "fail",
        message: loggedIn
          ? "Authentication status command succeeded."
          : "Authentication unavailable; use the provider CLI to sign in.",
      },
    ];
  }

  if (provider.id === "local") {
    const checks: DiagnosticCheck[] = [];
    const local = resolveLocalProviderConfig(config.providers?.local);
    try {
      const response = await fetch(`${local.baseUrl.replace(/\/$/, "")}/models`, {
        signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${local.apiKey}` },
      });
      checks.push({
        name: "connectivity:local",
        status: response.ok ? "pass" : "fail",
        message: `Models endpoint returned HTTP ${response.status}.`,
      });
      // Release the connection; only the status code matters.
      await response.body?.cancel();
    } catch {
      checks.push({
        name: "connectivity:local",
        status: "fail",
        message: "Models endpoint could not be reached within 8 seconds.",
      });
    }
    return checks;
  }

  return [
    {
      name: `auth:${provider.id}`,
      status: "skipped",
      message: "No non-inference auth probe supported.",
    },
  ];
}

/**
 * Availability, version and (when probing) auth checks for every provider. Problems
 * with the selected provider are failures; problems with any other provider are only
 * warnings.
 */
async function providerChecks(
  workspace: string,
  config: ProviderWorkspaceConfig,
  selected: ProviderId,
  probe: boolean,
): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  for (const provider of listProviderStatus(config, workspace)) {
    const required = provider.id === selected;
    const usable = provider.routable && (provider.configured || provider.id === "local");
    const target =
      provider.executable ??
      (provider.id === "local"
        ? "OpenAI-compatible endpoint"
        : "executable/configuration unavailable");
    checks.push({
      name: `provider:${provider.id}`,
      status: usable ? "pass" : required ? "fail" : "warn",
      message: `${provider.label}: ${target}; ${provider.auth}`,
    });

    if (provider.executable) {
      const version = await diagnosticCommand(provider.executable, ["--version"], workspace);
      checks.push({
        name: `version:${provider.id}`,
        status: version.exitCode === 0 ? "pass" : required ? "fail" : "warn",
        message:
          version.exitCode === 0
            ? (version.stdout.trim().split("\n")[0] ?? "Available")
            : version.userMessage,
      });
    }

    if (!probe || !required) continue;
    checks.push(...(await probeProviderAuth(provider, config, workspace)));
  }
  return checks;
}

/** Git repository state; when probing, also whether `origin` is reachable. Skipped if Git is absent. */
async function gitChecks(workspace: string, probe: boolean): Promise<DiagnosticCheck[]> {
  const git = findExecutable("git", workspace);
  if (!git) return [];

  const result = await diagnosticCommand(git, ["rev-parse", "--absolute-git-dir"], workspace);
  if (result.exitCode !== 0) {
    return [{ name: "git", status: "warn", message: "Workspace is not a Git repository." }];
  }

  const gitDir = result.stdout.trim();
  const locked = existsSync(join(gitDir, "index.lock"));
  const checks: DiagnosticCheck[] = [
    {
      name: "git",
      status: locked ? "warn" : "pass",
      message: locked
        ? "Git index lock exists."
        : `Repository: ${gitDir}; no write test performed.`,
    },
  ];
  if (probe) {
    const remote = await diagnosticCommand(git, ["ls-remote", "origin", "HEAD"], workspace);
    checks.push({
      name: "git:remote",
      status: remote.exitCode === 0 ? "pass" : "warn",
      message: remote.exitCode === 0 ? "Origin is reachable." : "Origin unavailable or absent.",
    });
  }
  return checks;
}

/**
 * Runs the `doctor` checks, in this order: runtime, workspace, storage, providers,
 * network/auth note, git.
 *
 * @param selected - The routed provider. Its failures are `fail`; other providers' are `warn`.
 * @param probe - Also run the auth, connectivity and git-remote probes.
 * @returns The checks; callers may append more (the command adds recovery and config rows).
 */
export async function doctor(
  workspace: string,
  config: ProviderWorkspaceConfig,
  selected: ProviderId,
  probe: boolean,
): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [
    { name: "runtime", status: "pass", message: `Bun ${process.versions.bun ?? "unknown"}` },
  ];
  try {
    accessSync(workspace, constants.R_OK);
    checks.push({ name: "workspace", status: "pass", message: workspace });
  } catch {
    checks.push({ name: "workspace", status: "fail", message: "Workspace cannot be read." });
  }
  checks.push(storageCheck(workspace));
  checks.push(...(await providerChecks(workspace, config, selected, probe)));
  if (!probe) {
    checks.push({
      name: "network/auth",
      status: "skipped",
      message: "Use --probe for connectivity/auth checks. No model prompt is submitted.",
    });
  }
  checks.push(...(await gitChecks(workspace, probe)));
  return checks;
}
