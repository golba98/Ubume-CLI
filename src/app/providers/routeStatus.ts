import { useMemo } from "react";
import { formatProviderRouteDiagnostics } from "../../commands/diagnosticsFormat.js";
import type { CodexModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import {
  formatContextCompact,
  type ModelContextMetadata,
} from "../../core/providerRuntime/contextMetadata.js";
import {
  getProviderRuntime,
  isProviderRouteConfigured,
} from "../../core/providerRuntime/registry.js";
import type { ProviderRoute, ProviderRuntime } from "../../core/providerRuntime/types.js";

interface UseRouteStatusContext {
  providerRegistry: ProviderConfig[];
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
  activeProviderRoute: ProviderRoute;
  activeContextMetadata: ModelContextMetadata | null;
  workspaceDefaultProvider: ProviderConfig;
  activeRouteProvider: ProviderConfig;
  activeProviderRuntime: ProviderRuntime;
  activeRouteModelCapabilities: CodexModelCapabilities | null;
  reasoningLevel: string;
}

export function useRouteStatus(context: UseRouteStatusContext) {
  const {
    providerRegistry,
    providerDiagnosticsRef,
    activeProviderRoute,
    activeContextMetadata,
    workspaceDefaultProvider,
    activeRouteProvider,
    activeProviderRuntime,
    activeRouteModelCapabilities,
    reasoningLevel,
  } = context;

  const routeStatusMessage = useMemo(() => {
    const providerLines = providerRegistry.map((provider) => {
      const runtime = getProviderRuntime(provider.id);
      const discovery = runtime.discoverModels();
      const routingStatus = runtime.routeAvailable
        ? isProviderRouteConfigured(provider.id)
          ? "configured"
          : "not configured"
        : "unavailable";

      let line = `  ${provider.displayName} routing: ${routingStatus} (${discovery.backendKind})`;

      line = formatProviderRouteDiagnostics(
        line,
        provider.id,
        providerDiagnosticsRef.current[provider.id],
      );

      return line;
    });

    const activeModelInfo = activeProviderRoute.modelId;

    const ctxValue =
      activeContextMetadata?.contextLength != null
        ? `${activeContextMetadata.confidence === "estimated" ? "~" : ""}${formatContextCompact(activeContextMetadata.contextLength)}`
        : "Unknown";
    const ctxSource =
      activeContextMetadata?.source && activeContextMetadata.source !== "unknown"
        ? ` (${activeContextMetadata.source})`
        : "";

    return [
      "Route status:",
      `  Workspace default provider: ${workspaceDefaultProvider?.displayName ?? "OpenAI"}`,
      `  Active chat route: ${activeRouteProvider?.displayName ?? "OpenAI"} / ${activeModelInfo}`,
      `  Context: ${ctxValue}${ctxSource}`,
      `  Backend kind: ${activeProviderRoute.backendKind}`,
      `  In-Ubume routing: ${activeProviderRuntime.routeAvailable ? (isProviderRouteConfigured(activeProviderRoute.providerId) ? "configured" : "not configured") : "unavailable"}`,
      `  External launch: ${activeRouteProvider?.launchCommand ? "Available" : "Unavailable"}`,
      ...(providerLines.length > 0 ? providerLines : []),
    ].join("\n");
  }, [
    activeContextMetadata,
    activeProviderRoute.backendKind,
    activeProviderRoute.modelId,
    activeProviderRoute.providerId,
    activeProviderRoute.reasoning,
    activeProviderRuntime.routeAvailable,
    activeRouteModelCapabilities,
    activeRouteProvider,
    providerRegistry,
    reasoningLevel,
    workspaceDefaultProvider,
  ]);
  return { routeStatusMessage };
}
