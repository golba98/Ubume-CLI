/**
 * Bordered-card and turn-chrome row builders: dash cards, panels, the
 * live-window elision row, the user prompt card, and the impact summary.
 *
 * Card rows carry `frame` metadata (`id` = keyPrefix, role top/content/bottom)
 * so `windowLiveRows` can tell when a slice would cut a card open. Content is
 * fitted (clamped + padded) to the inner width so borders always land on the
 * declared width, keeping each row exactly one terminal line.
 *
 * `buildDashCardRows` mirrors the React `DashCard` top-border layout and
 * `buildPanelRows` mirrors `Panel` (render/Markdown.tsx); the measured rows,
 * not the components, are what the transcript renders.
 */
import { formatDuration, getTextWidth, wrapPlainText } from "../../../core/shared/text.js";
import {
  sanitizeTerminalLines,
  sanitizeTerminalOutput,
} from "../../../core/terminal/terminalSanitize.js";
import type { ShellEvent } from "../../../session/types.js";
import { createRow, createSpan, fitSpansToWidth, getSpansWidth } from "./rows.js";
import type { TimelineRow, TimelineRowSpan, TimelineTone, TurnRenderItem } from "./types.js";

const MAX_SHELL_FAILURE_EXCERPT_LINES = 3;

// `╭── title ─…─ badge ──╮` (or `╭── title ─…──╮`); the fill absorbs the slack.
// Tones here are placeholders that buildDashCardRows remaps to the card's tones.
function buildTopBorder(width: number, title: string, rightBadge?: string): TimelineRowSpan[] {
  const safeWidth = Math.max(4, width);
  const prefixWidth = 4;
  const titleWidth = getTextWidth(title);
  const badgeWidth = rightBadge ? getTextWidth(rightBadge) : 0;
  const suffixWidth = rightBadge ? 4 : 3;
  const fillSpacerWidth = rightBadge ? 2 : 1;
  const fillCount = Math.max(
    1,
    safeWidth - prefixWidth - titleWidth - badgeWidth - suffixWidth - fillSpacerWidth,
  );

  const spans: TimelineRowSpan[] = [
    createSpan("╭── ", "borderSubtle"),
    createSpan(title, "muted", { bold: true }),
    createSpan(
      rightBadge ? ` ${"─".repeat(fillCount)} ` : ` ${"─".repeat(fillCount)}`,
      "borderSubtle",
    ),
  ];

  if (rightBadge) {
    spans.push(createSpan(rightBadge, "dim"));
    spans.push(createSpan(" ──╮", "borderSubtle"));
  } else {
    spans.push(createSpan("──╮", "borderSubtle"));
  }

  return spans;
}

/**
 * Rounded card: top border with title/badge, one `│ … │` row per content line
 * (each fitted to `width - 4`), and a bottom border. Row keys are
 * `${keyPrefix}-top|-content-N|-bottom`.
 */
export function buildDashCardRows(params: {
  keyPrefix: string;
  width: number;
  title: string;
  rightBadge?: string;
  borderTone?: TimelineTone;
  titleTone?: TimelineTone;
  badgeTone?: TimelineTone;
  contentRows: TimelineRowSpan[][];
}): TimelineRow[] {
  const width = Math.max(4, params.width);
  const contentWidth = Math.max(1, width - 4);
  const borderTone = params.borderTone ?? "borderSubtle";
  const titleTone = params.titleTone ?? "muted";
  const badgeTone = params.badgeTone ?? "dim";
  const topBase = buildTopBorder(width, params.title, params.rightBadge);
  const topRow = topBase.map((span) => {
    if (span.tone === "muted") return { ...span, tone: titleTone };
    if (span.tone === "dim") return { ...span, tone: badgeTone };
    return { ...span, tone: borderTone };
  });

  const frameId = params.keyPrefix;
  const rows: TimelineRow[] = [
    createRow(`${params.keyPrefix}-top`, fitSpansToWidth(topRow, width), width, {
      id: frameId,
      role: "top",
    }),
  ];

  params.contentRows.forEach((row, index) => {
    rows.push(
      createRow(
        `${params.keyPrefix}-content-${index}`,
        [
          createSpan("│ ", borderTone),
          ...fitSpansToWidth(row, contentWidth),
          createSpan(" │", borderTone),
        ],
        width,
        { id: frameId, role: "content" },
      ),
    );
  });

  rows.push(
    createRow(
      `${params.keyPrefix}-bottom`,
      [createSpan(`╰${"─".repeat(Math.max(1, width - 2))}╯`, borderTone)],
      width,
      { id: frameId, role: "bottom" },
    ),
  );

  return rows;
}

/**
 * Rebuild a card's elision notice for the live-row window: when the window cuts
 * into a card, the frame is re-capped with its own top border plus this row so
 * the viewer sees a complete box that says how much was dropped, never a
 * headless box starting mid-sentence.
 */
export function buildFrameElisionRow(frameTopRow: TimelineRow, hiddenRows: number): TimelineRow {
  const rowWidth = Math.max(4, getSpansWidth(frameTopRow.spans));
  // The top row may already be wrapped with outer padding (wrapRows), so locate
  // the corner glyph rather than assuming the box starts at column 0.
  const rowText = frameTopRow.spans.map((span) => span.text).join("");
  const cornerIndex = rowText.indexOf("╭");
  const leftPad = cornerIndex > 0 ? getTextWidth(rowText.slice(0, cornerIndex)) : 0;
  const borderTone =
    frameTopRow.spans.find((span) => span.text.includes("╭"))?.tone ?? "borderSubtle";
  const boxWidth = Math.max(4, rowWidth - leftPad * 2);
  const contentWidth = Math.max(1, boxWidth - 4);

  const fullLabel = `⋯ ${hiddenRows} row${hiddenRows === 1 ? "" : "s"} hidden`;
  // Narrow terminals would clip "rows hidden" to a misleading fragment.
  const label = getTextWidth(fullLabel) <= contentWidth ? fullLabel : `⋯ ${hiddenRows}`;

  const pad = leftPad > 0 ? [createSpan(" ".repeat(leftPad))] : [];
  return createRow(
    `${frameTopRow.key}-elided`,
    [
      ...pad,
      createSpan("│ ", borderTone),
      ...fitSpansToWidth([createSpan(label, "dim")], contentWidth),
      createSpan(" │", borderTone),
      ...pad,
    ],
    rowWidth,
    frameTopRow.frame ? { id: frameTopRow.frame.id, role: "content" } : undefined,
  );
}

/** `╭─ TITLE ─── RIGHT ╮` panel with active-border tones (minimum width 10). */
export function buildPanelRows(params: {
  keyPrefix: string;
  width: number;
  title: string;
  rightTitle?: string;
  contentRows: TimelineRowSpan[][];
}): TimelineRow[] {
  const width = Math.max(10, params.width);
  const leftLabel = ` ${params.title} `;
  const rightLabel = params.rightTitle ? ` ${params.rightTitle} ` : "";
  const dashCount = Math.max(0, width - 3 - getTextWidth(leftLabel) - getTextWidth(rightLabel));
  const frameId = params.keyPrefix;
  const rows: TimelineRow[] = [
    createRow(
      `${params.keyPrefix}-top`,
      [
        createSpan("╭─", "borderActive"),
        createSpan(leftLabel, "text"),
        createSpan("─".repeat(dashCount), "borderActive"),
        ...(params.rightTitle ? [createSpan(rightLabel, "dim")] : []),
        createSpan("╮", "borderActive"),
      ],
      width,
      { id: frameId, role: "top" },
    ),
  ];

  const contentWidth = Math.max(1, width - 4);
  params.contentRows.forEach((row, index) => {
    rows.push(
      createRow(
        `${params.keyPrefix}-content-${index}`,
        [
          createSpan("│ ", "borderActive"),
          ...fitSpansToWidth(row, contentWidth),
          createSpan(" │", "borderActive"),
        ],
        width,
        { id: frameId, role: "content" },
      ),
    );
  });

  rows.push(
    createRow(
      `${params.keyPrefix}-bottom`,
      [createSpan(`╰${"─".repeat(Math.max(1, width - 2))}╯`, "borderActive")],
      width,
      { id: frameId, role: "bottom" },
    ),
  );

  return rows;
}

// ─── Turn content builders ────────────────────────────────────────────────────

/** The "PROMPT" card for a turn's user prompt (`❯` marker, dimmed when the turn is dim). */
export function buildUserInputRows(item: TurnRenderItem, width: number): TimelineRow[] {
  const dim = item.renderState.opacity === "dim";
  const contentWidth = Math.max(1, width - 4);
  const lines = wrapPlainText(
    sanitizeTerminalOutput(item.item.user?.prompt ?? ""),
    Math.max(1, contentWidth - 2),
  ).map((line, index) => [
    createSpan(index === 0 ? "❯ " : "  ", dim ? "dim" : "text"),
    createSpan(line || " ", dim ? "dim" : "text"),
  ]);

  return buildDashCardRows({
    keyPrefix: `${item.key}-user`,
    width,
    title: "PROMPT",
    borderTone: "borderSubtle",
    contentRows: lines,
  });
}

/**
 * Up to three non-empty lines of a failed shell command's output (stderr
 * preferred), skipping a first line that merely repeats the summary.
 */
export function getShellFailureExcerpt(event: ShellEvent): string[] {
  const source = event.stderrLines.length > 0 ? event.stderrLines : event.lines;
  const summary = sanitizeTerminalOutput(event.summary ?? "")
    .trim()
    .toLowerCase();
  return sanitizeTerminalLines(source)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => !(index === 0 && summary && line.toLowerCase() === summary))
    .slice(0, MAX_SHELL_FAILURE_EXCERPT_LINES);
}

/**
 * Compact impact summary for completed runs (default mode).
 * Shows file changes and a summary footer. The action count only includes
 * tools that never appeared in the stream (already-streamed actions have
 * their own rows). Returns `[]` when there is nothing to report.
 */
export function buildImpactSummaryRows(item: TurnRenderItem, width: number): TimelineRow[] {
  const run = item.item.run!;
  const summary = run.activitySummary;
  const hasFiles = run.touchedFileCount > 0;
  const streamItemTools = new Set(
    (run.streamItems ?? []).filter((i) => i.kind === "action").map((i) => i.refId),
  );
  const unstreamedTools = run.toolActivities.filter((t) => !streamItemTools.has(t.id));
  const hasUnstreamedTools = unstreamedTools.length > 0;
  if (!hasFiles && !hasUnstreamedTools) return [];

  const rows: TimelineRow[] = [];
  const recentFiles = summary?.recent ?? run.activity.slice(-6);
  const hasDeletes = (summary?.deleted ?? 0) > 0;

  const opLabel = (op: string) => {
    switch (op) {
      case "created":
        return "CREATED ";
      case "modified":
        return "MODIFIED";
      case "deleted":
        return "DELETED ";
      default:
        return op.toUpperCase().padEnd(8);
    }
  };
  const opTone = (op: string): TimelineTone => {
    switch (op) {
      case "created":
        return "success";
      case "deleted":
        return "error";
      default:
        return "info";
    }
  };

  // Warning banner for destructive changes
  if (hasDeletes) {
    rows.push(
      createRow(
        `${item.key}-impact-warn`,
        [createSpan(" "), createSpan("⚠ Destructive changes detected:", "warning")],
        width,
      ),
    );
  }

  // "Changes:" label
  if (hasFiles) {
    rows.push(
      createRow(
        `${item.key}-impact-label`,
        [createSpan("   "), createSpan("Changes:", "dim")],
        width,
      ),
    );

    // File list
    recentFiles.forEach((file, index) => {
      const diffInfo =
        file.addedLines != null || file.removedLines != null
          ? ` (+${file.addedLines ?? 0} -${file.removedLines ?? 0})`
          : "";
      rows.push(
        createRow(
          `${item.key}-impact-file-${index}`,
          [
            createSpan("     "),
            createSpan(opLabel(file.operation), opTone(file.operation)),
            createSpan(` ${file.path}`, "text"),
            createSpan(diffInfo, "dim"),
          ],
          width,
        ),
      );
    });
  }

  // Summary footer
  const parts: string[] = [];
  if (run.touchedFileCount > 0)
    parts.push(`${run.touchedFileCount} file${run.touchedFileCount === 1 ? "" : "s"}`);
  if (hasUnstreamedTools)
    parts.push(`${unstreamedTools.length} action${unstreamedTools.length === 1 ? "" : "s"}`);
  if (run.durationMs != null) parts.push(formatDuration(run.durationMs));

  rows.push(
    createRow(
      `${item.key}-impact-summary`,
      [createSpan("   "), createSpan("✔ ", "success"), createSpan(parts.join(" • "), "dim")],
      width,
    ),
  );

  return rows;
}
