/**
 * State for the `/usage` panel: the usage adapter and scope for the active
 * route, the latest snapshot, and refreshing it.
 *
 * Usage results are cached per scope by a shared usage service, so switching
 * providers shows what is already known for the new scope, and a late result
 * for a scope the user has left is kept in the cache but not shown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import type { ModelContextMetadata } from "../../core/providerRuntime/contextMetadata.js";
import { isLocalRuntime } from "../../core/providerRuntime/deployment.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import { resolveUsageTarget } from "../../core/usage/registry.js";
import type { LocalUsageFacts } from "../../core/usage/types.js";
import { createUsageService, type UsageViewState } from "../../core/usage/usageService.js";
import type { Screen } from "../../session/types.js";

// One service per process: cached snapshots and in-flight requests survive panel
// close/reopen and provider switches, keyed by account scope.
const sharedUsageService = createUsageService();

interface UseProviderUsageContext {
  activeProviderRoute: ProviderRoute;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  workspaceRoot: string;
  activeContextMetadata: ModelContextMetadata | null;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  /** Test seams. */
  service?: typeof sharedUsageService;
  resolveTarget?: typeof resolveUsageTarget;
}

export function useProviderUsage({
  activeProviderRoute,
  providerWorkspaceConfig,
  workspaceRoot,
  activeContextMetadata,
  setScreen,
  service = sharedUsageService,
  resolveTarget = resolveUsageTarget,
}: UseProviderUsageContext) {
  const providerConfig = providerWorkspaceConfig.providers?.[activeProviderRoute.providerId];
  const target = useMemo(
    () => resolveTarget(activeProviderRoute, providerConfig),
    [activeProviderRoute, providerConfig, resolveTarget],
  );
  const [view, setView] = useState<UsageViewState>(() => service.peek(target.scopeKey));
  const scopeRef = useRef(target.scopeKey);
  scopeRef.current = target.scopeKey;
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // A provider switch shows only what is known for the new scope.
  useEffect(() => {
    setView(service.peek(target.scopeKey));
  }, [service, target.scopeKey]);

  const localFacts = useMemo((): LocalUsageFacts | undefined => {
    const { providerId, modelId, localBackend } = activeProviderRoute;
    if (providerId !== "local" && providerId !== "codexa-native" && providerId !== "codexa-cupy") {
      return undefined;
    }
    const metadata =
      activeContextMetadata?.providerId === providerId && activeContextMetadata.modelId === modelId
        ? activeContextMetadata
        : null;
    return {
      modelId,
      localBackend: localBackend ?? providerConfig?.localBackend,
      isLocalInference: isLocalRuntime(activeProviderRoute, providerConfig),
      contextWindow: metadata?.contextLength ?? null,
      contextConfidence: metadata?.confidence ?? null,
    };
  }, [activeContextMetadata, activeProviderRoute, providerConfig]);

  const refreshUsage = useCallback(() => {
    const { adapter, route, scopeKey } = target;
    const pending = service.request(adapter, {
      route,
      providerConfig,
      workspaceRoot,
      scopeKey,
      localFacts,
      googleMigrationRequired:
        route.providerId === "google" && providerWorkspaceConfig.googleMigrationRequired === true,
    });
    setView(service.peek(scopeKey));
    void pending.then((next) => {
      // Results for a scope the user has since left stay cached but never render.
      if (mountedRef.current && scopeRef.current === next.scopeKey) {
        setView(next);
      }
    });
  }, [
    localFacts,
    providerConfig,
    providerWorkspaceConfig.googleMigrationRequired,
    service,
    target,
    workspaceRoot,
  ]);

  const openUsagePanel = useCallback(() => {
    setScreen("usage-panel");
    refreshUsage();
  }, [refreshUsage, setScreen]);

  return {
    usageView: view,
    usageRefreshAvailableAt: target.adapter.passive ? 0 : view.nextRefreshAt,
    refreshUsage,
    openUsagePanel,
  };
}
