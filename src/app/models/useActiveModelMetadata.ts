/**
 * Capabilities and context-window metadata for the model on the active route.
 *
 * Capabilities come from the OpenAI capability snapshot or, for other
 * providers, from their model catalog. The context length is resolved
 * asynchronously (some providers need a lookup) and published to both the
 * session state and the provider's diagnostics.
 */

import { useEffect, useMemo } from "react";
import {
  type CodexModelCapabilities,
  findModelCapability,
} from "../../core/models/codexModelCapabilities.js";
import { resolveModelContextLength } from "../../core/providerRuntime/contextMetadata.js";
import { providerModelsToCodexCapabilities } from "../../core/providerRuntime/models.js";
import { discoverProviderModels } from "../../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { useAppState } from "../state/useAppState.js";

type AppState = ReturnType<typeof useAppState>;

interface UseActiveModelMetadataContext
  extends Pick<
    AppState,
    | "providerWorkspaceConfig"
    | "registryNonce"
    | "setRegistryNonce"
    | "setActiveContextMetadata"
    | "isMountedRef"
  > {
  activeProviderRoute: ProviderRoute;
  modelCapabilities: CodexModelCapabilities | null;
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
}

type ReasoningSourceLabel =
  | "Discovered from Claude Code"
  | "From Claude settings"
  | "Fallback defaults"
  | "Fallback defaults; unverified";

/** Label for where Claude's reasoning options came from, shown in the reasoning picker. */
function claudeReasoningSourceLabel(raw: unknown): ReasoningSourceLabel {
  const metadata = raw as { source?: string; effortVerified?: boolean } | null | undefined;
  if (metadata?.source === "claude-code" || metadata?.source === "discovered") {
    return "Discovered from Claude Code";
  }
  if (metadata?.source === "settings" || metadata?.source === "config") {
    return "From Claude settings";
  }
  return metadata?.effortVerified === false ? "Fallback defaults; unverified" : "Fallback defaults";
}

export function useActiveModelMetadata(context: UseActiveModelMetadataContext) {
  const {
    providerWorkspaceConfig,
    registryNonce,
    setRegistryNonce,
    setActiveContextMetadata,
    isMountedRef,
    activeProviderRoute,
    modelCapabilities,
    providerDiagnosticsRef,
  } = context;

  const activeRouteModelCapabilities = useMemo(() => {
    if (activeProviderRoute.providerId === "openai") return modelCapabilities;
    const discovery = discoverProviderModels(activeProviderRoute.providerId);
    return providerModelsToCodexCapabilities(discovery.models, activeProviderRoute.modelId);
    // Local startup discovery mutates the runtime cache without necessarily
    // changing the restored model id. Re-read it when the registry nonce moves
    // so discovered context metadata can replace the initial Unknown value.
  }, [
    activeProviderRoute.modelId,
    activeProviderRoute.providerId,
    modelCapabilities,
    registryNonce,
  ]);

  const currentModelCapability = useMemo(
    () => findModelCapability(activeRouteModelCapabilities, activeProviderRoute.modelId),
    [activeProviderRoute.modelId, activeRouteModelCapabilities],
  );

  // A stable string key for the model's raw metadata: the context-length effect
  // depends on the metadata's content, not on the identity of a fresh object.
  const currentModelRawMetadataKey = useMemo(
    () =>
      currentModelCapability?.raw === undefined ? "" : JSON.stringify(currentModelCapability.raw),
    [currentModelCapability?.raw],
  );

  const currentReasoningCapabilities = currentModelCapability?.supportedReasoningLevels ?? [];

  const currentReasoningSourceLabel = useMemo(
    () =>
      activeProviderRoute.providerId === "anthropic"
        ? claudeReasoningSourceLabel(currentModelCapability?.raw)
        : null,
    [activeProviderRoute.providerId, currentModelCapability],
  );

  useEffect(() => {
    let cancelled = false;
    const providerId = activeProviderRoute.providerId;

    void resolveModelContextLength({
      providerId,
      modelId: activeProviderRoute.modelId,
      providerConfig: providerWorkspaceConfig.providers?.[providerId],
      rawMetadata: currentModelCapability?.raw,
    }).then((metadata) => {
      if (cancelled || !isMountedRef.current) {
        return;
      }
      setActiveContextMetadata(metadata);
      providerDiagnosticsRef.current[providerId] = {
        ...(providerDiagnosticsRef.current[providerId] ?? {}),
        contextLength: metadata.contextLength,
        contextSource: metadata.source === "known-registry" ? "registry" : metadata.source,
        contextConfidence: metadata.confidence,
        contextRawField: metadata.rawField ?? null,
        contextError: metadata.error ?? null,
      };
      setRegistryNonce((current) => current + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeProviderRoute.modelId,
    activeProviderRoute.providerId,
    currentModelRawMetadataKey,
    providerWorkspaceConfig.providers,
  ]);

  return {
    activeRouteModelCapabilities,
    currentModelCapability,
    currentReasoningCapabilities,
    currentReasoningSourceLabel,
  };
}
