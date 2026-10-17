/**
 * Model inventories for every provider, and startup availability probes.
 *
 * - The shared `providerCatalog` (core/models/modelCatalog) owns freshness and
 *   request ordering. This hook subscribes to it and mirrors loading and error
 *   state into React, and keeps the OpenAI capability snapshot in sync.
 * - `refreshModelCapabilities` discovers Codex (OpenAI) models; concurrent
 *   calls for the same connection share one request.
 * - `ensureProviderModels` refreshes any other provider's catalog. When an
 *   authoritative catalog no longer lists the active model, the model is
 *   recorded as unavailable for that connection (once), which the prompt
 *   gate and the provider picker then respect.
 * - At startup it probes Codex login, Claude Code, and (when Local is
 *   active) the Local server, so the provider picker shows real availability.
 *
 * Results that arrive after the connection changed, or after unmount
 * (`discoveryLifetime`), are discarded.
 */

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
import { providerCatalog, providerConnectionKey } from "../../core/models/modelCatalog.js";
import { isCatalogModelUnavailable } from "../../core/models/modelSelection.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import { resolveLocalBackend } from "../../core/providerLauncher/localBackend.js";
import type { ProviderId, ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import {
  setProviderActiveRoute,
  setProviderDefaultModel,
} from "../../core/providerLauncher/workspaceConfig.js";
import {
  ANTHROPIC_ROUTE_SETUP_MESSAGE,
  validateAnthropicRoute,
} from "../../core/providerRuntime/anthropic.js";
import { modelRecoveryMessage } from "../../core/providerRuntime/failures.js";
import { validateLocalProvider } from "../../core/providerRuntime/local.js";
import {
  discoverProviderModels,
  getProviderRuntime,
  persistProviderDiscovery,
  refreshProviderModels,
} from "../../core/providerRuntime/registry.js";
import type { ProviderRoute, RuntimeAvailability } from "../../core/providerRuntime/types.js";
import type { BackendProvider } from "../../core/providers/types.js";

import { errorMessage } from "../../core/shared/values.js";

import { selectedLocalModel } from "../providers/providerActions.js";
import { openAiCapabilitiesFromDiscovery } from "./catalogLogic.js";

interface UseModelCatalogContext {
  // Selection and active route
  selectionCoordinator: SelectionCoordinator;
  activeProviderRoute: ProviderRoute;
  markProviderAvailability: (
    providerId: ProviderId,
    availability: RuntimeAvailability,
    reason: string,
  ) => void;
  providerRouteErrorsRef: React.RefObject<Record<string, string>>;
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
  reasoningLevel: string;

  // Codex model discovery
  providerOverride: BackendProvider | undefined;
  setModelCapabilities: React.Dispatch<React.SetStateAction<CodexModelCapabilities | null>>;
  setModelCapabilitiesBusy: React.Dispatch<React.SetStateAction<boolean>>;
  modelDiscoveryInFlightRef: React.RefObject<Promise<CodexModelCapabilities> | null>;
  modelDiscoveryAnnounceRef: React.RefObject<boolean>;

  // Provider catalog state
  providerModelsLoadedRef: React.RefObject<Set<ProviderId>>;
  providerModelRefreshesRef: React.RefObject<Map<ProviderId, Promise<unknown>>>;
  setProviderModelLoading: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setProviderModelErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setRegistryNonce: React.Dispatch<React.SetStateAction<number>>;

  // Auth probing
  setAuthStatus: React.Dispatch<React.SetStateAction<CodexAuthProbeResult>>;
  setAuthStatusBusy: React.Dispatch<React.SetStateAction<boolean>>;

  // Provider config and runtime
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  /** Saves a transform of the latest provider config; see useRuntimeSettings. */
  updateProviderWorkspaceConfig: (
    transform: (latest: ProviderWorkspaceConfig) => ProviderWorkspaceConfig,
  ) => ProviderWorkspaceConfig;
  updateRuntimeConfig: (updater: (current: RuntimeConfig) => RuntimeConfig) => void;

  // App plumbing
  workspaceRoot: string;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  getInputDebugSnapshot: (extra?: Record<string, unknown>) => Record<string, unknown>;
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
    updateProviderWorkspaceConfig,
    updateRuntimeConfig,
  } = context;

  // Async results compare against the route and config current when they land.
  const latest = useRef({ activeProviderRoute, providerWorkspaceConfig });
  latest.current = { activeProviderRoute, providerWorkspaceConfig };
  // Connection and generation of the in-flight Codex discovery (single-flight).
  const modelDiscoveryContextRef = useRef("");
  const modelDiscoveryGenerationRef = useRef(0);
  // Aborted on unmount; every discovery request is tied to it.
  const discoveryLifetime = useRef(new AbortController());

  // Mirror catalog snapshots into React state.
  useEffect(() => {
    if (discoveryLifetime.current.signal.aborted) {
      discoveryLifetime.current = new AbortController();
    }
    const unsubscribe = providerCatalog.subscribe((providerId, snapshot) => {
      setProviderModelLoading((current) => ({
        ...current,
        [providerId]: snapshot.refreshState === "loading",
      }));
      setProviderModelErrors((current) => {
        const next = { ...current };
        if (snapshot.freshness === "unverified" && snapshot.refreshState !== "loading") {
          next[providerId] = snapshot.message ?? "Cached model inventory is unverified.";
        } else {
          delete next[providerId];
        }
        return next;
      });
      if (providerId === "openai" && snapshot.refreshState !== "loading") {
        setModelCapabilities(
          openAiCapabilitiesFromDiscovery(snapshot, latest.current.activeProviderRoute.modelId),
        );
      }
      setRegistryNonce((current) => current + 1);
    });
    return () => {
      unsubscribe();
      discoveryLifetime.current.abort();
      providerCatalog.dispose();
    };
  }, []);

  /**
   * Discovers Codex models. With `announce`, the result is reported in the
   * transcript (used by `/models`). An embedded test provider gets the
   * fallback list without spawning Codex.
   */
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
      const connection = providerConnectionKey("openai", {
        cwd: workspaceRoot,
        config: providerWorkspaceConfig,
      });
      const currentConnection = () =>
        providerConnectionKey("openai", {
          cwd: workspaceRoot,
          config: latest.current.providerWorkspaceConfig,
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
          const capabilities = openAiCapabilitiesFromDiscovery(
            discovery,
            activeProviderRoute.modelId,
          );

          // A newer discovery or connection owns the snapshot now.
          const stale =
            discoveryLifetime.current.signal.aborted ||
            currentConnection() !== connection ||
            providerCatalog.get("openai") !== discovery;
          if (stale) {
            return capabilities;
          }

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

          if (discoveryLifetime.current.signal.aborted || currentConnection() !== connection) {
            return fallback;
          }

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

  /**
   * Refreshes a provider's model catalog (Codex discovery for OpenAI). Also
   * rejects the active model for this connection when the refreshed catalog
   * explicitly marks it unavailable; the selection revision captured here
   * keeps a late result from rejecting a model the user re-selected since.
   */
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

      const connection = providerConnectionKey(providerId, {
        cwd: workspaceRoot,
        config: providerWorkspaceConfig,
        routeLocalBackend: activeProviderRoute.localBackend,
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
              localBackend: resolveLocalBackend(
                providerWorkspaceConfig,
                activeProviderRoute.localBackend,
              ),
            }
          : {}),
      })

        .then((discovery) => {
          providerModelsLoadedRef.current.add(providerId);

          // A newer refresh (or an abort) owns the catalog now; leave it alone.
          if (
            discoveryLifetime.current.signal.aborted ||
            providerCatalog.get(providerId) !== discovery
          ) {
            return discovery;
          }

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

          // Reject the active selection when its model left the catalog.
          const activeModelStillSelected =
            providerId === latest.current.activeProviderRoute.providerId &&
            latest.current.activeProviderRoute.modelId === activeProviderRoute.modelId;
          if (
            activeModelStillSelected &&
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
            if (!alreadyRejected) {
              appendEvent("error", "Selected model unavailable", message);
            }
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
          // A newer refresh owns the in-flight marker; leave it registered.
          if (
            discoveryLifetime.current.signal.aborted ||
            providerModelRefreshesRef.current.get(providerId) !== promise
          ) {
            return;
          }
          providerModelRefreshesRef.current.delete(providerId);
          setProviderModelLoading((current) => ({ ...current, [providerId]: false }));
        });

      providerModelRefreshesRef.current.set(providerId, promise);
      return promise;
    },
    [
      selectionCoordinator,
      providerWorkspaceConfig.providers,
      activeProviderRoute.providerId,
      activeProviderRoute.modelId,
      appendEvent,
      refreshModelCapabilities,
      workspaceRoot,
    ],
  );

  // Keep the active provider's catalog fresh when the provider changes.
  useEffect(() => {
    void ensureProviderModels(activeProviderRoute.providerId);
  }, [activeProviderRoute.providerId, ensureProviderModels]);

  /** Probes Codex login state; with `announce` the result is posted and models refreshed. */
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
          providerDiagnosticsRef.current.anthropic = result.diagnostics;
        }
        if (result.status !== "ready") {
          providerRouteErrorsRef.current.anthropic =
            result.message ?? ANTHROPIC_ROUTE_SETUP_MESSAGE;
        } else {
          delete providerRouteErrorsRef.current.anthropic;
          // Persist the freshly discovered catalog so newly released Claude
          // models replace the stale on-disk cache without a manual refresh.
          persistProviderDiscovery(discoverProviderModels("anthropic"));
        }
      } catch {
        // Best-effort probe — failures are surfaced only when the user activates the route.
      }
      setRegistryNonce((n) => n + 1);
    })();
    // workspaceRoot is stable for the session lifetime, so this runs once.
  }, [workspaceRoot]);

  // Probe local OpenAI-compatible servers such as LM Studio at startup so the
  // provider picker can show actual availability and loaded model IDs.
  useEffect(() => {
    if (activeProviderRoute.providerId !== "local") return;
    const navigation = selectionCoordinator.navigationToken;
    const startedRoute = activeProviderRoute;
    const localConnection = () =>
      providerConnectionKey("local", {
        cwd: workspaceRoot,
        config: latest.current.providerWorkspaceConfig,
        routeLocalBackend: latest.current.activeProviderRoute.localBackend,
      });
    const startedConnection = localConnection();
    void (async () => {
      try {
        markProviderAvailability("local", "checking", "startup-probe");
        const result = await validateLocalProvider({
          override: providerWorkspaceConfig.providers?.local,
        });
        // Ignore the probe if the user navigated, switched route, or changed
        // the Local connection while it ran.
        const stale =
          discoveryLifetime.current.signal.aborted ||
          selectionCoordinator.navigationToken !== navigation ||
          latest.current.activeProviderRoute.providerId !== startedRoute.providerId ||
          latest.current.activeProviderRoute.modelId !== startedRoute.modelId ||
          localConnection() !== startedConnection;
        if (stale) {
          return;
        }
        if (result.diagnostics) {
          providerDiagnosticsRef.current.local = result.diagnostics;
        }
        if (result.status !== "ready") {
          providerRouteErrorsRef.current.local = result.message ?? "Local provider unavailable.";
        } else {
          delete providerRouteErrorsRef.current.local;
          // A placeholder route adopts the model the Local server has loaded.
          const detectedModel = selectedLocalModel(result, "");
          if (detectedModel && ["Local default", "default"].includes(activeProviderRoute.modelId)) {
            const nextReasoning = activeProviderRoute.reasoning ?? reasoningLevel;
            updateProviderWorkspaceConfig((latestConfig) => {
              const withRoute = setProviderActiveRoute(latestConfig, {
                providerId: "local",
                modelId: detectedModel,
                backendKind: result.backendKind,
                reasoning: nextReasoning,
                localBackend: resolveLocalBackend(latestConfig, activeProviderRoute.localBackend),
              });
              return setProviderDefaultModel(withRoute, "local", detectedModel);
            });
            updateRuntimeConfig((current) => ({ ...current, model: detectedModel }));
          }
        }
      } catch {
        // Best-effort probe — failures are surfaced only when the user activates the route.
      }
      setRegistryNonce((n) => n + 1);
    })();
    // Runs when Local becomes the active provider. workspaceRoot is stable,
    // and Local config is loaded before this first startup probe.
  }, [activeProviderRoute.providerId, workspaceRoot]);

  return { refreshModelCapabilities, ensureProviderModels, refreshAuthStatus };
}
