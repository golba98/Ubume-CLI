/**
 * Measure stage for markdown: parsed `Segment[]` (from `render/markdownParser.ts`)
 * → width-fitted, theme-neutral span rows.
 *
 * `buildMarkdownRows` is the single layout implementation for response text:
 * the measured transcript (response, plan cards) and the React
 * `MemoizedRenderMessage` both consume its output, so markdown looks and
 * measures identically everywhere. Rendered block rows are padded to the full width, while blank separator and
 * error-fallback rows are left unpadded for `createRow` to pad. Diff/code colouring is applied here as tones (raw ANSI was stripped
 * upstream).
 *
 * Caching: four module-level `MarkdownCache`s (display widths, wrapped table
 * cells, folded code lines, whole rendered blocks), each bounded by entry
 * count and character budget and cleared by `resetMarkdownCaches()`. Block
 * keys include the full segment JSON and width, so content or width changes
 * miss rather than return stale rows.
 */
import { getTextUnits, getTextWidth, wrapPlainText } from "../../../core/shared/text.js";
import { sanitizeTerminalOutput } from "../../../core/terminal/terminalSanitize.js";
import { maybeRenderDiff } from "../../render/diffRenderer.js";
import { detachMarkdownText, MarkdownCache } from "../../render/markdownCache.js";
import type {
  InlinePart,
  Segment,
  TableAlignment,
  TableSegment,
} from "../../render/markdownParser.js";
import { createSpan, wrapStyledSpans } from "./rows.js";
import type { TimelineRowSpan, TimelineTone } from "./types.js";

const widths = new MarkdownCache<number>(4096, 512_000);
const wrappedCells = new MarkdownCache<TimelineRowSpan[][]>(1024, 1_000_000);
const codeRows = new MarkdownCache<TimelineRowSpan[][]>(1024, 1_000_000);
const blockRows = new MarkdownCache<TimelineRowSpan[][]>(256, 1_000_000);

function textWidth(text: string): number {
  return widths.get(text) ?? widths.set(text, getTextWidth(text));
}

function rowWidth(row: TimelineRowSpan[]): number {
  return row.reduce((width, span) => width + textWidth(span.text), 0);
}

function padMarkdownRow(row: TimelineRowSpan[], width: number): TimelineRowSpan[] {
  const padding = width - rowWidth(row);
  return padding > 0 ? [...row, createSpan(" ".repeat(padding))] : row;
}

/**
 * Convert parsed inline parts to spans: inline code → "info", link text →
 * "muted", everything else → `tone`; bold/italic/underline/strike carried over.
 */
export function inlinePartsToSpans(
  parts: InlinePart[],
  tone: TimelineTone = "text",
): TimelineRowSpan[] {
  return parts.map((part) =>
    createSpan(part.text, part.kind === "code" ? "info" : part.target ? "muted" : tone, {
      bold: part.kind === "bold" || part.bold,
      italic: part.italic,
      underline: part.underline,
      strikethrough: part.strikethrough,
    }),
  );
}

function wrapCell(parts: InlinePart[], width: number, header = false): TimelineRowSpan[][] {
  const key = JSON.stringify([width, header, parts]);
  const cached = wrappedCells.get(key);
  if (cached) return cached;
  const spans = inlinePartsToSpans(parts).map((span) => (header ? { ...span, bold: true } : span));
  const result = wrapStyledSpans(spans, width);
  return wrappedCells.set(
    key,
    result,
    key.length + result.flat().reduce((n, span) => n + span.text.length, 0),
  );
}

function prefixedRows(
  parts: InlinePart[],
  prefix: TimelineRowSpan[],
  width: number,
  tone: TimelineTone = "text",
): TimelineRowSpan[][] {
  const prefixWidth = rowWidth(prefix);
  const bodyWidth = Math.max(1, width - prefixWidth);
  return wrapStyledSpans(inlinePartsToSpans(parts, tone), bodyWidth).map((row, index) => [
    ...(index === 0 ? prefix : [createSpan(" ".repeat(prefixWidth))]),
    ...row,
  ]);
}

/**
 * Column widths for a grid table, or null when even the minimum widths do not
 * fit (the caller then falls back to stacked "Header: value" records).
 *
 * Natural widths are capped at 40; each column gets its minimum, then spare
 * width is handed out one column at a time to the column furthest below its
 * natural width.
 * While streaming, only header widths are used (doubled, at least 12) so the
 * layout does not jump as each new row arrives.
 */
function tableColumnWidths(table: TableSegment, width: number): number[] | null {
  const headerWidths = table.headers.map((cell) =>
    textWidth(cell.map((part) => part.text).join("")),
  );
  const desired = headerWidths.map((value) => (table.streaming ? Math.max(12, value * 2) : value));
  if (!table.streaming) {
    for (const row of table.rows) {
      row.forEach((cell, index) => {
        desired[index] = Math.max(
          desired[index]!,
          textWidth(cell.map((part) => part.text).join("")),
        );
      });
    }
  }
  const natural = desired.map((value) => Math.max(1, Math.min(40, value)));
  const minimum = natural.map((value, index) =>
    Math.min(value, Math.max(8, Math.min(16, headerWidths[index]!))),
  );
  const available = width - (table.headers.length - 1) * 2;
  if (minimum.reduce((a, b) => a + b, 0) > available) return null;
  const result = [...minimum];
  let remaining = available - result.reduce((a, b) => a + b, 0);
  while (remaining > 0) {
    let target = -1;
    let deficit = 0;
    natural.forEach((value, index) => {
      if (value - result[index]! > deficit) {
        deficit = value - result[index]!;
        target = index;
      }
    });
    if (target < 0) break;
    result[target]! += 1;
    remaining -= 1;
  }
  return result;
}

function alignedCell(
  row: TimelineRowSpan[],
  width: number,
  alignment: TableAlignment,
): TimelineRowSpan[] {
  const slack = Math.max(0, width - rowWidth(row));
  const left = alignment === "right" ? slack : alignment === "center" ? Math.floor(slack / 2) : 0;
  return [createSpan(" ".repeat(left)), ...row, createSpan(" ".repeat(slack - left))];
}

function buildTableRows(table: TableSegment, width: number): TimelineRowSpan[][] {
  const columnWidths = tableColumnWidths(table, width);
  const rows: TimelineRowSpan[][] = [];
  if (!columnWidths) {
    const records = table.rows.length ? table.rows : [table.headers.map(() => [])];
    records.forEach((record, index) => {
      if (index) rows.push([createSpan("")]);
      table.headers.forEach((header, col) => {
        const label = header.some((part) => part.text)
          ? header
          : [{ kind: "text" as const, text: `Column ${col + 1}` }];
        const labelSpans = [
          ...inlinePartsToSpans(label).map((span) => ({ ...span, bold: true })),
          createSpan(": ", "dim"),
        ];
        if (rowWidth(labelSpans) <= Math.floor(width / 2)) {
          rows.push(...prefixedRows(record[col] ?? [], labelSpans, width));
        } else {
          rows.push(...wrapStyledSpans(labelSpans, width));
          rows.push(...prefixedRows(record[col] ?? [], [createSpan("  ")], width));
        }
      });
    });
    return rows;
  }
  const renderRecord = (cells: InlinePart[][], header: boolean) => {
    const wrapped = columnWidths.map((cellWidth, index) =>
      wrapCell(cells[index] ?? [], cellWidth, header),
    );
    const height = Math.max(1, ...wrapped.map((cell) => cell.length));
    for (let line = 0; line < height; line += 1) {
      const row: TimelineRowSpan[] = [];
      columnWidths.forEach((cellWidth, col) => {
        if (col) row.push(createSpan("  "));
        row.push(
          ...alignedCell(wrapped[col]![line] ?? [], cellWidth, table.alignments[col] ?? "left"),
        );
      });
      rows.push(row);
    }
  };
  renderRecord(table.headers, true);
  rows.push(
    columnWidths.flatMap((cellWidth, col) => [
      ...(col ? [createSpan("  ")] : []),
      createSpan("─".repeat(cellWidth), "borderSubtle"),
    ]),
  );
  for (const record of table.rows) renderRecord(record, false);
  return rows;
}

// Expand tabs to 2-column tab stops (code is parsed with tabs preserved).
function expandCodeTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let expanded = "";
  for (const part of line.split(/(\t)/)) {
    expanded += part === "\t" ? " ".repeat(2 - (getTextWidth(expanded) % 2)) : part;
  }
  return expanded;
}

/** Hard visual folds preserve every source character, including leading/trailing whitespace. */
function foldCode(line: string, width: number): string[] {
  if (textWidth(line) <= width) return [line];
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const unit of getTextUnits(line)) {
    if (row && used + unit.width > width) {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += unit.text;
    used += unit.width;
  }
  if (row) rows.push(row);
  return rows;
}

function diffTone(line: string): TimelineTone {
  if (/^\+(?!\+\+)/.test(line)) return "success";
  if (/^-(?!--)/.test(line)) return "error";
  if (line.startsWith("@@")) return "accent";
  if (/^(?:diff --git|index |--- |\+\+\+ |\\ No newline)/.test(line)) return "info";
  return "text";
}

/**
 * Code block: a dim language label row, then each source line hard-folded to
 * the content width behind a `│ ` gutter (`↳ ` on continuation rows). Code is
 * never word-wrapped, so whitespace is preserved exactly. Diff-looking blocks
 * (or ```diff fences) get per-line add/remove/hunk/header tones.
 */
function buildCodeRows(
  segment: Extract<Segment, { type: "code" }>,
  width: number,
): TimelineRowSpan[][] {
  const gutter = width >= 4 ? 2 : 0;
  const contentWidth = Math.max(1, width - gutter);
  const rows = prefixedRows([{ kind: "text", text: segment.lang || "code" }], [], width, "dim");
  const diff =
    maybeRenderDiff(segment.lines.join("\n"), { force: segment.lang.toLowerCase() === "diff" }) !==
    null;
  for (const source of segment.lines) {
    const line = expandCodeTabs(source);
    const tone = diff ? diffTone(line) : "text";
    const key = JSON.stringify([contentWidth, gutter, tone, line]);
    let folded = codeRows.get(key);
    if (!folded) {
      folded = foldCode(detachMarkdownText(line), contentWidth).map((text, index) => [
        ...(gutter ? [createSpan(index === 0 ? "│ " : "↳ ", "dim")] : []),
        createSpan(text, tone),
      ]);
      codeRows.set(key, folded, key.length + line.length);
    }
    rows.push(...folded);
  }
  return rows;
}

function renderSegment(
  segment: Segment,
  width: number,
  brightHeadings: boolean,
): TimelineRowSpan[][] {
  switch (segment.type) {
    case "table":
      return buildTableRows(segment, width);
    case "code":
      return buildCodeRows(segment, width);
    case "header": {
      const tone =
        segment.level === 1 ? "accent" : segment.level === 2 || brightHeadings ? "text" : "muted";
      return wrapStyledSpans(
        inlinePartsToSpans(segment.parts, tone).map((span) => ({
          ...span,
          bold: segment.level <= 3 || span.bold,
        })),
        width,
      );
    }
    case "rule":
      return [[createSpan("─".repeat(Math.min(width, 40)), "borderSubtle")]];
    case "quote": {
      const indent = width >= 4 ? 2 : 0;
      return buildMarkdownRows(segment.segments, Math.max(1, width - indent), {
        brightHeadings,
      }).map((row) => [...(indent ? [createSpan("│ ", "borderSubtle")] : []), ...row]);
    }
    case "list": {
      const rows: TimelineRowSpan[][] = [];
      segment.items.forEach((item) => {
        if (item.blankBefore) rows.push([createSpan("")]);
        const ordered = item.ordered ?? segment.ordered;
        const marker =
          item.checked !== undefined
            ? item.checked
              ? "☑ "
              : "☐ "
            : ordered
              ? `${item.marker ?? `${item.num}.`} `
              : "• ";
        const indent = Math.min(item.indent ?? 0, Math.max(0, width - textWidth(marker) - 8));
        const prefix = [
          createSpan(" ".repeat(indent)),
          createSpan(marker, item.checked ? "success" : "muted"),
        ];
        if (rowWidth(prefix) >= width - 1) {
          rows.push(...wrapStyledSpans(prefix, width), ...prefixedRows(item.parts, [], width));
        } else rows.push(...prefixedRows(item.parts, prefix, width));
      });
      return rows;
    }
    case "para": {
      // Source line boundaries are intentional in CLI answers. Keeping them also
      // lets append-only streaming reuse preceding rows without reflowing them.
      return segment.lines.flatMap((parts) => wrapStyledSpans(inlinePartsToSpans(parts), width));
    }
  }
}

/**
 * All response surfaces consume these exact theme-neutral rows.
 *
 * Lays out `segments` at `width` columns (non-finite widths fall back to 80),
 * separating blocks with one blank row; rendered block rows are padded to the
 * width. Callers turn each span row into one `TimelineRow` via `createRow`.
 * `brightHeadings` renders level 3+ headings in the "text" tone instead of
 * "muted". If laying out a segment throws, its sanitized raw source is
 * plain-wrapped instead so a malformed block never breaks the transcript.
 */
export function buildMarkdownRows(
  segments: Segment[],
  width: number,
  options: { brightHeadings?: boolean } = {},
): TimelineRowSpan[][] {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  const rows: TimelineRowSpan[][] = [];
  for (const segment of segments) {
    if (rows.length) rows.push([createSpan("")]);
    try {
      const key = JSON.stringify([safeWidth, options.brightHeadings ?? false, segment]);
      const cached = blockRows.get(key);
      const rendered =
        cached ??
        renderSegment(segment, safeWidth, options.brightHeadings ?? false).map((row) =>
          padMarkdownRow(row, safeWidth),
        );
      if (!cached)
        blockRows.set(
          key,
          rendered,
          key.length + rendered.flat().reduce((n, span) => n + span.text.length, 0),
        );
      rows.push(...rendered);
    } catch {
      const raw = sanitizeTerminalOutput(segment.raw ?? "");
      rows.push(...wrapPlainText(raw, safeWidth).map((text) => [createSpan(text)]));
    }
  }
  return rows;
}
