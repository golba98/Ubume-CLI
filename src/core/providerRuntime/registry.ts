import type { ResolvedRuntimeConfig } from "../../config/runtimeConfig.js";
import {
  getCodexModelCapabilities,
  isVerifiedCodexModelCapabilities,
} from "../models/codexModelCapabilities.js";
import {
  loadCachedProviderModels,
  loadSeededOpenAiModels,
  saveCachedProviderModels,
} from "../models/modelCache.js";
import { type CatalogContext, providerCatalog } from "../models/modelCatalog.js";
import { isCatalogModelUnavailable, resolveCatalogModel } from "../models/modelSelection.js";
import { reconcileReasoning } from "../models/reasoningControl.js";
import { LEGACY_GOOGLE_MESSAGE } from "../providerLauncher/providerIdentity.js";
import type {
  ProviderActiveRoute,
  ProviderId,
  ProviderWorkspaceConfig,
  ProviderWorkspaceOverride,
} from "../providerLauncher/types.js";
import { codexSubprocessProvider } from "../providers/codexSubprocess.js";
import type { BackendProvider, BackendRunHandlers } from "../providers/types.js";
import { isLocalDevChannel } from "../version/channel.js";
import type {
  LocalHarnessSessionMetadata,
  NativeSessionReference,
} from "../workspace/conversationStore.js";
import { anthropicRuntime } from "./anthropic.js";
import { antigravityRuntime, getAgyModelSelector } from "./antigravity.js";
import { CODEXA_NATIVE_MODEL_ID, codexaCupyRuntime, codexaNativeRuntime } from "./codexaNative.js";
import { classifyProviderFailure, isModelFailure, type ProviderFailure } from "./failures.js";
import { localRuntime } from "./local.js";
import { mistralVibeRuntime } from "./mistralVibe.js";
import { ANTHROPIC_FALLBACK_MODELS } from "./models.js";
import type {
  ActiveProviderRoute,
  ProviderChatRequest,
  ProviderModelDiscoveryResult,
  ProviderRoute,
  ProviderRouteValidationResult,
  ProviderRuntime,
} from "./types.js";

const openAiRuntime: ProviderRuntime = {
  providerId: "openai",
  label: "OpenAI/Codex",
  backendKind: "codex-cli-auth",
  routeAvailable: true,
  routeStatus: "Uses the configured Codex/OpenAI backend inside Ubume.",
  launchAvailable: true,
  discoverModels: () => ({
    status: "ready",
    providerId: "openai",
    backendKind: "codex-cli-auth",
    models: loadSeededOpenAiModels()?.models ?? [],
  }),
  refreshModels: async ({ providerConfig, signal }) => {
    const capabilities = await getCodexModelCapabilities({
      forceRefresh: true,
      executable: providerConfig?.codexCommandPath,
      signal,
    });
    const verified = isVerifiedCodexModelCapabilities(capabilities);
    return {
      status: "ready",
      providerId: "openai",
      backendKind: "codex-cli-auth",
      freshness: verified ? "verified" : "unverified",
      complete: verified,
      models: capabilities.models
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.id,
          modelId: model.model,
          label: model.label,
          description: model.description,
          defaultReasoningLevel: model.defaultReasoningLevel,
          supportedReasoningLevels: model.supportedReasoningLevels,
          source: verified ? "discovered" : "fallback",
        })),
      message:
        capabilities.error ??
        (verified
          ? undefined
          : "Cached Codex inventory is unverified after live discovery failed."),
    };
  },
  run: (request: ProviderChatRequest, handlers: BackendRunHandlers) => {
    handlers.onProgress?.({
      id: "openai-route",
      source: "stdout",
      text: "Starting Codex CLI",
    });
    return codexSubprocessProvider.run!(
      request.prompt,
      {
        runtime: request.runtime,
        workspaceRoot: request.workspaceRoot,
        projectInstructions: request.projectInstructions,
        promptPolicy: request.promptPolicy,
        conversationHistory: request.conversationHistory,
        imageAttachments: request.imageAttachments,
      },
      handlers,
    );
  },
};

const PROVIDER_RUNTIMES: Record<ProviderId, ProviderRuntime> = {
  openai: openAiRuntime,
  anthropic: anthropicRuntime,
  google: antigravityRuntime,
  mistral: mistralVibeRuntime,
  local: localRuntime,
  "codexa-native": codexaNativeRuntime,
  "codexa-cupy": codexaCupyRuntime,
};

export function getProviderRuntime(providerId: ProviderId): ProviderRuntime {
  return PROVIDER_RUNTIMES[providerId];
}

export function isProviderRoutableInUbume(
  providerId: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((providerId === "codexa-native" || providerId === "codexa-cupy") && !isLocalDevChannel(env)) {
    return false;
  }
  return getProviderRuntime(providerId).routeAvailable;
}

export function isProviderRouteConfigured(
  providerId: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const runtime = getProviderRuntime(providerId);
  return isProviderRoutableInUbume(providerId, env) && (runtime.isRouteConfigured?.() ?? true);
}

export function getProviderRouteSetupMessage(providerId: ProviderId): string {
  const runtime = getProviderRuntime(providerId);
  return runtime.routeSetupMessage ?? runtime.routeStatus;
}

export function discoverProviderModels(providerId: ProviderId): ProviderModelDiscoveryResult {
  const snapshot = providerCatalog.get(providerId);
  if (snapshot) return snapshot;
  const result = getProviderRuntime(providerId).discoverModels();
  const hasRuntimeModels = result.models.some(
    (model) => model.source && model.source !== "fallback",
  );
  if (result.status === "ready" && !hasRuntimeModels) {
    const cached = loadCachedProviderModels(providerId);
    if (cached) {
      return {
        ...result,
        models: cached.models,
        freshness: "unverified",
        refreshState: "cached",
        verifiedAt: cached.discoveredAt,
      };
    }
  }
  return result;
}

const persistedDiscovery = new WeakSet<ProviderModelDiscoveryResult>();
export function persistProviderDiscovery(discovery: ProviderModelDiscoveryResult): void {
  if (persistedDiscovery.has(discovery)) return;
  const runtimeModels = discovery.models.filter(
    (model) => model.source && model.source !== "fallback",
  );
  if (
    discovery.status !== "ready" ||
    discovery.freshness === "unverified" ||
    discovery.diagnostics?.refreshFailed === true
  ) {
    return;
  }
  if (!runtimeModels.length && discovery.freshness !== "verified") return;
  saveCachedProviderModels(discovery.providerId, {
    discoveredAt: discovery.verifiedAt ?? Date.now(),
    models: runtimeModels,
  });
  persistedDiscovery.add(discovery);
}

export async function refreshProviderModels(
  providerId: ProviderId,
  context: CatalogContext,
): Promise<ProviderModelDiscoveryResult> {
  const result = await providerCatalog.refresh(getProviderRuntime(providerId), context);
  if (providerCatalog.get(providerId) === result) persistProviderDiscovery(result);
  return result;
}

export async function validateProviderRouteActivation(options: {
  signal?: AbortSignal;
  providerConfig?: ProviderWorkspaceOverride;
  route: ProviderRoute;
  workspaceRoot: string;
  antigravityCommandPath?: string | null;
  claudeCommandPath?: string | null;
  localConfig?: ProviderWorkspaceOverride | null;
}): Promise<ProviderRouteValidationResult> {
  const runtime = getProviderRuntime(options.route.providerId);
  if (!runtime.routeAvailable) {
    return {
      status: "not-configured",
      providerId: options.route.providerId,
      backendKind: "unavailable",
      message: getProviderRouteSetupMessage(options.route.providerId),
    };
  }

  const catalog = discoverProviderModels(options.route.providerId);
  if (isCatalogModelUnavailable(catalog, options.route.modelId)) {
    const message = `The selected model ${options.route.modelId} is unavailable. Select a model explicitly before sending.`;
    return {
      status: "not-configured",
      providerId: options.route.providerId,
      backendKind: runtime.backendKind,
      message,
      failure: { kind: "model-unavailable", message, retryable: false },
    };
  }
  if (runtime.validateRoute) {
    const result = await runtime.validateRoute(options);
    if (result.status !== "ready" && !result.failure && result.message)
      return { ...result, failure: classifyProviderFailure(result.message) };
    return result;
  }

  if (!isProviderRouteConfigured(options.route.providerId)) {
    return {
      status: "not-configured",
      providerId: options.route.providerId,
      backendKind: "unavailable",
      message: getProviderRouteSetupMessage(options.route.providerId),
    };
  }

  return {
    status: "ready",
    providerId: options.route.providerId,
    backendKind: runtime.backendKind,
  };
}

export function resolveActiveProviderRoute(options: {
  workspaceConfigActiveRoute?: ProviderActiveRoute;
  googleMigrationRequired?: boolean;
  currentModel: string;
  currentReasoning: string;
}): ActiveProviderRoute {
  if (options.googleMigrationRequired)
    return {
      providerId: "google",
      modelId: "Model selection required",
      backendKind: "antigravity-cli-auth",
    };
  const configuredRoute = options.workspaceConfigActiveRoute;
  if (configuredRoute && isProviderRoutableInUbume(configuredRoute.providerId)) {
    const route: ActiveProviderRoute = {
      providerId: configuredRoute.providerId,
      modelId: configuredRoute.modelId,
      backendKind:
        configuredRoute.backendKind ?? getProviderRuntime(configuredRoute.providerId).backendKind,
      ...(configuredRoute.reasoning ? { reasoning: configuredRoute.reasoning } : {}),
      ...(configuredRoute.providerId === "local"
        ? { localBackend: configuredRoute.localBackend ?? "lm-studio" }
        : {}),
    };

    if (route.providerId === "google") {
      const models = discoverProviderModels("google").models;
      const selector = getAgyModelSelector(route.modelId, route.reasoning, models);
      const native = models.find((item) => item.modelId === selector);
      if (native) route.modelId = native.modelId;
    }
    return route;
  }

  return {
    providerId: "openai",
    modelId: options.currentModel,
    backendKind: "codex-cli-auth",
    reasoning: options.currentReasoning,
  };
}

export function getDefaultRouteModel(providerId: ProviderId, currentOpenAiModel: string): string {
  if (providerId === "anthropic") {
    const discovered = discoverProviderModels("anthropic");
    if (discovered.status === "ready" && discovered.models.length > 0) {
      return discovered.models[0].modelId;
    }
    return ANTHROPIC_FALLBACK_MODELS[0]?.modelId ?? "sonnet";
  }
  if (providerId === "google") {
    const discovered = discoverProviderModels("google");
    if (discovered.status === "ready" && discovered.models.length > 0) {
      return discovered.models[0].modelId;
    }
    return "Google default";
  }
  if (providerId === "local") {
    const discovery = discoverProviderModels("local");
    return discovery.models[0]?.modelId ?? "Local default";
  }
  if (providerId === "codexa-native") {
    return CODEXA_NATIVE_MODEL_ID;
  }
  if (providerId === "mistral") {
    const discovery = discoverProviderModels("mistral");
    return discovery.models[0]?.modelId ?? "Vibe default";
  }
  return currentOpenAiModel;
}

/** Common adapter for interactive and non-interactive requests. */
/** Classify once at the routing boundary; never discard provider error evidence. */
function handleFailure(
  route: ProviderRoute,
  cwd: string,
  providerConfig: ProviderWorkspaceOverride | undefined,
  handlers: BackendRunHandlers,
): BackendRunHandlers["onError"] {
  let refreshed = false;
  const requestCatalog = providerCatalog.get(route.providerId);
  return (message, rawOutput, evidence?: ProviderFailure) => {
    const failure = evidence ?? classifyProviderFailure(message);
    handlers.onError(message, rawOutput, failure);
    if (
      isModelFailure(failure) &&
      !refreshed &&
      providerCatalog.get(route.providerId) === requestCatalog
    ) {
      refreshed = true;
      void refreshProviderModels(route.providerId, {
        cwd,
        providerConfig,
        ...(route.providerId === "local"
          ? { localConfig: providerConfig, localBackend: route.localBackend }
          : {}),
        forceRefresh: true,
      });
    }
  };
}

export function createRoutedProvider(
  route: ProviderRoute,
  backend: BackendProvider,
  config: ProviderWorkspaceConfig,
  localHarnessSession?: () => LocalHarnessSessionMetadata | undefined,
  nativeSessions?: () => readonly NativeSessionReference[] | undefined,
): BackendProvider {
  const override = config.providers?.[route.providerId];
  if (config.googleMigrationRequired)
    return {
      ...backend,
      label: "Google",
      run: (_prompt, _options, handlers) => {
        handlers.onError(LEGACY_GOOGLE_MESSAGE);
        return () => undefined;
      },
    };
  if (route.providerId === "openai")
    return {
      ...backend,
      run: backend.run
        ? (prompt, options, handlers) => {
            const catalog = discoverProviderModels("openai");
            if (isCatalogModelUnavailable(catalog, route.modelId)) {
              handlers.onError(
                `The selected model ${route.modelId} is unavailable. Select a model explicitly before sending.`,
                undefined,
                {
                  kind: "model-unavailable",
                  message: `Model ${route.modelId} is unavailable.`,
                  retryable: false,
                },
              );
              return () => undefined;
            }
            return backend.run!(
              prompt,
              {
                ...options,
                runtime: override?.codexCommandPath
                  ? { ...options.runtime, codexCommandPath: override.codexCommandPath }
                  : options.runtime,
              },
              {
                ...handlers,
                onError: handleFailure(route, options.workspaceRoot, override, handlers),
              },
            );
          }
        : undefined,
    };
  const provider = getProviderRuntime(route.providerId);
  return {
    id: backend.id,
    label: provider.label,
    description: provider.routeStatus,
    authState: provider.routeAvailable ? "delegated" : "coming-soon",
    authLabel: provider.routeAvailable ? "Configured" : "Not configured",
    statusMessage: provider.routeStatus,
    supportsModels: (model) => model === route.modelId,
    run: provider.run
      ? (prompt, options, handlers) => {
          const catalog = discoverProviderModels(route.providerId);
          if (isCatalogModelUnavailable(catalog, route.modelId)) {
            handlers.onError(
              `The selected model ${route.modelId} is unavailable. Select a model explicitly before sending.`,
              undefined,
              {
                kind: "model-unavailable",
                message: `Model ${route.modelId} is unavailable.`,
                retryable: false,
              },
            );
            return () => undefined;
          }
          const descriptor = resolveCatalogModel(catalog.models, route.modelId);
          if (
            route.providerId === "mistral" &&
            descriptor &&
            (descriptor.source !== "config" || descriptor.modelId !== route.modelId) &&
            catalog.freshness !== "verified"
          ) {
            handlers.onError(
              `The Mistral API catalogue for ${route.modelId} is unverified. Refresh models before running this custom Vibe model.`,
            );
            return () => undefined;
          }
          // Old Vibe aliases can collide with newer API IDs. Require an explicit
          // native selection before changing their historical execution target.
          if (
            route.providerId === "mistral" &&
            override?.currentModel === route.modelId &&
            override?.models?.[route.modelId]?.reasoningPreference === undefined &&
            catalog.models.some((model) => {
              const raw = model.raw as { vibeAliases?: unknown } | null;
              return (
                model.modelId !== route.modelId &&
                Array.isArray(raw?.vibeAliases) &&
                raw.vibeAliases.includes(route.modelId)
              );
            }) &&
            catalog.models.some((model) => model.modelId === route.modelId)
          ) {
            handlers.onError(
              `The saved Vibe alias ${route.modelId} is ambiguous with an API model ID. Select a model explicitly before sending.`,
            );
            return () => undefined;
          }
          const requested =
            route.reasoning ?? override?.models?.[route.modelId]?.reasoningPreference ?? "";
          const effectiveReasoning =
            route.providerId === "google"
              ? requested
              : descriptor?.reasoningControl
                ? reconcileReasoning(descriptor.reasoningControl, requested)
                : descriptor?.supportedReasoningLevels?.some((level) => level.id === requested)
                  ? requested
                  : (descriptor?.defaultReasoningLevel ?? "");
          return provider.run!(
            {
              prompt,
              route: { ...route, reasoning: effectiveReasoning || undefined },
              providerConfig: override,
              modelDescriptor: descriptor,
              runtime: effectiveProviderRuntime(options.runtime, config, route),
              workspaceRoot: options.workspaceRoot,
              projectInstructions: options.projectInstructions,
              promptPolicy: options.promptPolicy,
              claudeCommandPath: override?.claudeCommandPath,
              antigravityCommandPath: override?.antigravityCommandPath,
              nativeSessions: nativeSessions?.(),
              localConfig: route.providerId === "local" ? override : undefined,
              runIntent: options.runIntent,
              conversationHistory: options.conversationHistory,
              localContextCheckpoint: options.localContextCheckpoint,
              imageAttachments: options.imageAttachments,
              localHarnessSession:
                route.providerId === "local" ? localHarnessSession?.() : undefined,
            },
            {
              ...handlers,
              onError: handleFailure(route, options.workspaceRoot, override, handlers),
            },
          );
        }
      : undefined,
  };
}
export function effectiveProviderRuntime(
  runtime: ResolvedRuntimeConfig,
  config: ProviderWorkspaceConfig,
  route: ProviderRoute,
): ResolvedRuntimeConfig {
  const override = config.providers?.[route.providerId];
  return {
    ...runtime,
    model: route.modelId,
    reasoningLevel: (route.reasoning ??
      runtime.reasoningLevel) as ResolvedRuntimeConfig["reasoningLevel"],
    ...(override?.antigravityCommandPath
      ? { antigravityCommandPath: override.antigravityCommandPath }
      : {}),
    ...(override?.codexCommandPath ? { codexCommandPath: override.codexCommandPath } : {}),
  };
}

export function formatRuntimeProviderLabel(providerId: ProviderId): string {
  if (providerId === "local") return "Local";
  if (providerId === "codexa-native" || providerId === "codexa-cupy") return "Codexa Native";
  if (providerId === "google") return "Google";
  if (providerId === "anthropic") return "Anthropic";
  if (providerId === "mistral") return "Mistral Vibe CLI";
  return "OpenAI";
}

export interface ProviderSetupPlan {
  installCommand: string | null;
  setupCommand: string;
}

export function getProviderSetupPlan(providerId: ProviderId, windows: boolean): ProviderSetupPlan {
  switch (providerId) {
    case "openai":
      return { installCommand: "npm install -g @openai/codex", setupCommand: "codex login" };
    case "anthropic":
      return { installCommand: "npm install -g @anthropic-ai/claude-code", setupCommand: "claude" };
    case "google":
      return windows
        ? {
            installCommand: "irm https://antigravity.google/cli/install.ps1 | iex",
            setupCommand: "agy",
          }
        : {
            installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            setupCommand: "agy",
          };
    case "mistral":
      return windows
        ? {
            installCommand:
              "if (Get-Command uv -ErrorAction SilentlyContinue) { uv tool install mistral-vibe } else { irm https://astral.sh/uv/install.ps1 | iex; uv tool install mistral-vibe }",
            setupCommand: "vibe --setup",
          }
        : {
            installCommand: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
            setupCommand: "vibe --setup",
          };
    default:
      return { installCommand: null, setupCommand: "" };
  }
}
