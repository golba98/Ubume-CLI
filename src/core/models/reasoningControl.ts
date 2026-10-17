import type { ReasoningControl } from "../providerRuntime/types.js";

/** Checks an advertised level or token budget, including explicit auto/disable capabilities. */
export function isSupportedReasoning(
  control: ReasoningControl | undefined,
  value: string,
): boolean {
  if (control?.kind === "levels") return control.levels.some((level) => level.id === value);
  if (control?.kind !== "budget") return false;
  if (value === "auto") return control.auto;
  if (!/^budget:\d+$/.test(value)) return false;
  const budget = Number(value.slice(7));
  return (
    (budget === 0 && control.canDisable) ||
    (Number.isInteger(budget) && budget >= control.min && budget <= control.max)
  );
}

/**
 * Keeps a supported preference or selects the control's valid default; unknown/unsupported
 * controls return an empty value.
 */
export function reconcileReasoning(control: ReasoningControl | undefined, value: string): string {
  if (isSupportedReasoning(control, value)) return value;
  if (control?.kind === "levels")
    return control.levels.some((level) => level.id === control.default)
      ? control.default
      : (control.levels[0]?.id ?? "");
  if (control?.kind === "budget")
    return control.auto && control.default === -1 ? "auto" : `budget:${control.default}`;
  return "";
}

/** Moves a budget by 1024 tokens and clamps it to the advertised range. */
export function stepReasoningBudget(
  control: Extract<ReasoningControl, { kind: "budget" }>,
  value: string,
  direction: -1 | 1,
): string {
  const current = /^budget:\d+$/.test(value) ? Number(value.slice(7)) : control.min;
  return `budget:${Math.max(control.min, Math.min(control.max, current + direction * 1024))}`;
}
