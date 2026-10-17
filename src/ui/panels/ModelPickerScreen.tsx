import { Box, Text, useFocus, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatReasoningLabel } from "../../config/settings.js";
import {
  type CodexModelCapability,
  normalizeReasoningForModelCapabilities,
  type ReasoningEffortCapability,
} from "../../core/models/codexModelCapabilities.js";
import { reconcileReasoning, stepReasoningBudget } from "../../core/models/reasoningControl.js";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import { clampVisualText } from "../../core/shared/text.js";
import { FOCUS_IDS } from "../input/focus.js";
import {
  type ActivePanelLayout,
  getAvailableRowsForPanel,
  getShellWidth,
  type Layout,
  type PanelLayout,
  useActivePanelLayout,
  useAppLayoutBudget,
  usePanelAvailableRows,
  usePanelLayout,
} from "../layout.js";
import { useTheme } from "../theme.js";
import { calculateResponsivePickerViewport } from "./responsivePickerViewport.js";

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

function getInitialCursor(models: readonly CodexModelCapability[], currentModel: string): number {
  const index = models.findIndex(
    (model) =>
      model.model === currentModel ||
      model.id === currentModel ||
      getVariantModelIds(model).includes(currentModel),
  );
  return Math.max(0, index);
}

function getModelName(model: CodexModelCapability): string {
  const raw = model.raw as { mistralExecutionClass?: unknown } | null;
  const suffix =
    raw?.mistralExecutionClass === "native-vibe"
      ? " · Native Vibe"
      : raw?.mistralExecutionClass === "custom-vibe"
        ? " · Custom via Vibe (request unverified)"
        : raw?.mistralExecutionClass === "local-vibe"
          ? " · Local via Vibe"
          : raw?.mistralExecutionClass === "unsupported"
            ? " · Unsupported"
            : "";
  return `${model.label}${suffix}`;
}

function getReasoningLevels(
  model: CodexModelCapability | undefined,
): readonly ReasoningEffortCapability[] {
  return model?.supportedReasoningLevels ?? [];
}

const GEMINI_EFFORT_IDS = new Set(["low", "medium", "high", "xhigh", "max"]);

function collapseGeminiEffortVariants(
  models: readonly CodexModelCapability[],
): readonly CodexModelCapability[] {
  const groups = new Map<string, CodexModelCapability>();
  const variantIds = new Map<string, string[]>();
  const variantLevels = new Map<string, Set<string>>();

  for (const model of models) {
    const match = model.model.match(/^(.*?)-(low|medium|high|xhigh|max)$/i);
    if (
      !match ||
      !GEMINI_EFFORT_IDS.has(match[2]!.toLowerCase()) ||
      model.reasoningControl?.kind !== "levels" ||
      model.reasoningControl.transport !== "variant"
    ) {
      groups.set(model.id, model);
      continue;
    }

    const familyId = match[1]!;
    const existing = groups.get(familyId);
    const level = match[2]!.toLowerCase();
    const ids = variantIds.get(familyId) ?? [];
    ids.push(model.model);
    variantIds.set(familyId, ids);
    const levels = variantLevels.get(familyId) ?? new Set<string>();
    levels.add(level);
    variantLevels.set(familyId, levels);

    const label = model.label.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, "");
    if (!existing) {
      groups.set(familyId, {
        ...model,
        id: familyId,
        model: familyId,
        label,
        description: `Select the intelligence level for ${label}.`,
        defaultReasoningLevel: level,
        supportedReasoningLevels: [
          { id: level, label: formatReasoningLabel(level), description: null },
        ],
        reasoningLevelCount: 1,
        reasoningControl: {
          kind: "levels",
          transport: "variant",
          default: level,
          levels: [{ id: level, label: formatReasoningLabel(level), description: null }],
        },
        raw: { ...(model.raw && typeof model.raw === "object" ? model.raw : {}), variantIds: ids },
      });
    } else {
      const orderedLevels = ["low", "medium", "high", "xhigh", "max"].filter((id) =>
        levels.has(id),
      );
      groups.set(familyId, {
        ...existing,
        supportedReasoningLevels: orderedLevels.map((id) => ({
          id,
          label: formatReasoningLabel(id),
          description: null,
        })),
        reasoningLevelCount: orderedLevels.length,
        reasoningControl: {
          kind: "levels",
          transport: "variant",
          default: existing.defaultReasoningLevel ?? orderedLevels[0]!,
          levels: orderedLevels.map((id) => ({
            id,
            label: formatReasoningLabel(id),
            description: null,
          })),
        },
        raw: {
          ...(existing.raw && typeof existing.raw === "object" ? existing.raw : {}),
          variantIds: ids,
        },
      });
    }
  }

  return [...groups.values()].map((model) => {
    const ids = variantIds.get(model.model);
    if (!ids) return model;
    return {
      ...model,
      raw: { ...(model.raw && typeof model.raw === "object" ? model.raw : {}), variantIds: ids },
    };
  });
}

function getVariantModelIds(model: CodexModelCapability): readonly string[] {
  const raw = model.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const metadata = raw as { variantIds?: unknown; raw?: { variantIds?: unknown } | null };
  const ids = metadata.variantIds ?? metadata.raw?.variantIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function getVariantReasoning(
  model: CodexModelCapability | undefined,
  modelId: string,
): string | null {
  if (model?.reasoningControl?.kind !== "levels" || model.reasoningControl.transport !== "variant")
    return null;
  const variant = getVariantModelIds(model).find((id) => id === modelId);
  const match = variant?.match(/-(low|medium|high|xhigh|max)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function resolveVariantModelId(
  model: CodexModelCapability,
  reasoning: string,
  currentModel: string,
): string {
  const variantIds = getVariantModelIds(model);
  if (model.reasoningControl?.kind !== "levels" || model.reasoningControl.transport !== "variant") {
    return variantIds.includes(currentModel) ? currentModel : model.model;
  }
  return variantIds.find((id) => id.endsWith(`-${reasoning.toLowerCase()}`)) ?? model.model;
}

function getModelSourceMarker(
  models: readonly CodexModelCapability[],
  activeProviderLabel: string,
): string | null {
  if (activeProviderLabel !== "Claude" || models.length === 0) return null;
  const raw = models[0]?.raw as { source?: string; discoveryKind?: string } | null | undefined;
  const source = raw?.source;
  const sourceLabel =
    source === "claude-code-package"
      ? "installed package metadata"
      : source === "claude-code-command"
        ? "Claude Code command"
        : source === "claude-code-cache"
          ? "Claude Code cache"
          : source === "claude-code-config" || source === "settings" || source === "config"
            ? "Claude settings"
            : "Claude Code";
  if (
    source === "claude-code-package" ||
    source === "claude-code-command" ||
    source === "claude-code-cache" ||
    source === "claude-code-config" ||
    source === "claude-code" ||
    source === "discovered"
  ) {
    return raw?.discoveryKind === "aliases"
      ? `Claude Code aliases resolved from ${sourceLabel}`
      : `Claude Code models discovered from ${sourceLabel}`;
  }
  if (source === "settings" || source === "config")
    return "Claude Code models discovered from Claude settings";
  if (source === "fallback") return "Claude Code discovery failed; using fallback aliases";
  return null;
}

function normalizeDraftReasoning(
  model: CodexModelCapability | undefined,
  reasoning: string,
): string {
  if (!model) return reasoning;
  if (model.reasoningControl) return reconcileReasoning(model.reasoningControl, reasoning);
  return normalizeReasoningForModelCapabilities(model.model, reasoning, {
    status: "ready",
    source: model.source,
    models: [model],
    discoveredAt: Date.now(),
    executable: null,
    error: null,
  });
}

function getReasoningIndex(
  levels: readonly ReasoningEffortCapability[],
  reasoning: string,
): number {
  return Math.max(
    0,
    levels.findIndex((level) => level.id === reasoning),
  );
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
  const initialModelIndex = getInitialCursor(models, currentModel);
  const [draftSelectedModel, setDraftSelectedModel] = useState(initialModelIndex);
  const selectedIdentityRef = useRef(models[initialModelIndex]?.model);
  const previousActiveSelection = useRef({ currentModel, currentReasoning });
  const [draftReasoning, setDraftReasoning] = useState(() =>
    normalizeDraftReasoning(
      models[initialModelIndex],
      getVariantReasoning(models[initialModelIndex], currentModel) ?? currentReasoning,
    ),
  );
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

  useEffect(() => {
    const activeChanged =
      previousActiveSelection.current.currentModel !== currentModel ||
      previousActiveSelection.current.currentReasoning !== currentReasoning;
    previousActiveSelection.current = { currentModel, currentReasoning };
    if (models.length === 0) {
      setDraftSelectedModel(0);
      setDraftReasoning(currentReasoning);
      return;
    }

    setDraftSelectedModel((current) => {
      const identityIndex = models.findIndex(
        (item) =>
          item.model === selectedIdentityRef.current ||
          getVariantModelIds(item).includes(selectedIdentityRef.current ?? ""),
      );
      const nextCursor =
        identityIndex >= 0 ? identityIndex : Math.min(Math.max(0, current), models.length - 1);
      selectedIdentityRef.current = models[nextCursor]?.model;
      const nextModel = models[nextCursor];
      setDraftReasoning((reasoning) =>
        normalizeDraftReasoning(
          nextModel,
          activeChanged
            ? (getVariantReasoning(nextModel, currentModel) ?? currentReasoning)
            : reasoning,
        ),
      );
      return nextCursor;
    });
  }, [currentModel, currentReasoning, models]);

  const moveModel = (direction: -1 | 1) => {
    setDraftSelectedModel((current) => {
      const next = Math.max(0, Math.min(models.length - 1, current + direction));
      const nextModel = models[next];
      selectedIdentityRef.current = nextModel?.model;
      setDraftReasoning((reasoning) =>
        normalizeDraftReasoning(nextModel, nextModel?.reasoningPreference ?? reasoning),
      );
      return next;
    });
  };

  const selectModelIndex = (index: number) => {
    setDraftSelectedModel(() => {
      const next = Math.max(0, Math.min(models.length - 1, index));
      selectedIdentityRef.current = models[next]?.model;
      setDraftReasoning((reasoning) =>
        normalizeDraftReasoning(models[next], models[next]?.reasoningPreference ?? reasoning),
      );
      return next;
    });
  };

  const moveReasoning = (direction: -1 | 1) => {
    const control = models[draftSelectedModel]?.reasoningControl;
    if (control?.kind === "budget") {
      setDraftReasoning((current) => stepReasoningBudget(control, current, direction));
      return;
    }
    const levels = getReasoningLevels(models[draftSelectedModel]);
    if (levels.length <= 1) return;

    setDraftReasoning((current) => {
      const currentIndex = getReasoningIndex(levels, current);
      const nextIndex = Math.max(0, Math.min(levels.length - 1, currentIndex + direction));
      return levels[nextIndex]?.id ?? current;
    });
  };

  useInput(
    (input, key) => {
      if (input.toLowerCase() === "r" && onRefresh) {
        onRefresh();
        return;
      }
      const control = selectedModel?.reasoningControl;
      if (control?.kind === "budget" && input === "a" && control.auto) {
        setDraftReasoning("auto");
        return;
      }
      if (control?.kind === "budget" && input === "d" && control.canDisable) {
        setDraftReasoning("budget:0");
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

      if (key.ctrl && (input === "c" || input === "q")) {
        onCancel("escape");
        return;
      }

      if (key.escape) {
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

      if (key.upArrow || input === "k") {
        moveModel(-1);
        return;
      }

      if (key.downArrow || input === "j") {
        moveModel(1);
        return;
      }

      if (key.home) {
        selectModelIndex(0);
        return;
      }

      if (key.end) {
        selectModelIndex(models.length - 1);
        return;
      }

      if (key.pageUp) {
        selectModelIndex(draftSelectedModel - Math.max(1, windowResult.capacity));
        return;
      }

      if (key.pageDown) {
        selectModelIndex(draftSelectedModel + Math.max(1, windowResult.capacity));
        return;
      }

      if (key.leftArrow || input === "h") {
        moveReasoning(-1);
        return;
      }

      if (key.rightArrow || input === "l") {
        moveReasoning(1);
      }
    },
    { isActive: isFocused },
  );

  const contextLayout = useActivePanelLayout();
  const activeLayout = (activePanelLayout ?? contextLayout) as ActivePanelLayout | undefined;

  const shellWidth = getShellWidth(layout.cols);
  const hookPanelLayout = usePanelLayout();
  const hookAvailableRows = usePanelAvailableRows();
  const resolvedPanelLayout = useMemo<PanelLayout>(() => {
    if (panelLayout) return panelLayout;
    if (hookPanelLayout) return hookPanelLayout;

    const mode = layout.mode;
    const resolvedRows = activeLayout
      ? activeLayout.availableRows
      : getAvailableRowsForPanel(layout, propAvailableRows ?? hookAvailableRows);
    const resolvedCols = activeLayout ? activeLayout.availableCols : Math.max(20, shellWidth - 4);

    return {
      mode,
      availableRows: resolvedRows,
      availableCols: resolvedCols,
    };
  }, [
    panelLayout,
    hookPanelLayout,
    layout,
    activeLayout,
    propAvailableRows,
    shellWidth,
    hookAvailableRows,
  ]);

  const panelWidth = activeLayout
    ? activeLayout.width
    : Math.max(38, Math.min(layout.contentWidth ?? shellWidth, shellWidth - 2));

  const availableRows = resolvedPanelLayout.availableRows;
  const innerWidth = Math.max(1, Math.min(resolvedPanelLayout.availableCols, panelWidth - 4));
  const help =
    resolvedPanelLayout.mode === "compact"
      ? "↑↓ model · ←→ effort · R refresh · Enter · Esc"
      : "↑↓ model · ←→ reasoning · R refresh · Enter select · Esc cancel";
  const aOrAn = /^[aeiou]/i.test(activeProviderLabel) ? "an" : "a";
  const routeText =
    routeTextOverride ?? `Choose ${aOrAn} ${activeProviderLabel} model to use inside Ubume.`;
  const sourceMarker = getModelSourceMarker(models, activeProviderLabel);

  const appLayoutBudget = useAppLayoutBudget();

  const activeModelIndex = models.findIndex(
    (model) =>
      model.model === currentModel ||
      model.id === currentModel ||
      getVariantModelIds(model).includes(currentModel),
  );
  const hasSourceMarker = !!sourceMarker;

  // ─── Layout & Windowing ───────────────────────────────────────────────────

  const windowResult = useMemo(() => {
    const allowFull = appLayoutBudget?.showPanelColumnHeaders ?? true;

    // availableRows is already the shell's border-safe panel body. Only rows
    // rendered inside that body belong in this calculation.
    const fullChrome = 5 + (hasSourceMarker ? 1 : 0);
    if (allowFull && models.length + fullChrome <= availableRows) {
      return {
        ...calculateResponsivePickerViewport({
          itemCount: models.length,
          selectedIndex: draftSelectedModel,
          availableRows,
          chromeRows: fullChrome,
          scrollOffset,
        }),
        mode: "full" as const,
        showCurrentLine: false,
        showRouteText: true,
        showReasoningText: true,
        showSourceMarker: hasSourceMarker,
      };
    }

    // Try fitting without source marker
    if (allowFull && models.length + 5 <= availableRows) {
      return {
        ...calculateResponsivePickerViewport({
          itemCount: models.length,
          selectedIndex: draftSelectedModel,
          availableRows,
          chromeRows: 3,
          scrollOffset,
        }),
        mode: "full" as const,
        showCurrentLine: false,
        showRouteText: true,
        showReasoningText: true,
        showSourceMarker: false,
      };
    }

    // Try compact with the dedicated intelligence control
    if (models.length + 4 <= availableRows) {
      return {
        ...calculateResponsivePickerViewport({
          itemCount: models.length,
          selectedIndex: draftSelectedModel,
          availableRows,
          chromeRows: 2,
          scrollOffset,
        }),
        mode: "compact" as const,
        showCurrentLine: false,
        showRouteText: false,
        showReasoningText: true,
        showSourceMarker: false,
      };
    }

    // Try minimal compact
    if (models.length + 2 <= availableRows) {
      return {
        ...calculateResponsivePickerViewport({
          itemCount: models.length,
          selectedIndex: draftSelectedModel,
          availableRows,
          chromeRows: 1,
          scrollOffset,
        }),
        mode: "compact" as const,
        showCurrentLine: false,
        showRouteText: false,
        showReasoningText: false,
        showSourceMarker: false,
      };
    }

    // Windowed mode
    let window = calculateResponsivePickerViewport({
      itemCount: models.length,
      selectedIndex: draftSelectedModel,
      availableRows,
      chromeRows: 1,
      scrollOffset,
    });
    let showCurrentLine =
      activeModelIndex >= 0 && (activeModelIndex < window.start || activeModelIndex >= window.end);
    if (showCurrentLine) {
      window = calculateResponsivePickerViewport({
        itemCount: models.length,
        selectedIndex: draftSelectedModel,
        availableRows,
        chromeRows: 2,
        scrollOffset,
      });
      showCurrentLine = activeModelIndex < window.start || activeModelIndex >= window.end;
    }

    return {
      ...window,
      mode: "windowed" as const,
      showCurrentLine,
      showRouteText: false,
      showReasoningText: false,
      showSourceMarker: false,
    };
  }, [
    models.length,
    draftSelectedModel,
    availableRows,
    hasSourceMarker,
    appLayoutBudget?.showPanelColumnHeaders,
    scrollOffset,
    activeModelIndex,
  ]);

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

  const isCurrent =
    model.model === currentModel ||
    model.id === currentModel ||
    getVariantModelIds(model).includes(currentModel);

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

function getCompactModelName(model: CodexModelCapability): string {
  const raw = model.raw as { mistralExecutionClass?: unknown } | null;
  const suffix =
    raw?.mistralExecutionClass === "native-vibe"
      ? " · Vibe"
      : raw?.mistralExecutionClass === "custom-vibe"
        ? " · Custom"
        : raw?.mistralExecutionClass === "local-vibe"
          ? " · Local"
          : raw?.mistralExecutionClass === "unsupported"
            ? " · Unsupported"
            : "";
  return `${model.label || model.model}${suffix}`;
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
