import { useCallback, useRef } from "react";

import type { LaunchArgs } from "../../config/launchArgs.js";
import { type LayeredConfigResult, resolveLayeredConfig } from "../../config/layeredConfig.js";

import {
  diffRuntimeConfig,
  mergeRuntimeConfig,
  type PartialRuntimeConfig,
  type RuntimeConfig,
} from "../../config/runtimeConfig.js";

import type {
  LocalBackendId,
  ProviderId,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import {
  saveProviderWorkspaceConfig,
  setProviderActiveRoute,
  setProviderDefaultModel,
  setProviderDefaultReasoning,
} from "../../core/providerLauncher/workspaceConfig.js";

import { getProviderRuntime } from "../../core/providerRuntime/registry.js";

import type { ProviderRoute } from "../../core/providerRuntime/types.js";

import { errorMessage } from "../../core/shared/values.js";

import type { ConversationRecord } from "../../core/workspace/conversationStore.js";

interface UseRuntimeSettingsContext {
  workspaceRoot: string;
  launchArgs: LaunchArgs;
  baseRuntimeConfigRef: React.RefObject<RuntimeConfig>;
  setBaseLayeredConfig: React.Dispatch<React.SetStateAction<LayeredConfigResult>>;
  setSessionRuntimeOverride: React.Dispatch<React.SetStateAction<PartialRuntimeConfig>>;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  setConversationRouteOverride: React.Dispatch<React.SetStateAction<ProviderRoute | null>>;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  setProviderWorkspaceConfig: React.Dispatch<React.SetStateAction<ProviderWorkspaceConfig>>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
}

export function useRuntimeSettings(context: UseRuntimeSettingsContext) {
  const {
    workspaceRoot,
    launchArgs,
    baseRuntimeConfigRef,
    setBaseLayeredConfig,
    setSessionRuntimeOverride,
    providerWorkspaceConfig,
    setConversationRouteOverride,
    routeChoiceRequiredRef,
    activeConversationRef,
    setProviderWorkspaceConfig,
    appendEvent,
  } = context;

  const configRef = useRef(providerWorkspaceConfig);
  configRef.current = providerWorkspaceConfig;

  const reloadBaseLayeredConfig = useCallback(() => {
    const nextConfig = resolveLayeredConfig({ workspaceRoot, launchArgs });
    baseRuntimeConfigRef.current = nextConfig.runtime;
    setBaseLayeredConfig(nextConfig);
    return nextConfig;
  }, [launchArgs, workspaceRoot]);

  const updateRuntimeConfig = useCallback((updater: (current: RuntimeConfig) => RuntimeConfig) => {
    setSessionRuntimeOverride((currentPatch) => {
      const baseRuntime = baseRuntimeConfigRef.current;
      const currentRuntime = mergeRuntimeConfig(baseRuntime, currentPatch);
      const nextRuntime = updater(currentRuntime);
      return diffRuntimeConfig(baseRuntime, nextRuntime);
    });
  }, []);

  const updateRuntimePolicy = useCallback(
    (updater: (current: RuntimeConfig["policy"]) => RuntimeConfig["policy"]) => {
      updateRuntimeConfig((current) => ({
        ...current,
        policy: updater(current.policy),
      }));
    },
    [updateRuntimeConfig],
  );

  const persistActiveRoute = useCallback(
    (
      providerId: ProviderId,
      nextModel: string,
      nextReasoning: string,
      backendKindOverride?: ReturnType<typeof getProviderRuntime>["backendKind"],
      localBackend?: LocalBackendId,
    ) => {
      try {
        const providerWorkspaceConfig = configRef.current;
        const runtime = getProviderRuntime(providerId);
        let nextConfig = setProviderActiveRoute(providerWorkspaceConfig, {
          providerId,
          modelId: nextModel,
          backendKind: backendKindOverride ?? runtime.backendKind,
          reasoning: nextReasoning,
          ...(providerId === "local"
            ? {
                localBackend:
                  localBackend ??
                  providerWorkspaceConfig.providers?.local?.localBackend ??
                  "lm-studio",
              }
            : {}),
        });
        if (
          nextConfig.activeRoute?.providerId !== providerId ||
          nextConfig.activeRoute.modelId !== nextModel
        )
          throw new Error("The provider route cannot be selected in this channel.");
        nextConfig = setProviderDefaultReasoning(
          setProviderDefaultModel(nextConfig, providerId, nextModel),
          providerId,
          nextReasoning,
        );
        saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
        configRef.current = nextConfig;
        setConversationRouteOverride(null);
        routeChoiceRequiredRef.current = null;
        const current = activeConversationRef.current;
        if (current && nextConfig.activeRoute)
          activeConversationRef.current = {
            ...current,
            metadata: { ...current.metadata, ...nextConfig.activeRoute },
          };
        setProviderWorkspaceConfig(nextConfig);
        return true;
      } catch (error) {
        const message = errorMessage(error, "Unable to save active route.");
        appendEvent("error", "Route save failed", message);
        return false;
      }
    },
    [appendEvent, providerWorkspaceConfig, workspaceRoot],
  );

  const persistProviderDefaultModelAndReasoning = useCallback(
    (providerId: ProviderId, modelId: string, nextReasoning: string) => {
      try {
        const withModel = setProviderDefaultModel(configRef.current, providerId, modelId);
        const nextConfig = setProviderDefaultReasoning(withModel, providerId, nextReasoning);
        saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
        configRef.current = nextConfig;
        setProviderWorkspaceConfig(nextConfig);
      } catch (error) {
        const message = errorMessage(error, "Unable to save provider defaults.");
        appendEvent("error", "Provider defaults save failed", message);
      }
    },
    [appendEvent, providerWorkspaceConfig, workspaceRoot],
  );
  return {
    reloadBaseLayeredConfig,
    updateRuntimeConfig,
    updateRuntimePolicy,
    persistActiveRoute,
    persistProviderDefaultModelAndReasoning,
  };
}
