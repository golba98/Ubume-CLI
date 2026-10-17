/**
 * Derives the provider route the next prompt will use, plus the provider
 * registry the picker and status views render.
 *
 * Route precedence (highest first):
 * 1. A route restored with a resumed conversation (`conversationRouteOverride`).
 * 2. `--model` from the command line, applied on top of the saved route until
 *    the user makes an interactive selection. The saved route is not changed,
 *    so the CLI override never outlives the session.
 * 3. The saved `activeRoute` in providers.json, resolved by the registry
 *    (which also applies the Google migration policy).
 *
 * Effects (declared in this order, matching their original position in App):
 * - Closing a Local harness session when the route moves away from Local.
 *   If a run is active the close is deferred until that run's final
 *   checkpoint capture.
 * - Resetting the external-CLI readiness indicator when the provider changes.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { LaunchArgs } from "../../config/launchArgs.js";
import { traceModelStateDebug } from "../../core/perf/debugLog.js";
import { buildProviderRegistry, findProvider } from "../../core/providerLauncher/registry.js";
import type { ProviderId } from "../../core/providerLauncher/types.js";
import { setLocalProviderConfig } from "../../core/providerRuntime/local.js";
import { closeLocalHarnessSession } from "../../core/providerRuntime/localHarness/runtime.js";
import {
  getProviderRuntime,
  resolveActiveProviderRoute,
} from "../../core/providerRuntime/registry.js";
import type { RuntimeAvailability } from "../../core/providerRuntime/types.js";
import type { useAppState } from "../state/useAppState.js";

type AppState = ReturnType<typeof useAppState>;

type ProviderDiagnostics = Record<string, Record<string, string | number | boolean | null>>;

interface UseActiveProviderRouteContext
  extends Pick<
    AppState,
    | "selectionCoordinator"
    | "conversationRouteOverride"
    | "providerWorkspaceConfig"
    | "registryNonce"
    | "setRegistryNonce"
    | "workspaceRoot"
    | "dispatchSession"
    | "activeConversationRef"
    | "activeRunIdRef"
    | "deferredRouteCloseRef"
    | "stoppingRef"
  > {
  // Launch and model
  launchArgs: LaunchArgs;
  model: string;
  reasoningLevel: string;

  // Selection state
  /** Changes whenever the selection coordinator publishes a new state. */
  selectionVersion: number;

  // Provider diagnostics
  providerDiagnosticsRef: React.RefObject<ProviderDiagnostics>;
  providerRouteErrorsRef: React.RefObject<Record<string, string>>;
}

export function useActiveProviderRoute(context: UseActiveProviderRouteContext) {
  const {
    selectionCoordinator,
    conversationRouteOverride,
    providerWorkspaceConfig,
    registryNonce,
    setRegistryNonce,
    workspaceRoot,
    dispatchSession,
    activeConversationRef,
    activeRunIdRef,
    deferredRouteCloseRef,
    stoppingRef,
    launchArgs,
    selectionVersion,
    model,
    reasoningLevel,
    providerDiagnosticsRef,
    providerRouteErrorsRef,
  } = context;

  const activeProviderRoute = useMemo(() => {
    if (conversationRouteOverride) {
      return conversationRouteOverride;
    }
    const cliModel = selectionCoordinator.interactiveSelection ? null : launchArgs.modelOverride;
    const configuredRoute = providerWorkspaceConfig.activeRoute;
    const effectiveRoute =
      cliModel && configuredRoute ? { ...configuredRoute, modelId: cliModel } : configuredRoute;
    return resolveActiveProviderRoute({
      workspaceConfigActiveRoute: effectiveRoute,
      googleMigrationRequired: providerWorkspaceConfig.googleMigrationRequired,
      currentModel: model,
      currentReasoning: reasoningLevel,
    });
    // registryNonce and selectionVersion are invalidation signals: the
    // coordinator's `interactiveSelection` flag and registry-side route policy
    // are not React state, so these counters force a re-resolve.
  }, [
    conversationRouteOverride,
    launchArgs.modelOverride,
    model,
    providerWorkspaceConfig,
    reasoningLevel,
    registryNonce,
    selectionVersion,
  ]);

  const previousProviderRouteRef = useRef(activeProviderRoute);
  useEffect(() => {
    const previous = previousProviderRouteRef.current;
    previousProviderRouteRef.current = activeProviderRoute;

    const changed =
      previous.providerId !== activeProviderRoute.providerId ||
      previous.modelId !== activeProviderRoute.modelId ||
      previous.localBackend !== activeProviderRoute.localBackend;
    if (!changed || previous.providerId !== "local") {
      return;
    }

    const sessionId = activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
    if (activeRunIdRef.current !== null) {
      // The running turn still uses the session; the run's final checkpoint
      // capture (useConversation's captureFinalRef) closes it afterwards.
      deferredRouteCloseRef.current = sessionId;
    } else {
      stoppingRef.current = stoppingRef.current.then(() => closeLocalHarnessSession(sessionId));
    }
  }, [activeProviderRoute]);

  const activeProviderRuntime = useMemo(
    () => getProviderRuntime(activeProviderRoute.providerId),
    [activeProviderRoute.providerId],
  );

  const providerRegistry = useMemo(
    () => {
      setLocalProviderConfig(providerWorkspaceConfig.providers?.local);
      return buildProviderRegistry({
        activeModel: model,
        workspaceRoot,
        workspaceConfig: providerWorkspaceConfig,
        diagnostics: providerDiagnosticsRef.current,
        routeErrors: providerRouteErrorsRef.current,
      });
    },
    // registryNonce is intentionally included: startup probes and post-validation
    // updates mutate providerDiagnosticsRef/providerRouteErrorsRef (refs, not state)
    // and then increment the nonce to trigger a re-read of those refs.
    [model, providerWorkspaceConfig, registryNonce, workspaceRoot],
  );

  const workspaceDefaultProvider = useMemo(
    () => providerRegistry.find((provider) => provider.isDefault) ?? providerRegistry[0] ?? null,
    [providerRegistry],
  );

  /**
   * Records a provider's availability in its diagnostics and refreshes the
   * registry. The selected model shown in diagnostics is kept when known.
   */
  const markProviderAvailability = useCallback(
    (providerId: ProviderId, availability: RuntimeAvailability, reason: string) => {
      const previous = providerDiagnosticsRef.current[providerId] ?? {};
      const recordedModel =
        typeof previous.selectedModel === "string" ? previous.selectedModel.trim() : "";
      const activeModel =
        providerId === activeProviderRoute.providerId ? activeProviderRoute.modelId : null;
      const selectedModel = recordedModel || activeModel;

      providerDiagnosticsRef.current[providerId] = {
        ...previous,
        selectedModel,
        availabilityStatus: availability,
        endpointCheckResult: availability,
      };
      traceModelStateDebug("provider_availability_marked", {
        providerId,
        selectedModel,
        availability,
        reason,
      });
      setRegistryNonce((current) => current + 1);
    },
    [activeProviderRoute.modelId, activeProviderRoute.providerId],
  );

  // A different provider has its own external CLI; its readiness is unknown.
  const activeRouteProviderId = activeProviderRoute.providerId;
  useEffect(() => {
    dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "idle" });
  }, [activeRouteProviderId]);

  const activeRouteProvider = useMemo(
    () => findProvider(providerRegistry, activeRouteProviderId) ?? providerRegistry[0] ?? null,
    [activeRouteProviderId, providerRegistry],
  );

  return {
    activeProviderRoute,
    activeProviderRuntime,
    providerRegistry,
    workspaceDefaultProvider,
    markProviderAvailability,
    activeRouteProvider,
  };
}
