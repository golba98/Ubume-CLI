/**
 * Row builders for a turn's unified stream (reasoning, actions, response
 * segments, plans), turn assembly (`buildTurnRows`), and the stream-shaping
 * transforms that keep live turns stable.
 *
 * Live-turn invariants (pinned by `streamingHeightStability.test.ts` and
 * `liveTurnOrderStability.test.ts`): while a run is `running`, its measured
 * height may only grow and its block order must be append-only. A shrink or an
 * insert-above lets the bottom-anchored viewport / live window re-reveal
 * content the user already scrolled past. Hence:
 * - `collectStreamEvents` hides reasoning blocks until the run finishes;
 * - `compactActionBursts` (height-reducing) only runs for finished runs;
 * - row keys derive from `streamSeq`, never array position.
 *
 * Caching: block rows go through `_streamingBlockRowCache` (LRU, content-token
 * keys), finished action rows through `_completedActionRowCache`, summary
 * cards through the frozen row-group cache, and action descriptors through
 * `_actionDisplayCache` — all from `caches.ts`.
 */
import * as renderDebug from "../../../core/perf/renderDebug.js";
import {
  clampVisualText,
  formatDuration,
  getTextWidth,
  wrapPlainText,
} from "../../../core/shared/text.js";
import { sanitizeTerminalOutput } from "../../../core/terminal/terminalSanitize.js";
import { normalizePlanReviewMarkdown } from "../../../core/workspace/planStorage.js";
import { RUN_OUTPUT_TRUNCATION_NOTICE } from "../../../session/chatLifecycle.js";
import type {
  RunEvent,
  RunProgressBlock,
  RunResponseSegment,
  RunToolActivity,
} from "../../../session/types.js";
import {
  getAssistantContent,
  getResponseSegmentText,
  getRunPlanText,
} from "../../../session/types.js";
import { transcriptContentIndent } from "../../layout.js";
import { parseMarkdown } from "../../render/Markdown.js";
import { formatProgressBlockBodyLines } from "../progressEntries.js";
import {
  coalesceConsecutiveThinking,
  getFriendlyActionLabel,
  normalizeCommand,
} from "../runActivityView.js";
import {
  _actionDisplayCache,
  _completedActionRowCache,
  _completedActionTokenById,
  _streamingBlockRowCache,
  getCachedFrozenRows,
  getCachedStreamingBlockRows,
  rowCacheKey,
  textCacheToken,
} from "./caches.js";
import { buildDashCardRows, buildImpactSummaryRows, buildUserInputRows } from "./cards.js";
import { buildActionRequiredRows, buildFileScanRows } from "./eventRows.js";
import { buildMarkdownRows } from "./markdownRows.js";
import { createBlankRow, createRow, createSpan } from "./rows.js";
import type {
  ActionDisplayDescriptor,
  StreamEvent,
  TimelineRow,
  TimelineRowSpan,
  TimelineTone,
  TurnRenderItem,
} from "./types.js";

const COMPACT_PROCESSING_BODY_LINE_CAP = 4;

const VISIBLE_THINKING_SOURCES = new Set(["reasoning", "todo"]);

/**
 * Re-tone rows for a turn's opacity. "active" returns `rows` unchanged;
 * "recent" downgrades active borders; "dim" also mutes text/accent tones.
 * Action rows (key contains `-action-`) are left as-is. Non-active opacities
 * return new row objects; only tones change, never the row count.
 */
export function applyTurnOpacity(
  rows: TimelineRow[],
  opacity: "active" | "recent" | "dim",
): TimelineRow[] {
  if (opacity === "active") {
    return rows;
  }

  if (opacity === "recent") {
    return rows.map((row) => {
      if (row.key.includes("-action-")) return row;
      return {
        ...row,
        spans: row.spans.map((span) => {
          if (span.tone === "borderActive") {
            return { ...span, tone: "borderSubtle" as TimelineTone };
          }
          return { ...span };
        }),
      };
    });
  }

  return rows.map((row) => {
    if (row.key.includes("-action-")) return row;
    return {
      ...row,
      spans: row.spans.map((span) => {
        if (
          span.tone === "text" ||
          span.tone === "muted" ||
          span.tone === "info" ||
          span.tone === "warning"
        ) {
          return { ...span, tone: "dim" as TimelineTone };
        }
        if (span.tone === "accent") {
          return { ...span, tone: "muted" as TimelineTone };
        }
        if (span.tone === "borderActive") {
          return { ...span, tone: "borderSubtle" as TimelineTone };
        }
        return { ...span };
      }),
    };
  });
}

const ACTION_COMPACT_KEEP_HEAD = 2;

const ACTION_COMPACT_KEEP_TAIL = 2;

const ACTION_COMPACT_MIN_COUNT = ACTION_COMPACT_KEEP_HEAD + ACTION_COMPACT_KEEP_TAIL + 2;

function getCompactableActionLabel(event: StreamEvent): string | null {
  if (event.kind !== "action") return null;
  if (event.tool.status !== "completed") return null;
  const label = getFriendlyActionLabel(normalizeCommand(event.tool.command));
  return label === "Read file" || label === "List files" ? label : null;
}

/**
 * Collapse bursts of same-label completed action cards into a single summary
 * line. This is a *height-reducing* transform, so it must only run for a
 * FINISHED turn: applying it while the run is still live shrinks the turn's
 * total height mid-stream, and the bottom-anchored viewport then re-reveals
 * earlier (already-scrolled-off) content — the "old states come back" glitch.
 *
 * Callers pass `finalized = run.status !== "running"`. We deliberately key off
 * `run.status` rather than the render phase: `resolveTurnRunPhase` reports
 * "final" during the ANSWER_VISIBLE window while the run is still running, so a
 * phase-based gate would compact during that intermediate, still-active frame.
 */
export function compactActionBursts(
  events: StreamEvent[],
  verbose: boolean,
  finalized: boolean,
): StreamEvent[] {
  if (verbose || !finalized) return events;

  const compacted: StreamEvent[] = [];
  for (let index = 0; index < events.length; ) {
    const label = getCompactableActionLabel(events[index]!);
    if (!label) {
      compacted.push(events[index]!);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < events.length && getCompactableActionLabel(events[end]!) === label) {
      end += 1;
    }

    const group = events.slice(index, end);
    if (group.length < ACTION_COMPACT_MIN_COUNT) {
      compacted.push(...group);
      index = end;
      continue;
    }

    const hidden = group.slice(ACTION_COMPACT_KEEP_HEAD, group.length - ACTION_COMPACT_KEEP_TAIL);
    compacted.push(...group.slice(0, ACTION_COMPACT_KEEP_HEAD));
    compacted.push({
      kind: "actionSummary",
      streamSeq:
        hidden[0]?.streamSeq ?? group[ACTION_COMPACT_KEEP_HEAD]?.streamSeq ?? group[0]!.streamSeq,
      id: `${label.toLowerCase().replace(/\s+/g, "-")}-${group[0]!.streamSeq}-${group[group.length - 1]!.streamSeq}`,
      label,
      count: hidden.length,
    });
    compacted.push(...group.slice(group.length - ACTION_COMPACT_KEEP_TAIL));
    index = end;
  }

  return compacted;
}

// ─── Codex stream block builders ─────────────────────────────────────────────

// Borderless block: a bold label row ("Ubume", "Reasoning", …) then content
// rows, all indented by transcriptContentIndent.
function buildCodexPlainRows(
  keyPrefix: string,
  width: number,
  contentRows: TimelineRowSpan[][],
  label = "Ubume",
): TimelineRow[] {
  const indent = " ".repeat(transcriptContentIndent);
  const rows: TimelineRow[] = [
    createRow(
      `${keyPrefix}-label`,
      [createSpan(indent), createSpan(label, "muted", { bold: true })],
      width,
    ),
  ];

  contentRows.forEach((row, index) => {
    rows.push(
      createRow(
        `${keyPrefix}-content-${index}`,
        [createSpan(indent), ...(row.length > 0 ? row : [createSpan(" ")])],
        width,
      ),
    );
  });

  return rows;
}

/**
 * "Reasoning" block rows. Compact mode shows at most 4 body lines plus a
 * "… (N more lines)" row; verbose shows everything.
 */
export function buildCodexThinkingRows(params: {
  keyPrefix: string;
  width: number;
  event: Extract<StreamEvent, { kind: "thinking" }>;
  verbose: boolean;
}): TimelineRow[] {
  renderDebug.traceRender("ThinkingBlock", params.event.block.status, {
    keyPrefix: params.keyPrefix,
    streamSeq: params.event.streamSeq,
    textLength: params.event.block.text.length,
  });

  const block = params.event.block;
  const cacheKey = rowCacheKey([
    "thinking",
    params.keyPrefix,
    block.id,
    block.status,
    block.updatedAt,
    textCacheToken(block.text),
    params.width,
    params.verbose,
  ]);

  return getCachedStreamingBlockRows(cacheKey, () => {
    const contentRows: TimelineRowSpan[][] = [];
    const contentWidth = Math.max(1, params.width - transcriptContentIndent);
    const bodyLines = formatProgressBlockBodyLines(params.event.block.text, contentWidth);
    const lineCap = params.verbose ? bodyLines.length : COMPACT_PROCESSING_BODY_LINE_CAP;
    const visibleBodyLines = bodyLines.slice(0, lineCap);
    const overflowCount = bodyLines.length - visibleBodyLines.length;

    visibleBodyLines.forEach((line) => {
      contentRows.push([createSpan(line || " ", "dim")]);
    });

    if (overflowCount > 0) {
      contentRows.push([
        createSpan(`… (${overflowCount} more line${overflowCount === 1 ? "" : "s"})`, "dim"),
      ]);
    }

    return buildCodexPlainRows(params.keyPrefix, params.width, contentRows, "Reasoning");
  });
}

// Serialized descriptor: the action-row cache key and descriptor-equality check.
function actionDisplayToken(descriptor: ActionDisplayDescriptor): string {
  return rowCacheKey([
    descriptor.id,
    descriptor.status,
    descriptor.label,
    descriptor.command,
    descriptor.duration,
    descriptor.summary,
    descriptor.icon,
    descriptor.iconTone,
    descriptor.showLiveCursor,
    descriptor.borderTone,
    descriptor.width,
    descriptor.verbose,
  ]);
}

function getActionDisplayDescriptor(params: {
  keyPrefix: string;
  tool: RunToolActivity;
  width: number;
  verbose: boolean;
  isLive: boolean;
  borderTone: TimelineTone;
}): ActionDisplayDescriptor {
  // Strip ANSI/control sequences before measuring or wrapping: string-width only
  // collapses *complete* escape sequences, so leftover bytes would otherwise be
  // counted (and wrapped) character-by-character and corrupt the card width.
  const command = normalizeCommand(sanitizeTerminalOutput(params.tool.command));
  const label = getFriendlyActionLabel(command);
  // Bare label (no leading gap) — the head-row builder right-aligns it and owns
  // the spacing, so the gap can never get baked into a width calculation.
  const duration =
    params.tool.completedAt != null
      ? formatDuration(params.tool.completedAt - params.tool.startedAt)
      : "";
  const summary = params.verbose ? (params.tool.summary ?? "") : "";
  const showLiveCursor = params.isLive && params.tool.status === "running";
  const descriptor: ActionDisplayDescriptor = {
    id: params.tool.id,
    status: params.tool.status,
    label,
    command,
    duration,
    summary,
    icon: params.tool.status === "failed" ? "✕" : params.tool.status === "completed" ? "✓" : "•",
    iconTone:
      params.tool.status === "failed"
        ? "error"
        : params.tool.status === "completed"
          ? "success"
          : "info",
    showLiveCursor,
    borderTone: params.borderTone,
    width: params.width,
    verbose: params.verbose,
  };
  const cacheKey = `${params.keyPrefix}:${params.tool.id}`;
  const cached = _actionDisplayCache.get(cacheKey);
  if (cached && actionDisplayToken(cached) === actionDisplayToken(descriptor)) {
    return cached;
  }
  _actionDisplayCache.set(cacheKey, descriptor);
  return descriptor;
}

// Single uncached row used when the plain-actions render debug flag is on.
function buildPlainActionDebugRows(params: {
  keyPrefix: string;
  width: number;
  descriptor: ActionDisplayDescriptor;
}): TimelineRow[] {
  const statusText = params.descriptor.label
    ? `${params.descriptor.label}: ${params.descriptor.command}`
    : params.descriptor.command;
  const suffix = params.descriptor.duration ? `  ${params.descriptor.duration}` : "";
  const text = clampVisualText(
    `${params.descriptor.icon} ${statusText}${suffix}`,
    Math.max(1, params.width - 1),
  );
  renderDebug.traceEvent("action", "plainActionRow", {
    actionId: params.descriptor.id,
    status: params.descriptor.status,
    keyPrefix: params.keyPrefix,
    width: params.width,
  });
  return [
    createRow(
      `${params.keyPrefix}-plain`,
      [createSpan(text || " ", params.descriptor.iconTone)],
      params.width,
    ),
  ];
}

function compactActionText(descriptor: ActionDisplayDescriptor): string {
  const command = descriptor.command.replace(/^([a-z][a-z0-9_]*):\s+/i, "$1 ");
  return descriptor.label && command === descriptor.command
    ? `${descriptor.label} ${command}`
    : command;
}

// One `icon label command  duration  ▌` row (command clamped so the row never
// wraps), plus a detail row in verbose mode.
function buildCompactActionRows(params: {
  keyPrefix: string;
  width: number;
  descriptor: ActionDisplayDescriptor;
}): TimelineRow[] {
  const durationSuffix = params.descriptor.duration ? `  ${params.descriptor.duration}` : "";
  const liveSuffix = params.descriptor.showLiveCursor ? "  ▌" : "";
  const availableWidth = Math.max(
    1,
    params.width -
      getTextWidth(params.descriptor.icon) -
      1 -
      getTextWidth(durationSuffix) -
      getTextWidth(liveSuffix),
  );
  const text = clampVisualText(compactActionText(params.descriptor), availableWidth);
  const rows: TimelineRow[] = [
    createRow(
      `${params.keyPrefix}-plain`,
      [
        createSpan(`${params.descriptor.icon} `, params.descriptor.iconTone),
        createSpan(text || " ", "text"),
        ...(durationSuffix ? [createSpan(durationSuffix, "dim")] : []),
        ...(liveSuffix ? [createSpan(liveSuffix, "accent")] : []),
      ],
      params.width,
    ),
  ];

  if (params.descriptor.verbose) {
    const detail = params.descriptor.showLiveCursor
      ? "running"
      : params.descriptor.summary.trim() || "completed";
    rows.push(
      createRow(
        `${params.keyPrefix}-detail`,
        [
          createSpan("  "),
          createSpan(clampVisualText(detail, Math.max(1, params.width - 2)), "muted"),
        ],
        params.width,
      ),
    );
  }

  return rows;
}

/**
 * Rows for one tool call: a compact single line (plus a detail line in verbose
 * mode). Running actions are cached in the LRU streaming cache; finished ones
 * in the completed-action cache, both keyed by the descriptor token so any
 * visible change produces new rows. `borderTone` only feeds the cache token;
 * the compact row has no border.
 */
export function buildActionEventRows(params: {
  keyPrefix: string;
  width: number;
  event: Extract<StreamEvent, { kind: "action" }>;
  borderTone: TimelineTone;
  verbose: boolean;
  isLive: boolean;
}): TimelineRow[] {
  const tool = params.event.tool;
  const descriptor = getActionDisplayDescriptor({
    keyPrefix: params.keyPrefix,
    tool,
    width: params.width,
    verbose: params.verbose,
    isLive: params.isLive,
    borderTone: params.borderTone,
  });
  // Serialized once: it feeds the cache key and every trace payload below.
  const displayedToken = actionDisplayToken(descriptor);
  renderDebug.traceRender("ActionLog", params.event.tool.status, {
    keyPrefix: params.keyPrefix,
    streamSeq: params.event.streamSeq,
    isLive: params.isLive,
    commandLength: params.event.tool.command.length,
    displayedToken: displayedToken,
  });

  if (renderDebug.isPlainActionsDebugEnabled()) {
    return buildPlainActionDebugRows({
      keyPrefix: params.keyPrefix,
      width: params.width,
      descriptor,
    });
  }

  const cacheKey = rowCacheKey(["action", params.keyPrefix, displayedToken]);

  const isCompleted = tool.status !== "running";
  if (isCompleted) {
    const cached = _completedActionRowCache.get(cacheKey);
    const completedActionTokenKey = `${params.keyPrefix}:${tool.id}`;
    const previousCompletedToken = _completedActionTokenById.get(completedActionTokenKey);
    if (previousCompletedToken && previousCompletedToken !== displayedToken) {
      renderDebug.traceEvent("action", "completedSnapshotInvalidation", {
        actionId: tool.id,
        status: tool.status,
        rowKey: params.keyPrefix,
      });
    }
    renderDebug.traceFlickerEvent("actionRowBuild", {
      cache: cached ? "hit-completed" : "miss-completed",
      actionId: tool.id,
      status: tool.status,
      rowKey: params.keyPrefix,
      displayedToken,
    });
    if (cached) return cached;
  } else {
    const cached = _streamingBlockRowCache.get(cacheKey);
    renderDebug.traceFlickerEvent("actionRowBuild", {
      cache: cached ? "hit-streaming" : "miss-streaming",
      actionId: tool.id,
      status: tool.status,
      rowKey: params.keyPrefix,
      displayedToken: displayedToken,
    });
  }

  const buildActionRows = () =>
    buildCompactActionRows({
      keyPrefix: params.keyPrefix,
      width: params.width,
      descriptor,
    });

  if (isCompleted) {
    const rows = buildActionRows();
    _completedActionRowCache.set(cacheKey, rows);
    _completedActionTokenById.set(`${params.keyPrefix}:${tool.id}`, displayedToken);
    return rows;
  }

  return getCachedStreamingBlockRows(cacheKey, buildActionRows);
}

/** "action" card standing in for a compacted burst ("N repeated read activity summarized"). */
export function buildActionSummaryRows(params: {
  keyPrefix: string;
  width: number;
  event: Extract<StreamEvent, { kind: "actionSummary" }>;
  borderTone: TimelineTone;
}): TimelineRow[] {
  const label = params.event.label === "Read file" ? "read activity" : "list activity";
  const cacheKey = rowCacheKey([
    "action-summary",
    params.keyPrefix,
    params.width,
    params.event.id,
    params.event.label,
    params.event.count,
    params.borderTone,
  ]);

  return getCachedFrozenRows(cacheKey, () =>
    buildDashCardRows({
      keyPrefix: params.keyPrefix,
      width: params.width,
      title: "action",
      borderTone: params.borderTone,
      contentRows: [
        [
          createSpan("✓ ", "success"),
          createSpan(`${params.event.count} repeated ${label}`, "text"),
          createSpan(" summarized", "dim"),
        ],
      ],
    }),
  );
}

/**
 * "Ubume" response block: the segment parsed as markdown and laid out by
 * `buildMarkdownRows`, preceded by the run's failure message when the run
 * failed and this is the last event. Settled segments are cached by content
 * token; an active segment is rebuilt every call (the markdown parser and row
 * caches still reuse its unchanged prefix). Row keys contain
 * `-codex-response-`, which the viewport's finalize anchoring searches for.
 */
export function buildCodexResponseRows(params: {
  keyPrefix: string;
  width: number;
  run: RunEvent;
  event: Extract<StreamEvent, { kind: "response" }>;
  streaming: boolean;
  isLastEvent: boolean;
  isLive: boolean;
  verbose: boolean;
}): TimelineRow[] {
  // Join the chunks once; the trace payload below must not pay for a second join.
  const segmentText = getResponseSegmentText(params.event.segment);
  renderDebug.traceRender("ActiveMessage", params.event.segment.status, {
    keyPrefix: params.keyPrefix,
    streamSeq: params.event.streamSeq,
    streaming: params.streaming,
    isLive: params.isLive,
    chunkCount: params.event.segment.chunks.length,
    textLength: segmentText.length,
  });

  const segmentStreaming = params.event.segment.status === "active";

  const buildRows = (): TimelineRow[] => {
    let responseRows: TimelineRowSpan[][] = [];
    const contentWidth = Math.max(1, params.width - transcriptContentIndent);
    const segments = parseMarkdown(segmentText, {
      streaming: segmentStreaming,
      cacheKey: `${params.keyPrefix}:${params.event.segment.id}`,
    });
    responseRows = buildMarkdownRows(segments, contentWidth);

    if (!params.streaming && params.run.status === "failed" && params.isLastEvent) {
      const failureMessage = sanitizeTerminalOutput(params.run.errorMessage ?? params.run.summary);
      const failureRows: TimelineRowSpan[][] = [];
      wrapPlainText(failureMessage, Math.max(1, contentWidth - 2)).forEach((row, index) => {
        failureRows.push([
          createSpan(index === 0 ? "✕ " : "  ", "error"),
          createSpan(row || " ", "error"),
        ]);
      });
      responseRows = [...failureRows, ...responseRows];
    }

    return buildCodexPlainRows(params.keyPrefix, params.width, responseRows);
  };

  if (!segmentStreaming) {
    const failureMessage =
      !params.streaming && params.run.status === "failed" && params.isLastEvent
        ? (params.run.errorMessage ?? params.run.summary)
        : "";
    const cacheKey = rowCacheKey([
      "response",
      params.keyPrefix,
      params.event.segment.id,
      params.event.segment.status,
      textCacheToken(segmentText),
      params.width,
      params.verbose,
      params.streaming,
      params.run.status,
      params.isLastEvent,
      textCacheToken(failureMessage),
    ]);
    return getCachedStreamingBlockRows(cacheKey, buildRows);
  }

  return buildRows();
}

// ─── Plan & unified stream rendering ─────────────────────────────────────────

/** "Plan" dash card with the plan rendered as markdown; badge "approved" once approved. Not cached here. */
export function buildApprovedPlanRows(params: {
  keyPrefix: string;
  width: number;
  planText: string;
  approved: boolean;
  workspaceRoot?: string | null;
}): TimelineRow[] {
  const contentWidth = Math.max(1, params.width - 4);
  const normalized = normalizePlanReviewMarkdown(params.planText, params.workspaceRoot);
  const formatted = parseMarkdown(normalized);
  const contentRows = buildMarkdownRows(formatted, contentWidth);

  return buildDashCardRows({
    keyPrefix: params.keyPrefix,
    width: params.width,
    title: "Plan",
    rightBadge: params.approved ? "approved" : undefined,
    borderTone: "accent",
    titleTone: "text",
    badgeTone: "success",
    contentRows,
  });
}

// All stream events of a turn separated by gap rows, plus — once the run has
// finished — the cancel notice, truncation notice and impact summary (or the
// file-scan card in verbose mode).
function buildUnifiedStreamRows(
  item: TurnRenderItem,
  width: number,
  options: { verbose?: boolean; workspaceRoot?: string | null },
): TimelineRow[] {
  const run = item.item.run!;
  const streaming = item.renderState.runPhase === "streaming";
  const actionBorderTone = item.renderState.opacity === "dim" ? "borderSubtle" : "borderActive";
  const verbose = options.verbose ?? false;
  const finalized = run.status !== "running";
  const events = compactActionBursts(collectStreamEvents(item), verbose, finalized);

  const rows: TimelineRow[] = [];

  events.forEach((event, index) => {
    const isLastEvent = index === events.length - 1;
    const isLive = run.status === "running" && isLastEvent; // The cursor is on the last event

    if (index > 0) {
      // Key the gap by the stable creation-order streamSeq, not the array
      // index, so gaps don't remount/reorder when the event set changes.
      rows.push(createBlankRow(`${item.key}-stream-gap-${event.streamSeq}`, width));
    }

    if (event.kind === "thinking") {
      rows.push(
        ...buildCodexThinkingRows({
          keyPrefix: `${item.key}-codex-thinking-${event.streamSeq}`,
          width,
          event,
          verbose,
        }),
      );
    } else if (event.kind === "action") {
      rows.push(
        ...buildActionEventRows({
          keyPrefix: `${item.key}-action-${event.streamSeq}`,
          width,
          event,
          borderTone: actionBorderTone,
          verbose,
          isLive,
        }),
      );
    } else if (event.kind === "actionSummary") {
      rows.push(
        ...buildActionSummaryRows({
          keyPrefix: `${item.key}-action-summary-${event.streamSeq}`,
          width,
          event,
          borderTone: actionBorderTone,
        }),
      );
    } else if (event.kind === "response") {
      rows.push(
        ...buildCodexResponseRows({
          keyPrefix: `${item.key}-codex-response-${event.streamSeq}`,
          width,
          run,
          event,
          streaming,
          isLastEvent,
          isLive,
          verbose,
        }),
      );
    } else if (event.kind === "plan") {
      rows.push(
        ...buildApprovedPlanRows({
          keyPrefix: `${item.key}-plan-${event.streamSeq}`,
          width,
          planText: event.planText,
          approved: event.approved,
          workspaceRoot: options.workspaceRoot,
        }),
      );
    }
  });

  if (!streaming && finalized) {
    if (run.status === "canceled") {
      rows.push(createBlankRow(`${item.key}-cancel-gap`, width));
      rows.push(
        ...buildCodexPlainRows(
          `${item.key}-cancel`,
          width,
          wrapPlainText(sanitizeTerminalOutput(run.summary), width).map((wrapped) => [
            createSpan(wrapped || " ", "warning"),
          ]),
        ),
      );
    } else if (
      run.status === "completed" &&
      !events.some(
        (event) => event.kind === "response" && getResponseSegmentText(event.segment).trim(),
      )
    ) {
      // Keep empty completed turns quiet.
    }

    if (run.truncatedOutput) {
      rows.push(
        ...buildCodexPlainRows(`${item.key}-truncated`, width, [
          [createSpan(RUN_OUTPUT_TRUNCATION_NOTICE, "dim")],
        ]),
      );
    }

    if (verbose) {
      if (run.touchedFileCount > 0) {
        const fileScanRows = buildFileScanRows(item, width);
        if (fileScanRows.length > 0) {
          rows.push(createBlankRow(`${item.key}-files-gap`, width));
          rows.push(...fileScanRows);
        }
      }
    } else {
      const impactRows = buildImpactSummaryRows(item, width);
      if (impactRows.length > 0) {
        rows.push(createBlankRow(`${item.key}-impact-gap`, width));
        rows.push(...impactRows);
      }
    }
  }

  return rows;
}

/**
 * Resolve a run's `streamItems` into ordered `StreamEvent`s (by `streamSeq`),
 * with fallbacks for legacy sessions without stream items and for a first
 * render that only has assistant text. Reasoning is withheld while the run is
 * live (see the comment below); consecutive reasoning blocks are coalesced.
 */
export function collectStreamEvents(item: TurnRenderItem): StreamEvent[] {
  const run = item.item.run!;
  const assistant = item.item.assistant;
  const streaming = item.renderState.runPhase === "streaming";
  const blocksById = new Map<string, RunProgressBlock>();
  for (const entry of run.progressEntries ?? []) {
    for (const block of entry.blocks) blocksById.set(block.id, block);
  }
  const toolsById = new Map(run.toolActivities.map((tool) => [tool.id, tool] as const));
  const segmentsById = new Map((run.responseSegments ?? []).map((seg) => [seg.id, seg] as const));

  const events: StreamEvent[] = [];
  const sortedItems = (run.streamItems ?? []).slice().sort((a, b) => a.streamSeq - b.streamSeq);
  for (const it of sortedItems) {
    if (it.kind === "thinking") {
      // Active-turn topology stability: while the run is live we never surface
      // reasoning blocks. A thinking block is assigned its streamSeq early (when
      // its reasoning first streams) but only *completes* later — revealing it
      // mid-stream slots it in at that early streamSeq, ABOVE answer/action
      // blocks that have already streamed at higher streamSeqs. That late
      // insert-above is what reorders the live turn. Defer all reasoning to
      // finalize, where the full streamSeq order (reasoning included) reflows
      // atomically. (Height grows when it appears — never shrinks mid-stream.)
      if (run.status !== "running") {
        const block = blocksById.get(it.refId);
        if (block && block.text.trim().length > 0) {
          events.push({
            kind: "thinking",
            streamSeq: it.streamSeq,
            block,
          });
        }
      }
    } else if (it.kind === "action") {
      const tool = toolsById.get(it.refId);
      if (tool) events.push({ kind: "action", streamSeq: it.streamSeq, tool });
    } else if (it.kind === "response") {
      const segment = segmentsById.get(it.refId);
      if (segment) events.push({ kind: "response", streamSeq: it.streamSeq, segment });
    } else if (it.kind === "plan") {
      const planText =
        run.plan?.id === it.refId ? getRunPlanText(run.plan) : (run.approvedPlan ?? "");
      if (planText.trim()) {
        events.push({
          kind: "plan",
          streamSeq: it.streamSeq,
          planText,
          approved: Boolean(run.approvedPlan),
        });
      }
    }
  }

  // Backward-compat fallback for older session data that predates streamItems.
  // New runs always use the streamItems path above.
  if (events.length === 0 && sortedItems.length === 0) {
    let legacySeq = 0;
    for (const entry of run.progressEntries ?? []) {
      if (!VISIBLE_THINKING_SOURCES.has(entry.source)) continue;
      for (const block of entry.blocks) {
        if (!block.text.trim()) continue;
        // Same active-turn topology rule as the streamItems path: defer all
        // reasoning while the run is live so it cannot insert above already
        // streamed answer/action blocks. Reveal only once finalized.
        if (run.status === "running") continue;
        legacySeq += 1;
        events.push({
          kind: "thinking",
          streamSeq: legacySeq,
          block,
        });
      }
    }

    for (const tool of run.toolActivities ?? []) {
      legacySeq += 1;
      events.push({ kind: "action", streamSeq: legacySeq, tool });
    }

    for (const segment of run.responseSegments ?? []) {
      if (!getResponseSegmentText(segment).trim() && !streaming) continue;
      legacySeq += 1;
      events.push({ kind: "response", streamSeq: legacySeq, segment });
    }
  }

  // First-render fallback: nothing resolvable yet but assistant text exists.
  if (events.length === 0 && (getAssistantContent(assistant).length > 0 || streaming)) {
    const synthetic: RunResponseSegment = {
      id: `synthetic-${run.id}`,
      streamSeq: 1,
      chunks: [getAssistantContent(assistant)],
      status: streaming ? "active" : "completed",
      startedAt: run.startedAt,
    };
    events.push({ kind: "response", streamSeq: 1, segment: synthetic });
  }

  return coalesceConsecutiveThinking(events);
}

// ─── Turn assembly & static caching ──────────────────────────────────────────

/**
 * Complete rows for one turn at `width`: prompt card, gap, unified stream
 * (when there is a run), question card, end gap — re-toned for the turn's
 * opacity. Used by the `Timeline` snapshot builders; `TranscriptShell` instead
 * assembles turns per event in `nativeTranscript.ts`.
 */
export function buildTurnRows(
  item: TurnRenderItem,
  width: number,
  options: { verbose?: boolean; workspaceRoot?: string | null } = {},
): TimelineRow[] {
  const rows: TimelineRow[] = [];

  rows.push(...buildUserInputRows(item, width));
  rows.push(createBlankRow(`${item.key}-prompt-gap`, width));

  if (item.item.run) {
    rows.push(...buildUnifiedStreamRows(item, width, options));
  }

  rows.push(...buildActionRequiredRows(item, width));
  rows.push(createBlankRow(`${item.key}-turn-end-gap`, width));
  return applyTurnOpacity(rows, item.renderState.opacity);
}

/**
 * Rows for a single stream event (no gap rows). `forceStable` renders a
 * response segment as if completed, so a block that is not the live one never
 * shows streaming-only state and hits the settled-response cache.
 */
export function buildStreamEventRows(params: {
  item: TurnRenderItem;
  event: StreamEvent;
  isLive: boolean;
  isLastEvent: boolean;
  innerWidth: number;
  verbose: boolean;
  workspaceRoot?: string | null;
  forceStable?: boolean;
}): TimelineRow[] {
  const { item, event, innerWidth, verbose } = params;
  const run = item.item.run!;
  const streaming = item.renderState.runPhase === "streaming";
  const actionBorderTone = item.renderState.opacity === "dim" ? "borderSubtle" : "borderActive";
  const rows: TimelineRow[] = [];

  if (event.kind === "thinking") {
    rows.push(
      ...buildCodexThinkingRows({
        keyPrefix: `${item.key}-codex-thinking-${event.streamSeq}`,
        width: innerWidth,
        event,
        verbose,
      }),
    );
  } else if (event.kind === "action") {
    rows.push(
      ...buildActionEventRows({
        keyPrefix: `${item.key}-action-${event.streamSeq}`,
        width: innerWidth,
        event,
        borderTone: actionBorderTone,
        verbose,
        isLive: params.isLive,
      }),
    );
  } else if (event.kind === "actionSummary") {
    rows.push(
      ...buildActionSummaryRows({
        keyPrefix: `${item.key}-action-summary-${event.streamSeq}`,
        width: innerWidth,
        event,
        borderTone: actionBorderTone,
      }),
    );
  } else if (event.kind === "response") {
    const stableEvent = params.forceStable
      ? { ...event, segment: { ...event.segment, status: "completed" as const } }
      : event;
    rows.push(
      ...buildCodexResponseRows({
        keyPrefix: `${item.key}-codex-response-${event.streamSeq}`,
        width: innerWidth,
        run,
        event: stableEvent,
        streaming,
        isLastEvent: params.isLastEvent,
        isLive: params.isLive,
        verbose,
      }),
    );
  } else if (event.kind === "plan") {
    rows.push(
      ...buildApprovedPlanRows({
        keyPrefix: `${item.key}-plan-${event.streamSeq}`,
        width: innerWidth,
        planText: event.planText,
        approved: event.approved,
        workspaceRoot: params.workspaceRoot,
      }),
    );
  }

  return rows;
}
