import { spawn } from "node:child_process";
import { useCallback, useEffect } from "react";
import type { ResolvedRuntimeConfig, RuntimeConfig } from "../../config/runtimeConfig.js";
import type { AvailableModel, ReasoningLevel } from "../../config/settings.js";
import { resolveVibeExecutable } from "../../core/executables/executableResolver.js";
import type { CodexModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import { catalogContextKey } from "../../core/models/modelCatalog.js";
import {
  isCatalogModelUnavailable,
  resolveCatalogModel,
} from "../../core/models/modelSelection.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import { commandExistsOnPath, launchProviderCli } from "../../core/providerLauncher/launcher.js";
import { findProvider } from "../../core/providerLauncher/registry.js";
import type {
  LocalBackendId,
  ProviderConfig,
  ProviderId,
  ProviderPickerAction,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import {
  saveProviderWorkspaceConfig,
  setLocalBackendPreference,
  setProviderWorkspaceDefault,
} from "../../core/providerLauncher/workspaceConfig.js";
import { validateAntigravityRoute } from "../../core/providerRuntime/antigravity.js";
import { unloadCodexaNative } from "../../core/providerRuntime/codexaNative.js";
import { runLocalDiagnostics, validateLocalProvider } from "../../core/providerRuntime/local.js";
import {
  detectVibeActiveModel,
  launchMistralVibeCli,
} from "../../core/providerRuntime/mistralVibe.js";
import {
  discoverProviderModels,
  getProviderSetupPlan,
  isProviderRoutableInUbume,
  isProviderRouteConfigured,
} from "../../core/providerRuntime/registry.js";
import type {
  ProviderModel,
  ProviderRoute,
  ProviderRouteValidationResult,
  RuntimeAvailability,
} from "../../core/providerRuntime/types.js";

import { errorMessage } from "../../core/shared/values.js";

import type { Screen } from "../../session/types.js";

import { FOCUS_IDS } from "../../ui/input/focus.js";

import type { LocalBackendStatus } from "../../ui/panels/ProviderPicker.js";

interface UseProviderRouteContext {
  selectionCoordinator: SelectionCoordinator;
  setRouteSwitchBusy: React.Dispatch<React.SetStateAction<boolean>>;
  localBackendCheckInFlightRef: React.RefObject<
    Map<LocalBackendId, Promise<ProviderRouteValidationResult>>
  >;
  setLocalBackendStatuses: React.Dispatch<
    React.SetStateAction<Record<LocalBackendId, LocalBackendStatus>>
  >;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  isMountedRef: React.RefObject<boolean>;
  modelPickerOpenRef: React.RefObject<boolean>;
  modelSelectionInFlightRef: React.RefObject<boolean>;
  setPendingRouteProviderId: React.Dispatch<React.SetStateAction<ProviderId | null>>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
  workspaceRoot: string;
  setRegistryNonce: React.Dispatch<React.SetStateAction<number>>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  busy: boolean;
  providerRegistry: ProviderConfig[];
  setProviderWorkspaceConfig: React.Dispatch<React.SetStateAction<ProviderWorkspaceConfig>>;
  activeRouteProvider: ProviderConfig;
  model: string;
  providerRouteErrorsRef: React.RefObject<Record<string, string>>;
  intendedInputModeRef: React.RefObject<"chat/input" | "model-picker">;
  intendedFocusTargetRef: React.RefObject<string>;
  setModelAndReasoningWithNotice: (
    nextModel: AvailableModel,
    nextReasoning: ReasoningLevel,
    providerId?: ProviderId,
    localBackend?: LocalBackendId,
  ) => Promise<void>;
  activeProviderRoute: ProviderRoute;
  reasoningLevel: string;
  ensureProviderModels: (providerId: ProviderId, forceRefresh?: boolean) => Promise<unknown>;
  modelCapabilities: CodexModelCapabilities | null;
  refreshModelCapabilities: (
    forceRefresh?: boolean,
    announce?: boolean,
  ) => Promise<CodexModelCapabilities>;
  markProviderAvailability: (
    providerId: ProviderId,
    availability: RuntimeAvailability,
    reason: string,
  ) => void;
  runtimeConfig: RuntimeConfig;
  resolvedRuntimeConfig: ResolvedRuntimeConfig;
  providerLaunchBypassRef: React.RefObject<boolean>;
  setProviderSetup: React.Dispatch<React.SetStateAction<ProviderId | null>>;
  providerActionRef: React.RefObject<
    | ((
        providerId: ProviderId,
        action: ProviderPickerAction,
        localBackend?: LocalBackendId,
      ) => void)
    | null
  >;
  busyRef: React.RefObject<boolean>;
  externalCliLaunchHooks: {
    stdin: NodeJS.ReadStream;
    beforeLaunch: () => void;
    afterLaunch: () => void;
  };
}

/**
 * Whether a provider's saved model can be used directly when the provider is
 * selected. Registry placeholders ("Google default", "Claude Code default") are
 * not choices, but a "… default" entry the provider's own catalog lists is —
 * Mistral's "Vibe default" runs whatever model Vibe itself has active.
 */
export function isUsableSavedModel(
  model: string | undefined,
  catalog: readonly ProviderModel[],
  catalogVerified = false,
): boolean {
  if (!model) return false;
  if (catalogVerified) {
    const descriptor = resolveCatalogModel(catalog, model);
    return descriptor !== undefined && descriptor.available !== false;
  }
  if (!model.endsWith("default")) return true;
  return resolveCatalogModel(catalog, model) !== undefined;
}

export function useProviderRoute(context: UseProviderRouteContext) {
  const {
    selectionCoordinator,
    setRouteSwitchBusy,
    localBackendCheckInFlightRef,
    setLocalBackendStatuses,
    providerWorkspaceConfig,
    isMountedRef,
    modelPickerOpenRef,
    modelSelectionInFlightRef,
    setPendingRouteProviderId,
    setScreen,
    providerDiagnosticsRef,
    workspaceRoot,
    setRegistryNonce,
    appendEvent,
    busy,
    providerRegistry,
    setProviderWorkspaceConfig,
    activeRouteProvider,
    model,
    providerRouteErrorsRef,
    intendedInputModeRef,
    intendedFocusTargetRef,
    setModelAndReasoningWithNotice,
    activeProviderRoute,
    reasoningLevel,
    ensureProviderModels,
    modelCapabilities,
    refreshModelCapabilities,
    markProviderAvailability,
    resolvedRuntimeConfig,
    providerLaunchBypassRef,
    setProviderSetup,
    providerActionRef,
    busyRef,
    externalCliLaunchHooks,
  } = context;

  const probeLocalBackend = useCallback(
    (localBackend: LocalBackendId) => {
      const existing = localBackendCheckInFlightRef.current.get(localBackend);
      if (existing) return existing;

      setLocalBackendStatuses((current) => ({
        ...current,
        [localBackend]: {
          state: "checking",
          label:
            current[localBackend]?.state === "ready"
              ? `Last seen: ${current[localBackend]?.label} · Checking…`
              : "Checking…",
        },
      }));
      const promise = validateLocalProvider({
        override: { ...providerWorkspaceConfig.providers?.local, localBackend },
        localBackend,
      })
        .then((validation) => {
          const selectedModel =
            typeof validation.diagnostics?.selectedModel === "string"
              ? validation.diagnostics.selectedModel.trim()
              : "";
          const message = validation.message ?? "";
          const endpointResult = validation.diagnostics?.endpointCheckResult;
          const status: LocalBackendStatus =
            validation.status === "ready"
              ? { state: "ready", label: selectedModel || "Model loaded" }
              : endpointResult === "no-models" ||
                  /no model is loaded|no models were returned/i.test(message)
                ? { state: "no-model", label: "No model loaded" }
                : /timed out/i.test(message)
                  ? { state: "timeout", label: "Check timed out" }
                  : /api key|authentication|authenticate|identity/i.test(message)
                    ? { state: "auth-required", label: "Authentication required" }
                    : { state: "not-running", label: "Not running" };
          if (isMountedRef.current) {
            setLocalBackendStatuses((current) => ({ ...current, [localBackend]: status }));
          }
          return validation;
        })
        .catch((error) => {
          if (isMountedRef.current) {
            const message = errorMessage(error);
            setLocalBackendStatuses((current) => ({
              ...current,
              [localBackend]: /api key|authentication|authenticate|identity/i.test(message)
                ? { state: "auth-required", label: "Authentication required" }
                : { state: "not-running", label: "Not running" },
            }));
          }
          throw error;
        })
        .finally(() => {
          localBackendCheckInFlightRef.current.delete(localBackend);
        });
      localBackendCheckInFlightRef.current.set(localBackend, promise);
      return promise;
    },
    [providerWorkspaceConfig.providers],
  );

  useEffect(() => {
    void unloadCodexaNative("Active provider or checkpoint changed.");
    return () => {
      void unloadCodexaNative("Ubume closed or checkpoint changed.");
    };
  }, [activeProviderRoute.providerId, activeProviderRoute.modelId]);

  const probeLocalBackends = useCallback(() => {
    void Promise.allSettled([probeLocalBackend("lm-studio"), probeLocalBackend("unsloth")]);
  }, [probeLocalBackend]);

  const openProviderPicker = useCallback(() => {
    modelPickerOpenRef.current = false;
    selectionCoordinator.navigate();
    setScreen("provider-picker");
    providerDiagnosticsRef.current.mistral = {
      ...providerDiagnosticsRef.current.mistral,
      selectedModel: detectVibeActiveModel({ cwd: workspaceRoot }).modelId,
      availabilityStatus: "checking",
    };
    void resolveVibeExecutable({ cwd: workspaceRoot })
      .then((resolvedCommand) => {
        if (!isMountedRef.current) return;
        const modelDetection = detectVibeActiveModel({ cwd: workspaceRoot });
        providerDiagnosticsRef.current.mistral = {
          resolvedCommand,
          selectedModel: modelDetection.modelId,
          modelSource: modelDetection.source,
          configPath: modelDetection.configPath,
          availabilityStatus: resolvedCommand ? "available" : "unavailable",
        };
        setRegistryNonce((n) => n + 1);
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        providerDiagnosticsRef.current.mistral = {
          selectedModel: detectVibeActiveModel({ cwd: workspaceRoot }).modelId,
          resolvedCommand: null,
          availabilityStatus: "unavailable",
        };
        setRegistryNonce((n) => n + 1);
      });
  }, [appendEvent, busy, workspaceRoot, selectionCoordinator]);

  const setWorkspaceDefaultProviderWithNotice = useCallback(
    (providerId: ProviderId) => {
      const provider = findProvider(providerRegistry, providerId);
      if (!provider) {
        appendEvent("error", "Provider unavailable", `Unknown provider: ${providerId}`);
        return;
      }

      try {
        const nextConfig = setProviderWorkspaceDefault(providerWorkspaceConfig, providerId);
        saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
        setProviderWorkspaceConfig(nextConfig);
        setScreen("main");
        const routeConfigured = isProviderRouteConfigured(providerId);
        appendEvent(
          "system",
          "Provider default updated",
          provider.routeMode === "launch-only"
            ? `${provider.displayName} is now the workspace default external CLI. Active chat route remains ${activeRouteProvider?.displayName ?? "OpenAI"} / ${model}.`
            : provider.routeMode === "in-ubume" && routeConfigured
              ? `${provider.displayName} is now the workspace default provider. Active chat route remains ${activeRouteProvider?.displayName ?? "OpenAI"} / ${model}.`
              : `${provider.displayName} is set as the workspace default, but in-Ubume routing is not configured yet. Active chat route remains ${activeRouteProvider?.displayName ?? "OpenAI"} / ${model}.`,
        );
      } catch (error) {
        const message = errorMessage(error, "Unable to save provider workspace config.");
        appendEvent("error", "Provider default failed", message);
      }
    },
    [
      activeRouteProvider,
      appendEvent,
      appendEvent,
      model,
      providerRegistry,
      providerWorkspaceConfig,
      workspaceRoot,
    ],
  );

  const handleProviderAction = useCallback(
    (
      providerId: ProviderId,
      action: ProviderPickerAction,
      selectedLocalBackend?: LocalBackendId,
    ) => {
      if (action === "use-in-ubume" || action === "select-model" || action === "cancel") {
        selectionCoordinator.navigate(providerId);
        selectionCoordinator.cancel();
        modelSelectionInFlightRef.current = false;
        setRouteSwitchBusy(false);
      }
      const navigation = selectionCoordinator.navigationToken;
      if (action === "cancel") {
        modelPickerOpenRef.current = false;
        setScreen("main");
        return;
      }

      if (action === "set-default") {
        setWorkspaceDefaultProviderWithNotice(providerId);
        return;
      }

      const provider = findProvider(providerRegistry, providerId);
      if (!provider) {
        setScreen("main");
        appendEvent("error", "Provider unavailable", `Unknown provider: ${providerId}`);
        return;
      }

      if (action === "use-in-ubume") {
        if (!isProviderRoutableInUbume(providerId)) {
          const message = provider.isDefault
            ? `${provider.displayName} is set as the workspace default, but in-Ubume routing is not configured yet.`
            : `${provider.displayName} in-Ubume routing is not configured yet.`;
          if (providerRouteErrorsRef.current[providerId] !== message) {
            appendEvent("system", "Provider route unavailable", message);
            providerRouteErrorsRef.current[providerId] = message;
          }
          return;
        }

        if (providerId === "local") {
          const localBackend =
            selectedLocalBackend ??
            providerWorkspaceConfig.providers?.local?.localBackend ??
            "lm-studio";
          const preferredConfig = setLocalBackendPreference(providerWorkspaceConfig, localBackend);
          saveProviderWorkspaceConfig(workspaceRoot, preferredConfig);
          setProviderWorkspaceConfig(preferredConfig);
          void probeLocalBackend(localBackend)
            .then((validation) => {
              if (!isMountedRef.current || selectionCoordinator.navigationToken !== navigation)
                return;
              if (validation.diagnostics) {
                providerDiagnosticsRef.current["local"] = validation.diagnostics as Record<
                  string,
                  string | number | boolean | null
                >;
              }
              if (validation.status !== "ready") {
                const message = validation.message ?? "Local provider unavailable.";
                providerRouteErrorsRef.current["local"] = message;
                setRegistryNonce((n) => n + 1);
                return;
              }
              delete providerRouteErrorsRef.current["local"];
              const selectedModel =
                typeof validation.diagnostics?.selectedModel === "string" &&
                validation.diagnostics.selectedModel.trim()
                  ? validation.diagnostics.selectedModel.trim()
                  : provider.currentModel;
              setRegistryNonce((n) => n + 1);
              intendedInputModeRef.current = "chat/input";
              intendedFocusTargetRef.current = FOCUS_IDS.composer;
              setScreen("main");
              void setModelAndReasoningWithNotice(
                selectedModel as AvailableModel,
                (providerWorkspaceConfig.providers?.local?.currentReasoning ??
                  activeProviderRoute.reasoning ??
                  reasoningLevel) as ReasoningLevel,
                "local",
                localBackend,
              );
            })
            .catch(() => undefined);
          return;
        }

        const workspaceProviderConfig = providerWorkspaceConfig.providers?.[providerId];
        const activeRoute = providerWorkspaceConfig.activeRoute;
        const isCurrentActive = activeRoute?.providerId === providerId;

        const discovery = discoverProviderModels(providerId);
        const preferredModel = workspaceProviderConfig?.currentModel ?? provider.currentModel;
        const connection = catalogContextKey(providerId, {
          cwd: workspaceRoot,
          providerConfig: workspaceProviderConfig,
        });
        const rejected =
          selectionCoordinator.state(connection, preferredModel)?.status === "unavailable";
        const isRealModel =
          !rejected &&
          !isCatalogModelUnavailable(discovery, preferredModel) &&
          isUsableSavedModel(
            preferredModel,
            discovery.models,
            discovery.freshness === "verified" && discovery.complete === true,
          );

        const providerReasoning =
          workspaceProviderConfig?.currentReasoning ??
          (isCurrentActive ? activeRoute?.reasoning : undefined) ??
          (providerId === "google"
            ? (resolveCatalogModel(
                discoverProviderModels("google").models,
                workspaceProviderConfig?.currentModel ?? provider.currentModel,
              )?.defaultReasoningLevel ?? "")
            : reasoningLevel);

        if (isRealModel) {
          intendedInputModeRef.current = "chat/input";
          intendedFocusTargetRef.current = FOCUS_IDS.composer;
          setScreen("main");
          void setModelAndReasoningWithNotice(
            (workspaceProviderConfig?.currentModel ?? provider.currentModel) as AvailableModel,
            providerReasoning as ReasoningLevel,
            providerId,
          );
          return;
        }

        // No clear model to use, open the picker.
        void ensureProviderModels(providerId);
        setPendingRouteProviderId(providerId);
        modelPickerOpenRef.current = true;
        intendedInputModeRef.current = "model-picker";
        intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
        setScreen("model-picker");
        return;
      }

      if (action === "select-model") {
        if (providerId === "openai" && !modelCapabilities) {
          void refreshModelCapabilities(false, false);
        }
        void ensureProviderModels(providerId);
        setPendingRouteProviderId(providerId);
        modelPickerOpenRef.current = true;
        intendedInputModeRef.current = "model-picker";
        intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
        setScreen("model-picker");
        return;
      }

      if (action === "refresh-models") {
        if (!isProviderRoutableInUbume(providerId)) {
          const message = provider.isDefault
            ? `${provider.displayName} is set as the workspace default, but in-Ubume routing is not configured yet.`
            : `${provider.displayName} in-Ubume routing is not configured yet.`;
          if (providerRouteErrorsRef.current[providerId] !== message) {
            appendEvent("system", "Provider route unavailable", message);
            providerRouteErrorsRef.current[providerId] = message;
          }
          return;
        }

        appendEvent(
          "system",
          "Model discovery",
          `Refreshing models for ${provider.displayName}...`,
        );
        void ensureProviderModels(providerId, true)
          .then(() => {
            const discovery = discoverProviderModels(providerId);
            appendEvent(
              discovery.freshness === "unverified" ? "error" : "system",
              "Model discovery",
              discovery.message ??
                `Loaded ${discovery.models.length} models for ${provider.displayName}.`,
            );
            setRegistryNonce((n) => n + 1);
          })
          .catch(() => appendEvent("error", "Model discovery", "Model refresh failed."));
        return;
      }

      if (action === "run-diagnostics") {
        if (providerId !== "google" && providerId !== "local") {
          appendEvent(
            "error",
            "Provider diagnostics unavailable",
            `Diagnostics are not implemented for ${provider.displayName}.`,
          );
          return;
        }

        setScreen("main");
        if (providerId === "local") {
          appendEvent("system", "Local diagnostics", "Running Local provider diagnostics...");
          void runLocalDiagnostics({
            localConfig: providerWorkspaceConfig.providers?.local,
          })
            .then((message) => {
              if (!isMountedRef.current) return;
              const discovery = discoverProviderModels("local");
              if (discovery.diagnostics) {
                providerDiagnosticsRef.current["local"] = discovery.diagnostics as Record<
                  string,
                  string | number | boolean | null
                >;
              }
              if (discovery.status === "ready") {
                delete providerRouteErrorsRef.current["local"];
              } else if (discovery.message) {
                providerRouteErrorsRef.current["local"] = discovery.message;
              }
              appendEvent("system", "Local diagnostics", message);
              setRegistryNonce((n) => n + 1);
            })
            .catch((error) => {
              if (!isMountedRef.current) return;
              appendEvent("error", "Local diagnostics failed", errorMessage(error));
            });
          return;
        }

        appendEvent("system", "Google diagnostics", "Running Google provider diagnostics...");
        const antigravityCommandPath =
          providerWorkspaceConfig.providers?.google?.antigravityCommandPath;
        void validateAntigravityRoute({
          cwd: workspaceRoot,
          configuredPath: antigravityCommandPath,
        })
          .then((validation) => {
            if (!isMountedRef.current) return;
            if (validation.diagnostics) {
              providerDiagnosticsRef.current["google"] = validation.diagnostics as Record<
                string,
                string | number | boolean | null
              >;
            }
            if (validation.status === "ready") {
              delete providerRouteErrorsRef.current["google"];
              const discovery = discoverProviderModels("google");
              appendEvent(
                "system",
                "Google diagnostics",
                validation.message ??
                  `Google Antigravity CLI is ready (${discovery.models.length} models available).`,
              );
            } else {
              const message = validation.message ?? "Google Antigravity CLI is unavailable.";
              providerRouteErrorsRef.current["google"] = message;
              appendEvent("error", "Google diagnostics failed", message);
            }
            setRegistryNonce((n) => n + 1);
          })
          .catch((error) => {
            if (!isMountedRef.current) return;
            const message = errorMessage(error, "Google diagnostics failed.");
            appendEvent("error", "Google diagnostics failed", message);
          });
        return;
      }

      // Do a real executable preflight before launching any external provider.
      // A missing CLI is a setup state, not a launch error the user should have
      // to decode after Ubume has already handed over the terminal.
      if (
        action === "launch" &&
        provider.launchCommand?.executable &&
        !providerLaunchBypassRef.current
      ) {
        void commandExistsOnPath(provider.launchCommand.executable)
          .then((available) => {
            if (!isMountedRef.current) return;
            if (!available) {
              setProviderSetup(providerId);
              setScreen("provider-setup");
              return;
            }
            providerLaunchBypassRef.current = true;
            providerActionRef.current?.(providerId, action);
          })
          .catch(() => {
            if (!isMountedRef.current) return;
            setProviderSetup(providerId);
            setScreen("provider-setup");
          });
        return;
      }
      providerLaunchBypassRef.current = false;

      if (busyRef.current) {
        appendEvent("system", "Busy", "Finish the current run before launching a provider CLI.");
        return;
      }

      setScreen("main");
      appendEvent(
        "system",
        "Provider launch",
        `Suspending Ubume and launching ${provider.displayName}${providerId === "mistral" ? ` / ${provider.currentModel}` : ""}. Ubume will resume when the external CLI exits.`,
      );

      const launchOptions = { cwd: workspaceRoot, ...externalCliLaunchHooks };
      const launchPromise =
        providerId === "mistral"
          ? launchMistralVibeCli(provider, launchOptions)
          : launchProviderCli(provider, launchOptions);

      void launchPromise
        .then((result) => {
          if (!isMountedRef.current) return;
          void ensureProviderModels(providerId, true);
          if (
            providerId === "mistral" &&
            (result.status === "missing-command" || result.status === "spawn-error")
          ) {
            appendEvent("error", "Mistral Vibe launch failed", result.message);
          } else {
            appendEvent("system", "Provider launch", result.message);
          }
        })
        .catch((error) => {
          if (!isMountedRef.current) return;
          const message = errorMessage(error, "Provider launch failed.");
          appendEvent("error", "Provider launch failed", message);
        });
    },
    [
      activeProviderRoute,
      selectionCoordinator,
      appendEvent,
      appendEvent,
      ensureProviderModels,
      providerRegistry,
      probeLocalBackend,
      providerWorkspaceConfig.providers,
      markProviderAvailability,
      modelCapabilities,
      reasoningLevel,
      refreshModelCapabilities,
      resolvedRuntimeConfig,
      setWorkspaceDefaultProviderWithNotice,
      externalCliLaunchHooks,
      workspaceRoot,
    ],
  );

  useEffect(() => {
    providerActionRef.current = handleProviderAction;
    return () => {
      providerActionRef.current = null;
    };
  }, [handleProviderAction]);

  const runProviderSetup = useCallback(
    (providerId: ProviderId) => {
      const provider = findProvider(providerRegistry, providerId);
      const label = provider?.displayName ?? providerId;
      const windows = process.platform === "win32";
      const plan = getProviderSetupPlan(providerId, windows);

      // Providers with user-supplied commands cannot be safely installed by
      // Ubume. The prompt still gives them a retry path after manual setup.
      if (!plan.installCommand) {
        providerLaunchBypassRef.current = true;
        setProviderSetup(null);
        setScreen("provider-picker");
        providerActionRef.current?.(providerId, "launch");
        return;
      }

      setProviderSetup(null);
      setScreen("main");
      const command = `${plan.installCommand}${plan.setupCommand ? `; ${plan.setupCommand}` : ""}`;
      const child = windows
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              `$ErrorActionPreference='Stop'; ${command}`,
            ],
            { cwd: workspaceRoot, stdio: "inherit" },
          )
        : spawn("sh", ["-lc", command.replace(/; /g, " && ")], {
            cwd: workspaceRoot,
            stdio: "inherit",
          });

      child.once("error", (error) => {
        appendEvent("error", `${label} setup failed`, error.message);
      });
      child.once("close", (code) => {
        if (code === 0) {
          void ensureProviderModels(providerId, true);
          appendEvent(
            "system",
            `${label} setup`,
            "Installation and setup finished. Reopen the provider picker to launch it.",
          );
        } else if (code !== null) {
          appendEvent(
            "error",
            `${label} setup failed`,
            `The setup process exited with code ${code}.`,
          );
        }
      });
    },
    [appendEvent, ensureProviderModels, providerRegistry, workspaceRoot],
  );
  return { probeLocalBackends, openProviderPicker, handleProviderAction, runProviderSetup };
}
