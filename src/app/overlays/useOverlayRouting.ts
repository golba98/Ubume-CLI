import type { useFocusManager } from "ink";
import { useCallback } from "react";
import { formatWritableRoots } from "../../commands/handler.js";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import type {
  CodexModelCapabilities,
  CodexModelCapability,
} from "../../core/models/codexModelCapabilities.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import type { ProviderId } from "../../core/providerLauncher/types.js";

import type { ProviderRoute } from "../../core/providerRuntime/types.js";

import type { Screen } from "../../session/types.js";

import { FOCUS_IDS } from "../../ui/input/focus.js";

import type { PermissionsPanelAction } from "../../ui/panels/PermissionsPanel.js";

interface UseOverlayRoutingContext {
  selectionCoordinator: SelectionCoordinator;
  modelSelectionInFlightRef: React.RefObject<boolean>;
  setPendingRouteProviderId: React.Dispatch<React.SetStateAction<ProviderId | null>>;
  getInputDebugSnapshot: (extra?: Record<string, unknown>) => {
    screen: Screen;
    mode: "chat/input" | "model-picker";
    modelPickerOpen: boolean;
    composerEnabled: boolean;
    inputLocked: boolean;
    busy: boolean;
    modelLoading: boolean;
    modelSelection: boolean;
    focusTarget: string;
    stdin: Record<string, unknown>;
  };
  screen: Screen;
  modelPickerOpenRef: React.RefObject<boolean>;
  intendedInputModeRef: React.RefObject<"chat/input" | "model-picker">;
  intendedFocusTargetRef: React.RefObject<string>;
  focusManager: ReturnType<typeof useFocusManager>;
  pendingRouteProviderId: ProviderId | null;
  activeProviderRoute: ProviderRoute;
  modelCapabilities: CodexModelCapabilities | null;
  refreshModelCapabilities: (
    forceRefresh?: boolean,
    announce?: boolean,
  ) => Promise<CodexModelCapabilities>;
  ensureProviderModels: (providerId: ProviderId, forceRefresh?: boolean) => Promise<unknown>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  busy: boolean;
  currentModelCapability: CodexModelCapability | null;
  modelCapabilitiesBusy: boolean;
  model: string;
  runtimeConfig: RuntimeConfig;
  clearWritableRootsWithNotice: () => void;
}

export function useOverlayRouting(context: UseOverlayRoutingContext) {
  const {
    selectionCoordinator,
    getInputDebugSnapshot,
    screen,
    modelPickerOpenRef,
    intendedInputModeRef,
    intendedFocusTargetRef,
    focusManager,
    pendingRouteProviderId,
    activeProviderRoute,
    modelCapabilities,
    refreshModelCapabilities,
    ensureProviderModels,
    setScreen,
    appendEvent,
    busy,
    currentModelCapability,
    modelCapabilitiesBusy,
    model,
    runtimeConfig,
    clearWritableRootsWithNotice,
  } = context;

  const openModelPicker = useCallback(() => {
    selectionCoordinator.navigate(pendingRouteProviderId ?? activeProviderRoute.providerId);
    traceInputDebug(
      "model_picker_open_request",
      getInputDebugSnapshot({
        handler: "openModelPicker",
        currentScreen: screen,
      }),
    );

    if (screen === "model-picker") {
      modelPickerOpenRef.current = true;
      intendedInputModeRef.current = "model-picker";
      intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
      traceInputDebug(
        "model_picker_open_duplicate",
        getInputDebugSnapshot({
          handler: "openModelPicker",
          focusTarget: FOCUS_IDS.modelPicker,
        }),
      );
      focusManager.focus(FOCUS_IDS.modelPicker);
      return;
    }

    // Kick off discovery if we don't already have capabilities. The helper is
    // single-flight, so repeated picker opens while discovery is in progress
    // subscribe to the existing promise instead of spawning duplicate jobs or
    // log entries. Open the picker immediately; it renders a loading state
    // until the promise resolves and state updates commit the model list.
    modelPickerOpenRef.current = true;
    const targetProviderId = pendingRouteProviderId ?? activeProviderRoute.providerId;
    if (targetProviderId === "openai" && !modelCapabilities) {
      traceInputDebug(
        "model_picker_loading_trigger",
        getInputDebugSnapshot({
          handler: "openModelPicker",
        }),
      );
      void refreshModelCapabilities(false, false);
    }
    void ensureProviderModels(targetProviderId);

    intendedInputModeRef.current = "model-picker";
    intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
    setScreen("model-picker");
    traceInputDebug(
      "model_picker_opened",
      getInputDebugSnapshot({
        handler: "openModelPicker",
        nextScreen: "model-picker",
        focusTarget: FOCUS_IDS.modelPicker,
      }),
    );
  }, [
    activeProviderRoute.providerId,
    selectionCoordinator,
    appendEvent,
    busy,
    ensureProviderModels,
    focusManager,
    getInputDebugSnapshot,
    modelCapabilities,
    pendingRouteProviderId,
    refreshModelCapabilities,
    screen,
  ]);

  const openModePicker = useCallback(() => {
    setScreen("mode-picker");
  }, [appendEvent, busy]);

  const openReasoningPicker = useCallback(() => {
    if (!currentModelCapability?.supportedReasoningLevels?.length) {
      if (!modelCapabilitiesBusy) {
        void refreshModelCapabilities(true, true);
      }
      appendEvent(
        "system",
        "Reasoning unavailable",
        `Codex has not provided reasoning metadata for ${model}. No guessed reasoning levels will be shown.`,
      );
      return;
    }

    setScreen("reasoning-picker");
  }, [
    appendEvent,
    busy,
    currentModelCapability,
    model,
    modelCapabilitiesBusy,
    refreshModelCapabilities,
  ]);

  const openThemePicker = useCallback(() => {
    setScreen("theme-picker");
  }, [appendEvent, busy]);

  const openSettingsPanel = useCallback(() => {
    setScreen("settings-panel");
  }, [appendEvent, busy]);

  const openAuthPanel = useCallback(() => {
    if (busy) {
      appendEvent("system", "Busy", "Finish the current run before opening auth guidance.");
      return;
    }

    setScreen("auth-panel");
  }, [appendEvent, busy]);

  const openPermissionsPanel = useCallback(() => {
    setScreen("permissions-panel");
  }, [appendEvent, busy]);

  const openPermissionsApprovalPicker = useCallback(() => {
    setScreen("permissions-approval-picker");
  }, []);

  const openPermissionsSandboxPicker = useCallback(() => {
    setScreen("permissions-sandbox-picker");
  }, []);

  const openPermissionsNetworkPicker = useCallback(() => {
    setScreen("permissions-network-picker");
  }, []);

  const openPermissionsAddWritableRoot = useCallback(() => {
    setScreen("permissions-add-writable-root");
  }, []);

  const openPermissionsRemoveWritableRoot = useCallback(() => {
    if (runtimeConfig.policy.writableRoots.length === 0) {
      appendEvent("system", "Runtime policy", "No writable roots are configured.");
      return;
    }

    setScreen("permissions-remove-writable-root");
  }, [appendEvent, runtimeConfig.policy.writableRoots.length]);

  const handlePermissionsPanelAction = useCallback(
    (action: PermissionsPanelAction) => {
      switch (action) {
        case "approval-policy":
          openPermissionsApprovalPicker();
          return;
        case "sandbox":
          openPermissionsSandboxPicker();
          return;
        case "network":
          openPermissionsNetworkPicker();
          return;
        case "writable-roots-summary":
          appendEvent(
            "system",
            "Runtime policy",
            `Writable roots:\n${formatWritableRoots(runtimeConfig.policy.writableRoots)}`,
          );
          return;
        case "writable-roots-add":
          openPermissionsAddWritableRoot();
          return;
        case "writable-roots-remove":
          openPermissionsRemoveWritableRoot();
          return;
        case "writable-roots-clear":
          clearWritableRootsWithNotice();
          return;
        default:
          return;
      }
    },
    [
      appendEvent,
      clearWritableRootsWithNotice,
      openPermissionsAddWritableRoot,
      openPermissionsApprovalPicker,
      openPermissionsNetworkPicker,
      openPermissionsRemoveWritableRoot,
      openPermissionsSandboxPicker,
      runtimeConfig.policy.writableRoots,
    ],
  );
  return {
    openModelPicker,
    openModePicker,
    openReasoningPicker,
    openThemePicker,
    openSettingsPanel,
    openAuthPanel,
    openPermissionsPanel,
    handlePermissionsPanelAction,
  };
}
