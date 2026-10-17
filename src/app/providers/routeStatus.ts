/**
 * The `/status` route report: which provider is the workspace default, which
 * route chats use, its context window, and every provider's routing state
 * with its diagnostics.
 */

import { useMemo } from "react";
import { formatProviderRouteDiagnostics } from "../../commands/diagnosticsFormat.js";
import type { CodexModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import type { ProviderConfig, ProviderId } from "../../core/providerLauncher/types.js";
import {
  formatContextCompact,
  type ModelContextMetadata,
} from "../../core/providerRuntime/contextMetadata.js";
import {
  getProviderRuntime,
  isProviderRouteConfigured,
} from "../../core/providerRuntime/registry.js";
import type { ProviderRoute, ProviderRuntime } from "../../core/providerRuntime/types.js";

type ProviderDiagnostics = Record<string, Record<string, string | number | boolean | null>>;

interface UseRouteStatusContext {
  providerRegistry: ProviderConfig[];
  providerDiagnosticsRef: React.RefObject<ProviderDiagnostics>;
  activeProviderRoute: ProviderRoute;
  activeContextMetadata: ModelContextMetadata | null;
  workspaceDefaultProvider: ProviderConfig;
  activeRouteProvider: ProviderConfig;
  activeProviderRuntime: ProviderRuntime;
  activeRouteModelCapabilities: CodexModelCapabilities | null;
  reasoningLevel: string;
}

/** Whether Ubume itself can send chats to a provider. */
function routingStatus(routeAvailable: boolean, providerId: ProviderId): string {
  if (!routeAvailable) {
    return "unavailable";
  }
  return isProviderRouteConfigured(providerId) ? "configured" : "not configured";
}

/** The active context window with its source, e.g. "~128K (registry)" or "Unknown". */
function formatContextLine(metadata: ModelContextMetadata | null): string {
  const value =
    metadata?.contextLength != null
      ? `${metadata.confidence === "estimated" ? "~" : ""}${formatContextCompact(metadata.contextLength)}`
      : "Unknown";
  const source = metadata?.source && metadata.source !== "unknown" ? ` (${metadata.source})` : "";
  return `${value}${source}`;
}

/** Builds the full route status report. */
export function formatRouteStatus(input: {
  providerRegistry: readonly ProviderConfig[];
  diagnostics: ProviderDiagnostics;
  activeProviderRoute: ProviderRoute;
  activeContextMetadata: ModelContextMetadata | null;
  workspaceDefaultProvider: ProviderConfig | null;
  activeRouteProvider: ProviderConfig | null;
  activeRouteAvailable: boolean;
}): string {
  const route = input.activeProviderRoute;
  const providerLines = input.providerRegistry.map((provider) => {
    const runtime = getProviderRuntime(provider.id);
    const { backendKind } = runtime.discoverModels();
    const status = routingStatus(runtime.routeAvailable, provider.id);
    return formatProviderRouteDiagnostics(
      `  ${provider.displayName} routing: ${status} (${backendKind})`,
      provider.id,
      input.diagnostics[provider.id],
    );
  });

  return [
    "Route status:",
    `  Workspace default provider: ${input.workspaceDefaultProvider?.displayName ?? "OpenAI"}`,
    `  Active chat route: ${input.activeRouteProvider?.displayName ?? "OpenAI"} / ${route.modelId}`,
    `  Context: ${formatContextLine(input.activeContextMetadata)}`,
    `  Backend kind: ${route.backendKind}`,
    `  In-Ubume routing: ${routingStatus(input.activeRouteAvailable, route.providerId)}`,
    `  External launch: ${input.activeRouteProvider?.launchCommand ? "Available" : "Unavailable"}`,
    ...providerLines,
  ].join("\n");
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

  const routeStatusMessage = useMemo(
    () =>
      formatRouteStatus({
        providerRegistry,
        diagnostics: providerDiagnosticsRef.current,
        activeProviderRoute,
        activeContextMetadata,
        workspaceDefaultProvider,
        activeRouteProvider,
        activeRouteAvailable: activeProviderRuntime.routeAvailable,
      }),
    // Diagnostics live in a ref. providerRegistry is rebuilt whenever they
    // change (registry nonce), and the model/reasoning entries re-read them
    // after a route change, so the report never shows stale diagnostics.
    [
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
    ],
  );

  return { routeStatusMessage };
}
