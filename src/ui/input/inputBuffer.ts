/**
 * Pure text-editing model behind the composer: sanitizing input, cursor
 * movement, insert/delete, wrapping into a scrollable viewport, horizontal row
 * windowing, word/line/vertical navigation, coalescing undo, and history search.
 *
 * Cursor offsets are UTF-16 indices into the string. Every operation keeps the
 * cursor off the middle of a surrogate pair, and the word/vertical helpers snap
 * out of the middle of atomic chips (see `pastedContent.ts`). Widths come from
 * `core/shared/text.ts` (terminal cell widths, not string lengths).
 *
 * Consumers: the composer (`chrome/composer/*`, `chrome/BottomComposer.tsx`)
 * and `panels/TextEntryPanel.tsx`. Owns no React state; the only stateful piece is the
 * `InputUndo` class, instantiated and held by the caller.
 */
import type { WrappedTextRow } from "../../core/shared/text.js";
import {
  getTextUnits,
  getTextWidth,
  normalizeLineBreaks,
  wrapTextRows,
} from "../../core/shared/text.js";
import { sanitizeTerminalInput } from "../../core/terminal/terminalSanitize.js";
import { findPastedContentSpan } from "./pastedContent.js";

type WrappedInputRow = WrappedTextRow;

/** Result of `createInputViewport`: all wrapped rows plus the visible window. */
interface InputViewport {
  rows: WrappedInputRow[];
  visibleRows: WrappedInputRow[];
  cursorRow: number;
  cursorColumn: number;
  scrollRow: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** SGR mouse report (`ESC [ < b ; x ; y M|m`), with or without its ESC byte. */
const LEAKED_SGR_MOUSE_PATTERN = /(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g;

/**
 * Canonicalize text entering the buffer: drop leaked mouse reports, strip
 * terminal control sequences (`sanitizeTerminalInput`) and normalize line
 * breaks. Applied to both the existing value and inserted text on every edit.
 */
export function normalizeInputText(text: string): string {
  if (!text) return "";
  // Strip out leaked SGR mouse coordinates that might have been emitted by
  // the terminal without their ESC prefix (swallowed by readline).
  const withoutMouse = text.replace(LEAKED_SGR_MOUSE_PATTERN, "");
  return normalizeLineBreaks(sanitizeTerminalInput(withoutMouse));
}

/** Remove leaked SGR mouse reports only, without any other sanitizing. */
export function stripMouseEscapes(input: string): string {
  return input.replace(LEAKED_SGR_MOUSE_PATTERN, "");
}

/**
 * Clamp `cursorOffset` into `[0, text.length]` and move it back one unit if it
 * would split a surrogate pair.
 */
export function normalizeCursorOffset(text: string, cursorOffset: number): number {
  const safeCursor = Math.max(0, Math.min(cursorOffset, text.length));

  if (
    safeCursor > 0 &&
    safeCursor < text.length &&
    isHighSurrogate(text.charCodeAt(safeCursor - 1)) &&
    isLowSurrogate(text.charCodeAt(safeCursor))
  ) {
    return safeCursor - 1;
  }

  return safeCursor;
}

// ─── Cursor movement ─────────────────────────────────────────────────────────

/** Move one code point left (two UTF-16 units across a surrogate pair). */
export function moveCursorLeft(text: string, cursorOffset: number): number {
  const safeCursor = normalizeCursorOffset(text, cursorOffset);
  if (safeCursor <= 0) return 0;

  let nextCursor = safeCursor - 1;
  if (
    nextCursor > 0 &&
    isLowSurrogate(text.charCodeAt(nextCursor)) &&
    isHighSurrogate(text.charCodeAt(nextCursor - 1))
  ) {
    nextCursor -= 1;
  }

  return nextCursor;
}

/** Move one code point right (two UTF-16 units across a surrogate pair). */
export function moveCursorRight(text: string, cursorOffset: number): number {
  const safeCursor = normalizeCursorOffset(text, cursorOffset);
  if (safeCursor >= text.length) return text.length;

  if (
    isHighSurrogate(text.charCodeAt(safeCursor)) &&
    safeCursor + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(safeCursor + 1))
  ) {
    return safeCursor + 2;
  }

  return safeCursor + 1;
}

// ─── Text mutations ───────────────────────────────────────────────────────────

/** Insert normalized `text` at the cursor; the cursor ends after the inserted text. */
export function insertInputText(params: { value: string; cursorOffset: number; text: string }): {
  value: string;
  cursorOffset: number;
} {
  const value = normalizeInputText(params.value);
  const safeCursor = normalizeCursorOffset(value, params.cursorOffset);
  const insertedText = normalizeInputText(params.text);
  return {
    value: value.slice(0, safeCursor) + insertedText + value.slice(safeCursor),
    cursorOffset: safeCursor + insertedText.length,
  };
}

/** Backspace: delete one code point before the cursor. Chip-atomic deletion is handled by callers. */
export function deleteInputBackward(params: { value: string; cursorOffset: number }): {
  value: string;
  cursorOffset: number;
} {
  const value = normalizeInputText(params.value);
  const safeCursor = normalizeCursorOffset(value, params.cursorOffset);

  if (safeCursor <= 0) {
    return { value, cursorOffset: 0 };
  }

  const previousCursor = moveCursorLeft(value, safeCursor);
  return {
    value: value.slice(0, previousCursor) + value.slice(safeCursor),
    cursorOffset: previousCursor,
  };
}

/** Delete key: delete one code point after the cursor; the cursor does not move. */
export function deleteInputForward(params: { value: string; cursorOffset: number }): {
  value: string;
  cursorOffset: number;
} {
  const value = normalizeInputText(params.value);
  const safeCursor = normalizeCursorOffset(value, params.cursorOffset);

  if (safeCursor >= value.length) {
    return { value, cursorOffset: safeCursor };
  }

  const nextCursor = moveCursorRight(value, safeCursor);
  return {
    value: value.slice(0, safeCursor) + value.slice(nextCursor),
    cursorOffset: safeCursor,
  };
}

// ─── Viewport ────────────────────────────────────────────────────────────────

/** Wrap normalized text into rows of at most `width` cells, keeping source offsets per row. */
export function wrapInputRows(text: string, width: number): WrappedInputRow[] {
  return wrapTextRows(normalizeInputText(text), width);
}

/**
 * Find the wrapped row and cell column for a UTF-16 cursor offset. Offsets past
 * the end land at the end of the last row. Assumes `rows` is non-empty.
 */
export function locateCursor(rows: WrappedInputRow[], cursorOffset: number) {
  const safeCursor = Math.max(0, cursorOffset);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (safeCursor <= row.end) {
      const relative = Math.max(0, Math.min(safeCursor, row.end) - row.start);
      return {
        row: index,
        column: getTextWidth(row.text.slice(0, relative)),
      };
    }
  }

  const lastRow = rows[rows.length - 1]!;
  return {
    row: rows.length - 1,
    column: getTextWidth(lastRow.text),
  };
}

/**
 * Return the minimal scroll adjustment that keeps `cursorRow` inside a window of
 * `visibleRowCount` rows, never scrolling past the last full window.
 */
export function clampScrollToCursor(
  scrollRow: number,
  cursorRow: number,
  visibleRowCount: number,
  totalRowCount = cursorRow + 1,
): number {
  const safeVisibleRows = Math.max(1, visibleRowCount);
  const maxScroll = Math.max(0, totalRowCount - safeVisibleRows);
  let nextScrollRow = Math.max(0, Math.min(scrollRow, maxScroll));

  if (cursorRow < nextScrollRow) {
    nextScrollRow = cursorRow;
  }

  if (cursorRow >= nextScrollRow + safeVisibleRows) {
    nextScrollRow = cursorRow - safeVisibleRows + 1;
  }

  return Math.max(0, Math.min(nextScrollRow, maxScroll));
}

/**
 * Wrap `text` and compute the visible slice, cursor row/column and the clamped
 * scroll row. Callers persist `scrollRow` and pass it back on the next render so
 * the viewport only scrolls when the cursor leaves it.
 */
export function createInputViewport(params: {
  text: string;
  cursorOffset: number;
  width: number;
  maxVisibleRows: number;
  scrollRow?: number;
}): InputViewport {
  const rows = wrapInputRows(params.text, params.width);
  const cursor = locateCursor(rows, params.cursorOffset);
  const nextScrollRow = clampScrollToCursor(
    params.scrollRow ?? 0,
    cursor.row,
    params.maxVisibleRows,
    rows.length,
  );

  return {
    rows,
    visibleRows: rows.slice(nextScrollRow, nextScrollRow + Math.max(1, params.maxVisibleRows)),
    cursorRow: cursor.row,
    cursorColumn: cursor.column,
    scrollRow: nextScrollRow,
  };
}

// These values describe the actual bordered row and are shared with its JSX.
export const COMPOSER_ROW_CHROME = {
  borderLeft: 1,
  borderRight: 1,
  paddingLeft: 1,
  paddingRight: 1,
  prompt: "❯ ",
} as const;

/**
 * Split a composer row's outer width into body (inside border + padding),
 * prompt glyph, and editable text widths. Must agree with `COMPOSER_ROW_CHROME`
 * as rendered, or the cursor drifts from the text.
 */
export function getComposerRowLayout(totalWidth: number) {
  const chrome = COMPOSER_ROW_CHROME;
  const bodyWidth = Math.max(
    0,
    totalWidth - chrome.borderLeft - chrome.borderRight - chrome.paddingLeft - chrome.paddingRight,
  );
  const promptWidth = getTextWidth(chrome.prompt);
  return { bodyWidth, promptWidth, editorWidth: Math.max(0, bodyWidth - promptWidth) };
}

/**
 * Bound a wrapped row, including its highlighted character or trailing cursor.
 *
 * Returns the text before the cursor cell, the cursor cell's grapheme (`" "`
 * when the cursor is past the end; `""` when no cursor is requested), the text
 * after it, and the cursor's cell column within the window. When the row is
 * wider than `width`, the window is shifted right just enough to keep the cursor
 * cell visible.
 */
export function createInputRowWindow(text: string, width: number, cursorColumn?: number) {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return { before: "", current: "", after: "", cursorColumn: 0 };
  // Ink advances at least one cell per emitted grapheme, even for invisible
  // token IDs. Keep zero-cell units in the buffer, but never send them to Ink.
  const units = getTextUnits(text).filter((unit) => unit.width > 0);
  let column = 0;
  let cursorIndex = units.length;
  const columns = units.map((unit, index) => {
    const start = column;
    if (
      cursorColumn !== undefined &&
      cursorIndex === units.length &&
      unit.width > 0 &&
      start + unit.width > cursorColumn
    )
      cursorIndex = index;
    column += unit.width;
    return start;
  });
  const hasCursor = cursorColumn !== undefined;
  const cursorStart = columns[cursorIndex] ?? column;
  const current = hasCursor ? (units[cursorIndex]?.text ?? " ") : "";
  const cursorWidth = getTextWidth(current);
  // A wide glyph cannot fit in a one-cell viewport: show a cursor cell instead.
  if (cursorWidth > safeWidth) return { before: "", current: " ", after: "", cursorColumn: 0 };
  let startIndex = 0;
  if (hasCursor) {
    const minimumStart = Math.max(0, cursorStart + cursorWidth - safeWidth);
    while (startIndex < cursorIndex && (columns[startIndex] ?? column) < minimumStart) startIndex++;
  }
  let used = 0;
  let before = "";
  let after = "";
  for (let index = startIndex; index < units.length; index++) {
    const unit = units[index]!;
    if (used + unit.width > safeWidth) break;
    if (!hasCursor || index < cursorIndex) before += unit.text;
    else if (index > cursorIndex) after += unit.text;
    used += unit.width;
  }
  return { before, current, after, cursorColumn: getTextWidth(before) };
}

/** Composer value plus cursor offset, as snapshotted by `InputUndo`. */
interface Draft {
  value: string;
  cursor: number;
}
/** Snap an offset that falls strictly inside a chip to the chip edge in `direction`. */
function atomicOffset(value: string, offset: number, direction: number): number {
  const span = findPastedContentSpan(value, offset);
  return span && offset > span.start && offset < span.end
    ? direction < 0
      ? span.start
      : span.end
    : normalizeCursorOffset(value, offset);
}
/** Offset of the start (`end=false`) or end (`end=true`) of the logical line at `cursor`. */
export function lineBoundary(value: string, cursor: number, end: boolean): number {
  if (!end) return cursor === 0 ? 0 : value.lastIndexOf("\n", cursor - 1) + 1;
  const next = value.indexOf("\n", cursor);
  return next < 0 ? value.length : next;
}
/**
 * Offset of the previous (`direction < 0`) or next word boundary. Words are runs
 * of letters/digits, or of any non-whitespace when `whitespace` is true. Iterates
 * by code point and snaps out of chips.
 */
export function wordBoundary(
  value: string,
  cursor: number,
  direction: number,
  whitespace = false,
): number {
  const word = whitespace ? /\S/u : /[\p{L}\p{N}]/u;
  const characters = Array.from(value);
  const positions = [0];
  for (const char of characters) positions.push(positions.at(-1)! + char.length);
  let index = positions.findIndex((position) => position >= cursor);
  if (index < 0) index = characters.length;
  if (direction < 0) {
    while (index > 0 && !word.test(characters[index - 1]!)) index--;
    while (index > 0 && word.test(characters[index - 1]!)) index--;
  } else {
    while (index < characters.length && !word.test(characters[index]!)) index++;
    while (index < characters.length && word.test(characters[index]!)) index++;
  }
  const offset = positions[index]!;
  return atomicOffset(value, offset, direction);
}
/**
 * Move the cursor one wrapped row up (`-1`) or down (`+1`), aiming for
 * `desiredColumn` (sticky column) or the current column. `boundary: true` means
 * there is no row in that direction and the cursor is unchanged, which callers
 * can use to fall through to history navigation.
 */
export function verticalCursor(
  value: string,
  cursor: number,
  width: number,
  direction: number,
  desiredColumn?: number,
): { cursor: number; column: number; boundary: boolean } {
  const rows = wrapInputRows(value, width);
  const position = locateCursor(rows, cursor);
  const column = desiredColumn ?? position.column;
  const row = rows[position.row + direction];
  if (!row) return { cursor, column, boundary: true };
  let offset = row.start;
  for (const char of row.text) {
    if (getTextWidth(value.slice(row.start, offset) + char) > column) break;
    offset += char.length;
  }
  return { cursor: atomicOffset(value, offset, direction), column, boundary: false };
}
/**
 * Bounded undo stack (100 entries) for the composer.
 *
 * Consecutive single-character insertions made within 600 ms of each other on
 * an unchanged base value are coalesced into one entry, so undo removes a typed
 * burst rather than one character. Any other edit starts a new entry. `undo()`
 * also breaks the current coalescing run.
 */
export class InputUndo {
  private entries: Draft[] = [];
  private lastEdit = 0;
  private lastValue = "";
  record(before: Draft, after: Draft, now = Date.now()): void {
    if (before.value === after.value) return;
    const typing = after.value.length === before.value.length + 1;
    if (
      !typing ||
      now - this.lastEdit > 600 ||
      before.value !== this.lastValue ||
      this.entries.length === 0
    ) {
      this.entries.push({ ...before });
      if (this.entries.length > 100) this.entries.shift();
    }
    this.lastEdit = typing ? now : 0;
    this.lastValue = after.value;
  }
  undo(): Draft | undefined {
    this.lastEdit = 0;
    this.lastValue = "";
    return this.entries.pop();
  }
}
/**
 * Case-insensitive substring search over `history`; returns the `offset`-th
 * match in array order (the composer's Ctrl+R search cycles `offset`), or
 * undefined.
 */
export function searchHistory(
  history: readonly string[],
  query: string,
  offset = 0,
): string | undefined {
  return history.filter((item) => item.toLowerCase().includes(query.toLowerCase()))[offset];
}
