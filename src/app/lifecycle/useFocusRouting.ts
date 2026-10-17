/**
 * Keyboard focus routing between the composer and overlays.
 *
 * Ink's focus manager has no notion of screens, so every screen change
 * re-focuses that screen's target (`getFocusTargetForScreen`). Async work
 * (model validation, discovery, run completion) must not move focus on its
 * own: it goes through `returnToChatMode`, which keeps an explicitly opened
 * model picker focused instead of jumping back to the composer.
 *
 * `getInputDebugSnapshot` describes the input state for UBUME debug traces.
 */

import type { useFocusManager } from "ink";
import { useCallback, useEffect } from "react";
import { getStdinDebugState, traceInputDebug } from "../../core/perf/debugLog.js";
import type { PlanFlowState } from "../../session/planFlow.js";
import type { Screen } from "../../session/types.js";
import { FOCUS_IDS, getFocusTargetForScreen } from "../../ui/input/focus.js";
import { shouldBumpComposerInstance } from "../../ui/theme.js";

interface UseFocusRoutingContext {
  // Screen tracking
  screen: Screen;
  screenRef: React.RefObject<Screen>;
  previousScreenRef: React.RefObject<Screen>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;

  // Focus targets and intent
  intendedInputModeRef: React.RefObject<"model-picker" | "chat/input">;
  intendedFocusTargetRef: React.RefObject<string>;
  modelPickerOpenRef: React.RefObject<boolean>;
  focusManager: ReturnType<typeof useFocusManager>;

  // Busy and selection guards
  busyRef: React.RefObject<boolean>;
  modelCapabilitiesBusyRef: React.RefObject<boolean>;
  modelSelectionInFlightRef: React.RefObject<boolean>;

  // Composer instance
  composerInstanceKey: number;
  setComposerInstanceKey: React.Dispatch<React.SetStateAction<number>>;

  // Plan flow
  planFlow: PlanFlowState;

  // Input and theme
  stdin: NodeJS.ReadStream;
  themePreviewTimerRef: React.RefObject<NodeJS.Timeout | null>;
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
    themePreviewTimerRef,
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

  // Leaving the theme picker cancels a pending live preview.
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
