/**
 * Plain-text body formatting for reasoning/progress blocks.
 *
 * Shared by the measured row path (`measure/streamRows.ts`
 * `buildCodexThinkingRows`) and the React `TurnGroup` reasoning block so both
 * wrap reasoning text identically. Pure and uncached; callers cache the rows
 * they build from it.
 */
import { normalizeLineBreaks, wrapPlainText } from "../../core/shared/text.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";

// ─── Types ───────────────────────────────────────────────────────────────────

// ─── Block selection ─────────────────────────────────────────────────────────

/**
 * Sanitize and wrap a progress block's text into display lines of at most
 * `width` columns.
 *
 * Source line breaks are kept; blank source lines become `""` entries. Always
 * returns at least one entry (`[" "]` for empty/whitespace-only text) so a
 * block never measures zero rows. Line capping (compact vs verbose) is left to
 * the caller.
 */
export function formatProgressBlockBodyLines(text: string, width: number): string[] {
  const contentWidth = Math.max(1, width);
  const normalized = normalizeLineBreaks(sanitizeTerminalOutput(text)).replace(/[ \t]+\n/g, "\n");

  if (!normalized.trim()) {
    return [" "];
  }

  const rows: string[] = [];
  for (const rawLine of normalized.split("\n")) {
    if (!rawLine.trim()) {
      rows.push("");
      continue;
    }

    const wrapped = wrapPlainText(rawLine, contentWidth);
    rows.push(...(wrapped.length > 0 ? wrapped : [" "]));
  }

  return rows.length > 0 ? rows : [" "];
}
