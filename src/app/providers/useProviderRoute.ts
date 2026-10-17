/**
 * Provider picker actions: choosing which provider Ubume talks to, probing
 * Local backends, running diagnostics, and launching or installing external
 * provider CLIs.
 *
 * State ownership:
 * - Provider *navigation* (which provider the picker is acting on) is tracked
 *   by the session's `SelectionCoordinator`; every action that changes
 *   navigation cancels any in-flight model validation first.
 * - Model *activation* is delegated to `setModelAndReasoningWithNotice` from
 *   `useModelSelection`, the single path that validates, persists and commits
 *   a route. This hook never commits a route itself.
 * - Provider configuration writes go through `updateProviderWorkspaceConfig`
 *   so they merge with the latest saved config.
 *
 * Recovery: selecting a provider whose saved model is known to be unusable
 * (rejected this session or missing from an authoritative catalog) opens that
 * provider's model picker instead of retrying the model. Navigation therefore
 * never depends on a model initializing successfully.
 */

import { spawn } from "node:child_process";
import { useCallback, useEffect } from "react";
import type { AvailableModel, ReasoningLevel } from "../../config/settings.js";
import { resolveVibeExecutable } from "../../core/executables/executableResolver.js";
import type { CodexModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import { providerConnectionKey } from "../../core/models/modelCatalog.js";
import { isCatalogModelUnavailable } from "../../core/models/modelSelection.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import { commandExistsOnPath, launchProviderCli } from "../../core/providerLauncher/launcher.js";
import { resolveLocalBackend } from "../../core/providerLauncher/localBackend.js";
import { findProvider } from "../../core/providerLauncher/registry.js";
import type {
  LocalBackendId,
  ProviderConfig,
  ProviderId,
  ProviderPickerAction,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import {
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
  ProviderRoute,
  ProviderRouteValidationResult,
} from "../../core/providerRuntime/types.js";
import { errorMessage } from "../../core/shared/values.js";
import type { Screen } from "../../session/types.js";
import { FOCUS_IDS } from "../../ui/input/focus.js";
import type { LocalBackendStatus } from "../../ui/panels/ProviderPicker.js";
import {
  buildSetupSpawn,
  localBackendStatusFromError,
  localBackendStatusFromValidation,
  resolveProviderActivation,
  routeUnavailableMessage,
  selectedLocalModel,
  workspaceDefaultNotice,
} from "./providerActions.js";

type ProviderActionHandler = (
  providerId: ProviderId,
  action: ProviderPickerAction,
  localBackend?: LocalBackendId,
) => void;

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
  providerRegistry: ProviderConfig[];
  /** Saves a transform of the latest provider config; see useRuntimeSettings. */
  updateProviderWorkspaceConfig: (
    transform: (latest: ProviderWorkspaceConfig) => ProviderWorkspaceConfig,
  ) => ProviderWorkspaceConfig;
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
  /**
   * Set after a successful executable preflight so the re-dispatched
   * `launch` action skips the check once.
   */
  providerLaunchBypassRef: React.RefObject<boolean>;
  setProviderSetup: React.Dispatch<React.SetStateAction<ProviderId | null>>;
  /** Always points at the latest `handleProviderAction`, for async re-dispatch. */
  providerActionRef: React.RefObject<ProviderActionHandler | null>;
  busyRef: React.RefObject<boolean>;
  externalCliLaunchHooks: {
    stdin: NodeJS.ReadStream;
    beforeLaunch: () => void;
    afterLaunch: () => void;
  };
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
    providerRegistry,
    updateProviderWorkspaceConfig,
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
    providerLaunchBypassRef,
    setProviderSetup,
    providerActionRef,
    busyRef,
    externalCliLaunchHooks,
  } = context;

  // ---------------------------------------------------------------------------
  // Local backend probes
  // ---------------------------------------------------------------------------

  /**
   * Checks whether a Local backend is reachable and has a model loaded, and
   * updates its picker badge. Concurrent probes of the same backend share one
   * request. The returned promise rejects if the probe itself throws.
   */
  const probeLocalBackend = useCallback(
    (localBackend: LocalBackendId) => {
      const existing = localBackendCheckInFlightRef.current.get(localBackend);
      if (existing) {
        return existing;
      }

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

      const setStatus = (status: LocalBackendStatus) => {
        if (isMountedRef.current) {
          setLocalBackendStatuses((current) => ({ ...current, [localBackend]: status }));
        }
      };

      const promise = validateLocalProvider({
        override: { ...providerWorkspaceConfig.providers?.local, localBackend },
        localBackend,
      })
        .then((validation) => {
          setStatus(localBackendStatusFromValidation(validation));
          return validation;
        })
        .catch((error) => {
          setStatus(localBackendStatusFromError(errorMessage(error)));
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

  const probeLocalBackends = useCallback(() => {
    void Promise.allSettled([probeLocalBackend("lm-studio"), probeLocalBackend("unsloth")]);
  }, [probeLocalBackend]);

  // The Codexa native runtime holds a model in memory; release it whenever the
  // active route changes away from it and when Ubume exits.
  useEffect(() => {
    void unloadCodexaNative("Active provider or checkpoint changed.");
    return () => {
      void unloadCodexaNative("Ubume closed or checkpoint changed.");
    };
  }, [activeProviderRoute.providerId, activeProviderRoute.modelId]);

  // ---------------------------------------------------------------------------
  // Picker navigation
  // ---------------------------------------------------------------------------

  /**
   * Opens the provider picker. Mistral's active Vibe model is refreshed in the
   * background because it lives in Vibe's own config, not Ubume's.
   */
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
        if (!isMountedRef.current) {
          return;
        }
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
        if (!isMountedRef.current) {
          return;
        }
        providerDiagnosticsRef.current.mistral = {
          selectedModel: detectVibeActiveModel({ cwd: workspaceRoot }).modelId,
          resolvedCommand: null,
          availabilityStatus: "unavailable",
        };
        setRegistryNonce((n) => n + 1);
      });
  }, [workspaceRoot, selectionCoordinator]);

  /** Opens the model picker scoped to `providerId` (the "pending" provider). */
  const openModelPickerFor = useCallback(
    (providerId: ProviderId) => {
      void ensureProviderModels(providerId);
      setPendingRouteProviderId(providerId);
      modelPickerOpenRef.current = true;
      intendedInputModeRef.current = "model-picker";
      intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
      setScreen("model-picker");
    },
    [ensureProviderModels],
  );

  /** Returns to chat and hands the chosen model to the shared activation path. */
  const activateModel = useCallback(
    (providerId: ProviderId, modelId: string, reasoning: string, localBackend?: LocalBackendId) => {
      intendedInputModeRef.current = "chat/input";
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      setScreen("main");
      void setModelAndReasoningWithNotice(
        modelId as AvailableModel,
        reasoning as ReasoningLevel,
        providerId,
        localBackend,
      );
    },
    [setModelAndReasoningWithNotice],
  );

  /** Reports (once per distinct message) that a provider cannot be routed in Ubume. */
  const reportRouteUnavailable = useCallback(
    (provider: ProviderConfig) => {
      const message = routeUnavailableMessage(provider);
      if (providerRouteErrorsRef.current[provider.id] !== message) {
        appendEvent("system", "Provider route unavailable", message);
        providerRouteErrorsRef.current[provider.id] = message;
      }
    },
    [appendEvent],
  );

  // ---------------------------------------------------------------------------
  // Picker actions
  // ---------------------------------------------------------------------------

  const setWorkspaceDefaultProviderWithNotice = useCallback(
    (providerId: ProviderId) => {
      const provider = findProvider(providerRegistry, providerId);
      if (!provider) {
        appendEvent("error", "Provider unavailable", `Unknown provider: ${providerId}`);
        return;
      }

      try {
        updateProviderWorkspaceConfig((latest) => setProviderWorkspaceDefault(latest, providerId));
        setScreen("main");
        const activeRouteLabel = `${activeRouteProvider?.displayName ?? "OpenAI"} / ${model}`;
        appendEvent(
          "system",
          "Provider default updated",
          workspaceDefaultNotice(provider, isProviderRouteConfigured(providerId), activeRouteLabel),
        );
      } catch (error) {
        const message = errorMessage(error, "Unable to save provider workspace config.");
        appendEvent("error", "Provider default failed", message);
      }
    },
    [activeRouteProvider, appendEvent, model, providerRegistry, updateProviderWorkspaceConfig],
  );

  /**
   * "Use in Ubume" for Local: remember the chosen backend, probe it, and if a
   * model is loaded activate it. The probe result is ignored when the user
   * navigated elsewhere in the meantime.
   */
  const routeToLocalProvider = useCallback(
    (provider: ProviderConfig, selectedLocalBackend: LocalBackendId | undefined) => {
      const navigation = selectionCoordinator.navigationToken;
      const localBackend = resolveLocalBackend(providerWorkspaceConfig, selectedLocalBackend);
      updateProviderWorkspaceConfig((latest) => setLocalBackendPreference(latest, localBackend));

      void probeLocalBackend(localBackend)
        .then((validation) => {
          const stillCurrent =
            isMountedRef.current && selectionCoordinator.navigationToken === navigation;
          if (!stillCurrent) {
            return;
          }
          if (validation.diagnostics) {
            providerDiagnosticsRef.current.local = validation.diagnostics;
          }
          if (validation.status !== "ready") {
            providerRouteErrorsRef.current.local =
              validation.message ?? "Local provider unavailable.";
            setRegistryNonce((n) => n + 1);
            return;
          }

          delete providerRouteErrorsRef.current.local;
          setRegistryNonce((n) => n + 1);
          const reasoning =
            providerWorkspaceConfig.providers?.local?.currentReasoning ??
            activeProviderRoute.reasoning ??
            reasoningLevel;
          activateModel(
            "local",
            selectedLocalModel(validation, provider.currentModel),
            reasoning,
            localBackend,
          );
        })
        // Probe failures are already reflected in the backend's status badge.
        .catch(() => undefined);
    },
    [
      activateModel,
      activeProviderRoute.reasoning,
      probeLocalBackend,
      providerWorkspaceConfig,
      reasoningLevel,
      selectionCoordinator,
      updateProviderWorkspaceConfig,
    ],
  );

  /**
   * "Use in Ubume" for every provider except Local: activate the saved model
   * when it is known to be usable, otherwise open this provider's picker.
   */
  const routeToProvider = useCallback(
    (provider: ProviderConfig) => {
      const discovery = discoverProviderModels(provider.id);
      const savedModel =
        providerWorkspaceConfig.providers?.[provider.id]?.currentModel ?? provider.currentModel;
      const connection = providerConnectionKey(provider.id, {
        cwd: workspaceRoot,
        config: providerWorkspaceConfig,
      });
      const activation = resolveProviderActivation({
        provider,
        config: providerWorkspaceConfig,
        discovery,
        rejected: selectionCoordinator.state(connection, savedModel)?.status === "unavailable",
        catalogMarksUnavailable: isCatalogModelUnavailable(discovery, savedModel),
        sessionReasoningLevel: reasoningLevel,
      });

      if (activation.kind === "activate") {
        activateModel(provider.id, activation.model, activation.reasoning);
      } else {
        openModelPickerFor(provider.id);
      }
    },
    [
      activateModel,
      openModelPickerFor,
      providerWorkspaceConfig,
      reasoningLevel,
      selectionCoordinator,
      workspaceRoot,
    ],
  );

  const selectModelFor = useCallback(
    (providerId: ProviderId) => {
      if (providerId === "openai" && !modelCapabilities) {
        void refreshModelCapabilities(false, false);
      }
      openModelPickerFor(providerId);
    },
    [modelCapabilities, openModelPickerFor, refreshModelCapabilities],
  );

  const refreshModelsFor = useCallback(
    (provider: ProviderConfig) => {
      appendEvent("system", "Model discovery", `Refreshing models for ${provider.displayName}...`);
      void ensureProviderModels(provider.id, true)
        .then(() => {
          const discovery = discoverProviderModels(provider.id);
          appendEvent(
            discovery.freshness === "unverified" ? "error" : "system",
            "Model discovery",
            discovery.message ??
              `Loaded ${discovery.models.length} models for ${provider.displayName}.`,
          );
          setRegistryNonce((n) => n + 1);
        })
        .catch(() => appendEvent("error", "Model discovery", "Model refresh failed."));
    },
    [appendEvent, ensureProviderModels],
  );

  const runLocalProviderDiagnostics = useCallback(() => {
    appendEvent("system", "Local diagnostics", "Running Local provider diagnostics...");
    void runLocalDiagnostics({ localConfig: providerWorkspaceConfig.providers?.local })
      .then((message) => {
        if (!isMountedRef.current) {
          return;
        }
        const discovery = discoverProviderModels("local");
        if (discovery.diagnostics) {
          providerDiagnosticsRef.current.local = discovery.diagnostics;
        }
        if (discovery.status === "ready") {
          delete providerRouteErrorsRef.current.local;
        } else if (discovery.message) {
          providerRouteErrorsRef.current.local = discovery.message;
        }
        appendEvent("system", "Local diagnostics", message);
        setRegistryNonce((n) => n + 1);
      })
      .catch((error) => {
        if (isMountedRef.current) {
          appendEvent("error", "Local diagnostics failed", errorMessage(error));
        }
      });
  }, [appendEvent, providerWorkspaceConfig.providers]);

  const runGoogleProviderDiagnostics = useCallback(() => {
    appendEvent("system", "Google diagnostics", "Running Google provider diagnostics...");
    void validateAntigravityRoute({
      cwd: workspaceRoot,
      configuredPath: providerWorkspaceConfig.providers?.google?.antigravityCommandPath,
    })
      .then((validation) => {
        if (!isMountedRef.current) {
          return;
        }
        if (validation.diagnostics) {
          providerDiagnosticsRef.current.google = validation.diagnostics;
        }
        if (validation.status === "ready") {
          delete providerRouteErrorsRef.current.google;
          const discovery = discoverProviderModels("google");
          appendEvent(
            "system",
            "Google diagnostics",
            validation.message ??
              `Google Antigravity CLI is ready (${discovery.models.length} models available).`,
          );
        } else {
          const message = validation.message ?? "Google Antigravity CLI is unavailable.";
          providerRouteErrorsRef.current.google = message;
          appendEvent("error", "Google diagnostics failed", message);
        }
        setRegistryNonce((n) => n + 1);
      })
      .catch((error) => {
        if (isMountedRef.current) {
          const message = errorMessage(error, "Google diagnostics failed.");
          appendEvent("error", "Google diagnostics failed", message);
        }
      });
  }, [appendEvent, providerWorkspaceConfig.providers, workspaceRoot]);

  /**
   * Launches a provider's own CLI in place of Ubume's UI.
   *
   * A real executable preflight runs first: a missing CLI is a setup state,
   * not a launch error the user should have to decode after Ubume has already
   * handed over the terminal. When the preflight passes, the action is
   * re-dispatched through `providerActionRef` with the bypass flag set, so the
   * launch uses the latest provider registry and run state.
   */
  const launchProvider = useCallback(
    (provider: ProviderConfig) => {
      const providerId = provider.id;
      if (provider.launchCommand?.executable && !providerLaunchBypassRef.current) {
        const showSetup = () => {
          setProviderSetup(providerId);
          setScreen("provider-setup");
        };
        void commandExistsOnPath(provider.launchCommand.executable)
          .then((available) => {
            if (!isMountedRef.current) {
              return;
            }
            if (!available) {
              showSetup();
              return;
            }
            providerLaunchBypassRef.current = true;
            providerActionRef.current?.(providerId, "launch");
          })
          .catch(() => {
            if (isMountedRef.current) {
              showSetup();
            }
          });
        return;
      }
      providerLaunchBypassRef.current = false;

      if (busyRef.current) {
        appendEvent("system", "Busy", "Finish the current run before launching a provider CLI.");
        return;
      }

      setScreen("main");
      const modelSuffix = providerId === "mistral" ? ` / ${provider.currentModel}` : "";
      appendEvent(
        "system",
        "Provider launch",
        `Suspending Ubume and launching ${provider.displayName}${modelSuffix}. Ubume will resume when the external CLI exits.`,
      );

      const launchOptions = { cwd: workspaceRoot, ...externalCliLaunchHooks };
      const launchPromise =
        providerId === "mistral"
          ? launchMistralVibeCli(provider, launchOptions)
          : launchProviderCli(provider, launchOptions);

      void launchPromise
        .then((result) => {
          if (!isMountedRef.current) {
            return;
          }
          // The external CLI may have changed its own model or login state.
          void ensureProviderModels(providerId, true);
          const mistralFailed =
            providerId === "mistral" &&
            (result.status === "missing-command" || result.status === "spawn-error");
          if (mistralFailed) {
            appendEvent("error", "Mistral Vibe launch failed", result.message);
          } else {
            appendEvent("system", "Provider launch", result.message);
          }
        })
        .catch((error) => {
          if (isMountedRef.current) {
            const message = errorMessage(error, "Provider launch failed.");
            appendEvent("error", "Provider launch failed", message);
          }
        });
    },
    [appendEvent, ensureProviderModels, externalCliLaunchHooks, workspaceRoot],
  );

  /**
   * Single entry point for provider picker actions.
   *
   * Actions that change which provider the user is working with
   * (`use-in-ubume`, `select-model`, `cancel`) first take navigation ownership
   * and cancel any in-flight model validation, so a late result from the
   * previous provider cannot commit, steal focus or clear busy state.
   */
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

      switch (action) {
        case "use-in-ubume":
          if (!isProviderRoutableInUbume(providerId)) {
            reportRouteUnavailable(provider);
          } else if (providerId === "local") {
            routeToLocalProvider(provider, selectedLocalBackend);
          } else {
            routeToProvider(provider);
          }
          return;

        case "select-model":
          selectModelFor(providerId);
          return;

        case "refresh-models":
          if (isProviderRoutableInUbume(providerId)) {
            refreshModelsFor(provider);
          } else {
            reportRouteUnavailable(provider);
          }
          return;

        case "run-diagnostics":
          if (providerId === "local") {
            setScreen("main");
            runLocalProviderDiagnostics();
          } else if (providerId === "google") {
            setScreen("main");
            runGoogleProviderDiagnostics();
          } else {
            appendEvent(
              "error",
              "Provider diagnostics unavailable",
              `Diagnostics are not implemented for ${provider.displayName}.`,
            );
          }
          return;

        case "launch":
          launchProvider(provider);
          return;
      }
    },
    [
      appendEvent,
      launchProvider,
      providerRegistry,
      refreshModelsFor,
      reportRouteUnavailable,
      runGoogleProviderDiagnostics,
      runLocalProviderDiagnostics,
      selectModelFor,
      selectionCoordinator,
      setWorkspaceDefaultProviderWithNotice,
      routeToLocalProvider,
      routeToProvider,
    ],
  );

  useEffect(() => {
    providerActionRef.current = handleProviderAction;
    return () => {
      providerActionRef.current = null;
    };
  }, [handleProviderAction]);

  // ---------------------------------------------------------------------------
  // Provider CLI setup
  // ---------------------------------------------------------------------------

  /**
   * Installs and sets up a provider CLI in the foreground terminal.
   *
   * Providers with user-supplied commands cannot be safely installed by Ubume;
   * for those the launch is retried directly so the user still has a path
   * forward after manual setup.
   */
  const runProviderSetup = useCallback(
    (providerId: ProviderId) => {
      const provider = findProvider(providerRegistry, providerId);
      const label = provider?.displayName ?? providerId;
      const windows = process.platform === "win32";
      const plan = getProviderSetupPlan(providerId, windows);

      if (!plan.installCommand) {
        providerLaunchBypassRef.current = true;
        setProviderSetup(null);
        setScreen("provider-picker");
        providerActionRef.current?.(providerId, "launch");
        return;
      }

      setProviderSetup(null);
      setScreen("main");
      const setup = buildSetupSpawn(
        { installCommand: plan.installCommand, setupCommand: plan.setupCommand },
        windows,
      );
      const child = spawn(setup.command, setup.args, { cwd: workspaceRoot, stdio: "inherit" });

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
