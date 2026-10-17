import { useCallback, useEffect, useRef } from "react";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import {
  type CodexAuthProbeResult,
  getAuthStatusMessage,
  probeCodexAuthStatus,
} from "../../core/codex/codexAuth.js";
import {
  type CodexModelCapabilities,
  createFallbackModelCapabilities,
  getSelectableModelCapabilities,
} from "../../core/models/codexModelCapabilities.js";
import { catalogContextKey, providerCatalog } from "../../core/models/modelCatalog.js";
import { isCatalogModelUnavailable } from "../../core/models/modelSelection.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import type { ProviderId, ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import {
  saveProviderWorkspaceConfig,
  setProviderActiveRoute,
  setProviderDefaultModel,
} from "../../core/providerLauncher/workspaceConfig.js";
import {
  ANTHROPIC_ROUTE_SETUP_MESSAGE,
  validateAnthropicRoute,
} from "../../core/providerRuntime/anthropic.js";
import { modelRecoveryMessage } from "../../core/providerRuntime/failures.js";
import { validateLocalProvider } from "../../core/providerRuntime/local.js";
import { providerModelsToCodexCapabilities } from "../../core/providerRuntime/models.js";
import {
  discoverProviderModels,
  getProviderRuntime,
  persistProviderDiscovery,
  refreshProviderModels,
} from "../../core/providerRuntime/registry.js";
import type { ProviderRoute, RuntimeAvailability } from "../../core/providerRuntime/types.js";
import type { BackendProvider } from "../../core/providers/types.js";

import { errorMessage } from "../../core/shared/values.js";

import type { Screen } from "../../session/types.js";

interface UseModelCatalogContext {
  selectionCoordinator: SelectionCoordinator;
  providerOverride: BackendProvider | undefined;
  setModelCapabilities: React.Dispatch<React.SetStateAction<CodexModelCapabilities | null>>;
  modelDiscoveryInFlightRef: React.RefObject<Promise<CodexModelCapabilities> | null>;
  getInputDebugSnapshot: (extra?: Record<string, unknown>) => {
    screen: Screen;
    mode: "model-picker" | "chat/input";
    modelPickerOpen: boolean;
    composerEnabled: boolean;
    inputLocked: boolean;
    busy: boolean;
    modelLoading: boolean;
    modelSelection: boolean;
    focusTarget: string;
    stdin: Record<string, unknown>;
  };
  modelDiscoveryAnnounceRef: React.RefObject<boolean>;
  setModelCapabilitiesBusy: React.Dispatch<React.SetStateAction<boolean>>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  providerModelsLoadedRef: React.RefObject<Set<ProviderId>>;
  providerModelRefreshesRef: React.RefObject<Map<ProviderId, Promise<unknown>>>;
  setProviderModelLoading: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setProviderModelErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  workspaceRoot: string;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  setRegistryNonce: React.Dispatch<React.SetStateAction<number>>;
  setAuthStatus: React.Dispatch<React.SetStateAction<CodexAuthProbeResult>>;
  setAuthStatusBusy: React.Dispatch<React.SetStateAction<boolean>>;
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
  providerRouteErrorsRef: React.RefObject<Record<string, string>>;
  activeProviderRoute: ProviderRoute;
  markProviderAvailability: (
    providerId: ProviderId,
    availability: RuntimeAvailability,
    reason: string,
  ) => void;
  reasoningLevel: string;
  setProviderWorkspaceConfig: React.Dispatch<React.SetStateAction<ProviderWorkspaceConfig>>;
  updateRuntimeConfig: (updater: (current: RuntimeConfig) => RuntimeConfig) => void;
}

export function useModelCatalog(context: UseModelCatalogContext) {
  const {
    selectionCoordinator,
    providerOverride,
    setModelCapabilities,
    modelDiscoveryInFlightRef,
    getInputDebugSnapshot,
    modelDiscoveryAnnounceRef,
    setModelCapabilitiesBusy,
    appendEvent,
    providerModelsLoadedRef,
    providerModelRefreshesRef,
    setProviderModelLoading,
    setProviderModelErrors,
    workspaceRoot,
    providerWorkspaceConfig,
    setRegistryNonce,
    setAuthStatus,
    setAuthStatusBusy,
    providerDiagnosticsRef,
    providerRouteErrorsRef,
    activeProviderRoute,
    markProviderAvailability,
    reasoningLevel,
    setProviderWorkspaceConfig,
    updateRuntimeConfig,
  } = context;

  const latest = useRef({ activeProviderRoute, providerWorkspaceConfig });
  latest.current = { activeProviderRoute, providerWorkspaceConfig };
  const modelDiscoveryContextRef = useRef("");
  const modelDiscoveryGenerationRef = useRef(0);
  const discoveryLifetime = useRef(new AbortController());
  useEffect(() => {
    if (discoveryLifetime.current.signal.aborted) discoveryLifetime.current = new AbortController();
    const unsubscribe = providerCatalog.subscribe((providerId, snapshot) => {
      setProviderModelLoading((current) => ({
        ...current,
        [providerId]: snapshot.refreshState === "loading",
      }));
      setProviderModelErrors((current) => {
        const next = { ...current };
        if (snapshot.freshness === "unverified" && snapshot.refreshState !== "loading")
          next[providerId] = snapshot.message ?? "Cached model inventory is unverified.";
        else delete next[providerId];
        return next;
      });
      if (providerId === "openai" && snapshot.refreshState !== "loading") {
        const capabilities = providerModelsToCodexCapabilities(
          snapshot.models,
          latest.current.activeProviderRoute.modelId,
        );
        setModelCapabilities({
          ...capabilities,
          status: snapshot.freshness === "verified" ? "ready" : "fallback",
          error:
            snapshot.freshness === "verified"
              ? null
              : (snapshot.message ?? "Cached Codex inventory is unverified."),
        });
      }
      setRegistryNonce((current) => current + 1);
    });
    return () => {
      unsubscribe();
      discoveryLifetime.current.abort();
      providerCatalog.dispose();
    };
  }, []);

  const refreshModelCapabilities = useCallback(
    (forceRefresh = false, announce = false): Promise<CodexModelCapabilities> => {
      if (providerOverride) {
        const capabilities = createFallbackModelCapabilities(null);
        setModelCapabilities(capabilities);
        return Promise.resolve(capabilities);
      }
      // Single-flight: concurrent requests share the same in-flight discovery
      // promise so we never spawn a duplicate discovery job or emit duplicate
      // transcript messages.
      const connection = catalogContextKey("openai", {
        cwd: workspaceRoot,
        providerConfig: providerWorkspaceConfig.providers?.openai,
      });
      const currentConnection = () =>
        catalogContextKey("openai", {
          cwd: workspaceRoot,
          providerConfig: latest.current.providerWorkspaceConfig.providers?.openai,
        });
      if (modelDiscoveryInFlightRef.current && modelDiscoveryContextRef.current === connection) {
        traceInputDebug(
          "model_loading_inflight",
          getInputDebugSnapshot({ forceRefresh, announce }),
        );
        if (announce) {
          modelDiscoveryAnnounceRef.current = true;
        }
        return modelDiscoveryInFlightRef.current;
      }

      if (announce) {
        modelDiscoveryAnnounceRef.current = true;
      }

      const discoveryGeneration = ++modelDiscoveryGenerationRef.current;
      modelDiscoveryContextRef.current = connection;
      setModelCapabilitiesBusy(true);
      traceInputDebug("model_loading_start", getInputDebugSnapshot({ forceRefresh, announce }));
      const promise = (async () => {
        try {
          const discovery = await refreshProviderModels("openai", {
            cwd: workspaceRoot,
            providerConfig: providerWorkspaceConfig.providers?.openai,
            forceRefresh,
            signal: discoveryLifetime.current.signal,
          });
          const converted = providerModelsToCodexCapabilities(
            discovery.models,
            activeProviderRoute.modelId,
          );
          const capabilities: CodexModelCapabilities = {
            ...converted,
            status: discovery.freshness === "verified" ? "ready" : "fallback",
            error:
              discovery.freshness === "verified"
                ? null
                : (discovery.message ?? "Cached Codex inventory is unverified."),
          };
          if (
            discoveryLifetime.current.signal.aborted ||
            currentConnection() !== connection ||
            providerCatalog.get("openai") !== discovery
          )
            return capabilities;
          setModelCapabilities(capabilities);
          traceInputDebug(
            "model_loading_success",
            getInputDebugSnapshot({
              status: capabilities.status,
              source: capabilities.source,
              modelCount: getSelectableModelCapabilities(capabilities).length,
            }),
          );
          if (capabilities.status === "fallback") {
            traceInputDebug(
              "model_loading_failure",
              getInputDebugSnapshot({
                status: capabilities.status,
                error: capabilities.error,
              }),
            );
          }
          if (modelDiscoveryAnnounceRef.current) {
            const modelCount = getSelectableModelCapabilities(capabilities).length;
            const source =
              capabilities.status === "ready" ? "Codex runtime" : "fallback compatibility list";
            appendEvent("system", "Model discovery", `Loaded ${modelCount} models from ${source}.`);
          }
          return capabilities;
        } catch (error) {
          const fallback = createFallbackModelCapabilities(error);
          if (discoveryLifetime.current.signal.aborted || currentConnection() !== connection)
            return fallback;
          setModelCapabilities(fallback);
          traceInputDebug(
            "model_loading_failure",
            getInputDebugSnapshot({
              error: errorMessage(error),
            }),
          );
          if (modelDiscoveryAnnounceRef.current) {
            appendEvent(
              "error",
              "Model discovery failed",
              fallback.error ?? "Unable to discover Codex models.",
            );
          }
          return fallback;
        } finally {
          if (modelDiscoveryGenerationRef.current === discoveryGeneration) {
            setModelCapabilitiesBusy(false);
            modelDiscoveryInFlightRef.current = null;
            modelDiscoveryAnnounceRef.current = false;
            traceInputDebug(
              "model_loading_finished",
              getInputDebugSnapshot({ forceRefresh, announce }),
            );
          }
        }
      })();

      modelDiscoveryInFlightRef.current = promise;
      return promise;
    },
    [
      appendEvent,
      getInputDebugSnapshot,
      workspaceRoot,
      providerWorkspaceConfig.providers?.openai,
      activeProviderRoute.modelId,
    ],
  );

  const ensureProviderModels = useCallback(
    (providerId: ProviderId, forceRefresh = false) => {
      if (providerId === "openai") {
        return refreshModelCapabilities(forceRefresh, false);
      }

      const runtime = getProviderRuntime(providerId);
      if (!runtime.refreshModels) {
        return Promise.resolve(null);
      }

      setProviderModelLoading((current) => ({ ...current, [providerId]: true }));
      setProviderModelErrors((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });

      const connection = catalogContextKey(providerId, {
        cwd: workspaceRoot,
        providerConfig: providerWorkspaceConfig.providers?.[providerId],
        ...(providerId === "local"
          ? {
              localBackend:
                activeProviderRoute.localBackend ??
                providerWorkspaceConfig.providers?.local?.localBackend ??
                "lm-studio",
            }
          : {}),
      });
      const revision = selectionCoordinator.revision(connection, activeProviderRoute.modelId);
      const promise = refreshProviderModels(providerId, {
        cwd: workspaceRoot,
        forceRefresh,
        signal: discoveryLifetime.current.signal,
        providerConfig: providerWorkspaceConfig.providers?.[providerId],
        localConfig: providerId === "local" ? providerWorkspaceConfig.providers?.local : undefined,
        ...(providerId === "local"
          ? {
              localBackend:
                activeProviderRoute.localBackend ??
                providerWorkspaceConfig.providers?.local?.localBackend ??
                "lm-studio",
            }
          : {}),
      })
        .then((discovery) => {
          providerModelsLoadedRef.current.add(providerId);
          if (
            discoveryLifetime.current.signal.aborted ||
            providerCatalog.get(providerId) !== discovery
          )
            return discovery;
          if (
            discovery.status !== "ready" ||
            discovery.freshness === "unverified" ||
            discovery.models.length === 0
          ) {
            setProviderModelErrors((current) => ({
              ...current,
              [providerId]: discovery.message ?? `Unable to load ${runtime.label} models.`,
            }));
          }
          if (
            providerId === latest.current.activeProviderRoute.providerId &&
            latest.current.activeProviderRoute.modelId === activeProviderRoute.modelId &&
            isCatalogModelUnavailable(discovery, activeProviderRoute.modelId)
          ) {
            const message = modelRecoveryMessage(activeProviderRoute.modelId);
            const alreadyRejected =
              selectionCoordinator.state(connection, activeProviderRoute.modelId)?.status ===
              "unavailable";
            selectionCoordinator.reject(
              connection,
              activeProviderRoute.modelId,
              { kind: "model-unavailable", message, retryable: false },
              revision,
            );
            if (!alreadyRejected) appendEvent("error", "Selected model unavailable", message);
          }
          setRegistryNonce((current) => current + 1);
          return discovery;
        })
        .catch((error) => {
          const message = errorMessage(error);
          setProviderModelErrors((current) => ({ ...current, [providerId]: message }));
          setRegistryNonce((current) => current + 1);
          return null;
        })
        .finally(() => {
          if (
            discoveryLifetime.current.signal.aborted ||
            providerModelRefreshesRef.current.get(providerId) !== promise
          )
            return;
          providerModelRefreshesRef.current.delete(providerId);
          setProviderModelLoading((current) => ({ ...current, [providerId]: false }));
        });

      providerModelRefreshesRef.current.set(providerId, promise);
      return promise;
    },
    [
      refreshProviderModels,
      selectionCoordinator,
      providerWorkspaceConfig.providers,
      activeProviderRoute.providerId,
      activeProviderRoute.modelId,
      appendEvent,
      refreshModelCapabilities,
      workspaceRoot,
    ],
  );

  useEffect(() => {
    void ensureProviderModels(activeProviderRoute.providerId);
  }, [activeProviderRoute.providerId, ensureProviderModels]);

  const refreshAuthStatus = useCallback(
    async (announce: boolean) => {
      if (providerOverride) {
        setAuthStatus({
          state: "authenticated",
          checkedAt: Date.now(),
          rawSummary: "Embedded runtime",
          recommendedAction: "",
        });
        return;
      }
      setAuthStatusBusy(true);
      setAuthStatus((prev) => ({ ...prev, state: "checking" }));

      try {
        const result = await probeCodexAuthStatus();
        setAuthStatus(result);
        if (announce) {
          appendEvent("system", "Auth status", getAuthStatusMessage(result));
          void ensureProviderModels(activeProviderRoute.providerId, true);
        }
      } catch (error) {
        const message = errorMessage(error, "Unknown auth probe failure");
        const fallback: CodexAuthProbeResult = {
          state: "unknown",
          checkedAt: Date.now(),
          rawSummary: message,
          recommendedAction: "Run `codex login` manually, then retry /auth status.",
        };
        setAuthStatus(fallback);
        if (announce) {
          appendEvent("error", "Auth status probe failed", message);
        }
      } finally {
        setAuthStatusBusy(false);
      }
    },
    [appendEvent, ensureProviderModels, activeProviderRoute.providerId],
  );

  useEffect(() => {
    void refreshAuthStatus(false);
  }, []);

  // Probe Anthropic/Claude Code CLI auth at startup so the provider picker
  // shows the correct route availability without requiring manual activation.
  useEffect(() => {
    void (async () => {
      try {
        const result = await validateAnthropicRoute({
          cwd: workspaceRoot,
          configuredPath: providerWorkspaceConfig.providers?.anthropic?.claudeCommandPath,
        });
        if (result.diagnostics) {
          providerDiagnosticsRef.current["anthropic"] = result.diagnostics as Record<
            string,
            string | number | boolean | null
          >;
        }
        if (result.status !== "ready") {
          providerRouteErrorsRef.current["anthropic"] =
            result.message ?? ANTHROPIC_ROUTE_SETUP_MESSAGE;
        } else {
          delete providerRouteErrorsRef.current["anthropic"];
          // Persist the freshly discovered catalog so newly released Claude
          // models replace the stale on-disk cache without a manual refresh.
          persistProviderDiscovery(discoverProviderModels("anthropic"));
        }
      } catch {
        // Best-effort probe — failures are surfaced only when the user activates the route.
      }
      setRegistryNonce((n) => n + 1);
    })();
    // workspaceRoot is stable for the session lifetime; this runs exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot]);

  // Probe local OpenAI-compatible servers such as LM Studio at startup so the
  // provider picker can show actual availability and loaded model IDs.
  useEffect(() => {
    if (activeProviderRoute.providerId !== "local") return;
    const navigation = selectionCoordinator.navigationToken;
    const startedRoute = activeProviderRoute;
    const localConnection = () =>
      catalogContextKey("local", {
        cwd: workspaceRoot,
        providerConfig: latest.current.providerWorkspaceConfig.providers?.local,
        localBackend:
          latest.current.activeProviderRoute.localBackend ??
          latest.current.providerWorkspaceConfig.providers?.local?.localBackend ??
          "lm-studio",
      });
    const startedConnection = localConnection();
    void (async () => {
      try {
        markProviderAvailability("local", "checking", "startup-probe");
        const result = await validateLocalProvider({
          override: providerWorkspaceConfig.providers?.local,
        });
        if (
          discoveryLifetime.current.signal.aborted ||
          selectionCoordinator.navigationToken !== navigation ||
          latest.current.activeProviderRoute.providerId !== startedRoute.providerId ||
          latest.current.activeProviderRoute.modelId !== startedRoute.modelId ||
          localConnection() !== startedConnection
        )
          return;
        if (result.diagnostics) {
          providerDiagnosticsRef.current["local"] = result.diagnostics as Record<
            string,
            string | number | boolean | null
          >;
        }
        if (result.status !== "ready") {
          providerRouteErrorsRef.current["local"] = result.message ?? "Local provider unavailable.";
        } else {
          delete providerRouteErrorsRef.current["local"];
          const detectedModel =
            typeof result.diagnostics?.selectedModel === "string"
              ? result.diagnostics.selectedModel.trim()
              : "";
          if (detectedModel && ["Local default", "default"].includes(activeProviderRoute.modelId)) {
            const localBackend =
              activeProviderRoute.localBackend ??
              providerWorkspaceConfig.providers?.local?.localBackend ??
              "lm-studio";
            const nextReasoning = activeProviderRoute.reasoning ?? reasoningLevel;
            let nextConfig = setProviderActiveRoute(providerWorkspaceConfig, {
              providerId: "local",
              modelId: detectedModel,
              backendKind: result.backendKind,
              reasoning: nextReasoning,
              localBackend,
            });
            nextConfig = setProviderDefaultModel(nextConfig, "local", detectedModel);
            saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
            setProviderWorkspaceConfig(nextConfig);
            updateRuntimeConfig((current) => ({ ...current, model: detectedModel }));
          }
        }
      } catch {
        // Best-effort probe — failures are surfaced only when the user activates the route.
      }
      setRegistryNonce((n) => n + 1);
    })();
    // workspaceRoot is stable for the session lifetime; local provider config is
    // loaded before this first startup probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProviderRoute.providerId, workspaceRoot]);
  return { refreshModelCapabilities, ensureProviderModels, refreshAuthStatus };
}
