/**
 * Classify stage of the render pipeline: markdown text → typed `Segment[]`
 * (code, header, list, para, table, quote, rule) with inline styling parts.
 *
 * A small, forgiving CommonMark-ish parser tuned for CLI answers, not a spec
 * implementation: source line breaks inside paragraphs are kept, bare diffs
 * become `diff` code blocks, local link labels are compacted, and on any
 * internal error the whole input degrades to plain paragraph lines. Input is
 * sanitized (control/ANSI sequences stripped, tabs preserved) before parsing;
 * session strings themselves are never modified. Output is consumed by
 * `timeline/measure/markdownRows.ts`.
 *
 * Caching (module-level `MarkdownCache`s, cleared by `resetMarkdownCaches`):
 * - `inlineCache` — inline parse results keyed by source text;
 * - `streamCache` — last parse per `cacheKey`. When the new source extends the
 *   cached source, all but the last segment are reused and parsing restarts
 *   at that segment, so a streaming delta re-parses only the tail.
 */
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { detachMarkdownText, MarkdownCache } from "./markdownCache.js";
import { formatLocalPathForTerminal } from "./terminalAnswerFormat.js";

/**
 * A run of inline text. `kind: "code"` is inline code; link text carries
 * `target` (and underline), followed by a separate ` (target)` part.
 */
export interface InlinePart {
  kind: "text" | "code" | "bold";
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  /** Displayed as text, never passed through as a model-supplied escape sequence. */
  target?: string;
}
// Absolute offsets into the sanitized source; used to restart incremental
// parsing at the last segment, and `raw` for the measure-stage error fallback.
interface SourceRange {
  sourceStart?: number;
  sourceEnd?: number;
  raw?: string;
}
export type CodeSegment = SourceRange & {
  type: "code";
  lang: string;
  lines: string[];
  closed?: boolean;
};
export type HeaderSegment = SourceRange & {
  type: "header";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  parts: InlinePart[];
};
export interface ListItem {
  num: number;
  marker?: string;
  ordered?: boolean;
  indent?: number;
  checked?: boolean;
  blankBefore?: boolean;
  parts: InlinePart[];
}
export type ListSegment = SourceRange & { type: "list"; ordered: boolean; items: ListItem[] };
export type ParaSegment = SourceRange & {
  type: "para";
  lines: InlinePart[][];
  hardBreaks?: boolean[];
};
export type TableAlignment = "left" | "center" | "right";
/** `streaming` is set when the table is still the trailing block of a streaming answer. */
export type TableSegment = SourceRange & {
  type: "table";
  headers: InlinePart[][];
  alignments: TableAlignment[];
  rows: InlinePart[][][];
  streaming?: boolean;
};
export type QuoteSegment = SourceRange & { type: "quote"; segments: Segment[] };
export type RuleSegment = SourceRange & { type: "rule" };
export type Segment =
  | CodeSegment
  | HeaderSegment
  | ListSegment
  | ParaSegment
  | TableSegment
  | QuoteSegment
  | RuleSegment;
/**
 * `streaming`: content is still growing (affects table layout hints).
 * `cacheKey`: stable id of the growing document (e.g. run + segment id) that
 * enables incremental re-parsing; omit for one-off parses.
 */
export interface MarkdownOptions {
  streaming?: boolean;
  cacheKey?: string;
}

const inlineCache = new MarkdownCache<InlinePart[]>(2048, 512_000);
const streamCache = new MarkdownCache<{ source: string; segments: Segment[] }>(16, 1_000_000);
const MAX_DEPTH = 24;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+)$/;
const LIST = /^([ \t]*)([-+*]|\d+[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ESCAPABLE = /[\\`*{}\[\]()#+\-.!_|>~]/;
const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "powershell",
  "pwsh",
  "cmd",
  "bat",
  "batch",
]);
/** True for fence languages that denote shell commands (bash, zsh, pwsh, cmd, …). */
export function isShellCodeLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(language.trim().toLowerCase());
}

/** Find an exact matching run, so pipes inside ``a|b`` are not cell delimiters. */
function codeEnd(text: string, start: number, count: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] !== "`") continue;
    let end = index;
    while (text[end] === "`") end += 1;
    if (end - index === count) return index;
    index = end - 1;
  }
  return -1;
}

/**
 * Split a table row on unescaped `|` outside inline code, dropping the empty
 * cells produced by leading/trailing pipes. Returns null when the line has no
 * delimiter at all.
 */
export function splitTableCells(line: string): string[] | null {
  const text = line.trim();
  const cells: string[] = [];
  let start = 0;
  let found = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "`") {
      let end = index;
      while (text[end] === "`") end += 1;
      const close = codeEnd(text, end, end - index);
      if (close >= 0) {
        index = close + end - index - 1;
        continue;
      }
      index = end - 1;
      continue;
    }
    if (text[index] !== "|") continue;
    cells.push(text.slice(start, index).trim());
    start = index + 1;
    found = true;
  }
  if (!found) return null;
  cells.push(text.slice(start).trim());
  if (text.startsWith("|")) cells.shift();
  if (start === text.length) cells.pop();
  return cells;
}

// Index of the closing emphasis/strike delimiter for `marker` (`*`, `**`,
// `***`, `__`, `~~`, …) at or after `start`, or -1. Skips escapes and inline
// code, and ignores closers preceded by whitespace.
function delimiterEnd(text: string, marker: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "`") {
      let end = index;
      while (text[end] === "`") end += 1;
      const close = codeEnd(text, end, end - index);
      if (close >= 0) {
        index = close + end - index - 1;
        continue;
      }
    }
    if (text[index] !== marker[0]) continue;
    let end = index;
    while (text[end] === marker[0]) end += 1;
    const run = end - index;
    if (run < marker.length || /\s/.test(text[index - 1] ?? " ")) {
      index = end - 1;
      continue;
    }
    if (marker.length === 1 && run === 2) {
      index = end - 1;
      continue;
    }
    // Leave the inner emphasis closer inside the outer bold delimiter.
    if (marker.length === 2 && run === 3) {
      const inner = text.slice(start, index).split(marker[0]!).length - 1;
      if (inner % 2 === 1) return index + 1;
    }
    if (marker.length === 1 && run === 3) return index + 2;
    return index;
  }
  return -1;
}

// Recursive inline parser; `style` accumulates nested emphasis. Recursion is
// capped at MAX_DEPTH so adversarial nesting degrades to plain text.
function parseInlineInner(
  text: string,
  depth: number,
  style: Partial<InlinePart> = {},
): InlinePart[] {
  if (depth >= MAX_DEPTH) return [{ kind: "text", text, ...style }];
  const parts: InlinePart[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) parts.push({ kind: style.bold ? "bold" : "text", text: buffer, ...style });
    buffer = "";
  };
  for (let index = 0; index < text.length; ) {
    const char = text[index]!;
    // Consume absolute/UNC paths verbatim so characters such as `_` or `\`
    // inside them are not mistaken for emphasis or escapes.
    const path =
      char === "/" || (char === "\\" && text[index + 1] === "\\") || text[index + 1] === ":"
        ? /^(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_.-]|\/[A-Za-z0-9_.-])[^\s`<>*|]*/.exec(
            text.slice(index),
          )
        : null;
    if (path) {
      buffer += path[0];
      index += path[0].length;
      continue;
    }
    if (char === "\\" && ESCAPABLE.test(text[index + 1] ?? "")) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      let end = index;
      while (text[end] === "`") end += 1;
      const close = codeEnd(text, end, end - index);
      if (close >= 0) {
        flush();
        parts.push({ ...style, kind: "code", text: text.slice(end, close) });
        index = close + end - index;
        continue;
      }
      buffer += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "[" && text[index - 1] !== "!") {
      let labelEnd = index + 1;
      let brackets = 1;
      for (; labelEnd < text.length; labelEnd += 1) {
        if (text[labelEnd] === "\\") {
          labelEnd += 1;
          continue;
        }
        if (text[labelEnd] === "[") brackets += 1;
        if (text[labelEnd] === "]" && --brackets === 0) break;
      }
      if (brackets !== 0) {
        buffer += text.slice(index);
        break;
      }
      if (text[labelEnd + 1] === "(") {
        let targetEnd = labelEnd + 2;
        let parentheses = 1;
        for (; targetEnd < text.length; targetEnd += 1) {
          if (text[targetEnd] === "\\") {
            targetEnd += 1;
            continue;
          }
          if (text[targetEnd] === "(") parentheses += 1;
          if (text[targetEnd] === ")" && --parentheses === 0) break;
        }
        if (parentheses === 0) {
          flush();
          const target = text.slice(labelEnd + 2, targetEnd).replace(/^<|>$/g, "");
          let label = text.slice(index + 1, labelEnd);
          if (
            /^(?:file:|[A-Za-z]:[\\/]|\/(?:home|Users|workspace)\/)/.test(target) &&
            /[\\/]/.test(label)
          ) {
            label = formatLocalPathForTerminal(label);
          }
          parts.push(...parseInlineInner(label, depth + 1, { ...style, underline: true, target }));
          parts.push({ kind: "text", text: ` (${target})`, target });
          index = targetEnd + 1;
          continue;
        }
      }
    }
    if (char === "*" || char === "_" || char === "~") {
      const run = text.slice(index).match(/^(\*+|_+|~+)/)?.[0] ?? char;
      const marker = char === "~" ? "~~" : run.slice(0, Math.min(3, run.length));
      const inWord = char === "_" && /[\p{L}\p{N}]/u.test(text[index - 1] ?? "");
      if (
        !inWord &&
        (char !== "~" || run.length >= 2) &&
        !/\s/.test(text[index + marker.length] ?? " ")
      ) {
        const close = delimiterEnd(text, marker, index + marker.length);
        if (close >= 0) {
          flush();
          parts.push(
            ...parseInlineInner(text.slice(index + marker.length, close), depth + 1, {
              ...style,
              ...(char === "~"
                ? { strikethrough: true }
                : {
                    ...(marker.length >= 2 ? { bold: true } : {}),
                    ...(marker.length % 2 === 1 ? { italic: true } : {}),
                  }),
            }),
          );
          index = close + marker.length;
          continue;
        }
      }
      buffer += run;
      index += run.length;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return parts.length ? parts : [{ kind: "text", text: "", ...style }];
}
/** Parse inline markdown (code, emphasis, strike, links), cached by source text. */
export function parseInline(text: string): InlinePart[] {
  const cached = inlineCache.get(text);
  if (cached) return cached;
  const owned = detachMarkdownText(text);
  return inlineCache.set(owned, parseInlineInner(owned, 0), owned.length * 2);
}

// A header row followed by a matching `---|:--:|--:` delimiter row, or null.
function tableHeader(
  lines: string[],
  index: number,
): { cells: string[]; alignment: TableAlignment[] } | null {
  const cells = splitTableCells(lines[index] ?? "");
  const delimiter = splitTableCells(lines[index + 1] ?? "");
  if (
    !cells?.length ||
    delimiter?.length !== cells.length ||
    !delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
    return null;
  return {
    cells,
    alignment: delimiter.map((cell) =>
      cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left",
    ),
  };
}

/**
 * Line-oriented block parser. `base` is the absolute offset of `source` in the
 * full document (so segment source ranges stay absolute when re-parsing a
 * tail); `depth` bounds blockquote nesting.
 */
function parseBlocks(source: string, streaming: boolean, base = 0, depth = 0): Segment[] {
  const lines = source.split("\n");
  const offsets: number[] = [];
  let offset = base;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const out: Segment[] = [];
  let index = 0;
  const push = (segment: Segment, start: number) => {
    const end = index < lines.length ? offsets[index]! : base + source.length;
    out.push({
      ...segment,
      sourceStart: offsets[start],
      sourceEnd: end,
      raw: source.slice(offsets[start]! - base, end - base),
    });
  };
  const isStart = (i: number) =>
    FENCE.test(lines[i]!) ||
    HEADING.test(lines[i]!) ||
    LIST.test(lines[i]!) ||
    QUOTE.test(lines[i]!) ||
    RULE.test(lines[i]!) ||
    tableHeader(lines, i) !== null;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const start = index;
    // Unfenced unified diff: treat everything up to the next blank line as a
    // `diff` code block so it gets diff tones and no markdown interpretation.
    if (
      /^(?:diff --git\s|@@\s+-\d)/.test(line) ||
      (/^--- \S/.test(line) && /^\+\+\+ \S/.test(lines[index + 1] ?? ""))
    ) {
      const diffLines: string[] = [];
      while (index < lines.length && lines[index] !== "") diffLines.push(lines[index++]!);
      push({ type: "code", lang: "diff", lines: diffLines, closed: true }, start);
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index]!)) codeLines.push(lines[index++]!);
      const closed = index < lines.length;
      if (closed) index += 1;
      else if (source.endsWith("\n")) codeLines.pop(); // split's trailing sentinel is not a source line
      push({ type: "code", lang: fence[2]!.trim(), lines: codeLines, closed }, start);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      index += 1;
      push(
        {
          type: "header",
          level: heading[1]!.length as HeaderSegment["level"],
          parts: parseInline(heading[2]!.replace(/[ \t]+#+[ \t]*$/, "")),
        },
        start,
      );
      continue;
    }
    if (RULE.test(line)) {
      index += 1;
      push({ type: "rule" }, start);
      continue;
    }
    const table = tableHeader(lines, index);
    if (table) {
      index += 2;
      const cells: string[][] = [];
      while (index < lines.length && lines[index]!.trim()) {
        const row = splitTableCells(lines[index]!);
        if (!row) break;
        cells.push(row);
        index += 1;
      }
      const count = Math.max(table.cells.length, ...cells.map((row) => row.length));
      const headers = Array.from({ length: count }, (_, col) =>
        parseInline(table.cells[col] ?? `Column ${col + 1}`),
      );
      push(
        {
          type: "table",
          headers,
          alignments: Array.from({ length: count }, (_, col) => table.alignment[col] ?? "left"),
          rows: cells.map((row) =>
            Array.from({ length: count }, (_, col) => parseInline(row[col] ?? "")),
          ),
          streaming: streaming && lines.slice(index).every((line) => !line.trim()),
        },
        start,
      );
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote && depth < MAX_DEPTH) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]!);
        if (!match) break;
        quoted.push(match[1]!);
        index += 1;
      }
      push(
        { type: "quote", segments: parseBlocks(quoted.join("\n"), streaming, 0, depth + 1) },
        start,
      );
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      const items: ListItem[] = [];
      const baseIndent = list[1]!.replace(/\t/g, "  ").length;
      let blank = false;
      while (index < lines.length) {
        const match = LIST.exec(lines[index]!);
        if (match) {
          const indent = match[1]!.replace(/\t/g, "  ").length;
          if (indent < baseIndent) break;
          const task = /^\[([ xX])\][ \t]+(.*)$/.exec(match[3]!);
          const ordered = /^\d/.test(match[2]!);
          items.push({
            num: ordered ? Number.parseInt(match[2]!, 10) : items.length + 1,
            marker: match[2],
            ordered,
            indent: indent - baseIndent,
            ...(task ? { checked: task[1] !== " " } : {}),
            blankBefore: blank,
            parts: parseInline(task ? task[2]! : match[3]!),
          });
          blank = false;
          index += 1;
          continue;
        }
        if (!lines[index]!.trim()) {
          if (LIST.test(lines[index + 1] ?? "")) {
            blank = true;
            index += 1;
            continue;
          }
          break;
        }
        const indentation = lines[index]!.match(/^[ \t]*/)?.[0].replace(/\t/g, "  ").length ?? 0;
        const item = items.at(-1)!;
        if (indentation <= baseIndent + (item.indent ?? 0) || isStart(index)) break;
        item.parts = [
          ...item.parts,
          { kind: "text", text: " " },
          ...parseInline(lines[index]!.trim()),
        ];
        index += 1;
      }
      push({ type: "list", ordered: /^\d/.test(list[2]!), items }, start);
      continue;
    }
    if (/^ {0,3}(?:={3,}|-{3,})[ \t]*$/.test(lines[index + 1] ?? "")) {
      index += 2;
      push(
        {
          type: "header",
          level: lines[start + 1]!.trim().startsWith("=") ? 1 : 2,
          parts: parseInline(line),
        },
        start,
      );
      continue;
    }
    // Paragraph: consecutive non-blank lines until another block starts. A
    // trailing backslash is a hard break unless the line ends in a Windows path.
    const para: InlinePart[][] = [];
    const hardBreaks: boolean[] = [];
    while (index < lines.length && lines[index]!.trim() && (index === start || !isStart(index))) {
      const current = lines[index]!;
      const pathEnding = /(?:[A-Za-z]:[\\/]|\\\\)[^\n]*\\$/.test(current);
      const hard = / {2,}$/.test(current) || (!pathEnding && /\\$/.test(current));
      para.push(parseInline(hard ? current.replace(/(?: {2,}|\\)$/, "") : current));
      hardBreaks.push(hard);
      index += 1;
    }
    push({ type: "para", lines: para, hardBreaks }, start);
  }
  return out;
}

/**
 * Presentation-only parsing: session strings are never mutated or normalized destructively.
 *
 * Returns the segments for `content`. With `options.cacheKey`, reuses the
 * previous parse for that key when `content` only appended to it (see module
 * doc); a non-append change re-parses from scratch. If block parsing throws,
 * returns the source as plain paragraph lines instead.
 */
export function parseMarkdown(content: string, options: MarkdownOptions = {}): Segment[] {
  const source = sanitizeTerminalOutput(content, { preserveTabs: true });
  try {
    const previous = options.cacheKey ? streamCache.get(options.cacheKey) : undefined;
    let prefix: Segment[] = [];
    let restart = 0;
    if (previous && source.startsWith(previous.source)) {
      // Retain one mutable block for table promotion, list growth and unclosed fences.
      prefix = previous.segments.slice(0, -1);
      restart = previous.segments.at(-1)?.sourceStart ?? 0;
    }
    const segments = [
      ...prefix,
      ...parseBlocks(source.slice(restart), options.streaming ?? false, restart),
    ];
    if (options.cacheKey)
      streamCache.set(options.cacheKey, { source, segments }, source.length * 3);
    return segments;
  } catch {
    return [
      {
        type: "para",
        lines: source.split("\n").map((text) => [{ kind: "text", text }]),
        hardBreaks: source.split("\n").map(() => true),
      },
    ];
  }
}
