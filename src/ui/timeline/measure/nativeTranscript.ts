/**
 * Measurement for the production transcript (`TranscriptShell`), which splits
 * output into Ink `<Static>` items (printed once into native scrollback) and
 * live rows (re-rendered each flush).
 *
 * Placement rule: a finalized turn emits one static item per block (prompt,
 * each stream event, gaps); a running turn emits *everything* — prompt,
 * blocks, question card, gaps — as live rows, and moves to `<Static>` only
 * once it finalizes. Non-turn items (intro, standalone events) are always
 * static and are measured via `buildTimelineSnapshot`. Row keys use
 * `streamSeq`, not array index, so they stay stable as events arrive.
 *
 * The finalized-turn half is incrementally cached by `staticTranscriptCache.ts`;
 * row-level caching comes from the shared `measure/` caches.
 */
import * as renderDebug from "../../../core/perf/renderDebug.js";
import type { RunEvent } from "../../../session/types.js";
import { buildUserInputRows } from "./cards.js";
import { buildActionRequiredRows } from "./eventRows.js";
import { createBlankRow, wrapRows } from "./rows.js";
import { buildTimelineSnapshot } from "./stableSnapshot.js";
import { buildStreamEventRows, collectStreamEvents, compactActionBursts } from "./streamRows.js";
import type {
  NativeTranscriptParts,
  RenderTimelineItem,
  StreamEvent,
  TimelineRow,
  TurnRenderItem,
} from "./types.js";

// ─── Native transcript builders ───────────────────────────────────────────────

/**
 * Whether `event` is the block currently being produced (and so gets a live
 * indicator): the running tool, the active response segment, or an active
 * plan. Always false once the run has finished.
 */
function isNativeLiveStreamEvent(event: StreamEvent, run: RunEvent): boolean {
  if (run.status !== "running") return false;
  if (event.kind === "action") return event.tool.status === "running";
  if (event.kind === "response") return event.segment.id === (run.activeResponseSegmentId ?? null);
  if (event.kind === "plan") return run.plan?.status === "active";
  return false;
}

// Native items get no trailing margin row: explicit gap rows are emitted instead.
function wrapNativeRows(
  rows: TimelineRow[],
  totalWidth: number,
  padded: boolean,
  keyPrefix: string,
): TimelineRow[] {
  return wrapRows(rows, totalWidth, padded, keyPrefix, false);
}

// Counts full per-turn row builds so tests can assert that unchanged finalized
// turns are served from the static transcript cache instead of being rebuilt.
let _nativeTurnBuildCount = 0;

export function __getNativeTurnBuildCountForTests(): number {
  return _nativeTurnBuildCount;
}

export function __resetNativeTurnBuildCountForTests(): void {
  _nativeTurnBuildCount = 0;
}

/** Append one turn's rows to `output`, routing them to `staticItems` or `liveRows` by run status. */
function appendNativeTurnParts(
  output: NativeTranscriptParts,
  item: TurnRenderItem,
  options: {
    totalWidth: number;
    verboseMode?: boolean;
    workspaceRoot?: string | null;
  },
): void {
  _nativeTurnBuildCount += 1;
  const run = item.item.run;
  const innerWidth = Math.max(10, options.totalWidth - (item.padded ? 2 : 0));
  const verbose = options.verboseMode ?? false;
  const running = run?.status === "running";

  if (item.item.user) {
    const userRows = wrapNativeRows(
      buildUserInputRows(item, innerWidth),
      options.totalWidth,
      item.padded,
      item.key,
    );
    const promptGapRow = createBlankRow(`${item.key}-prompt-gap-row`, options.totalWidth);
    if (running) {
      output.liveRows.push(...userRows, promptGapRow);
    } else {
      output.staticItems.push({ key: `${item.key}-user`, rows: userRows });
      output.staticItems.push({ key: `${item.key}-prompt-gap`, rows: [promptGapRow] });
    }
  }

  if (!run) return;

  const events = compactActionBursts(collectStreamEvents(item), verbose, run.status !== "running");
  events.forEach((event, eventIndex) => {
    // Keep the complete active turn live and commit it atomically on finalize.
    // Ink <Static> is append-only, and finalize-time rendering differs from the
    // live rendering (action bursts compact, deferred reasoning rows reflow in,
    // plan-mode chatter is demoted), so committing early would leave scrollback
    // that disagrees with the finalized turn. Width resizes remount <Static>
    // via repaintGeneration. TranscriptShell tail-windows these rows so the
    // live region never exceeds the terminal (Ink would clear scrollback).
    const placeAsLive = running;
    // Rendering: only the event that is currently active gets a live indicator
    // (spinner / streaming cursor). Completed events render in stable form even
    // while their parent run is still running.
    const isLiveRender = placeAsLive && isNativeLiveStreamEvent(event, run);
    const rows = buildStreamEventRows({
      item,
      event,
      isLive: isLiveRender,
      isLastEvent: false,
      innerWidth,
      verbose,
      workspaceRoot: options.workspaceRoot,
      forceStable: !isLiveRender,
    });

    if (eventIndex > 0)
      rows.unshift(createBlankRow(`${item.key}-stream-gap-${event.streamSeq}`, innerWidth));
    const wrappedRows = wrapNativeRows(rows, options.totalWidth, item.padded, item.key);
    if (placeAsLive) {
      output.liveRows.push(...wrappedRows);
    } else {
      output.staticItems.push({
        key: `${item.key}-stream-${event.streamSeq}`,
        rows: wrappedRows,
      });
    }
  });

  // A pending question is always placed live, even on a finalized turn: it
  // comes from transient UI state (AWAITING_USER_ACTION), not transcript
  // content, so it must never be committed to append-only <Static>.
  const questionRows = buildActionRequiredRows(item, innerWidth);
  if (questionRows.length > 0) {
    output.liveRows.push(
      ...wrapNativeRows(questionRows, options.totalWidth, item.padded, item.key),
    );
  }

  const endGapRow = createBlankRow(`${item.key}-turn-end-gap-row`, options.totalWidth);
  if (run && run.status === "running") {
    output.liveRows.push(endGapRow);
  } else {
    output.staticItems.push({
      key: `${item.key}-turn-end-gap`,
      rows: [endGapRow],
    });
  }
}

/**
 * Measure `items` into `<Static>` items and live rows at `totalWidth`.
 *
 * Note: unlike `buildTurnRows`, this path emits per-event rows only (no
 * run-level footer such as the impact summary or cancel notice) and does not
 * apply turn opacity.
 */
export function buildNativeTranscriptParts(
  items: RenderTimelineItem[],
  options: {
    totalWidth: number;
    verboseMode?: boolean;
    debugLabel?: string;
    workspaceRoot?: string | null;
  },
): NativeTranscriptParts {
  renderDebug.traceEvent("timeline", "buildNativeTranscriptParts", {
    debugLabel: options.debugLabel ?? "native",
    items: items.length,
    totalWidth: options.totalWidth,
    verbose: options.verboseMode ?? false,
  });

  const output: NativeTranscriptParts = {
    staticItems: [],
    liveRows: [],
  };

  for (const item of items) {
    if (item.type === "turn") {
      appendNativeTurnParts(output, item, options);
      continue;
    }

    const rows = buildTimelineSnapshot([item], options).rows;
    // A running shell event changes when it finishes. Ink's <Static> prints an item once and
    // never redraws it, so printing the running event there would leave "Executing shell" in
    // scrollback forever; it stays live until FINALIZE_SHELL moves the result to static.
    if (item.type === "event" && item.event.type === "shell" && item.event.status === "running") {
      output.liveRows.push(...rows);
      continue;
    }
    output.staticItems.push({ key: item.key, rows });
  }

  return output;
}
