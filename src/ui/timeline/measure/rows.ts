/**
 * Span/row primitives: span creation and merging, display-width measurement,
 * word wrapping, padding/clamping, and the outer `wrapRows` pass.
 *
 * Invariant owned here: every row built through `createRow` is padded with
 * spaces to the requested width (by display width, via `getTextWidth`), so one
 * `TimelineRow` is exactly one terminal line and row counts equal rendered
 * heights. `createRow` pads but does not clamp; builders that might overflow
 * use `fitSpansToWidth` first. Rows are interned through the module-level
 * caches in `caches.ts` so unchanged content returns the same row object —
 * the React row components memoize on that identity.
 */
import { getTextWidth, splitTextAtColumn } from "../../../core/shared/text.js";
import {
  _blankRowCache,
  _rowContentCache,
  _wrappedBlankRowCache,
  _wrappedRowCache,
  rememberRow,
} from "./caches.js";
import type {
  BuiltTimelineItem,
  StyledToken,
  TimelineRow,
  TimelineRowFrame,
  TimelineRowSpan,
  TimelineSnapshot,
  TimelineTone,
} from "./types.js";

// ─── Span & row primitives ────────────────────────────────────────────────────

/** Build a span; style flags are copied explicitly so absent options stay `undefined`. */
export function createSpan(
  text: string,
  tone?: TimelineTone,
  options: Pick<
    TimelineRowSpan,
    "bold" | "italic" | "underline" | "strikethrough" | "backgroundTone"
  > = {},
): TimelineRowSpan {
  return {
    text,
    tone,
    bold: options.bold,
    italic: options.italic,
    underline: options.underline,
    strikethrough: options.strikethrough,
    backgroundTone: options.backgroundTone,
  };
}

function spansEqual(left: TimelineRowSpan | undefined, right: TimelineRowSpan): boolean {
  return (
    left?.tone === right.tone &&
    left?.bold === right.bold &&
    left?.italic === right.italic &&
    left?.underline === right.underline &&
    left?.strikethrough === right.strikethrough &&
    left?.backgroundTone === right.backgroundTone
  );
}

/**
 * Push `span` onto `target`, merging into the previous span when styles match.
 * Mutates `target` (and may mutate its last span's text); empty spans are
 * dropped.
 */
export function appendSpan(target: TimelineRowSpan[], span: TimelineRowSpan) {
  if (!span.text) return;
  const previous = target[target.length - 1];
  if (previous && spansEqual(previous, span)) {
    previous.text += span.text;
    return;
  }
  target.push({ ...span });
}

function cloneSpan(span: TimelineRowSpan, text = span.text): TimelineRowSpan {
  return {
    text,
    tone: span.tone,
    bold: span.bold,
    italic: span.italic,
    underline: span.underline,
    strikethrough: span.strikethrough,
    backgroundTone: span.backgroundTone,
  };
}

/** Total display width (terminal columns, not string length) of a span list. */
export function getSpansWidth(spans: TimelineRowSpan[]): number {
  return spans.reduce((width, span) => width + getTextWidth(span.text), 0);
}

/**
 * Copy `spans` and append unstyled spaces up to `width` columns. Never
 * truncates; an over-wide input is returned (copied) as-is.
 */
export function padSpansToWidth(spans: TimelineRowSpan[], width: number): TimelineRowSpan[] {
  const safeWidth = Math.max(0, width);
  const next = spans.map((span) => ({ ...span }));
  const currentWidth = getSpansWidth(next);
  if (currentWidth < safeWidth) {
    appendSpan(next, createSpan(" ".repeat(safeWidth - currentWidth)));
  }
  return next;
}

/**
 * Truncates a span list to at most `width` display columns, cutting the
 * overflowing span on a grapheme/display-width boundary. Used as a safety net so
 * a too-wide content row can never push a card border past its declared width.
 */
function clampSpansToWidth(spans: TimelineRowSpan[], width: number): TimelineRowSpan[] {
  const safeWidth = Math.max(0, width);
  const result: TimelineRowSpan[] = [];
  let used = 0;
  for (const span of spans) {
    if (used >= safeWidth) break;
    const spanWidth = getTextWidth(span.text);
    if (used + spanWidth <= safeWidth) {
      result.push({ ...span });
      used += spanWidth;
      continue;
    }
    const fitted = splitTextAtColumn(span.text, safeWidth - used).before;
    if (fitted) {
      result.push(cloneSpan(span, fitted));
    }
    break;
  }
  return result;
}

/** Clamp a row to `width` then pad it back out so it occupies exactly `width`. */
export function fitSpansToWidth(spans: TimelineRowSpan[], width: number): TimelineRowSpan[] {
  return padSpansToWidth(clampSpansToWidth(spans, width), width);
}

function spanCacheToken(span: TimelineRowSpan): string {
  return [
    span.text,
    span.tone ?? "",
    span.backgroundTone ?? "",
    span.bold ? "1" : "0",
    span.italic ? "1" : "0",
    span.underline ? "1" : "0",
    span.strikethrough ? "1" : "0",
  ].join("\u001f");
}

/**
 * Build (or reuse) a row of `width` columns from `spans`, padding with spaces.
 *
 * Interned in `_rowContentCache`: the same key/width/frame/span content yields
 * the same row object, which lets memoized row components skip re-rendering.
 * Two lookups are tried — first by the raw input spans (skips width
 * measurement; hits when the input already fills the width, as markdown rows
 * do), then by the padded spans. Returned rows are shared; callers
 * must not mutate them. `frame` tags the row as part of a bordered card for
 * the live-row window.
 */
export function createRow(
  key: string,
  spans: TimelineRowSpan[],
  width: number,
  frame?: TimelineRowFrame,
): TimelineRow {
  const frameToken = frame ? `${frame.id}\u001f${frame.role}` : "";
  // Markdown layout already fills its rows. Reuse unchanged rows before paying
  // for display-width measurement and cloning during every streaming flush.
  const inputKey = `${key}:${width}:${frameToken}:${spans.map(spanCacheToken).join("\u001e")}`;
  const existing = _rowContentCache.get(inputKey);
  if (existing) return rememberRow(inputKey, existing);
  const paddedSpans = padSpansToWidth(spans, width);
  const cacheKey = `${key}:${width}:${frameToken}:${paddedSpans.map(spanCacheToken).join("\u001e")}`;
  const cached = _rowContentCache.get(cacheKey);
  if (cached) {
    _rowContentCache.delete(cacheKey);
    _rowContentCache.set(cacheKey, cached);
    return cached;
  }

  return rememberRow(
    cacheKey,
    frame ? { key, spans: paddedSpans, frame } : { key, spans: paddedSpans },
  );
}

/** An all-space row of `width` columns, cached per key+width (used for gaps and margins). */
export function createBlankRow(key: string, width: number): TimelineRow {
  const cacheKey = `${key}:${width}`;
  let row = _blankRowCache.get(cacheKey);
  if (!row) {
    row = createRow(key, [createSpan(" ".repeat(Math.max(0, width)))], width);
    _blankRowCache.set(cacheKey, row);
  }
  return row;
}

function flattenSpansToTokens(spans: TimelineRowSpan[]): StyledToken[] {
  const tokens: StyledToken[] = [];
  for (const span of spans) {
    const parts = span.text.split(/([ \t\n]+)/);
    for (const part of parts) {
      if (part === "") continue;
      const isNewline = part === "\n" || (part.includes("\n") && /^[\s]+$/.test(part));
      const isWhitespace = /^[ \t\n]+$/.test(part);
      tokens.push({
        text: part,
        isWhitespace,
        isNewline,
        tone: span.tone,
        bold: span.bold,
        italic: span.italic,
        underline: span.underline,
        strikethrough: span.strikethrough,
        backgroundTone: span.backgroundTone,
      });
    }
  }
  return tokens;
}

/**
 * Word-wrap styled spans into lines of at most `width` display columns,
 * preserving per-span styling across breaks.
 *
 * Breaks at whitespace; newlines force a break; leading whitespace on a wrapped
 * line and whitespace that would overflow are dropped. A styled run inside one
 * word (`pre**bold**post`) is treated as a single word. Words wider than the
 * line are hard-split by display column, keeping wide graphemes intact.
 * Returned lines are NOT padded. Always returns at least one line.
 */
export function wrapStyledSpans(spans: TimelineRowSpan[], width: number): TimelineRowSpan[][] {
  const safeWidth = Math.max(1, width);
  const rows: TimelineRowSpan[][] = [];
  let currentRow: TimelineRowSpan[] = [];
  let currentWidth = 0;

  const pushRow = () => {
    rows.push(currentRow.length > 0 ? currentRow : [createSpan("")]);
    currentRow = [];
    currentWidth = 0;
  };

  const spanFor = (token: StyledToken, text: string): TimelineRowSpan => ({
    text,
    ...(token.tone !== undefined ? { tone: token.tone } : {}),
    ...(token.bold ? { bold: token.bold } : {}),
    ...(token.italic ? { italic: token.italic } : {}),
    ...(token.underline ? { underline: token.underline } : {}),
    ...(token.strikethrough ? { strikethrough: token.strikethrough } : {}),
    ...(token.backgroundTone !== undefined ? { backgroundTone: token.backgroundTone } : {}),
  });

  const tokens = flattenSpansToTokens(spans);
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex]!;
    // An inline style boundary is not a word boundary (pre**bold**post).
    if (
      !token.isWhitespace &&
      (tokenIndex === 0 || tokens[tokenIndex - 1]!.isWhitespace) &&
      tokens[tokenIndex + 1] !== undefined &&
      !tokens[tokenIndex + 1]!.isWhitespace
    ) {
      let wordWidth = 0;
      for (
        let lookahead = tokenIndex;
        lookahead < tokens.length && !tokens[lookahead]!.isWhitespace;
        lookahead += 1
      ) {
        wordWidth += getTextWidth(tokens[lookahead]!.text);
      }
      if (wordWidth <= safeWidth && currentWidth > 0 && currentWidth + wordWidth > safeWidth)
        pushRow();
    }
    if (token.isNewline) {
      pushRow();
      continue;
    }

    const tokenWidth = getTextWidth(token.text);

    if (token.isWhitespace) {
      if (currentWidth === 0) continue; // skip leading whitespace on a new row
      if (currentWidth + tokenWidth > safeWidth) {
        pushRow();
        continue; // drop whitespace that pushes us over the edge
      }
      appendSpan(currentRow, spanFor(token, token.text));
      currentWidth += tokenWidth;
      continue;
    }

    // Word token
    if (currentWidth + tokenWidth > safeWidth && currentWidth > 0) {
      pushRow();
    }

    // Overlong token: character-split across as many rows as needed
    if (tokenWidth > safeWidth) {
      let remaining = token.text;
      let remainingWidth = tokenWidth;
      while (remainingWidth > safeWidth - currentWidth) {
        const available = safeWidth - currentWidth;
        const split = splitTextAtColumn(remaining, available);
        if (!split.before && split.current && available > 0) {
          // A single wide grapheme cannot fit a one-column viewport. Consume it
          // atomically rather than looping forever or splitting its codepoints.
          appendSpan(currentRow, spanFor(token, split.current));
          remaining = split.after;
        } else {
          if (split.before) appendSpan(currentRow, spanFor(token, split.before));
          remaining = split.current + split.after;
        }
        pushRow();
        remainingWidth = getTextWidth(remaining);
      }
      if (remaining) {
        appendSpan(currentRow, spanFor(token, remaining));
        currentWidth += getTextWidth(remaining);
      }
      continue;
    }

    appendSpan(currentRow, spanFor(token, token.text));
    currentWidth += tokenWidth;
  }

  if (currentRow.length === 0 && rows.length === 0) {
    rows.push([createSpan("")]);
  } else if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Wrap `content` beside a marker column: `marker` on the first row,
 * `continuationMarker` (normally the same width) on the rest. Rows are keyed
 * `${keyPrefix}-${index}` and padded to `width`.
 */
export function buildPrefixedContentRows(
  keyPrefix: string,
  marker: TimelineRowSpan[],
  continuationMarker: TimelineRowSpan[],
  content: TimelineRowSpan[],
  width: number,
): TimelineRow[] {
  const markerWidth = Math.max(0, getSpansWidth(marker));
  const bodyWidth = Math.max(1, width - markerWidth);
  const wrappedRows = wrapStyledSpans(content, bodyWidth);

  return wrappedRows.map((row, index) =>
    createRow(
      `${keyPrefix}-${index}`,
      [...(index === 0 ? marker : continuationMarker), ...padSpansToWidth(row, bodyWidth)],
      width,
    ),
  );
}

// ─── Border & card builders ───────────────────────────────────────────────────

/** Prefix each pre-wrapped line with `indent` spaces and pad it to `width`. */
export function buildIndentedRows(
  keyPrefix: string,
  rows: TimelineRowSpan[][],
  width: number,
  indent: number,
): TimelineRow[] {
  const safeIndent = Math.max(0, indent);
  const contentWidth = Math.max(1, width - safeIndent);
  return rows.map((row, index) =>
    createRow(
      `${keyPrefix}-${index}`,
      [createSpan(" ".repeat(safeIndent)), ...padSpansToWidth(row, contentWidth)],
      width,
    ),
  );
}

export function __wrapStyledSpansForTests(
  spans: TimelineRowSpan[],
  width: number,
): TimelineRowSpan[][] {
  return wrapStyledSpans(spans, width);
}

/**
 * Outer layout pass applied to every item's rows: re-key them under
 * `keyPrefix`, add one column of left/right padding when `padded`, pad to
 * `totalWidth`, and optionally append one blank margin row.
 *
 * The inner rows must already have been built at `totalWidth - 2` when
 * `padded` (the snapshot builders do this). Results are cached per source row
 * object (WeakMap), so an unchanged inner row yields the same wrapped row.
 */
export function wrapRows(
  rows: TimelineRow[],
  totalWidth: number,
  padded: boolean,
  keyPrefix: string,
  includeMargin: boolean,
): TimelineRow[] {
  const leftPad = padded ? 1 : 0;
  const innerWidth = Math.max(1, totalWidth - leftPad * 2);
  const prefixedRows = rows.map((row) => {
    const cacheKey = `${keyPrefix}:${row.key}:${totalWidth}:${innerWidth}:${leftPad}`;
    let rowCache = _wrappedRowCache.get(row);
    if (!rowCache) {
      rowCache = new Map<string, TimelineRow>();
      _wrappedRowCache.set(row, rowCache);
    }

    const cached = rowCache.get(cacheKey);
    if (cached) return cached;

    const wrapped = createRow(
      `${keyPrefix}-wrapped-${row.key}`,
      [
        ...(leftPad > 0 ? [createSpan(" ".repeat(leftPad))] : []),
        ...padSpansToWidth(row.spans, innerWidth),
        ...(leftPad > 0 ? [createSpan(" ".repeat(leftPad))] : []),
      ],
      totalWidth,
      // Frame metadata must survive wrapping: the live-row window reads it to
      // avoid slicing a card open.
      row.frame,
    );
    rowCache.set(cacheKey, wrapped);
    return wrapped;
  });

  if (includeMargin) {
    const marginKey = `${keyPrefix}:${totalWidth}:margin`;
    let margin = _wrappedBlankRowCache.get(marginKey);
    if (!margin) {
      margin = createBlankRow(`${keyPrefix}-margin`, totalWidth);
      _wrappedBlankRowCache.set(marginKey, margin);
    }
    prefixedRows.push(margin);
  }
  return prefixedRows;
}

/** `wrapRows` with the trailing margin row always included. */
export function wrapItemRows(
  rows: TimelineRow[],
  totalWidth: number,
  padded: boolean,
  keyPrefix: string,
): TimelineRow[] {
  return wrapRows(rows, totalWidth, padded, keyPrefix, true);
}

/** Concatenate built items into a `TimelineSnapshot`. */
export function rowsToSnapshot(items: BuiltTimelineItem[]): TimelineSnapshot {
  const rows = items.flatMap((item) => item.rows);
  return {
    items,
    rows,
    totalRows: rows.length,
    itemCount: items.length,
  };
}
