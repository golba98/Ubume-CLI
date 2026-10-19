/**
 * Resolves which provider, model and runtime a headless command runs with.
 *
 * This is the headless counterpart of the TUI's provider/model selection. It reads the
 * same persisted state: the layered TOML config, `providers.json` and the saved
 * conversation. It adds the CLI flags on top. Sessions move between the TUI and
 * headless runs, so precedence changes are compatibility changes.
 *
 * Provider selection precedence: `--provider` → the resumed session's provider →
 * the workspace's active route → the workspace default → `openai`.
 *
 * `providers.json` is always opened read-only: a headless run never rewrites the
 * workspace's provider selection.
 */
import type { LaunchArgs } from "../config/launchArgs.js";
import { type LayeredConfigResult, resolveLayeredConfig } from "../config/layeredConfig.js";
import {
  mergeRuntimeConfig,
  type ResolvedRuntimeConfig,
  resolveRuntimeConfig,
} from "../config/runtimeConfig.js";
import { findExecutable } from "../core/executables/executableResolver.js";
import {
  LEGACY_GOOGLE_MESSAGE,
  resolveProviderIdentity,
} from "../core/providerLauncher/providerIdentity.js";
import { isKnownProviderId } from "../core/providerLauncher/registry.js";
import type { ProviderId, ProviderWorkspaceConfig } from "../core/providerLauncher/types.js";
import { loadProviderWorkspaceConfig } from "../core/providerLauncher/workspaceConfig.js";
import { resolveAnthropicExecutionBackend } from "../core/providerRuntime/anthropic.js";
import {
  createRoutedProvider,
  effectiveProviderRuntime,
  getDefaultRouteModel,
  getProviderRuntime,
  isProviderRoutableInUbume,
} from "../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../core/providerRuntime/types.js";
import { getBackendProvider } from "../core/providers/registry.js";
import type { BackendProvider } from "../core/providers/types.js";
import type { ConversationRecord } from "../core/workspace/conversationStore.js";
import { buildResumedProviderRoute } from "../session/conversation.js";
import { CommandError, EXIT_CODE } from "./commandResult.js";
import { providerExecutable } from "./diagnostics.js";

// Compatibility re-exports: CommandError moved to commandResult.ts.
export { CommandError, EXIT_CODE };

/** Everything a headless run needs, resolved once and shared by the saved-exec and runner layers. */
export interface HeadlessExecutionContext {
  layered: LayeredConfigResult;
  /** Read-only snapshot of the workspace's `providers.json`. */
  config: ProviderWorkspaceConfig;
  route: ProviderRoute;
  /** Runtime config with the route's model/reasoning and provider overrides applied; plan mode off. */
  runtime: ResolvedRuntimeConfig;
  /** Backend wrapped for the route; reads session metadata lazily from the saved record. */
  provider: BackendProvider;
}

export interface ResolveExecutionContextOptions {
  /** Explicit `--provider`, which overrides the saved route and the Google migration guard. */
  providerId?: string;
  /** The conversation being resumed, if any. */
  saved?: ConversationRecord;
  /**
   * Inspection mode, used by `status`/`config`/`doctor`/`models`: resolve the route but
   * skip every execution-readiness check, so a broken setup can still be inspected.
   */
  inspect?: boolean;
}

function isSavedProviderResolvable(saved: ConversationRecord): boolean {
  return !!resolveProviderIdentity(saved.metadata.providerId, saved.metadata.backendKind);
}

/**
 * Picks the provider id, following the precedence in the module header. The result
 * may be unknown (e.g. an id from a newer Ubume); the caller validates it.
 */
function selectProviderId(
  config: ProviderWorkspaceConfig,
  options: ResolveExecutionContextOptions,
): string {
  const explicit = options.providerId
    ? resolveProviderIdentity(options.providerId, undefined, true)
    : undefined;
  const saved = options.saved
    ? resolveProviderIdentity(options.saved.metadata.providerId, options.saved.metadata.backendKind)
    : undefined;
  return (
    explicit ??
    saved ??
    config.activeRoute?.providerId ??
    config.workspaceDefaultProviderId ??
    "openai"
  );
}

/**
 * Builds the route (provider, model, backend, reasoning, local backend).
 *
 * Model precedence: an explicit `--model` or `-c model=…` → the saved route → the
 * workspace route → the provider's `currentModel` → the provider default.
 * Reasoning follows the same chain, with `-c model_reasoning_effort=…` taking priority.
 * Google takes no reasoning default, and an explicit Google model clears inherited
 * reasoning, because AGY models carry their own effort.
 * Claude uses provider-managed effort when no Claude preference was selected.
 */
function buildProviderRoute(
  selectedId: ProviderId,
  base: ResolvedRuntimeConfig,
  config: ProviderWorkspaceConfig,
  launchArgs: LaunchArgs,
  savedRoute: ProviderRoute | undefined,
  fallbackBackendKind: ProviderRoute["backendKind"],
): ProviderRoute {
  const workspaceRoute =
    config.activeRoute?.providerId === selectedId ? config.activeRoute : undefined;
  const override = config.providers?.[selectedId];
  const modelExplicit =
    launchArgs.modelOverride !== null ||
    launchArgs.configOverrides.some((item) => /^model\s*=/.test(item));
  const reasoningExplicit = launchArgs.configOverrides.some((item) =>
    /^model_reasoning_effort\s*=/.test(item),
  );
  const isGoogle = selectedId === "google";

  const modelId = modelExplicit
    ? base.model
    : (savedRoute?.modelId ??
      workspaceRoute?.modelId ??
      override?.currentModel ??
      getDefaultRouteModel(selectedId, base.model));

  let reasoning: ProviderRoute["reasoning"];
  if (reasoningExplicit) reasoning = base.reasoningLevel;
  else if (modelExplicit && isGoogle) reasoning = undefined;
  else
    reasoning =
      savedRoute?.reasoning ??
      workspaceRoute?.reasoning ??
      override?.currentReasoning ??
      (isGoogle || selectedId === "anthropic" ? undefined : base.reasoningLevel);

  return {
    providerId: selectedId,
    modelId,
    backendKind: savedRoute?.backendKind ?? fallbackBackendKind,
    reasoning,
    ...(selectedId === "local"
      ? {
          localBackend:
            savedRoute?.localBackend ??
            workspaceRoute?.localBackend ??
            override?.localBackend ??
            "lm-studio",
        }
      : {}),
  };
}

/**
 * Fails fast if the provider CLI is missing, so the user sees an actionable message
 * instead of a spawn error mid-run. An Anthropic route that will execute through the
 * Messages API (a configured `apiKey` or `ANTHROPIC_API_KEY`) needs no Claude executable;
 * readiness follows the same transport choice as `run()`.
 */
function assertExecutableAvailable(
  selectedId: ProviderId,
  route: ProviderRoute,
  runtime: ResolvedRuntimeConfig,
  config: ProviderWorkspaceConfig,
  workspaceRoot: string,
  label: string,
): void {
  const command =
    selectedId === "openai"
      ? (runtime.codexCommandPath ?? providerExecutable(selectedId, config))
      : providerExecutable(selectedId, config);
  if (!command || findExecutable(command, workspaceRoot)) return;
  if (
    selectedId === "anthropic" &&
    resolveAnthropicExecutionBackend(route, config.providers?.anthropic) === "anthropic-api-key"
  )
    return;
  throw new CommandError(
    `${label} executable is unavailable: ${command}. Install it or configure its explicit path.`,
  );
}

/**
 * Resolves the provider route and runtime for a headless command. This performs no
 * writes, and only spawns or contacts something if a provider's model discovery does.
 *
 * Execution-readiness checks run in a fixed order (skipped in `inspect` mode), so the
 * first problem the user must fix is the one reported:
 * 1. a legacy Google selection that needs migration (`MIGRATION_REQUIRED`, exit 3);
 * 2. an unknown provider;
 * 3. a saved provider that no longer resolves;
 * 4. a provider that is not routable, cannot run, or is disabled;
 * 5. an older Local chat with no recorded backend;
 * 6. a missing provider executable.
 *
 * Checks 2 and 3 also apply in `inspect` mode.
 *
 * @throws {CommandError} with exit code 3 for every condition above.
 */
export function resolveExecutionContext(
  workspaceRoot: string,
  launchArgs: LaunchArgs,
  options: ResolveExecutionContextOptions = {},
): HeadlessExecutionContext {
  const { saved, inspect } = options;
  const explicitProvider = !!options.providerId;
  const layered = resolveLayeredConfig({ workspaceRoot, launchArgs });
  const config = loadProviderWorkspaceConfig(workspaceRoot, { readOnly: true });
  // Headless runs cannot stop for plan review, so plan mode is always off.
  const base = resolveRuntimeConfig(mergeRuntimeConfig(layered.runtime, { planMode: false }));

  const legacyGoogleSelection =
    config.googleMigrationRequired ||
    (saved?.metadata.providerId === "google" && !isSavedProviderResolvable(saved));
  if (!inspect && !explicitProvider && legacyGoogleSelection) {
    throw new CommandError(LEGACY_GOOGLE_MESSAGE, EXIT_CODE.UNAVAILABLE, "MIGRATION_REQUIRED");
  }

  const selectedId = selectProviderId(config, options);
  if (!isKnownProviderId(selectedId)) {
    throw new CommandError(
      `Unknown saved or selected provider: ${selectedId}. Select a supported provider explicitly.`,
    );
  }
  if (saved && !explicitProvider && !isSavedProviderResolvable(saved)) {
    throw new CommandError(
      "The saved provider is unavailable. Select a supported provider explicitly.",
    );
  }

  const provider = getProviderRuntime(selectedId);
  const runnable =
    isProviderRoutableInUbume(selectedId) &&
    !!provider.run &&
    config.providers?.[selectedId]?.enabled !== false;
  if (!inspect && !runnable) {
    throw new CommandError(
      `${provider.label} is unavailable for execution. ${provider.routeSetupMessage ?? provider.routeStatus}`,
    );
  }
  if (
    !inspect &&
    !explicitProvider &&
    saved?.metadata.providerId === "local" &&
    !saved.metadata.localBackend
  ) {
    throw new CommandError(
      "This older Local chat has no recorded backend. Select a Local backend explicitly before continuing.",
    );
  }

  const savedRoute =
    saved && !explicitProvider
      ? buildResumedProviderRoute(saved.metadata, selectedId, provider.backendKind)
      : undefined;
  const route = buildProviderRoute(
    selectedId,
    base,
    config,
    launchArgs,
    savedRoute,
    provider.backendKind,
  );
  const runtime = effectiveProviderRuntime(base, config, route);
  if (!inspect) {
    assertExecutableAvailable(selectedId, route, runtime, config, workspaceRoot, provider.label);
  }

  return {
    layered,
    config,
    route,
    runtime,
    provider: createRoutedProvider(
      route,
      getBackendProvider(runtime.provider),
      // An explicit --provider is a deliberate choice, so the routed provider must not
      // re-apply the legacy-Google block that the selection already bypassed.
      explicitProvider ? { ...config, googleMigrationRequired: undefined } : config,
      // Getters, not values: savedExec updates these fields during the run.
      () => saved?.metadata.localHarnessSession,
      () => saved?.metadata.nativeSessions,
    ),
  };
}
