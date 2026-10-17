/**
 * Model picker overlay: lists the active provider's models, lets the user choose a
 * model and a reasoning level (discrete levels, a token budget, or Gemini effort
 * variants), and reports the choice through `onSelect(modelId, reasoning)`.
 *
 * Rendering and key handling live here; selection rules, variant grouping and the
 * responsive window are pure functions in `modelPickerModel.ts`. The draft is held
 * in a reducer so it can be re-synchronised safely when the model list or active
 * route changes while the picker is open (see `modelPickerSelectionReducer`).
 *
 * Keys: ↑/↓ or j/k move, Home/End/PgUp/PgDn jump, ←/→ or h/l change reasoning,
 * A/D set an automatic/disabled thinking budget, R refreshes, Enter selects, Esc or
 * Ctrl+C/Ctrl+Q cancels. Enter on an empty list cancels with `empty-selection`.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { formatReasoningLabel } from "../../config/settings.js";
import type {
  CodexModelCapability,
  ReasoningEffortCapability,
} from "../../core/models/codexModelCapabilities.js";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import { clampVisualText } from "../../core/shared/text.js";
import { FOCUS_IDS } from "../input/focus.js";
import {
  type ActivePanelLayout,
  type Layout,
  type PanelLayout,
  useAppLayoutBudget,
  usePickerPanelGeometry,
} from "../layout.js";
import { useTheme } from "../theme.js";
import {
  calculateModelPickerWindow,
  collapseGeminiEffortVariants,
  getCompactModelName,
  getModelName,
  getModelSourceMarker,
  getReasoningLevels,
  initModelPickerSelection,
  isModelIdentifiedBy,
  modelPickerSelectionReducer,
  normalizeDraftReasoning,
  resolveVariantModelId,
} from "./modelPickerModel.js";

// ─── Types & helpers ─────────────────────────────────────────────────────────

type ModelPickerCloseReason = "escape" | "empty-selection";

interface ModelPickerScreenProps {
  layout: Layout & {
    contentWidth?: number;
  };
  availableRows?: number;
  activePanelLayout?: ActivePanelLayout;
  panelLayout?: PanelLayout;
  models: readonly CodexModelCapability[];
  currentModel: string;
  currentReasoning: string;
  activeProviderLabel?: string;
  isLoading?: boolean;
  emptyMessage?: string;
  routeTextOverride?: string;
  onSelect: (model: string, reasoning: string) => void;
  onRefresh?: () => void;
  refreshMessage?: string;
  onCancel: (reason?: ModelPickerCloseReason) => void;
}

function describeInputKey(
  input: string,
  key: {
    escape?: boolean;
    return?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  },
) {
  return {
    input,
    escape: Boolean(key.escape),
    return: Boolean(key.return),
    upArrow: Boolean(key.upArrow),
    downArrow: Boolean(key.downArrow),
    leftArrow: Boolean(key.leftArrow),
    rightArrow: Boolean(key.rightArrow),
    ctrl: Boolean(key.ctrl),
    meta: Boolean(key.meta),
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ModelPickerScreen({
  layout,
  availableRows: propAvailableRows,
  activePanelLayout,
  panelLayout,
  models: baseModels,
  currentModel,
  currentReasoning,
  activeProviderLabel = "OpenAI",
  isLoading = false,
  emptyMessage,
  routeTextOverride,
  onSelect,
  onCancel,
  onRefresh,
  refreshMessage,
}: ModelPickerScreenProps) {
  const theme = useTheme();
  const isGoogle = activeProviderLabel === "Google";
  const isAntigravity = isGoogle || activeProviderLabel.toLowerCase().includes("antigravity");

  const models = useMemo(() => {
    return isAntigravity ? collapseGeminiEffortVariants(baseModels) : baseModels;
  }, [baseModels, isAntigravity]);

  const { isFocused } = useFocus({ id: FOCUS_IDS.modelPicker, autoFocus: true });
  const [selection, dispatch] = useReducer(
    modelPickerSelectionReducer,
    { models, currentModel, currentReasoning },
    initModelPickerSelection,
  );
  const draftSelectedModel = selection.cursor;
  const draftReasoning = selection.reasoning;
  const previousActiveSelection = useRef({ currentModel, currentReasoning });
  const [scrollOffset, setScrollOffset] = useState(0);

  const selectedModel = models[draftSelectedModel];
  const selectedReasoningLevels = getReasoningLevels(selectedModel);
  const reasoningUnavailable = selectedReasoningLevels.length === 0;

  useEffect(() => {
    traceInputDebug("model_picker_panel_mounted", {
      focusTarget: FOCUS_IDS.modelPicker,
      modelCount: models.length,
      isLoading,
    });
    return () => {
      traceInputDebug("model_picker_panel_unmounted", {
        focusTarget: FOCUS_IDS.modelPicker,
      });
    };
  }, []);

  // Keep the draft valid while the picker is open: model discovery can refresh or
  // shrink the list, and another surface can change the active route.
  useEffect(() => {
    const activeChanged =
      previousActiveSelection.current.currentModel !== currentModel ||
      previousActiveSelection.current.currentReasoning !== currentReasoning;
    previousActiveSelection.current = { currentModel, currentReasoning };
    dispatch({ type: "sync", models, currentModel, currentReasoning, activeChanged });
  }, [currentModel, currentReasoning, models]);

  useInput(
    (input, key) => {
      if (input.toLowerCase() === "r" && onRefresh) {
        onRefresh();
        return;
      }
      const control = selectedModel?.reasoningControl;
      if (control?.kind === "budget" && input === "a" && control.auto) {
        dispatch({ type: "setReasoning", reasoning: "auto" });
        return;
      }
      if (control?.kind === "budget" && input === "d" && control.canDisable) {
        dispatch({ type: "setReasoning", reasoning: "budget:0" });
        return;
      }
      traceInputDebug("model_picker_panel_input", {
        handler: "ModelPickerScreen.useInput",
        key: describeInputKey(input, key),
        isFocused,
        isLoading,
        modelCount: models.length,
        cursor: draftSelectedModel,
        draftReasoning,
      });

      if ((key.ctrl && (input === "c" || input === "q")) || key.escape) {
        onCancel("escape");
        return;
      }

      if (key.return) {
        const model = models[draftSelectedModel];
        if (!model) {
          onCancel("empty-selection");
          return;
        }
        const normalizedReasoning = normalizeDraftReasoning(model, draftReasoning);
        onSelect(
          resolveVariantModelId(model, normalizedReasoning, currentModel),
          normalizedReasoning,
        );
        return;
      }

      const page = Math.max(1, windowResult.capacity);
      if (key.upArrow || input === "k") dispatch({ type: "move", models, direction: -1 });
      else if (key.downArrow || input === "j") dispatch({ type: "move", models, direction: 1 });
      else if (key.home) dispatch({ type: "select", models, index: 0 });
      else if (key.end) dispatch({ type: "select", models, index: models.length - 1 });
      else if (key.pageUp) dispatch({ type: "select", models, index: draftSelectedModel - page });
      else if (key.pageDown) dispatch({ type: "select", models, index: draftSelectedModel + page });
      else if (key.leftArrow || input === "h")
        dispatch({ type: "stepReasoning", models, direction: -1 });
      else if (key.rightArrow || input === "l")
        dispatch({ type: "stepReasoning", models, direction: 1 });
    },
    { isActive: isFocused },
  );

  const {
    panelLayout: resolvedPanelLayout,
    panelWidth,
    innerWidth,
  } = usePickerPanelGeometry({
    layout,
    panelLayout,
    activePanelLayout,
    availableRows: propAvailableRows,
    minPanelWidth: 38,
    minAvailableCols: 20,
  });
  const availableRows = resolvedPanelLayout.availableRows;
  const help =
    resolvedPanelLayout.mode === "compact"
      ? "↑↓ model · ←→ effort · R refresh · Enter · Esc"
      : "↑↓ model · ←→ reasoning · R refresh · Enter select · Esc cancel";
  const aOrAn = /^[aeiou]/i.test(activeProviderLabel) ? "an" : "a";
  const routeText =
    routeTextOverride ?? `Choose ${aOrAn} ${activeProviderLabel} model to use inside Ubume.`;
  const sourceMarker = getModelSourceMarker(models, activeProviderLabel);

  const appLayoutBudget = useAppLayoutBudget();
  const activeModelIndex = models.findIndex((model) => isModelIdentifiedBy(model, currentModel));
  const hasSourceMarker = !!sourceMarker;

  // ─── Layout & Windowing ───────────────────────────────────────────────────

  const windowResult = useMemo(
    () =>
      calculateModelPickerWindow({
        itemCount: models.length,
        selectedIndex: draftSelectedModel,
        availableRows,
        scrollOffset,
        hasSourceMarker,
        allowFull: appLayoutBudget?.showPanelColumnHeaders ?? true,
        activeModelIndex,
      }),
    [
      models.length,
      draftSelectedModel,
      availableRows,
      hasSourceMarker,
      appLayoutBudget?.showPanelColumnHeaders,
      scrollOffset,
      activeModelIndex,
    ],
  );
  useEffect(() => {
    setScrollOffset(windowResult.start);
  }, [windowResult.start]);

  const visibleModels = useMemo(() => {
    return models.slice(windowResult.start, windowResult.end);
  }, [models, windowResult.start, windowResult.end]);

  const activeModel = models[activeModelIndex];

  const title = clampVisualText(
    windowResult.mode === "windowed"
      ? `Models · ${windowResult.selectedIndex + 1}/${models.length} · ${activeProviderLabel}`
      : `Select model · ${activeProviderLabel}   ${help}`,
    innerWidth,
  );

  return (
    <Box flexDirection="column" width={panelWidth}>
      <Box
        borderStyle="round"
        borderColor={theme.prompt}
        paddingX={1}
        paddingY={0}
        width={panelWidth}
        flexDirection="column"
      >
        <Box width="100%" overflow="hidden">
          <Text color={theme.accent} bold>
            {title}
          </Text>
        </Box>
        {windowResult.showRouteText && (
          <Box width="100%" overflow="hidden">
            <Text color={theme.textMuted}>{clampVisualText(routeText, innerWidth)}</Text>
          </Box>
        )}
        {windowResult.showReasoningText && (
          <Box width="100%" overflow="hidden">
            <Text color={reasoningUnavailable ? theme.textDim : theme.textMuted}>
              {clampVisualText(
                models.length === 0
                  ? "Reasoning: current/default"
                  : reasoningUnavailable
                    ? isAntigravity
                      ? "Uses this model's native AGY configuration"
                      : "Reasoning: fixed or provider-managed"
                    : `Reasoning: ${formatReasoningLabel(draftReasoning)} · Intelligence: ${formatReasoningLabel(draftReasoning)}`,
                innerWidth,
              )}
            </Text>
          </Box>
        )}
        {windowResult.showSourceMarker && sourceMarker && (
          <Box width="100%" overflow="hidden">
            <Text color={theme.textDim}>{clampVisualText(sourceMarker, innerWidth)}</Text>
          </Box>
        )}

        {windowResult.showCurrentLine && activeModel && (
          <Box height={1} overflow="hidden">
            <Text color={theme.textMuted} wrap="truncate">
              Current:{" "}
              <Text color={theme.text} bold>
                {clampVisualText(getModelName(activeModel), Math.max(1, innerWidth - 9))}
              </Text>
            </Text>
          </Box>
        )}

        {refreshMessage && (
          <Text color={theme.textMuted} wrap="truncate">
            {refreshMessage}
          </Text>
        )}
        <Box
          flexDirection="column"
          marginTop={0}
          width="100%"
          height={models.length > 0 ? visibleModels.length : undefined}
          overflow={models.length > 0 ? "hidden" : undefined}
        >
          {models.length === 0 ? (
            <Text color={theme.textMuted}>
              {isLoading
                ? `Discovering models from ${activeProviderLabel === "OpenAI" ? "the Codex runtime" : activeProviderLabel}...`
                : (emptyMessage ?? "No models available.")}
            </Text>
          ) : (
            visibleModels.map((model, index) => {
              const actualIndex = windowResult.start + index;
              return (
                <ModelPickerRow
                  key={model.id}
                  model={model}
                  width={innerWidth}
                  currentModel={currentModel}
                  isHighlighted={actualIndex === draftSelectedModel}
                />
              );
            })
          )}
        </Box>

        {models.length > 0 &&
          windowResult.mode !== "windowed" &&
          selectedReasoningLevels.length > 1 && (
            <IntelligenceSlider
              levels={selectedReasoningLevels}
              selected={draftReasoning}
              width={innerWidth}
              unavailable={reasoningUnavailable}
            />
          )}
        {selectedModel?.reasoningControl?.kind === "budget" && (
          <Text color={theme.accent}>
            Thinking budget: {draftReasoning.replace("budget:", "")} · ←/→ adjust · A automatic
            {selectedModel.reasoningControl.canDisable ? " · D off" : ""}
          </Text>
        )}
        {selectedReasoningLevels.length <= 1 &&
          selectedModel?.reasoningControl?.kind !== "budget" && (
            <Text color={theme.textMuted}>
              {selectedModel?.reasoningControl?.kind === "fixed"
                ? selectedModel.reasoningControl.label
                : selectedReasoningLevels.length === 1
                  ? `Fixed variant: ${selectedReasoningLevels[0]!.label}`
                  : "Reasoning: provider-managed; no verified control"}
            </Text>
          )}
      </Box>
    </Box>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function ModelPickerRow({
  model,
  width,
  currentModel,
  isHighlighted,
}: {
  model: CodexModelCapability;
  width: number;
  currentModel: string;
  isHighlighted: boolean;
}) {
  const theme = useTheme();

  const isCurrent = isModelIdentifiedBy(model, currentModel);

  const markerWidth = 2;
  const checkWidth = 2;
  const nameWidth = Math.max(8, width - markerWidth - checkWidth);
  const name = clampVisualText(
    `${model.available === false && model.source === "runtime" ? "[Unavailable] " : ""}${isHighlighted ? getModelName(model) : getCompactModelName(model)}`,
    nameWidth,
  );

  return (
    <Box width="100%" overflow="hidden">
      <Box width={markerWidth} flexShrink={0}>
        <Text color={isHighlighted ? theme.accent : theme.textDim}>
          {isHighlighted ? ">" : " "}
        </Text>
      </Box>
      <Box width={nameWidth} flexShrink={0} overflow="hidden">
        <Text
          color={isHighlighted ? theme.text : theme.textMuted}
          bold={isHighlighted}
          wrap="truncate"
        >
          {name}
        </Text>
      </Box>
      <Box width={checkWidth} flexShrink={0}>
        <Text color={theme.textDim}>{isCurrent ? "✓" : " "}</Text>
      </Box>
    </Box>
  );
}

function IntelligenceSlider({
  levels,
  selected,
  width,
  unavailable,
}: {
  levels: readonly ReasoningEffortCapability[];
  selected: string;
  width: number;
  unavailable: boolean;
}) {
  const theme = useTheme();
  if (unavailable) {
    return (
      <Box marginTop={1} width="100%" overflow="hidden">
        <Text color={theme.textDim}>Intelligence unavailable for this model</Text>
      </Box>
    );
  }

  const selectedIndex = Math.max(
    0,
    levels.findIndex((level) => level.id === selected),
  );
  const trackWidth = Math.max(5, Math.min(24, width - 26));
  const thumbPosition =
    levels.length <= 1 ? 0 : Math.round((selectedIndex / (levels.length - 1)) * (trackWidth - 1));
  const track = Array.from({ length: trackWidth }, (_, index) =>
    index === thumbPosition ? "●" : "─",
  ).join("");
  const low = formatReasoningLabel(levels[0]?.id ?? "low");
  const high = formatReasoningLabel(levels[levels.length - 1]?.id ?? "high");
  const value = formatReasoningLabel(levels[selectedIndex]?.id ?? selected);
  const sliderText = `Intelligence  ${low} ${track} ${high}  ${value}`;

  return (
    <Box marginTop={1} width="100%" overflow="hidden">
      <Text color={theme.textMuted} wrap="truncate">
        {clampVisualText(sliderText, width)}
      </Text>
    </Box>
  );
}
