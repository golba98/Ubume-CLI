/**
 * Snapshot builders for the `Timeline` row view: render items → `TimelineSnapshot`.
 *
 * - `buildTimelineSnapshot` — static/finalized items. Intro, events and
 *   completed turns are cached in `_staticRowCache` (via `getStaticRows`);
 *   turns still streaming/thinking are rebuilt each call.
 * - `buildStableTimelineSnapshot` — active items. Builds each turn block by
 *   block and caches every non-live block (prompt card, finished thinking /
 *   action / response, plan) in the frozen row-group cache keyed by content
 *   tokens, so a streaming flush only rebuilds the block that is changing.
 *
 * Height stability: while a run is `running`, its measured height must only
 * grow and its block order must be append-only, otherwise the bottom-anchored
 * viewport re-reveals scrolled-off content. That is enforced by the stream
 * helpers this file uses (`collectStreamEvents` defers reasoning while running;
 * `compactActionBursts` only compacts finalized runs) and pinned by
 * `streamingHeightStability.test.ts` and `liveTurnOrderStability.test.ts`.
 * Gap rows are keyed by `streamSeq`, not array index, so row keys stay stable
 * (no remounts) as events arrive.
 */
import * as renderDebug from "../../../core/perf/renderDebug.js";
import type { RunEvent } from "../../../session/types.js";
import { getResponseSegmentText } from "../../../session/types.js";
import { getCachedFrozenRows, getStaticRows, rowCacheKey, textCacheToken } from "./caches.js";
import { buildUserInputRows } from "./cards.js";
import { buildActionRequiredRows, buildIntroRows, buildStandaloneEventRows } from "./eventRows.js";
import { createBlankRow, rowsToSnapshot, wrapItemRows, wrapRows } from "./rows.js";
import {
  applyTurnOpacity,
  buildActionSummaryRows,
  buildStreamEventRows,
  buildTurnRows,
  collectStreamEvents,
  compactActionBursts,
} from "./streamRows.js";
import type {
  BuiltTimelineItem,
  RenderTimelineItem,
  StableTimelineSnapshot,
  StreamEvent,
  TimelineBuildOptions,
  TimelineRow,
  TimelineSnapshot,
  TurnRenderItem,
} from "./types.js";

function buildStableEventRows(
  item: Extract<RenderTimelineItem, { type: "event" }>,
  innerWidth: number,
): TimelineRow[] {
  const cacheKey = rowCacheKey([
    "stable-event",
    item.key,
    item.event.type,
    item.event.id,
    innerWidth,
    textCacheToken("title" in item.event ? item.event.title : item.event.command),
    textCacheToken("content" in item.event ? item.event.content : (item.event.summary ?? "")),
    "status" in item.event ? item.event.status : "",
    "durationMs" in item.event ? item.event.durationMs : "",
  ]);
  return getCachedFrozenRows(cacheKey, () => buildStandaloneEventRows(item, innerWidth));
}

function introCacheKey(
  item: Extract<RenderTimelineItem, { type: "intro" }>,
  innerWidth: number,
): string {
  return rowCacheKey([
    "intro",
    item.key,
    innerWidth,
    item.intro.version,
    item.intro.layoutMode,
    item.intro.startupHeaderMode ?? "",
    item.intro.authLabel,
    textCacheToken(item.intro.workspaceLabel),
    item.intro.providerLabel ?? "",
    item.intro.modelLabel ?? "",
    item.intro.middleLine ?? "provider",
    item.intro.startupModelLabel ?? "",
    item.intro.usageLabel ?? "",
    textCacheToken(item.intro.workspacePath ?? ""),
    item.intro.logoStyle ?? "normal",
    JSON.stringify(item.intro.headerLayout ?? null),
    JSON.stringify(item.intro.logoSize ?? null),
  ]);
}

function buildStableIntroRows(
  item: Extract<RenderTimelineItem, { type: "intro" }>,
  innerWidth: number,
): TimelineRow[] {
  return getCachedFrozenRows(introCacheKey(item, innerWidth), () =>
    buildIntroRows(item, innerWidth),
  );
}

// Cache-key fragment covering the plan's identity/content and the stream item
// order, so a plan edit or reordering invalidates otherwise-static turn rows.
function buildPlanCacheSignature(run: RunEvent | null | undefined): string {
  if (!run) return "";
  const plan = run.plan;
  return rowCacheKey([
    "plan",
    plan?.id ?? "",
    plan?.status ?? "",
    plan?.streamSeq ?? "",
    (plan?.chunks ?? []).map((chunk) => textCacheToken(chunk)),
    textCacheToken(run.approvedPlan),
    (run.streamItems ?? []).map((item) => `${item.streamSeq}:${item.kind}:${item.refId}`),
  ]);
}

// Whole-turn rows (via buildTurnRows) for a turn that is not streaming/thinking,
// keyed by every content input that can still change on an active turn.
function buildStableFrozenTurnRows(
  item: TurnRenderItem,
  innerWidth: number,
  options: { verbose?: boolean; workspaceRoot?: string | null },
): TimelineRow[] {
  const verbose = options.verbose ?? false;
  const run = item.item.run;
  const user = item.item.user;
  const cacheKey = rowCacheKey([
    "stable-turn",
    item.key,
    innerWidth,
    verbose,
    item.renderState.opacity,
    item.renderState.runPhase,
    user?.id,
    textCacheToken(user?.prompt),
    run?.id,
    run?.status,
    buildPlanCacheSignature(run),
    run?.durationMs,
    textCacheToken(run?.summary),
    textCacheToken(item.item.assistant?.content),
    textCacheToken(item.item.assistant?.contentChunks.join("")),
    run?.toolActivities
      .map(
        (tool) =>
          `${tool.id}:${tool.authorization ?? ""}:${tool.status}:${tool.startedAt}:${tool.completedAt ?? ""}:${textCacheToken(tool.command)}:${textCacheToken(tool.summary)}`,
      )
      .join("|"),
    run?.responseSegments
      ?.map(
        (segment) =>
          `${segment.id}:${segment.status}:${textCacheToken(getResponseSegmentText(segment))}`,
      )
      .join("|"),
    run?.progressEntries
      .map(
        (entry) =>
          `${entry.id}:${entry.blocks.map((block) => `${block.id}:${block.status}:${block.updatedAt}:${textCacheToken(block.text)}`).join(",")}`,
      )
      .join("|"),
    options.workspaceRoot ?? "",
  ]);
  return getCachedFrozenRows(cacheKey, () => buildTurnRows(item, innerWidth, options));
}

// Live blocks are rebuilt every call (never cached): the active response
// segment and running tools of a running run.
function isLiveStreamEvent(event: StreamEvent, run: RunEvent): boolean {
  if (run.status !== "running") return false;
  if (event.kind === "response") return event.segment.status === "active";
  if (event.kind === "action") return event.tool.status === "running";
  if (event.kind === "actionSummary") return false;
  return false;
}

/**
 * Block-by-block rows for an active turn. Streaming/thinking turns are
 * assembled from per-block cached rows (mirroring `buildTurnRows`' prompt,
 * stream events, question and gaps — but without its finalized-run footer);
 * other turns fall back to cached whole-turn rows. All rows are returned as
 * `frozenRows`; `liveRows` is always empty.
 */
function buildStableActiveTurnGroups(
  item: TurnRenderItem,
  innerWidth: number,
  options: { verbose?: boolean; workspaceRoot?: string | null },
): { frozenRows: TimelineRow[]; liveRows: TimelineRow[] } {
  const verbose = options.verbose ?? false;
  const run = item.item.run;
  if (
    !run ||
    (item.renderState.runPhase !== "streaming" && item.renderState.runPhase !== "thinking")
  ) {
    return {
      frozenRows: buildStableFrozenTurnRows(item, innerWidth, options),
      liveRows: [],
    };
  }

  const actionBorderTone = item.renderState.opacity === "dim" ? "borderSubtle" : "borderActive";
  const finalized = run.status !== "running";
  const events = compactActionBursts(collectStreamEvents(item), verbose, finalized);
  const orderedRows = [
    ...getCachedFrozenRows(
      rowCacheKey([
        "stable-active-user",
        item.key,
        innerWidth,
        item.renderState.opacity,
        textCacheToken(item.item.user?.prompt),
      ]),
      () => buildUserInputRows(item, innerWidth),
    ),
  ];
  orderedRows.push(createBlankRow(`${item.key}-active-prompt-gap`, innerWidth));

  events.forEach((event, index) => {
    const liveEvent = isLiveStreamEvent(event, run);
    const targetRows: TimelineRow[] = [];
    const isLastEvent = index === events.length - 1;

    if (index > 0) {
      // Stable creation-order key (streamSeq), not array index — matches the
      // native path and avoids index-based remount when events change.
      targetRows.push(createBlankRow(`${item.key}-stream-gap-${event.streamSeq}`, innerWidth));
    }

    if (event.kind === "thinking") {
      const build = () =>
        buildStreamEventRows({
          item,
          event,
          innerWidth,
          verbose,
          isLive: liveEvent,
          isLastEvent,
          workspaceRoot: options.workspaceRoot,
        });
      targetRows.push(
        ...(liveEvent
          ? build()
          : getCachedFrozenRows(
              rowCacheKey([
                "stable-thinking",
                item.key,
                innerWidth,
                verbose,
                event.block.id,
                event.block.status,
                event.block.updatedAt,
                textCacheToken(event.block.text),
              ]),
              build,
            )),
      );
    } else if (event.kind === "action") {
      const build = () =>
        buildStreamEventRows({
          item,
          event,
          innerWidth,
          verbose,
          isLive: liveEvent,
          isLastEvent,
          workspaceRoot: options.workspaceRoot,
        });
      targetRows.push(
        ...(liveEvent
          ? build()
          : getCachedFrozenRows(
              rowCacheKey([
                "stable-action",
                item.key,
                innerWidth,
                verbose,
                event.tool.id,
                event.tool.status,
                event.tool.authorization ?? "",
                event.tool.startedAt,
                event.tool.completedAt ?? "",
                textCacheToken(event.tool.command),
              ]),
              build,
            )),
      );
    } else if (event.kind === "actionSummary") {
      targetRows.push(
        ...buildActionSummaryRows({
          keyPrefix: `${item.key}-action-summary-${event.streamSeq}`,
          width: innerWidth,
          event,
          borderTone: actionBorderTone,
        }),
      );
    } else if (event.kind === "response") {
      const build = () =>
        buildStreamEventRows({
          item,
          event,
          innerWidth,
          verbose,
          isLive: liveEvent,
          isLastEvent,
          workspaceRoot: options.workspaceRoot,
        });
      targetRows.push(
        ...(liveEvent
          ? build()
          : getCachedFrozenRows(
              rowCacheKey([
                "stable-response",
                item.key,
                innerWidth,
                verbose,
                run.status,
                event.segment.id,
                event.segment.status,
                textCacheToken(getResponseSegmentText(event.segment)),
              ]),
              build,
            )),
      );
    } else if (event.kind === "plan") {
      const build = () =>
        buildStreamEventRows({
          item,
          event,
          innerWidth,
          verbose,
          isLive: liveEvent,
          isLastEvent,
          workspaceRoot: options.workspaceRoot,
        });
      targetRows.push(
        ...getCachedFrozenRows(
          rowCacheKey([
            "stable-plan",
            item.key,
            innerWidth,
            textCacheToken(event.planText),
            event.approved ? "approved" : "draft",
            options.workspaceRoot ?? "",
          ]),
          build,
        ),
      );
    }

    orderedRows.push(...targetRows);
  });

  const questionRows = buildActionRequiredRows(item, innerWidth);
  if (questionRows.length > 0) {
    orderedRows.push(...questionRows);
  }

  orderedRows.push(createBlankRow(`${item.key}-active-turn-end-gap`, innerWidth));

  return {
    frozenRows: applyTurnOpacity(orderedRows, item.renderState.opacity),
    liveRows: [],
  };
}

// ─── Public snapshot builders ─────────────────────────────────────────────────

/**
 * Measure active render items into a snapshot (see module doc). Each item's
 * rows are wrapped to `totalWidth` with a trailing margin row.
 */
export function buildStableTimelineSnapshot(
  items: RenderTimelineItem[],
  options: TimelineBuildOptions,
): StableTimelineSnapshot {
  const verbose = options.verboseMode ?? false;
  renderDebug.traceFlickerEvent("snapshotBuild", {
    reason: options.debugLabel ?? "stable",
    items: items.length,
    totalWidth: options.totalWidth,
    verbose,
    stable: true,
  });

  const builtItems: BuiltTimelineItem[] = [];
  const frozenRows: TimelineRow[] = [];
  const liveRows: TimelineRow[] = [];

  for (const item of items) {
    const innerWidth = Math.max(1, options.totalWidth - (item.padded ? 2 : 0));
    let itemFrozenRows: TimelineRow[];
    let itemLiveRows: TimelineRow[];

    if (item.type === "intro") {
      itemFrozenRows = buildStableIntroRows(item, innerWidth);
      itemLiveRows = [];
    } else if (item.type === "event") {
      itemFrozenRows = buildStableEventRows(item, innerWidth);
      itemLiveRows = [];
    } else {
      const groups = buildStableActiveTurnGroups(item, innerWidth, {
        verbose,
        workspaceRoot: options.workspaceRoot,
      });
      itemFrozenRows = groups.frozenRows;
      itemLiveRows = groups.liveRows;
    }

    const hasLiveRows = itemLiveRows.length > 0;
    const wrappedFrozenRows = wrapRows(
      itemFrozenRows,
      options.totalWidth,
      item.padded,
      item.key,
      !hasLiveRows,
    );
    const wrappedLiveRows = hasLiveRows
      ? wrapRows(itemLiveRows, options.totalWidth, item.padded, item.key, true)
      : [];
    const rows = [...wrappedFrozenRows, ...wrappedLiveRows];
    frozenRows.push(...wrappedFrozenRows);
    liveRows.push(...wrappedLiveRows);
    builtItems.push({
      key: item.key,
      rows,
      rowCount: rows.length,
    });
  }

  return {
    snapshot: rowsToSnapshot(builtItems),
    frozenRows,
    liveRows,
  };
}

/**
 * Measure static render items into a snapshot (see module doc). Also used by
 * `buildNativeTranscriptParts` for intro and standalone-event items.
 */
export function buildTimelineSnapshot(
  items: RenderTimelineItem[],
  options: TimelineBuildOptions,
): TimelineSnapshot {
  const verbose = options.verboseMode ?? false;
  renderDebug.traceEvent("timeline", "buildSnapshot", {
    items: items.length,
    totalWidth: options.totalWidth,
    verbose,
  });
  renderDebug.traceFlickerEvent("snapshotBuild", {
    reason: options.debugLabel ?? "unknown",
    items: items.length,
    totalWidth: options.totalWidth,
    verbose,
  });

  const builtItems = items.map((item) => {
    const innerWidth = Math.max(1, options.totalWidth - (item.padded ? 2 : 0));

    let builtRows: TimelineRow[];

    if (item.type === "intro") {
      const cacheKey = introCacheKey(item, innerWidth);
      builtRows = getStaticRows(cacheKey, () => buildIntroRows(item, innerWidth), {
        itemKey: item.key,
        itemType: "intro",
        innerWidth,
      });
    } else if (item.type === "event") {
      // Standalone events are immutable for a given event payload, not just id.
      const cacheKey = rowCacheKey([
        "event",
        item.key,
        item.event.type,
        item.event.id,
        innerWidth,
        textCacheToken("title" in item.event ? item.event.title : item.event.command),
        textCacheToken("content" in item.event ? item.event.content : (item.event.summary ?? "")),
        "status" in item.event ? item.event.status : "",
        "durationMs" in item.event ? item.event.durationMs : "",
      ]);
      builtRows = getStaticRows(cacheKey, () => buildStandaloneEventRows(item, innerWidth), {
        itemKey: item.key,
        itemType: "event",
        innerWidth,
      });
    } else {
      const { runPhase, opacity } = item.renderState;
      // Only cache completed turns (runPhase "none"/"final") at a stable
      // opacity. Streaming and thinking items change every tick.
      const cacheable = runPhase !== "streaming" && runPhase !== "thinking";
      if (cacheable) {
        const cacheKey = rowCacheKey([
          "turn",
          item.key,
          innerWidth,
          verbose,
          runPhase,
          opacity,
          options.workspaceRoot ?? "",
          buildPlanCacheSignature(item.item.run),
        ]);
        builtRows = getStaticRows(
          cacheKey,
          () => buildTurnRows(item, innerWidth, { verbose, workspaceRoot: options.workspaceRoot }),
          { itemKey: item.key, itemType: "turn", innerWidth, runPhase, opacity },
        );
      } else {
        renderDebug.traceEvent("timeline", "rowGeneration", {
          itemKey: item.key,
          itemType: "turn",
          runPhase,
          opacity,
          cache: "active",
          innerWidth,
        });
        renderDebug.traceEvent("timeline", "activeBuild", { itemKey: item.key, runPhase, opacity });
        builtRows = buildTurnRows(item, innerWidth, {
          verbose,
          workspaceRoot: options.workspaceRoot,
        });
      }
    }

    const rows = wrapItemRows(builtRows, options.totalWidth, item.padded, item.key);
    return {
      key: item.key,
      rows,
      rowCount: rows.length,
    };
  });

  return rowsToSnapshot(builtItems);
}
