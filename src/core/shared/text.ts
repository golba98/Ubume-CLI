/**
 * Unicode width measurement, grapheme-based input/wrapping helpers and shared text normalization.
 */

import stringWidth from "string-width";

interface TextUnit {
  text: string;
  start: number;
  end: number;
  width: number;
}

export interface WrappedTextRow {
  text: string;
  start: number;
  end: number;
  breakType: "soft" | "hard" | "end";
}

// ─── Character measurement ───────────────────────────────────────────────────

function getCharWidth(char: string): number {
  return stringWidth(char);
}

const textSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Segments text into graphemes with source offsets and per-grapheme terminal widths. */
export function getTextUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  for (const { segment: char, index: offset } of textSegmenter.segment(text)) {
    const length = char.length;
    units.push({
      text: char,
      start: offset,
      end: offset + length,
      width: getCharWidth(char),
    });
  }

  return units;
}

/** Measures terminal column width while excluding ANSI formatting sequences. */
export function getTextWidth(text: string): number {
  return stringWidth(text);
}

// ─── Input window ────────────────────────────────────────────────────────────

/** Returns text before, at and after a visual column using grapheme widths. */
export function splitTextAtColumn(
  text: string,
  column: number,
): { before: string; current: string; after: string } {
  const safeColumn = Math.max(0, column);
  let width = 0;
  const units = getTextUnits(text);

  for (const unit of units) {
    if (width + unit.width > safeColumn) {
      return {
        before: text.slice(0, unit.start),
        current: unit.text,
        after: text.slice(unit.end),
      };
    }

    width += unit.width;
    if (width > safeColumn) break;
  }

  return {
    before: text,
    current: "",
    after: "",
  };
}

// ─── Text wrapping ────────────────────────────────────────────────────────────

/** Wraps text by terminal width while retaining source offsets for layout consumers. */
export function wrapTextRows(
  text: string,
  maxWidth: number,
  firstLineWidth: number = maxWidth,
): WrappedTextRow[] {
  const normalized = normalizeLineBreaks(text);
  const safeWidth = Math.max(1, maxWidth);
  const safeFirstWidth = Math.max(1, firstLineWidth);
  const rows: WrappedTextRow[] = [];
  let rowUnits: TextUnit[] = [];
  let rowWidth = 0;
  let skippingSoftWhitespace = false;

  const unitsText = (units: TextUnit[]) => units.map((unit) => unit.text).join("");
  const unitsWidth = (units: TextUnit[]) =>
    units.reduce((total, current) => total + current.width, 0);
  const pushRow = (units: TextUnit[], end: number, breakType: WrappedTextRow["breakType"]) => {
    rows.push({
      text: unitsText(units),
      start: units[0]?.start ?? end,
      end,
      breakType,
    });
  };
  const findWordBoundary = (
    units: TextUnit[],
  ): { breakStart: number; continuationStart: number } | null => {
    for (let index = units.length - 2; index >= 0; index -= 1) {
      if (!/^[ \t]$/.test(units[index]!.text)) continue;

      let breakStart = index;
      while (breakStart > 0 && /^[ \t]$/.test(units[breakStart - 1]!.text)) {
        breakStart -= 1;
      }

      let continuationStart = index + 1;
      while (continuationStart < units.length && /^[ \t]$/.test(units[continuationStart]!.text)) {
        continuationStart += 1;
      }

      if (breakStart > 0 && continuationStart < units.length) {
        return { breakStart, continuationStart };
      }
      index = breakStart;
    }
    return null;
  };

  for (const unit of getTextUnits(normalized)) {
    if (unit.text === "\n") {
      pushRow(rowUnits, unit.start, "hard");
      rowUnits = [];
      rowWidth = 0;
      skippingSoftWhitespace = false;
      continue;
    }

    if (skippingSoftWhitespace && /^[ \t]$/.test(unit.text)) continue;
    skippingSoftWhitespace = false;

    // Only the first emitted row honors firstLineWidth; later rows use maxWidth.
    const limit = rows.length === 0 ? safeFirstWidth : safeWidth;
    if (rowUnits.length > 0 && rowWidth + unit.width > limit) {
      const candidate = [...rowUnits, unit];
      const boundary = findWordBoundary(candidate);
      if (boundary) {
        const before = candidate.slice(0, boundary.breakStart);
        const after = candidate.slice(boundary.continuationStart);
        pushRow(before, candidate[boundary.breakStart]!.start, "soft");
        rowUnits = after;
        rowWidth = unitsWidth(after);
      } else if (/^[ \t]$/.test(unit.text)) {
        pushRow(rowUnits, unit.start, "soft");
        rowUnits = [];
        rowWidth = 0;
        skippingSoftWhitespace = true;
      } else {
        pushRow(rowUnits, unit.start, "soft");
        rowUnits = [unit];
        rowWidth = unit.width;
      }
      continue;
    }

    rowUnits.push(unit);
    rowWidth += unit.width;
  }

  if (rowUnits.length > 0) {
    pushRow(rowUnits, normalized.length, "end");
  } else {
    rows.push({
      text: "",
      start: normalized.length,
      end: normalized.length,
      breakType: "end",
    });
  }

  return rows.length > 0
    ? rows
    : [
        {
          text: "",
          start: 0,
          end: 0,
          breakType: "end",
        },
      ];
}

/** Wraps plain display text using terminal column widths rather than string length. */
export function wrapPlainText(
  text: string,
  maxWidth: number,
  firstLineWidth: number = maxWidth,
): string[] {
  return wrapTextRows(text, maxWidth, firstLineWidth).map((row) => row.text);
}

/** Wraps command tokens with two-space continuation indentation, dropping the indent when a wide grapheme would otherwise prevent progress. */
export function wrapCommandText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 2) return [];
  const normalized = normalizeLineBreaks(text);
  const rows: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  // Split on whitespace, but keep the whitespace tokens
  const tokens = normalized.split(/([ \t]+)/);

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    if (!token) continue;

    if (token === "\n") {
      rows.push(currentLine);
      currentLine = "  ";
      currentWidth = 2;
      continue;
    }

    let tokenWidth = getTextWidth(token);

    // Skip leading whitespace on continuation lines
    if (/^[ \t]+$/.test(token) && currentLine === "  ") {
      continue;
    }

    if (currentWidth + tokenWidth > maxWidth) {
      if (/^[ \t]+$/.test(token)) {
        // Space that pushes us over the edge, ignore it and break
        rows.push(currentLine);
        currentLine = "  ";
        currentWidth = 2;
        continue;
      }

      if (currentWidth > 2) {
        // We have some content on this line, push it and start a new line
        rows.push(currentLine);
        currentLine = "  ";
        currentWidth = 2;
      }

      // Now check if the token alone exceeds the available width (maxWidth - 2)
      while (tokenWidth > maxWidth - currentWidth) {
        const available = maxWidth - currentWidth;
        const split = splitTextAtColumn(token, available);

        if (!split.before && split.current) {
          // A wide grapheme may not fit after the continuation indent. Emit it
          // without indentation so the token shrinks instead of looping forever.
          if (currentLine.trim()) rows.push(currentLine.trimEnd());
          rows.push(split.current);
          token = split.after;
        } else {
          currentLine += split.before;
          rows.push(currentLine);
          token = split.current + split.after;
        }
        tokenWidth = getTextWidth(token);
        currentLine = "  ";
        currentWidth = 2;
      }

      currentLine += token;
      currentWidth += tokenWidth;
    } else {
      currentLine += token;
      currentWidth += tokenWidth;
    }
  }

  if (currentLine.trim().length > 0 || currentLine === "  ") {
    // only push if there is actual content, or if it is an intentionally empty line (rare)
    if (currentLine !== "  ") {
      rows.push(currentLine);
    }
  }

  if (rows.length > 0 && rows[0].startsWith("  ") && !text.startsWith("  ")) {
    rows[0] = rows[0].substring(2);
  }

  return rows;
}

/** Truncates `text` to `maxWidth` terminal columns, ending with an ellipsis when cut. */
export function clampVisualText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (getTextWidth(text) <= maxWidth) return text;

  const ellipsis = maxWidth > 1 ? "…" : "";
  const suffixWidth = getTextWidth(ellipsis);
  let output = "";

  for (const char of Array.from(text)) {
    if (getTextWidth(output + char) + suffixWidth > maxWidth) {
      break;
    }
    output += char;
  }

  return output + ellipsis;
}

/** Converts CRLF and lone CR line breaks to LF. */
export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Formats a duration as `850ms` below one second, otherwise `4.2s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Single-line title in the same shape Ubume uses for its own conversations. */
export function titleFromText(text: string, max = 72): string {
  const title = text.replace(/\s+/g, " ").trim();
  return title.length > max ? `${title.slice(0, max - 3).trimEnd()}...` : title;
}

/** Keeps up to max characters and appends the omitted character count when truncated. */
export function clampText(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n[… ${text.length - max} more characters]`
    : text;
}
