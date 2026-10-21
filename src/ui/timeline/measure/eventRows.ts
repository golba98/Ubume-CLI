/**
 * Row builders for non-stream content: the verbose file-scan card, the
 * action-required question card, standalone system/error/shell events, and
 * the startup intro (logo + metadata).
 *
 * All output goes through `createRow`, so each row is one terminal line padded
 * to `width`. Callers cache results (`stableSnapshot.ts`, `getStaticRows`);
 * these functions are pure apart from the shared row interning.
 */
import { clampVisualText, getTextWidth, wrapPlainText } from "../../../core/shared/text.js";
import { sanitizeTerminalOutput } from "../../../core/terminal/terminalSanitize.js";
import {
  LOGO_COMPACT,
  LOGO_COMPACT_MIN_COLS,
  selectLogoVariant,
} from "../../render/logoVariants.js";
import { wordmarkArt, wordmarkBand } from "../../render/wordmarkArt.js";
import { selectVisibleRunActivity } from "../runActivityView.js";
import { buildDashCardRows, getShellFailureExcerpt } from "./cards.js";
import {
  buildIndentedRows,
  buildPrefixedContentRows,
  createBlankRow,
  createRow,
  createSpan,
} from "./rows.js";
import { buildCompactStartupRows } from "./startupBrandingRows.js";
import type {
  RenderTimelineItem,
  TimelineRow,
  TimelineRowSpan,
  TimelineTone,
  TurnRenderItem,
} from "./types.js";

// ─── Agent & action builders ──────────────────────────────────────────────────

/** Verbose-mode "Scanning workspace ..." card listing recently touched files. */
export function buildFileScanRows(item: TurnRenderItem, width: number): TimelineRow[] {
  const run = item.item.run!;
  const { visible, hiddenCount } = selectVisibleRunActivity(run);
  const contentRows: TimelineRowSpan[][] = [];

  if (hiddenCount > 0) {
    contentRows.push([createSpan(`... ${hiddenCount} more`, "dim")]);
  }

  visible.forEach((file) => {
    contentRows.push([createSpan("● ", "success"), createSpan(file.path, "text")]);
  });

  return buildDashCardRows({
    keyPrefix: `${item.key}-files`,
    width,
    title: "Scanning workspace ...",
    rightBadge: `${run.touchedFileCount} file${run.touchedFileCount === 1 ? "" : "s"}`,
    contentRows,
  });
}

/**
 * Square-bordered "[N] ACTION REQUIRED" card for the turn's pending question,
 * or `[]` when there is none. These rows carry no `frame` metadata.
 */
export function buildActionRequiredRows(item: TurnRenderItem, width: number): TimelineRow[] {
  const question = item.renderState.question;
  if (!question) return [];

  const contentWidth = Math.max(1, width - 4);
  const wrappedQuestion = question.split("\n").flatMap((line) => {
    const rows = wrapPlainText(line, contentWidth);
    return rows.length > 0 ? rows : [""];
  });

  const rows: TimelineRow[] = [
    createRow(
      `${item.key}-question-top`,
      [createSpan(`┌${"─".repeat(Math.max(1, width - 2))}┐`, "borderActive")],
      width,
    ),
  ];

  const title = `[${item.item.turnIndex}] ACTION REQUIRED`;
  const titleWidth = getTextWidth(title) + getTextWidth("⚡");
  const padding = Math.max(1, contentWidth - titleWidth);
  rows.push(
    createRow(
      `${item.key}-question-title`,
      [
        createSpan("│ ", "borderActive"),
        createSpan(title, "text", { bold: true }),
        createSpan(" ".repeat(padding)),
        createSpan("⚡", "text", { bold: true }),
        createSpan(" │", "borderActive"),
      ],
      width,
    ),
  );
  rows.push(createBlankRow(`${item.key}-question-gap`, width));
  rows.push(
    createRow(
      `${item.key}-question-label`,
      [
        createSpan("│ ", "borderActive"),
        createSpan("Verification Question", "text", { bold: true }),
        createSpan(" ".repeat(Math.max(0, contentWidth - getTextWidth("Verification Question")))),
        createSpan(" │", "borderActive"),
      ],
      width,
    ),
  );

  wrappedQuestion.forEach((row, index) => {
    rows.push(
      createRow(
        `${item.key}-question-row-${index}`,
        [
          createSpan("│ ", "borderActive"),
          createSpan(row || " ", "text"),
          createSpan(" ".repeat(Math.max(0, contentWidth - getTextWidth(row || " ")))),
          createSpan(" │", "borderActive"),
        ],
        width,
      ),
    );
  });

  rows.push(createBlankRow(`${item.key}-question-end-gap`, width));
  rows.push(
    createRow(
      `${item.key}-question-bottom`,
      [createSpan(`└${"─".repeat(Math.max(1, width - 2))}┘`, "borderActive")],
      width,
    ),
  );
  return rows;
}

// ─── Standalone event & intro rows ───────────────────────────────────────────

/**
 * Rows for a standalone timeline event: shell runs (heading, summary, and a
 * stderr excerpt on failure), errors, and system notices (title + full
 * multi-line content, indented by two columns).
 */
export function buildStandaloneEventRows(
  item: Extract<RenderTimelineItem, { type: "event" }>,
  width: number,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const event = item.event;

  if (event.type === "shell") {
    const command = sanitizeTerminalOutput(event.command);
    const summary = sanitizeTerminalOutput(event.summary ?? "");
    const marker = event.status === "failed" ? "✕ " : "✧ ";
    const markerTone = event.status === "failed" ? "error" : "accent";
    const verb =
      event.status === "running"
        ? "Executing shell"
        : event.status === "completed"
          ? "Executed shell"
          : "Shell failed";
    const statusBits = [
      event.exitCode !== null && event.status !== "running" ? `exit ${event.exitCode}` : null,
      event.durationMs !== null ? `${(event.durationMs / 1000).toFixed(2)}s` : null,
    ]
      .filter(Boolean)
      .join(" • ");
    const heading = `${verb}: ${command}${statusBits ? `  •  ${statusBits}` : ""}`;

    rows.push(
      ...buildPrefixedContentRows(
        `${item.key}-shell`,
        [createSpan(marker, markerTone)],
        [createSpan("  ", markerTone)],
        [createSpan(heading, "text")],
        width,
      ),
    );

    if (summary && event.status !== "running") {
      const summaryRows = wrapPlainText(summary, Math.max(1, width - 2));
      rows.push(
        ...buildIndentedRows(
          `${item.key}-summary`,
          summaryRows.map((row) => [
            createSpan(row || " ", event.status === "failed" ? "error" : "muted"),
          ]),
          width,
          2,
        ),
      );
    }

    if (event.status === "failed") {
      const failureExcerpt = getShellFailureExcerpt(event);
      rows.push(
        ...buildIndentedRows(
          `${item.key}-stderr`,
          failureExcerpt.map((line) => [createSpan(line, "error")]),
          width,
          2,
        ),
      );
    }

    return rows;
  }

  if (event.type === "error") {
    rows.push(
      ...buildPrefixedContentRows(
        `${item.key}-error`,
        [createSpan("✕ ", "error")],
        [createSpan("  ", "error")],
        [createSpan(sanitizeTerminalOutput(event.title), "error")],
        width,
      ),
    );

    // Show the full content — not just the first line.  Error messages can span
    // multiple lines (stack traces, multi-step explanations) and silently
    // truncating to line 1 hides important diagnostic information.
    const errorContentLines = sanitizeTerminalOutput(event.content)
      .split("\n")
      .filter((line) => line.trim());
    if (errorContentLines.length > 0) {
      const wrappedRows = errorContentLines.flatMap((line) =>
        wrapPlainText(line, Math.max(1, width - 2)).map((row) => [createSpan(row || " ", "muted")]),
      );
      rows.push(...buildIndentedRows(`${item.key}-error-content`, wrappedRows, width, 2));
    }
    return rows;
  }

  rows.push(
    ...buildPrefixedContentRows(
      `${item.key}-system`,
      [createSpan("• ", "info")],
      [createSpan("  ", "info")],
      [createSpan(sanitizeTerminalOutput(event.title), "text")],
      width,
    ),
  );

  // Show the full content — not just the first line.  System events carry
  // rich multi-line payloads: /help output, auth status, model listings,
  // workspace summaries, etc.  Limiting to line 1 silently hides all of it.
  const systemContentLines = sanitizeTerminalOutput(event.content)
    .split("\n")
    .filter((line) => line.trim());
  if (systemContentLines.length > 0) {
    const wrappedRows = systemContentLines.flatMap((line) =>
      wrapPlainText(line, Math.max(1, width - 2)).map((row) => [createSpan(row || " ", "dim")]),
    );
    rows.push(...buildIndentedRows(`${item.key}-system-content`, wrappedRows, width, 2));
  }

  return rows;
}

/**
 * Startup header rows. "tiny" mode prints only text lines; otherwise a logo
 * (large mode: best fitting variant; compact mode: the one-line mark) is laid
 * out beside the metadata when it fits, or stacked above it, followed by one
 * blank gap row.
 */
export function buildIntroRows(
  item: Extract<RenderTimelineItem, { type: "intro" }>,
  width: number,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const { intro } = item;
  const safeWidth = Math.max(1, width);
  const startupHeaderMode =
    intro.startupHeaderMode ?? (intro.layoutMode === "expanded" ? "large" : "compact");

  // Compact branding styles (`minimal`, `simple`) have their own renderers and
  // stay readable across narrow and wide terminals; `normal` keeps the
  // historical ASCII logo layout below with its "tiny" fallback.
  const compactRows = buildCompactStartupRows(item, safeWidth);
  if (compactRows) {
    return compactRows;
  }

  const workspaceName = getWorkspaceDisplayName(intro.workspaceLabel);
  if (intro.headerLayout) {
    const plan = intro.headerLayout;
    const metadata = [
      `Ubume v${intro.version}`,
      workspaceName ? `Workspace: ${workspaceName}` : null,
      intro.providerLabel ? `Provider: ${intro.providerLabel}` : `Auth: ${intro.authLabel}`,
    ].filter((line): line is string => Boolean(line));
    // With two rows, retain identity and provider; the directory yields first.
    const selected =
      plan.metadataRows === 2
        ? [metadata[0]!, metadata.at(-1)!]
        : metadata.slice(0, plan.metadataRows);
    const logo =
      plan.logo === "identity" ? LOGO_COMPACT : plan.size ? wordmarkArt(plan.size.rows) : [];
    const top =
      plan.arrangement === "stacked"
        ? logo.length
        : Math.max(0, Math.floor((logo.length - selected.length) / 2));
    const count = plan.totalRows - plan.topRows - plan.bottomRows;
    for (let i = 0; i < plan.topRows; i++)
      rows.push(createBlankRow(`${item.key}-top-gap-${i}`, safeWidth));
    for (let row = 0; row < count; row++) {
      const line = logo[row];
      const metadataIndex = row - top;
      const text = selected[metadataIndex];
      const spans: TimelineRowSpan[] = [];
      if (line !== undefined)
        spans.push(
          createSpan(
            line,
            plan.logo === "identity"
              ? "accent"
              : (["logoPrimary", "logoSecondary", "logoShadow"][
                  wordmarkBand(row, logo.length)
                ] as TimelineTone),
          ),
        );
      if (plan.arrangement === "beside" && plan.size)
        spans.push(
          createSpan(
            " ".repeat(Math.max(0, plan.size.columns - getTextWidth(line ?? "")) + plan.size.gap),
          ),
        );
      if (text !== undefined)
        spans.push(
          createSpan(
            clampVisualText(
              sanitizeTerminalOutput(text).replace(/[\r\n\u2028\u2029]/g, " "),
              plan.metadataWidth,
            ),
            metadataIndex === 0 ? "text" : "muted",
            { bold: metadataIndex === 0 },
          ),
        );
      rows.push(createRow(`${item.key}-intro-row-${row}`, spans, safeWidth));
    }
    for (let i = 0; i < plan.bottomRows; i++)
      rows.push(createBlankRow(`${item.key}-gap-${i}`, safeWidth));
    return rows;
  }
  if (startupHeaderMode === "tiny") {
    const messageRows = [
      `Ubume v${intro.version}`,
      workspaceName ? `Workspace: ${workspaceName}` : null,
      intro.providerLabel ? `Provider: ${intro.providerLabel}` : `Auth: ${intro.authLabel}`,
    ].filter((line): line is string => Boolean(line));
    messageRows.forEach((line, index) => {
      rows.push(
        createRow(
          `${item.key}-resize-${index}`,
          [
            createSpan(clampVisualText(line, safeWidth), index === 0 ? "text" : "muted", {
              bold: index === 0,
            }),
          ],
          safeWidth,
        ),
      );
    });
    return rows;
  }

  // Compact startup mode deliberately uses the one-line mark even when the
  // terminal is wide: its row budget is what made the full logo unsafe.
  const logoRows =
    startupHeaderMode === "large"
      ? selectLogoVariant(safeWidth)
      : safeWidth >= LOGO_COMPACT_MIN_COLS
        ? LOGO_COMPACT
        : [];
  const effectiveLogoRows = logoRows.length > 0 ? logoRows : ["UBUME"];
  if (startupHeaderMode === "large") {
    rows.push(createBlankRow(`${item.key}-top-gap`, safeWidth));
  }
  const logoWidth = effectiveLogoRows.reduce(
    (maxWidth, line) => Math.max(maxWidth, getTextWidth(line)),
    0,
  );
  const metaLines = [
    `Ubume v${intro.version}`,
    workspaceName ? `Workspace: ${workspaceName}` : null,
    intro.providerLabel ? `Provider: ${intro.providerLabel}` : `Auth: ${intro.authLabel}`,
  ].filter((line): line is string => Boolean(line));
  const gapWidth = 2;
  const widestMetaLine = metaLines.reduce(
    (maxWidth, line) => Math.max(maxWidth, getTextWidth(line)),
    0,
  );
  const canRenderSideBySide =
    metaLines.length > 0 && safeWidth >= logoWidth + gapWidth + widestMetaLine;

  if (canRenderSideBySide) {
    const metaStartRow = Math.max(0, Math.floor((effectiveLogoRows.length - metaLines.length) / 2));
    const rowCount = Math.max(effectiveLogoRows.length, metaStartRow + metaLines.length);
    const metaWidth = Math.max(1, safeWidth - logoWidth - gapWidth);

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const logoLine = effectiveLogoRows[rowIndex] ?? "";
      const logoPadding = Math.max(0, logoWidth - getTextWidth(logoLine));
      const metaIndex = rowIndex - metaStartRow;
      const metaLine =
        metaIndex >= 0 && metaIndex < metaLines.length
          ? sanitizeTerminalOutput(metaLines[metaIndex]!)
          : "";
      let logoTone: TimelineTone = "logoPrimary";
      if (effectiveLogoRows.length === 6) {
        if (rowIndex === 2 || rowIndex === 3) logoTone = "logoSecondary";
        else if (rowIndex === 4 || rowIndex === 5) logoTone = "logoShadow";
      } else if (effectiveLogoRows === LOGO_COMPACT) {
        logoTone = "accent";
      }
      // No bold on logo spans — bold on block/box-drawing chars causes spacing artifacts.
      const spans = [
        createSpan(`${logoLine}${" ".repeat(logoPadding)}`, logoTone),
        createSpan(" ".repeat(gapWidth)),
      ];

      if (metaLine) {
        spans.push(
          createSpan(clampVisualText(metaLine, metaWidth), metaIndex === 0 ? "text" : "muted", {
            bold: metaIndex === 0,
          }),
        );
      }

      rows.push(createRow(`${item.key}-intro-row-${rowIndex}`, spans, safeWidth));
    }
  } else {
    effectiveLogoRows.forEach((line, index) => {
      let logoTone: TimelineTone = "logoPrimary";
      if (effectiveLogoRows.length === 6) {
        if (index === 2 || index === 3) logoTone = "logoSecondary";
        else if (index === 4 || index === 5) logoTone = "logoShadow";
      } else if (effectiveLogoRows === LOGO_COMPACT) {
        logoTone = "accent";
      }
      rows.push(
        createRow(
          `${item.key}-logo-${index}`,
          [createSpan(clampVisualText(line, safeWidth), logoTone)],
          safeWidth,
        ),
      );
    });

    metaLines.forEach((line, index) => {
      const wrapped = wrapPlainText(sanitizeTerminalOutput(line), safeWidth);
      wrapped.forEach((row, rowIndex) => {
        rows.push(
          createRow(
            `${item.key}-meta-${index}-${rowIndex}`,
            [createSpan(row || " ", index === 0 ? "text" : "muted", { bold: index === 0 })],
            safeWidth,
          ),
        );
      });
    });
  }

  rows.push(createBlankRow(`${item.key}-gap`, safeWidth));
  return rows;
}

/** Last path segment of the workspace label (handles both `/` and `\`). */
function getWorkspaceDisplayName(workspaceLabel: string): string {
  const sanitized = sanitizeTerminalOutput(workspaceLabel).trim();
  if (!sanitized) return "";
  const segments = sanitized
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments[segments.length - 1] ?? sanitized;
}
