/**
 * Runtime configuration for the session, and provider route persistence.
 *
 * - The effective runtime config is the layered TOML config
 *   (`baseLayeredConfig`) plus a session override patch. `updateRuntimeConfig`
 *   stores only the difference from the base, so a config reload is not
 *   shadowed by values the user never changed.
 * - `providers.json` (workspace provider config) is written only through
 *   `updateProviderWorkspaceConfig`, which applies changes to the latest saved
 *   config. `persistActiveRoute` builds on it: it saves the route first and
 *   returns false (after reporting the error) when the save fails, so a
 *   caller never publishes a route that is not on disk.
 */

import { useCallback, useRef } from "react";

import type { LaunchArgs } from "../../config/launchArgs.js";
import { type LayeredConfigResult, resolveLayeredConfig } from "../../config/layeredConfig.js";

import {
  diffRuntimeConfig,
  mergeRuntimeConfig,
  type PartialRuntimeConfig,
  type RuntimeConfig,
} from "../../config/runtimeConfig.js";
import { resolveLocalBackend } from "../../core/providerLauncher/localBackend.js";
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
  // Workspace and launch
  workspaceRoot: string;
  launchArgs: LaunchArgs;

  // Runtime config state
  baseRuntimeConfigRef: React.RefObject<RuntimeConfig>;
  setBaseLayeredConfig: React.Dispatch<React.SetStateAction<LayeredConfigResult>>;
  setSessionRuntimeOverride: React.Dispatch<React.SetStateAction<PartialRuntimeConfig>>;

  // Provider config and route
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  setProviderWorkspaceConfig: React.Dispatch<React.SetStateAction<ProviderWorkspaceConfig>>;
  setConversationRouteOverride: React.Dispatch<React.SetStateAction<ProviderRoute | null>>;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  activeConversationRef: React.RefObject<ConversationRecord | null>;

  // Feedback
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

  // The newest provider config, including writes React has not rendered yet.
  const configRef = useRef(providerWorkspaceConfig);
  configRef.current = providerWorkspaceConfig;

  /** Re-reads the layered TOML config (for example after a trust change). */
  const reloadBaseLayeredConfig = useCallback(() => {
    const nextConfig = resolveLayeredConfig({ workspaceRoot, launchArgs });
    baseRuntimeConfigRef.current = nextConfig.runtime;
    setBaseLayeredConfig(nextConfig);
    return nextConfig;
  }, [launchArgs, workspaceRoot]);

  /** Applies `updater` to the effective runtime config for this session. */
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

  /**
   * Applies `transform` to the newest provider workspace config, saves it and
   * publishes it to React state.
   *
   * Every write to `providers.json` goes through here so that it merges against
   * the latest saved config (tracked in `configRef`) rather than a snapshot a
   * callback captured when it was created. Throws when the save fails; callers
   * own the user-facing error.
   */
  const updateProviderWorkspaceConfig = useCallback(
    (transform: (latest: ProviderWorkspaceConfig) => ProviderWorkspaceConfig) => {
      const nextConfig = transform(configRef.current);
      saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
      configRef.current = nextConfig;
      setProviderWorkspaceConfig(nextConfig);
      return nextConfig;
    },
    [workspaceRoot],
  );

  /**
   * Saves `providerId`/`nextModel` as the active route and as that provider's
   * default model and reasoning. Also clears a resumed conversation's route
   * override and records the route in the active conversation's metadata.
   *
   * Returns false when the route is not selectable in this channel or the
   * save failed; the previous route and preferences are then unchanged.
   */
  const persistActiveRoute = useCallback(
    (
      providerId: ProviderId,
      nextModel: string,
      nextReasoning: string,
      backendKindOverride?: ReturnType<typeof getProviderRuntime>["backendKind"],
      localBackend?: LocalBackendId,
    ) => {
      try {
        // Build the next route, resolving the local backend when needed.
        const providerWorkspaceConfig = configRef.current;
        const runtime = getProviderRuntime(providerId);
        let nextConfig = setProviderActiveRoute(providerWorkspaceConfig, {
          providerId,
          modelId: nextModel,
          backendKind: backendKindOverride ?? runtime.backendKind,
          reasoning: nextReasoning,
          ...(providerId === "local"
            ? { localBackend: resolveLocalBackend(providerWorkspaceConfig, localBackend) }
            : {}),
        });

        // The route must actually be selectable in this channel.
        if (
          nextConfig.activeRoute?.providerId !== providerId ||
          nextConfig.activeRoute.modelId !== nextModel
        )
          throw new Error("The provider route cannot be selected in this channel.");

        // Persist the provider's default model and reasoning alongside the route.
        nextConfig = setProviderDefaultReasoning(
          setProviderDefaultModel(nextConfig, providerId, nextModel),
          providerId,
          nextReasoning,
        );
        updateProviderWorkspaceConfig(() => nextConfig);

        // A resumed conversation no longer needs its saved route override.
        setConversationRouteOverride(null);
        routeChoiceRequiredRef.current = null;

        // Record the route in the active conversation's metadata.
        const current = activeConversationRef.current;
        if (current && nextConfig.activeRoute) {
          activeConversationRef.current = {
            ...current,
            metadata: { ...current.metadata, ...nextConfig.activeRoute },
          };
        }

        return true;
      } catch (error) {
        const message = errorMessage(error, "Unable to save active route.");
        appendEvent("error", "Route save failed", message);
        return false;
      }
    },
    [appendEvent, updateProviderWorkspaceConfig],
  );

  /** Saves a provider's default model and reasoning without changing the active route. */
  const persistProviderDefaultModelAndReasoning = useCallback(
    (providerId: ProviderId, modelId: string, nextReasoning: string) => {
      try {
        updateProviderWorkspaceConfig((latest) =>
          setProviderDefaultReasoning(
            setProviderDefaultModel(latest, providerId, modelId),
            providerId,
            nextReasoning,
          ),
        );
      } catch (error) {
        const message = errorMessage(error, "Unable to save provider defaults.");
        appendEvent("error", "Provider defaults save failed", message);
      }
    },
    [appendEvent, updateProviderWorkspaceConfig],
  );
  return {
    reloadBaseLayeredConfig,
    updateRuntimeConfig,
    updateRuntimePolicy,
    updateProviderWorkspaceConfig,
    persistActiveRoute,
    persistProviderDefaultModelAndReasoning,
  };
}
