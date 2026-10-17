/**
 * Fixed-height, app-scrolled transcript view built on measured rows.
 *
 * Used by `chrome/AppShell.tsx` (overlay composition); the main chat screen
 * uses `TranscriptShell` instead, which relies on native terminal scrollback.
 * Pipeline: events → render items (`timelineItems.ts`) → `TimelineSnapshot`s
 * (`buildTimelineSnapshot` for static events, `buildStableTimelineSnapshot`
 * for active ones) → viewport slice (`useTimelineViewport`) →
 * `TimelineRowsView`. The box height is exactly `viewportRows` (unless
 * `contentSized`) and the slice never exceeds it, which only holds because each
 * measured row renders as one terminal line.
 *
 * Blank-frame guards: if the snapshot or the visible slice is transiently
 * empty while events exist, the last non-empty snapshot / slice is reused.
 */
import { Box } from "ink";
import { memo, useMemo, useRef } from "react";
import type { CodexAuthState } from "../../core/codex/codexAuth.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { TimelineEvent, UIState } from "../../session/types.js";
import { getShellWidth, type Layout, type StartupHeaderMode } from "../layout.js";
import type { TurnTimelineItem } from "./measure/types.js";
import { TimelineRowsView } from "./TimelineRows.js";
import {
  buildActiveRenderItems,
  buildIntroRenderItem,
  buildStaticRenderItems,
  buildTimelineItems,
  getActiveTurnId,
  getFinalizedTurnIds,
  getRunningTurnIds,
  hasFinalizeTransition,
  isBusyUiState,
  latestFinalizedRunEndsWithPlan,
} from "./timelineItems.js";
import type { TimelineRow, TimelineSnapshot } from "./timelineMeasure.js";
import { buildStableTimelineSnapshot, buildTimelineSnapshot } from "./timelineMeasure.js";
import { useTimelineViewport } from "./useTimelineViewport.js";

// ─── Types & constants ────────────────────────────────────────────────────────

interface TimelineProps {
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  layout: Layout;
  uiState: UIState;
  viewportRows: number;
  verboseMode?: boolean;
  authState?: CodexAuthState;
  workspaceLabel?: string;
  workspaceRoot?: string | null;
  providerLabel?: string | null;
  startupHeaderMode?: StartupHeaderMode;
  showIntro?: boolean;
  contentSized?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Render the visible slice of the measured transcript. Memoized with a custom
 * comparator over the props that affect output (layout compared by
 * cols/rows/mode, not identity).
 */
export const Timeline = memo(
  function Timeline({
    staticEvents,
    activeEvents,
    layout,
    uiState,
    viewportRows,
    verboseMode = false,
    authState = "checking",
    workspaceLabel = "",
    workspaceRoot = null,
    providerLabel = null,
    startupHeaderMode,
    showIntro = true,
    contentSized = false,
  }: TimelineProps) {
    renderDebug.useRenderDebug("Timeline", {
      staticEvents,
      activeEvents,
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      cols: layout.cols,
      rows: layout.rows,
      mode: layout.mode,
      uiStateKind: uiState.kind,
      viewportRows,
      verboseMode,
      authState,
      workspaceLabel,
      workspaceRoot,
    });
    renderDebug.useLifecycleDebug("Timeline", {
      cols: layout.cols,
      rows: layout.rows,
      mode: layout.mode,
      viewportRows,
    });
    renderDebug.traceLayoutValidity("Timeline", {
      cols: layout.cols,
      rows: layout.rows,
      viewportRows,
    });
    renderDebug.useFlickerDebug("timelineRender", {
      staticEvents,
      activeEvents,
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      cols: layout.cols,
      rows: layout.rows,
      mode: layout.mode,
      uiStateKind: uiState.kind,
      viewportRows,
      verboseMode,
      authState,
      workspaceLabel,
    });
    renderDebug.useRenderDebug("Transcript", {
      staticEvents,
      activeEvents,
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      cols: layout.cols,
      rows: layout.rows,
      mode: layout.mode,
      uiStateKind: uiState.kind,
      viewportRows,
      verboseMode,
      workspaceRoot,
    });

    const staticItems = useMemo(() => buildTimelineItems(staticEvents), [staticEvents]);
    const activeItems = useMemo(() => buildTimelineItems(activeEvents), [activeEvents]);
    const activeTurnId = getActiveTurnId(uiState);
    const runningTurnIds = useMemo(() => getRunningTurnIds(activeEvents), [activeEvents]);
    const finalizedTurnIds = useMemo(() => getFinalizedTurnIds(staticEvents), [staticEvents]);
    const finalizedPlanAtTail = useMemo(
      () => latestFinalizedRunEndsWithPlan(staticEvents),
      [staticEvents],
    );
    const finalizeTransitionRef = useRef<{
      runningTurnIds: number[];
      finalizedTurnIds: number[];
      busy: boolean;
    }>({
      runningTurnIds,
      finalizedTurnIds,
      busy: isBusyUiState(uiState),
    });
    const finalizeTransition = hasFinalizeTransition({
      previousRunningTurnIds: finalizeTransitionRef.current.runningTurnIds,
      nextRunningTurnIds: runningTurnIds,
      nextFinalizedTurnIds: finalizedTurnIds,
      previousBusy: finalizeTransitionRef.current.busy,
      nextBusy: isBusyUiState(uiState),
    });
    const questionTurnId = uiState.kind === "AWAITING_USER_ACTION" ? uiState.turnId : null;
    const question = uiState.kind === "AWAITING_USER_ACTION" ? uiState.question : null;
    const staticTurnIds = useMemo(
      () =>
        staticItems
          .filter((item): item is TurnTimelineItem => item.type === "turn")
          .map((item) => item.turnId),
      [staticItems],
    );
    const activeTurnIds = useMemo(
      () =>
        activeItems
          .filter((item): item is TurnTimelineItem => item.type === "turn")
          .map((item) => item.turnId),
      [activeItems],
    );
    const allTurnIds = useMemo(
      () => [...staticTurnIds, ...activeTurnIds],
      [activeTurnIds, staticTurnIds],
    );
    const staticRenderItems = useMemo(
      () => [
        ...(showIntro
          ? [
              buildIntroRenderItem({
                authState,
                workspaceLabel,
                layout,
                providerLabel,
                startupHeaderMode,
              }),
            ]
          : []),
        ...buildStaticRenderItems(staticItems, allTurnIds, activeTurnId, questionTurnId, question),
      ],
      [
        activeTurnId,
        allTurnIds,
        authState,
        layout,
        providerLabel,
        question,
        questionTurnId,
        showIntro,
        startupHeaderMode,
        staticItems,
        workspaceLabel,
      ],
    );
    const activeRenderItems = useMemo(
      () => buildActiveRenderItems(activeItems, allTurnIds, uiState),
      [activeItems, allTurnIds, uiState],
    );
    // ── Split snapshot building ──────────────────────────────────────────────
    // During streaming, activeEvents change every frame but staticEvents stay
    // the same, so the static snapshot memo is reused untouched. Within the
    // active snapshot, buildStableTimelineSnapshot caches each block (user
    // prompt, finished actions/responses, …) by content token, so in practice
    // only the block that is still streaming is rebuilt each frame.
    const snapshotWidth = Math.max(10, getShellWidth(layout.cols) - 1);
    const staticSnapshot = useMemo(
      () =>
        buildTimelineSnapshot(staticRenderItems, {
          totalWidth: snapshotWidth,
          verboseMode,
          debugLabel: "static",
          workspaceRoot,
        }),
      [snapshotWidth, staticRenderItems, verboseMode, workspaceRoot],
    );
    const stableActiveSnapshot = useMemo(
      () =>
        buildStableTimelineSnapshot(activeRenderItems, {
          totalWidth: snapshotWidth,
          verboseMode,
          debugLabel: "active-stable-render",
          workspaceRoot,
        }),
      [snapshotWidth, activeRenderItems, verboseMode, workspaceRoot],
    );
    const liveSnapshot = useMemo(
      () => ({
        items: [...staticSnapshot.items, ...stableActiveSnapshot.snapshot.items],
        rows: [...staticSnapshot.rows, ...stableActiveSnapshot.snapshot.rows],
        totalRows: staticSnapshot.totalRows + stableActiveSnapshot.snapshot.totalRows,
        itemCount: staticSnapshot.itemCount + stableActiveSnapshot.snapshot.itemCount,
      }),
      [staticSnapshot, stableActiveSnapshot],
    );

    const lastNonEmptySnapshotRef = useRef<TimelineSnapshot>(liveSnapshot);
    if (liveSnapshot.totalRows > 0) {
      lastNonEmptySnapshotRef.current = liveSnapshot;
    }

    const transcriptEventCount = staticEvents.length + activeEvents.length;

    const effectiveSnapshot = useMemo(() => {
      // If we have events but the live snapshot is empty, fallback to the last
      // known good snapshot to avoid blanking the screen during transitions.
      if (
        liveSnapshot.totalRows === 0 &&
        transcriptEventCount > 0 &&
        lastNonEmptySnapshotRef.current.totalRows > 0
      ) {
        renderDebug.traceFlickerEvent("snapshotFallback", {
          reason: "empty-while-busy-with-events",
          uiStateKind: uiState.kind,
          previousTotalRows: lastNonEmptySnapshotRef.current.totalRows,
          transcriptEventCount,
        });
        return lastNonEmptySnapshotRef.current;
      }
      return liveSnapshot;
    }, [liveSnapshot, transcriptEventCount, uiState.kind]);
    const snapshotForViewport = effectiveSnapshot;

    const { visibleRows } = useTimelineViewport({
      snapshotForViewport,
      effectiveSnapshot,
      snapshotWidth,
      viewportRows,
      finalizeTransition,
      finalizedPlanAtTail,
      finalizeTransitionRef,
      runningTurnIds,
      finalizedTurnIds,
      uiState,
      staticEvents,
      activeEvents,
      liveSnapshot,
    });

    const lastNonEmptyVisibleRowsRef = useRef<TimelineRow[]>([]);
    if (visibleRows.length > 0) {
      lastNonEmptyVisibleRowsRef.current = visibleRows;
    }
    const usingLastGoodFrameFallback = visibleRows.length === 0 && transcriptEventCount > 0;
    if (usingLastGoodFrameFallback) {
      renderDebug.traceEvent("viewport", "lastGoodFrameFallback", {
        providerState: uiState.kind,
        totalRows: liveSnapshot.totalRows,
        availableTimelineRows: viewportRows,
        preservedRows: lastNonEmptyVisibleRowsRef.current.length,
      });
    }
    const preservedVisibleRows = usingLastGoodFrameFallback
      ? lastNonEmptyVisibleRowsRef.current
      : visibleRows;

    const rowsForDisplay = preservedVisibleRows;

    if (visibleRows.length === 0) {
      renderDebug.traceBlankFrame("Timeline", {
        reason:
          transcriptEventCount > 0
            ? "visible-rows-zero-with-events"
            : "visible-rows-zero-no-events",
        staticEventsLength: staticEvents.length,
        activeEventsLength: activeEvents.length,
        transcriptEventCount,
        totalRows: liveSnapshot.totalRows,
        viewportRows,
        preservedRows: preservedVisibleRows.length,
        uiStateKind: uiState.kind,
      });
    }

    if (preservedVisibleRows.length === 0) {
      renderDebug.traceBlankFrame("Timeline", {
        reason: "empty-root-layout-return",
        staticEventsLength: staticEvents.length,
        activeEventsLength: activeEvents.length,
        transcriptEventCount,
        totalRows: liveSnapshot.totalRows,
        effectiveTotalRows: snapshotForViewport.totalRows,
        viewportRows,
        uiStateKind: uiState.kind,
      });
      return (
        <Box
          flexDirection="column"
          width="100%"
          height={contentSized ? undefined : Math.max(1, viewportRows)}
        />
      );
    }

    return (
      <Box
        flexDirection="column"
        width="100%"
        height={contentSized ? undefined : Math.max(1, viewportRows)}
        overflow="hidden"
      >
        <TimelineRowsView rows={rowsForDisplay} />
      </Box>
    );
  },
  (prev, next) => {
    return (
      prev.staticEvents === next.staticEvents &&
      prev.activeEvents === next.activeEvents &&
      prev.layout.cols === next.layout.cols &&
      prev.layout.rows === next.layout.rows &&
      prev.layout.mode === next.layout.mode &&
      prev.uiState === next.uiState &&
      prev.viewportRows === next.viewportRows &&
      prev.verboseMode === next.verboseMode &&
      prev.authState === next.authState &&
      prev.workspaceLabel === next.workspaceLabel &&
      prev.workspaceRoot === next.workspaceRoot &&
      prev.providerLabel === next.providerLabel &&
      prev.startupHeaderMode === next.startupHeaderMode &&
      prev.showIntro === next.showIntro &&
      prev.contentSized === next.contentSized
    );
  },
);
