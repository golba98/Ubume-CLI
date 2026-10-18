/**
 * Pure model-picker logic: model identity and display names, Gemini effort-variant
 * grouping, reasoning normalisation, the draft-selection reducer, and the responsive
 * windowing decision.
 *
 * `ModelPickerScreen.tsx` owns rendering and key handling; everything here is
 * deterministic so the selection rules — in particular recovery when the model list
 * changes underneath an open picker — can be tested without Ink.
 *
 * Terminology:
 * - *variant*: providers such as Antigravity expose one model id per effort level
 *   (`gemini-3-pro-low`, `…-high`). The picker collapses them into one row whose
 *   reasoning control selects the variant; `raw.variantIds` remembers the originals.
 * - *draft*: the highlighted row and reasoning level, which only become the active
 *   route when the user presses Enter.
 */
import { formatReasoningLabel } from "../../config/settings.js";
import {
  type CodexModelCapability,
  normalizeReasoningForModelCapabilities,
  type ReasoningEffortCapability,
} from "../../core/models/codexModelCapabilities.js";
import { reconcileReasoning, stepReasoningBudget } from "../../core/models/reasoningControl.js";
import { calculateResponsivePickerViewport } from "./responsivePickerViewport.js";

// ─── Identity & display ──────────────────────────────────────────────────────

/** Original per-effort model ids folded into a collapsed variant row (empty otherwise). */
export function getVariantModelIds(model: CodexModelCapability): readonly string[] {
  const raw = model.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const metadata = raw as { variantIds?: unknown; raw?: { variantIds?: unknown } | null };
  const ids = metadata.variantIds ?? metadata.raw?.variantIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** True when `modelId` names this row: its model id, catalog id, or one of its variants. */
export function isModelIdentifiedBy(model: CodexModelCapability, modelId: string): boolean {
  return (
    model.model === modelId || model.id === modelId || getVariantModelIds(model).includes(modelId)
  );
}

/** Row to highlight when the picker opens: the active model, else the first row. */
export function getInitialCursor(
  models: readonly CodexModelCapability[],
  currentModel: string,
): number {
  return Math.max(
    0,
    models.findIndex((model) => isModelIdentifiedBy(model, currentModel)),
  );
}

/** Mistral Vibe execution classes, as `[full suffix, compact suffix]`. */
const MISTRAL_EXECUTION_SUFFIXES: Record<string, readonly [string, string]> = {
  "native-vibe": [" · Native Vibe", " · Vibe"],
  "custom-vibe": [" · Custom via Vibe (request unverified)", " · Custom"],
  "local-vibe": [" · Local via Vibe", " · Local"],
  unsupported: [" · Unsupported", " · Unsupported"],
};

function mistralExecutionSuffix(model: CodexModelCapability, compact: boolean): string {
  const raw = model.raw as { mistralExecutionClass?: unknown } | null;
  const executionClass = raw?.mistralExecutionClass;
  if (typeof executionClass !== "string") return "";
  return MISTRAL_EXECUTION_SUFFIXES[executionClass]?.[compact ? 1 : 0] ?? "";
}

/** Full row label (used for the highlighted row and the "Current:" line). */
export function getModelName(model: CodexModelCapability): string {
  return `${model.label}${mistralExecutionSuffix(model, false)}`;
}

/** Shorter label for non-highlighted rows; falls back to the model id when unlabeled. */
export function getCompactModelName(model: CodexModelCapability): string {
  return `${model.label || model.model}${mistralExecutionSuffix(model, true)}`;
}

/** Discrete reasoning levels advertised for a model (empty when none or unknown). */
export function getReasoningLevels(
  model: CodexModelCapability | undefined,
): readonly ReasoningEffortCapability[] {
  return model?.supportedReasoningLevels ?? [];
}

/**
 * Provenance line for Claude Code model lists (installed package, command, cache,
 * settings or fallback aliases). Null for every other provider.
 */
export function getModelSourceMarker(
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

// ─── Gemini effort variants ──────────────────────────────────────────────────

const GEMINI_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const GEMINI_EFFORT_IDS = new Set(GEMINI_EFFORT_ORDER);

function effortLevel(id: string): ReasoningEffortCapability {
  return { id, label: formatReasoningLabel(id), description: null };
}

function withVariantIds(model: CodexModelCapability, ids: readonly string[]): unknown {
  return { ...(model.raw && typeof model.raw === "object" ? model.raw : {}), variantIds: ids };
}

/**
 * Collapses per-effort Gemini model ids (`<family>-<effort>` with a `variant`
 * reasoning transport) into one row per family whose reasoning levels are the
 * efforts that were present, in canonical order. Every other model passes through.
 * Row order follows the first appearance of each family.
 */
export function collapseGeminiEffortVariants(
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

    if (!existing) {
      const label = model.label.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, "");
      groups.set(familyId, {
        ...model,
        id: familyId,
        model: familyId,
        label,
        description: `Select the intelligence level for ${label}.`,
        defaultReasoningLevel: level,
        supportedReasoningLevels: [effortLevel(level)],
        reasoningLevelCount: 1,
        reasoningControl: {
          kind: "levels",
          transport: "variant",
          default: level,
          levels: [effortLevel(level)],
        },
        raw: withVariantIds(model, ids),
      });
      continue;
    }

    const orderedLevels = GEMINI_EFFORT_ORDER.filter((id) => levels.has(id));
    groups.set(familyId, {
      ...existing,
      supportedReasoningLevels: orderedLevels.map(effortLevel),
      reasoningLevelCount: orderedLevels.length,
      reasoningControl: {
        kind: "levels",
        transport: "variant",
        default: existing.defaultReasoningLevel ?? orderedLevels[0]!,
        levels: orderedLevels.map(effortLevel),
      },
      raw: withVariantIds(existing, ids),
    });
  }

  return [...groups.values()].map((model) => {
    const ids = variantIds.get(model.model);
    return ids ? { ...model, raw: withVariantIds(model, ids) } : model;
  });
}

function isVariantTransport(model: CodexModelCapability | undefined): boolean {
  return (
    model?.reasoningControl?.kind === "levels" && model.reasoningControl.transport === "variant"
  );
}

/** Effort encoded in `modelId` when it is one of this row's variants, else null. */
export function getVariantReasoning(
  model: CodexModelCapability | undefined,
  modelId: string,
): string | null {
  if (!model || !isVariantTransport(model)) return null;
  const variant = getVariantModelIds(model).find((id) => id === modelId);
  const match = variant?.match(/-(low|medium|high|xhigh|max)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The concrete model id to activate for a row and reasoning choice: the matching
 * per-effort variant for variant rows; otherwise the row's model (keeping the
 * current id when it is one of the row's variants).
 */
export function resolveVariantModelId(
  model: CodexModelCapability,
  reasoning: string,
  currentModel: string,
): string {
  const variantIds = getVariantModelIds(model);
  if (!isVariantTransport(model)) {
    return variantIds.includes(currentModel) ? currentModel : model.model;
  }
  return variantIds.find((id) => id.endsWith(`-${reasoning.toLowerCase()}`)) ?? model.model;
}

// ─── Reasoning ───────────────────────────────────────────────────────────────

/**
 * Coerces a reasoning value to one the model supports: through its advertised
 * reasoning control when present, else through the Codex capability rules.
 */
export function normalizeDraftReasoning(
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

// ─── Draft selection reducer ─────────────────────────────────────────────────

/**
 * The picker's draft. `identity` is the model id of the highlighted row, so the
 * highlight can follow that model when the list is reordered or refreshed.
 */
export interface ModelPickerSelection {
  cursor: number;
  identity: string | undefined;
  reasoning: string;
  /** Claude intent survives stale capability snapshots until fresh discovery arrives. */
  requestedReasoning?: string;
}

function isClaudeModel(model: CodexModelCapability | undefined): boolean {
  const raw = model?.raw as { providerId?: string; effortSource?: string; source?: string } | null;
  return (
    raw?.providerId === "anthropic" ||
    raw?.effortSource !== undefined ||
    Boolean(raw?.source?.startsWith("claude-code"))
  );
}

export type ModelPickerSelectionAction =
  /** Move the highlight by one row (clamped). */
  | { type: "move"; models: readonly CodexModelCapability[]; direction: -1 | 1 }
  /** Jump the highlight to an index (clamped). */
  | { type: "select"; models: readonly CodexModelCapability[]; index: number }
  /** Step the reasoning level/budget of the highlighted model. */
  | { type: "stepReasoning"; models: readonly CodexModelCapability[]; direction: -1 | 1 }
  /** Set the reasoning value directly (budget "auto" / "budget:0" shortcuts). */
  | { type: "setReasoning"; reasoning: string }
  /**
   * The model list or the active route changed while the picker is open.
   * `activeChanged` is true when the active model/reasoning changed, in which case
   * the draft reasoning is re-seeded from the active route.
   */
  | {
      type: "sync";
      models: readonly CodexModelCapability[];
      currentModel: string;
      currentReasoning: string;
      activeChanged: boolean;
    };

/** Initial draft: the active model highlighted with its (variant-aware) reasoning. */
export function initModelPickerSelection(params: {
  models: readonly CodexModelCapability[];
  currentModel: string;
  currentReasoning: string;
}): ModelPickerSelection {
  const { models, currentModel, currentReasoning } = params;
  const cursor = getInitialCursor(models, currentModel);
  const model = models[cursor];
  return {
    cursor,
    identity: model?.model,
    reasoning: normalizeDraftReasoning(
      model,
      getVariantReasoning(model, currentModel) ?? currentReasoning,
    ),
    ...(isClaudeModel(model) ? { requestedReasoning: currentReasoning } : {}),
  };
}

/** Highlights `index` (clamped); the new row's preferred reasoning wins if it has one. */
function highlight(
  state: ModelPickerSelection,
  models: readonly CodexModelCapability[],
  index: number,
): ModelPickerSelection {
  const cursor = Math.max(0, Math.min(models.length - 1, index));
  const model = models[cursor];
  const requested =
    model?.reasoningPreference ??
    (isClaudeModel(model) ? (state.requestedReasoning ?? state.reasoning) : state.reasoning);
  return {
    cursor,
    identity: model?.model,
    reasoning: normalizeDraftReasoning(model, requested),
    ...(isClaudeModel(model) ? { requestedReasoning: requested } : {}),
  };
}

/**
 * Draft-selection transitions. Pure: no React state, refs or side effects.
 *
 * Recovery rule for `sync`: the highlight stays on the same model (by id or variant
 * id) if it still exists; otherwise it keeps its index, clamped to the new list. An
 * empty list parks the cursor at 0 and resets the draft reasoning to the active one —
 * Enter then closes the picker with an `empty-selection` reason instead of selecting
 * a model that no longer exists.
 */
export function modelPickerSelectionReducer(
  state: ModelPickerSelection,
  action: ModelPickerSelectionAction,
): ModelPickerSelection {
  switch (action.type) {
    case "move":
      return highlight(state, action.models, state.cursor + action.direction);

    case "select":
      return highlight(state, action.models, action.index);

    case "setReasoning":
      return {
        ...state,
        reasoning: action.reasoning,
        ...(state.requestedReasoning !== undefined ? { requestedReasoning: action.reasoning } : {}),
      };

    case "stepReasoning": {
      const model = action.models[state.cursor];
      const control = model?.reasoningControl;
      if (control?.kind === "budget") {
        return {
          ...state,
          reasoning: stepReasoningBudget(control, state.reasoning, action.direction),
        };
      }
      const levels = getReasoningLevels(model);
      if (levels.length <= 1) return state;
      const currentIndex = getReasoningIndex(levels, state.reasoning);
      const nextIndex = Math.max(0, Math.min(levels.length - 1, currentIndex + action.direction));
      const reasoning = levels[nextIndex]?.id ?? state.reasoning;
      return {
        ...state,
        reasoning,
        ...(isClaudeModel(model) ? { requestedReasoning: reasoning } : {}),
      };
    }

    case "sync": {
      const { models, currentModel, currentReasoning, activeChanged } = action;
      if (models.length === 0) return { ...state, cursor: 0, reasoning: currentReasoning };

      const identity = state.identity ?? "";
      const identityIndex = models.findIndex(
        (model) => model.model === state.identity || getVariantModelIds(model).includes(identity),
      );
      const cursor =
        identityIndex >= 0 ? identityIndex : Math.min(Math.max(0, state.cursor), models.length - 1);
      const model = models[cursor];
      const requested = activeChanged
        ? (getVariantReasoning(model, currentModel) ?? currentReasoning)
        : isClaudeModel(model)
          ? (state.requestedReasoning ?? state.reasoning)
          : state.reasoning;
      return {
        cursor,
        identity: model?.model,
        reasoning: normalizeDraftReasoning(model, requested),
        ...(isClaudeModel(model) ? { requestedReasoning: requested } : {}),
      };
    }
  }
}

// ─── Responsive window ───────────────────────────────────────────────────────

/** Which chrome rows fit, plus the visible slice of the model list. */
export interface ModelPickerWindow {
  start: number;
  end: number;
  capacity: number;
  selectedIndex: number;
  /** full: everything fits; compact: model rows plus some chrome; windowed: scrolling list. */
  mode: "full" | "compact" | "windowed";
  /** Show a "Current: …" line because the active model is scrolled out of view. */
  showCurrentLine: boolean;
  showRouteText: boolean;
  showReasoningText: boolean;
  showSourceMarker: boolean;
}

/**
 * Chooses the richest layout that fits `availableRows` (the panel body inside the
 * border), dropping chrome in this order: source marker, route text, reasoning
 * text; and finally scrolling the list (with a "Current:" line when the active
 * model is outside the visible window).
 */
export function calculateModelPickerWindow(params: {
  itemCount: number;
  selectedIndex: number;
  availableRows: number;
  scrollOffset: number;
  hasSourceMarker: boolean;
  /** False when the app budget hides panel column headers; disables the full layout. */
  allowFull: boolean;
  activeModelIndex: number;
}): ModelPickerWindow {
  const {
    itemCount,
    selectedIndex,
    availableRows,
    scrollOffset,
    hasSourceMarker,
    allowFull,
    activeModelIndex,
  } = params;
  const viewport = (chromeRows: number) =>
    calculateResponsivePickerViewport({
      itemCount,
      selectedIndex,
      availableRows,
      chromeRows,
      scrollOffset,
    });
  const hidden = { showCurrentLine: false, showSourceMarker: false };

  const fullChrome = 5 + (hasSourceMarker ? 1 : 0);
  if (allowFull && itemCount + fullChrome <= availableRows) {
    return {
      ...viewport(fullChrome),
      ...hidden,
      mode: "full",
      showRouteText: true,
      showReasoningText: true,
      showSourceMarker: hasSourceMarker,
    };
  }
  if (allowFull && itemCount + 5 <= availableRows) {
    return {
      ...viewport(3),
      ...hidden,
      mode: "full",
      showRouteText: true,
      showReasoningText: true,
    };
  }
  if (itemCount + 4 <= availableRows) {
    return {
      ...viewport(2),
      ...hidden,
      mode: "compact",
      showRouteText: false,
      showReasoningText: true,
    };
  }
  if (itemCount + 2 <= availableRows) {
    return {
      ...viewport(1),
      ...hidden,
      mode: "compact",
      showRouteText: false,
      showReasoningText: false,
    };
  }

  // Windowed: reserve a second chrome row for "Current:" only when the active model
  // would otherwise be scrolled out of view, then re-check with the smaller window.
  const isOutside = (window: { start: number; end: number }) =>
    activeModelIndex < window.start || activeModelIndex >= window.end;
  let window = viewport(1);
  let showCurrentLine = activeModelIndex >= 0 && isOutside(window);
  if (showCurrentLine) {
    window = viewport(2);
    showCurrentLine = isOutside(window);
  }
  return {
    ...window,
    mode: "windowed",
    showCurrentLine,
    showRouteText: false,
    showReasoningText: false,
    showSourceMarker: false,
  };
}
