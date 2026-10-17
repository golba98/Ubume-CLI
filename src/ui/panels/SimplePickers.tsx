/**
 * Thin wrappers that configure `SelectionPanel` for the mode, theme and
 * reasoning-level overlays (and delegate budget-style reasoning to
 * `ReasoningBudgetPicker`).
 *
 * Stateless: the current values and the select/cancel/highlight callbacks come
 * from `src/app/overlays/OverlayPanels.tsx`, which also applies the choice.
 * Each picker uses its own `FOCUS_IDS` entry so `useFocusRouting` can focus it.
 */
import {
  AVAILABLE_MODES,
  AVAILABLE_THEMES,
  formatReasoningLabel,
  formatThemeLabel,
} from "../../config/settings.js";
import type { ReasoningEffortCapability } from "../../core/models/codexModelCapabilities.js";
import type { ReasoningControl } from "../../core/providerRuntime/types.js";
import { FOCUS_IDS } from "../input/focus.js";
import { ReasoningBudgetPicker } from "./ReasoningBudgetPicker.js";
import { SelectionPanel } from "./SelectionPanel.js";

interface ModePickerProps {
  currentMode: string;
  planMode?: boolean;
  onSelect: (mode: string) => void;
  onCancel: () => void;
}

/**
 * Execution-mode picker. The first item, `plan`, toggles session plan mode
 * (checked when `planMode`); the rest are `AVAILABLE_MODES`, with the current
 * one checked. No initial value is passed, so the cursor starts on `plan`.
 */
export function ModePicker({ currentMode, planMode = false, onSelect, onCancel }: ModePickerProps) {
  const items = [
    { label: planMode ? "Plan  ✓" : "Plan", value: "plan" },
    ...AVAILABLE_MODES.map((mode) => ({
      label: mode.key === currentMode ? `${mode.label}  ✓` : mode.label,
      value: mode.key,
    })),
  ];

  return (
    <SelectionPanel
      focusId={FOCUS_IDS.modePicker}
      title="Select mode"
      subtitle="Plan inspects without changing files; execution modes control implementation access."
      items={items}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}

interface ThemePickerProps {
  currentTheme: string;
  onSelect: (themeId: string) => void;
  onHighlight?: (themeId: string) => void;
  onCancel: () => void;
}

/**
 * Theme picker starting on the current theme. `onHighlight` fires while moving,
 * which the app uses to preview the theme before Enter commits it.
 */
export function ThemePicker({ currentTheme, onSelect, onHighlight, onCancel }: ThemePickerProps) {
  const items = AVAILABLE_THEMES.map((theme) => ({
    label:
      theme.id === currentTheme ? `${formatThemeLabel(theme.id)}  ✓` : formatThemeLabel(theme.id),
    value: theme.id,
  }));

  return (
    <SelectionPanel
      focusId={FOCUS_IDS.themePicker}
      title="Select visual theme"
      subtitle="Use arrow keys and Enter to switch. Esc closes the panel."
      items={items}
      limit={8}
      initialValue={currentTheme}
      onSelect={onSelect}
      onHighlight={onHighlight}
      onCancel={onCancel}
    />
  );
}

interface ReasoningPickerProps {
  /** Provider reasoning control; `kind: "budget"` switches to `ReasoningBudgetPicker`. */
  control?: ReasoningControl;
  currentReasoning: string;
  currentModel: string;
  reasoningLevels: readonly ReasoningEffortCapability[];
  /** Model's suggested level; preselected when the current level is not offered. */
  defaultReasoning: string | null;
  /** Where the level list came from, appended to the subtitle. */
  sourceLabel?: string | null;
  onSelect: (reasoning: string) => void;
  onCancel: () => void;
}

/** Reasoning picker: level list from `reasoningLevels`, or the budget editor for budget controls. */
export function ReasoningPicker({
  control,
  currentReasoning,
  currentModel,
  reasoningLevels,
  defaultReasoning,
  sourceLabel,
  onSelect,
  onCancel,
}: ReasoningPickerProps) {
  if (control?.kind === "budget")
    return (
      <ReasoningBudgetPicker
        control={control}
        value={currentReasoning}
        onSelect={onSelect}
        onCancel={onCancel}
      />
    );
  const items = reasoningLevels.map((reasoning) => ({
    label: reasoning.id === currentReasoning ? `${reasoning.label}  ✓` : reasoning.label,
    value: reasoning.id,
  }));

  const baseSubtitle = defaultReasoning
    ? `Suggested for ${currentModel}: ${formatReasoningLabel(defaultReasoning)}`
    : `Detected levels for ${currentModel}`;
  const subtitle = sourceLabel ? `${baseSubtitle} · ${sourceLabel}` : baseSubtitle;

  return (
    <SelectionPanel
      focusId={FOCUS_IDS.reasoningPicker}
      title="Select reasoning level"
      subtitle={subtitle}
      items={items}
      initialValue={
        items.some((item) => item.value === currentReasoning)
          ? currentReasoning
          : (defaultReasoning ?? undefined)
      }
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}
