/**
 * Read-only inspection commands: `config`, `providers`, `status`, `doctor`, `models`, and
 * (via `sessionCommands.ts`) `sessions`.
 *
 * These commands never submit a model prompt and never write to the workspace or the
 * data dir (stores are opened read-only), so they are safe in CI and alongside a running
 * TUI. The one write is `models --refresh`, which persists a verified inventory to the
 * shared model cache exactly as an interactive refresh does. Provider route resolution
 * runs in `inspect` mode, so a broken setup can still be inspected.
 *
 * Every inspection command accepts `--json`, `--cwd DIR` and `--help`. Command-specific
 * options are listed in {@link COMMAND_OPTIONS}. Unknown commands go through the same
 * pipeline and fail last with `Unknown command`, after their options, workspace and
 * arguments have been validated.
 */
import type { LaunchArgs } from "../config/launchArgs.js";
import { resolveLocalBackend } from "../core/providerLauncher/localBackend.js";
import { isKnownProviderId } from "../core/providerLauncher/registry.js";
import { discoverLocalModels } from "../core/providerRuntime/local.js";
import {
  discoverProviderModels,
  getProviderRuntime,
  refreshProviderModels,
} from "../core/providerRuntime/registry.js";
import { getAppVersion } from "../core/version/channel.js";
import {
  resolveUbumeConversationDir,
  resolveUbumeWorkspaceDataDir,
} from "../core/workspace/appData.js";
import { pendingFileRecoveries } from "../core/workspace/checkpoints.js";
import { ConversationStore } from "../core/workspace/conversationStore.js";
import { inspectOwnership } from "../core/workspace/ownership.js";
import {
  type CommandEnv,
  type CommandOutcome,
  commandWorkspace,
  EXIT_CODE,
  resultOutcome,
  usageError,
} from "./commandResult.js";
import { type HeadlessExecutionContext, resolveExecutionContext } from "./context.js";
import { type DiagnosticCheck, doctor, listProviderStatus } from "./diagnostics.js";
import { providerSecrets } from "./redact.js";
import { hasPendingRestore, runSessionsCommand } from "./sessionCommands.js";

/** Options accepted by every inspection command. */
const COMMON_OPTIONS = ["--json", "--cwd", "--help", "-h"];
/** Command-specific options. */
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  doctor: ["--probe"],
  models: ["--provider", "--refresh"],
  sessions: ["--turn", "--file"],
};
/** Options that take a value (`--name value` or `--name=value`); every other option is a flag. */
const VALUE_OPTIONS = new Set(["--cwd", "--provider", "--turn", "--file"]);

/** Parsed inspection arguments. */
export interface InspectionArgs {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

/**
 * Parses the arguments after an inspection command name.
 *
 * @throws {CommandError} `USAGE` for an option the command does not accept, a value
 *   option without a value (or whose value looks like `--…`), or `--flag=value` on a flag.
 */
export function parseInspectionArgs(command: string, argv: readonly string[]): InspectionArgs {
  const allowed = new Set([...COMMON_OPTIONS, ...(COMMAND_OPTIONS[command] ?? [])]);
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    const name = arg.split("=")[0]!;
    if (!allowed.has(name)) throw usageError(`Unknown option: ${name}`);

    if (VALUE_OPTIONS.has(name)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
      if (!value || value.startsWith("--")) throw usageError(`Missing value for ${name}.`);
      values.set(name, value);
    } else {
      if (arg.includes("=")) throw usageError(`Unexpected value for ${name}.`);
      flags.add(name);
    }
  }
  return { positional, values, flags };
}

/** Inspection never applies CLI config overrides; it reports the configured state. */
function defaultLaunchArgs(): LaunchArgs {
  return {
    help: false,
    version: false,
    initialPrompt: null,
    profile: null,
    configOverrides: [],
    passthroughArgs: [],
    modelOverride: null,
    noClear: false,
  };
}

interface InspectionScope {
  workspace: string;
  dataRoot: string;
  store: ConversationStore;
  context: HeadlessExecutionContext;
  args: InspectionArgs;
}

async function statusCommand({ workspace, dataRoot, store, context }: InspectionScope) {
  return resultOutcome({
    version: getAppVersion(),
    workspace,
    route: context.route,
    storage: dataRoot,
    chatStorage: resolveUbumeConversationDir(workspace),
    execution: inspectOwnership(workspace, "execution"),
    pendingRecoverySessions: await pendingFileRecoveries(workspace),
    sessions: store.list().map((session) => ({
      id: session.id,
      ownership: inspectOwnership(workspace, session.id),
      pendingRecovery: hasPendingRestore(dataRoot, session.id),
    })),
  });
}

/**
 * Runs the `doctor` checks, then appends rows for pending file recovery and for config
 * layers that failed to load. Exits 1 if any check failed.
 */
async function doctorCommand({ workspace, context, args }: InspectionScope) {
  const checks: DiagnosticCheck[] = await doctor(
    workspace,
    context.config,
    context.route.providerId,
    args.flags.has("--probe"),
  );

  const pending = await pendingFileRecoveries(workspace);
  if (pending.length) {
    checks.push({
      name: "recovery",
      status: "fail",
      message: `Pending file recovery: resume ${pending.join(", ")}.`,
    });
  }
  for (const layer of context.layered.diagnostics.layers) {
    if (layer.status === "error" || layer.status === "blocked") {
      checks.push({
        name: `config:${layer.label}`,
        status: layer.status === "error" ? "fail" : "warn",
        message: layer.reason ?? layer.status,
      });
    }
  }

  return resultOutcome(
    { workspace, checks },
    {
      exitCode: checks.some((check) => check.status === "fail") ? EXIT_CODE.FAILED : EXIT_CODE.OK,
      human: checks
        .map((check) => `${check.status.toUpperCase().padEnd(7)} ${check.name}: ${check.message}`)
        .join("\n"),
    },
  );
}

/**
 * Lists models for `--provider` (default: the routed provider). `--refresh` rediscovers
 * the list through the shared catalog, with the same provider configuration (executable,
 * endpoint, key, Local backend), deadline, cancellation and cache persistence as an
 * interactive refresh. Exits 3 unless the list is ready and, when refreshed, verified.
 */
async function modelsCommand({ workspace, context, args }: InspectionScope, env: CommandEnv) {
  const id = args.values.get("--provider") ?? context.route.providerId;
  if (!isKnownProviderId(id)) throw usageError(`Unknown provider: ${id}`);

  const localConfig = context.config.providers?.local;
  // The routed Local backend applies only when Local is the routed provider.
  const localBackend = resolveLocalBackend(
    context.config,
    context.route.providerId === "local" ? context.route.localBackend : undefined,
  );
  const refresh = args.flags.has("--refresh") && !!getProviderRuntime(id).refreshModels;
  let result: Awaited<ReturnType<typeof discoverProviderModels>>;
  if (refresh) {
    result = await refreshProviderModels(id, {
      cwd: workspace,
      providerConfig:
        id === "openai"
          ? {
              ...context.config.providers?.openai,
              codexCommandPath:
                context.config.providers?.openai?.codexCommandPath ??
                context.runtime.codexCommandPath,
            }
          : context.config.providers?.[id],
      ...(id === "local" ? { localConfig, localBackend } : {}),
      signal: env.signal,
      forceRefresh: true,
    });
    env.signal?.throwIfAborted();
  } else if (id === "local") {
    result = discoverLocalModels(localConfig, localBackend);
  } else {
    result = discoverProviderModels(id);
  }
  const ready = result.status === "ready" && (!refresh || result.freshness === "verified");
  return resultOutcome(result, { exitCode: ready ? EXIT_CODE.OK : EXIT_CODE.UNAVAILABLE });
}

/**
 * Runs an inspection command, or fails with `Unknown command` if `command` is not one.
 *
 * Validation order is part of the contract, because it decides which error a script
 * sees: options → `--help` → workspace → (`sessions` dispatch) → stray positional
 * arguments → route resolution → command name.
 *
 * Registers the configured provider API keys in `env.secrets` before running any
 * handler, so that redaction also covers errors thrown afterwards.
 */
export async function runInspectionCommand(
  command: string,
  argv: readonly string[],
  env: CommandEnv,
): Promise<CommandOutcome> {
  const args = parseInspectionArgs(command, argv);
  if (args.flags.has("--help") || args.flags.has("-h")) return env.helpOutcome();

  const workspace = commandWorkspace(args.values.get("--cwd"));
  const dataRoot = resolveUbumeWorkspaceDataDir(workspace, { readOnly: true });
  const store = new ConversationStore(workspace, {
    onDiagnostic: (message) => env.io.stderr.write(`${message}\n`),
  });
  if (command === "sessions") return runSessionsCommand({ workspace, dataRoot, store, args });

  if (args.positional.length) throw usageError(`Unexpected arguments for ${command}.`);
  const context = resolveExecutionContext(workspace, defaultLaunchArgs(), { inspect: true });
  env.secrets.push(...providerSecrets(context.config));
  const scope: InspectionScope = { workspace, dataRoot, store, context, args };

  switch (command) {
    case "config":
      return resultOutcome({
        runtime: context.runtime,
        providers: context.config,
        diagnostics: context.layered.diagnostics,
      });
    case "providers":
      return resultOutcome(listProviderStatus(context.config, workspace));
    case "status":
      return statusCommand(scope);
    case "doctor":
      return doctorCommand(scope);
    case "models":
      return modelsCommand(scope, env);
    default:
      throw usageError(`Unknown command: ${command}`);
  }
}
