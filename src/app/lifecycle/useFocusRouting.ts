import type { useFocusManager } from "ink";
import { useCallback, useEffect } from "react";
import type { LayeredConfigResult } from "../../config/layeredConfig.js";
import type { loadSettings } from "../../config/persistence.js";
import { saveSettings } from "../../config/persistence.js";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import type { HeaderConfig, Theme } from "../../config/settings.js";
import { getStdinDebugState, traceInputDebug } from "../../core/perf/debugLog.js";
import { shutdownLocalHarness } from "../../core/providerRuntime/localHarness/runtime.js";
import type { BackendProvider } from "../../core/providers/types.js";
import type { PlanFlowState } from "../../session/planFlow.js";
import type { Screen } from "../../session/types.js";
import { FOCUS_IDS, getFocusTargetForScreen } from "../../ui/input/focus.js";
import { shouldBumpComposerInstance, type ThemeSelectionState } from "../../ui/theme.js";
import { buildSettingsPayload } from "../models/useSettings.js";

interface UseFocusRoutingContext {
  screenRef: React.RefObject<Screen>;
  busyRef: React.RefObject<boolean>;
  modelCapabilitiesBusyRef: React.RefObject<boolean>;
  intendedInputModeRef: React.RefObject<"model-picker" | "chat/input">;
  modelSelectionInFlightRef: React.RefObject<boolean>;
  intendedFocusTargetRef: React.RefObject<string>;
  stdin: NodeJS.ReadStream;
  baseRuntimeConfigRef: React.RefObject<RuntimeConfig>;
  baseLayeredConfig: LayeredConfigResult;
  providerOverride: BackendProvider | undefined;
  initialSettings: React.RefObject<ReturnType<typeof loadSettings>>;
  themeSelection: ThemeSelectionState;
  workspaceDisplayMode: "dir" | "name" | "simple";
  terminalTitleMode: "dir" | "name" | "simple";
  showBusyLoader: boolean;
  customTheme: Partial<Theme> | undefined;
  authPreference: "chatgpt-login-goal" | "api-key-first" | "runner-managed";
  headerConfig: HeaderConfig;
  isMountedRef: React.RefObject<boolean>;
  cleanupRef: React.RefObject<(() => void) | null>;
  themePreviewTimerRef: React.RefObject<NodeJS.Timeout | null>;
  themeNoticeTimerRef: React.RefObject<NodeJS.Timeout | null>;
  screen: Screen;
  previousScreenRef: React.RefObject<Screen>;
  setComposerInstanceKey: React.Dispatch<React.SetStateAction<number>>;
  focusManager: ReturnType<typeof useFocusManager>;
  composerInstanceKey: number;
  planFlow: PlanFlowState;
  modelPickerOpenRef: React.RefObject<boolean>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
}

export function useFocusRouting(context: UseFocusRoutingContext) {
  const {
    screenRef,
    busyRef,
    modelCapabilitiesBusyRef,
    intendedInputModeRef,
    modelSelectionInFlightRef,
    intendedFocusTargetRef,
    stdin,
    baseRuntimeConfigRef,
    baseLayeredConfig,
    providerOverride,
    initialSettings,
    themeSelection,
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader,
    customTheme,
    authPreference,
    headerConfig,
    isMountedRef,
    cleanupRef,
    themePreviewTimerRef,
    themeNoticeTimerRef,
    screen,
    previousScreenRef,
    setComposerInstanceKey,
    focusManager,
    composerInstanceKey,
    planFlow,
    modelPickerOpenRef,
    setScreen,
  } = context;

  const getInputDebugSnapshot = useCallback(
    (extra: Record<string, unknown> = {}) => {
      const currentScreen = screenRef.current;
      const currentBusy = busyRef.current;
      const currentModelLoading = modelCapabilitiesBusyRef.current;

      return {
        screen: currentScreen,
        mode: intendedInputModeRef.current,
        modelPickerOpen: currentScreen === "model-picker",
        composerEnabled: currentScreen === "main",
        inputLocked: false,
        busy: currentBusy,
        modelLoading: currentModelLoading,
        modelSelection: modelSelectionInFlightRef.current,
        focusTarget: intendedFocusTargetRef.current,
        stdin: getStdinDebugState(stdin),
        ...extra,
      };
    },
    [stdin],
  );

  useEffect(() => {
    baseRuntimeConfigRef.current = baseLayeredConfig.runtime;
  }, [baseLayeredConfig.runtime]);

  useEffect(() => {
    if (providerOverride) return;
    saveSettings(
      buildSettingsPayload(
        initialSettings.current,
        {
          theme: themeSelection.committedTheme,
          workspaceDisplayMode,
          terminalTitleMode,
          showBusyLoader,
          customTheme,
        },
        authPreference,
        headerConfig,
      ),
    );
  }, [
    authPreference,
    customTheme,
    showBusyLoader,
    terminalTitleMode,
    themeSelection.committedTheme,
    workspaceDisplayMode,
    providerOverride,
  ]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cleanupRef.current?.();
      void shutdownLocalHarness();
      if (themePreviewTimerRef.current) {
        clearTimeout(themePreviewTimerRef.current);
        themePreviewTimerRef.current = null;
      }
      if (themeNoticeTimerRef.current) {
        clearTimeout(themeNoticeTimerRef.current);
        themeNoticeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (screen === "theme-picker") {
      return;
    }

    if (themePreviewTimerRef.current) {
      clearTimeout(themePreviewTimerRef.current);
      themePreviewTimerRef.current = null;
    }
  }, [screen]);

  useEffect(() => {
    const previousScreen = previousScreenRef.current;
    if (shouldBumpComposerInstance(previousScreen, screen)) {
      setComposerInstanceKey((currentKey) => currentKey + 1);
    }
    previousScreenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    const focusTarget = getFocusTargetForScreen(screen);
    intendedFocusTargetRef.current = focusTarget;
    traceInputDebug("focus_route", getInputDebugSnapshot({ focusTarget }));
    focusManager.focus(focusTarget);
  }, [composerInstanceKey, focusManager, getInputDebugSnapshot, screen]);

  useEffect(() => {
    if (screen !== "main") return;

    if (planFlow.kind === "awaiting_action") {
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      focusManager.focus(FOCUS_IDS.composer);
      return;
    }

    if (planFlow.kind === "collecting_feedback") {
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      focusManager.focus(FOCUS_IDS.composer);
    }
  }, [focusManager, planFlow.kind, screen]);

  useEffect(() => {
    if (screen === "model-picker" || intendedInputModeRef.current !== "model-picker") {
      return;
    }

    traceInputDebug(
      "safety_recovery",
      getInputDebugSnapshot({
        reason: "model-picker-closed-with-stale-input-mode",
        restoredMode: "chat/input",
        restoredFocusTarget: FOCUS_IDS.composer,
      }),
    );
    intendedInputModeRef.current = "chat/input";
    intendedFocusTargetRef.current = FOCUS_IDS.composer;
    focusManager.focus(FOCUS_IDS.composer);
  }, [focusManager, getInputDebugSnapshot, screen]);

  const returnToChatMode = useCallback(
    (reason = "unknown") => {
      if (modelPickerOpenRef.current) {
        intendedInputModeRef.current = "model-picker";
        intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
        traceInputDebug(
          "model_picker_async_completion_preserved",
          getInputDebugSnapshot({
            reason,
            restoredMode: "model-picker",
            restoredModelPickerOpen: true,
            restoredFocusTarget: FOCUS_IDS.modelPicker,
          }),
        );
        focusManager.focus(FOCUS_IDS.modelPicker);
        return;
      }
      intendedInputModeRef.current = "chat/input";
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      traceInputDebug(
        "model_picker_close",
        getInputDebugSnapshot({
          reason,
          restoredMode: "chat/input",
          restoredModelPickerOpen: false,
          restoredComposerEnabled: true,
          restoredInputLocked: false,
          restoredFocusTarget: FOCUS_IDS.composer,
        }),
      );
      setScreen("main");
      focusManager.focus(FOCUS_IDS.composer);
    },
    [focusManager, getInputDebugSnapshot],
  );

  const returnFromUpdateOverlay = useCallback(() => {
    setScreen("main");
    focusManager.focus(FOCUS_IDS.composer);
  }, [focusManager]);
  return { getInputDebugSnapshot, returnToChatMode, returnFromUpdateOverlay };
}
