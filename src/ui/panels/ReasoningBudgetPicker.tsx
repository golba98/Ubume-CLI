/**
 * Token-budget editor for providers whose reasoning control is a numeric
 * thinking budget (`ReasoningControl` with `kind: "budget"`), rendered by
 * `SimplePickers.ReasoningPicker` in place of the level list.
 *
 * Owns local state only: `draft` (the stepped/selected value, e.g.
 * `budget:8000` or `auto`) and `entry` (digits typed directly). Values are
 * validated with `core/models/reasoningControl.ts`; the result is reported via
 * `onSelect` and persisted by the caller. Registers the `reasoningPicker` focus
 * id with `autoFocus`; input is only handled while focused.
 *
 * Keys: digits type a budget (max 8 digits), Backspace/Delete erase, Left/Down
 * and Right/Up step the draft (clearing typed digits), `A` sets auto (when the
 * control supports it), `D` sets `budget:0` (when it can be disabled), Enter
 * saves (silently ignored when the value is unsupported), Esc cancels.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useState } from "react";
import {
  isSupportedReasoning,
  reconcileReasoning,
  stepReasoningBudget,
} from "../../core/models/reasoningControl.js";
import type { ReasoningControl } from "../../core/providerRuntime/types.js";
import { FOCUS_IDS } from "../input/focus.js";

/** Budget editor; `value` is the current reasoning string, reconciled to the control on mount. */
export function ReasoningBudgetPicker({
  control,
  value,
  onSelect,
  onCancel,
}: {
  control: Extract<ReasoningControl, { kind: "budget" }>;
  value: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
}) {
  const { isFocused } = useFocus({ id: FOCUS_IDS.reasoningPicker, autoFocus: true });
  const [draft, setDraft] = useState(() => reconcileReasoning(control, value));
  const [entry, setEntry] = useState("");
  useInput(
    (input, key) => {
      if (key.escape) onCancel();
      else if (key.return) {
        const value = entry ? `budget:${entry}` : draft;
        if (isSupportedReasoning(control, value)) onSelect(value);
      } else if (key.backspace || key.delete) setEntry((value) => value.slice(0, -1));
      else if (/^\d+$/.test(input)) setEntry((value) => (value + input).slice(0, 8));
      else if (key.leftArrow || key.downArrow) {
        setEntry("");
        setDraft((value) => stepReasoningBudget(control, value, -1));
      } else if (key.rightArrow || key.upArrow) {
        setEntry("");
        setDraft((value) => stepReasoningBudget(control, value, 1));
      } else if (input.toLowerCase() === "a" && control.auto) {
        setEntry("");
        setDraft("auto");
      } else if (input.toLowerCase() === "d" && control.canDisable) {
        setEntry("");
        setDraft("budget:0");
      }
    },
    { isActive: isFocused },
  );
  return (
    <Box flexDirection="column" borderStyle="round">
      <Text bold>
        {isFocused ? "› " : ""}Thinking budget: {entry || draft.replace("budget:", "")}
      </Text>
      <Text>
        {control.min}–{control.max} tokens · type a budget or arrows adjust · Enter save · Esc
        cancel
        {control.auto ? " · A auto" : ""}
        {control.canDisable ? " · D off" : ""}
      </Text>
    </Box>
  );
}
