/**
 * Fixed-height shell that renders overlay screens (pickers, settings, viewers):
 * header, a panel stage sized by the app layout budget, an optional hint, and
 * the composer.
 *
 * Role in the app: `src/app/App.tsx` renders `TranscriptShell` for
 * `screen === "main"` (native Ink Static scrollback) and renders `AppShell` only
 * while `screen !== "main"`, passing `<OverlayPanels/>` as `panel`
 * (`src/appRenderStability.test.ts` guards this split, and that AppShell never
 * uses Ink's Static component — that test greps this file's source, so do not
 * write the JSX tag name here, even in comments). The `screen === "main"` branches here (Timeline,
 * `mainPanel`, `full-output`) are still supported and exercised by tests.
 *
 * Layout: sizes come from `computeAppLayoutBudget` in `../layout.ts`. The shell
 * publishes them to panels through four contexts — `AppLayoutBudgetContext`,
 * `PanelAvailableRowsContext`, `ActivePanelLayoutContext`, `PanelLayoutContext`
 * (read via `usePanelLayout()` etc.) — and also clones them as props onto the
 * `panel` element (`injectPanelLayout`).
 *
 * State: owns none besides `previousMeasurements`, a ref holding the last valid
 * transcript row budget so a transient invalid measurement (e.g. mid-resize)
 * reuses the previous height instead of collapsing the stage. Everything else is
 * received as props from App.
 *
 * Memoization (do not "simplify"): `AppShell` is `memo`ized with a custom
 * comparator so streaming deltas that do not change any compared prop skip the
 * shell's render. It compares `layout` by fields (cols, rows, mode,
 * `layoutEpoch`) rather than identity, everything else by identity, and the
 * panel props only for the screen that shows them (`mainPanel` on main;
 * `panel` + `panelHint` on overlays). `session/appSession.ts` deliberately
 * preserves `uiState` identity so the `uiState` check can bail out. Adding a
 * prop that changes during streaming defeats this, and a new prop that is not
 * in the comparator will not trigger a re-render on its own.
 *
 * No timers, stdin listeners or focus handling live here; panels own their focus.
 */
import { Box, Text } from "ink";
import React, { memo, useEffect, useMemo, useRef } from "react";
import type { RuntimeSummary } from "../../config/runtimeConfig.js";
import { HEADER_CONFIG_DEFAULTS, type HeaderConfig } from "../../config/settings.js";
import type { CodexAuthState } from "../../core/codex/codexAuth.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { Screen, TimelineEvent, UIState } from "../../session/types.js";
import {
  type ActivePanelLayout,
  ActivePanelLayoutContext,
  AppLayoutBudgetContext,
  computeAppLayoutBudget,
  getContentWidth,
  getShellHeight,
  getShellWidth,
  type Layout,
  type LayoutMode,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  PanelAvailableRowsContext,
  type PanelLayout,
  PanelLayoutContext,
  type TerminalViewport,
} from "../layout.js";
import { HEADER_CONSTRAINTS } from "../render/responsiveHeader.js";
import { useTheme } from "../theme.js";
import { Timeline } from "../timeline/Timeline.js";
import { MemoizedTopHeader, measureTopHeaderRows, type UpdateAvailableInfo } from "./TopHeader.js";

// Header-to-composer gap by terminal height tier for the cold-start spacer.
// Currently all tiers are 1 row; kept separate so the tiers can diverge.
const COMPACT_HEADER_TO_COMPOSER_GAP_ROWS = 1;
const MEDIUM_HEADER_TO_COMPOSER_GAP_ROWS = 1;
const TALL_HEADER_TO_COMPOSER_GAP_ROWS = 1;

// ─── Types & constants ────────────────────────────────────────────────────────

type AppShellLayout = TerminalViewport;
interface AppShellProps {
  /** Terminal viewport; compared by cols/rows/mode/layoutEpoch in the memo comparator. */
  layout: AppShellLayout;
  screen: Screen;
  authState: CodexAuthState;
  workspaceLabel: string;
  workspaceRoot?: string | null;
  runtimeSummary?: RuntimeSummary | null;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
  /** Overlay content shown when `screen !== "main"` (App passes `<OverlayPanels/>`). */
  panel: React.ReactNode;
  /** Replaces the Timeline on the main screen when non-null. */
  mainPanel?: React.ReactNode;
  /**
   * `viewport` clips `mainPanel` to the transcript budget; `full-output` renders
   * header + `mainPanel` + composer unclipped at natural height.
   */
  mainPanelMode?: "viewport" | "full-output";
  /** Composer element; always rendered below the stage. */
  composer: React.ReactNode;
  /** Rows the composer occupies; feeds the layout budget. */
  composerRows: number;
  /** Optional hint under the panel stage on overlay screens; reserves 2 rows when present. */
  panelHint?: React.ReactNode;
  verboseMode?: boolean;
  /** Bumped by `/clear`; used as the Timeline `key` so it remounts empty. */
  clearCount?: number;
  /** Header field visibility. Note: not part of the memo comparator. */
  headerConfig?: HeaderConfig;
  updateAvailable?: UpdateAvailableInfo | null;
}

// ─── Helpers & subcomponents ─────────────────────────────────────────────────

/**
 * Rows of blank spacer needed to fill the shell below intro + content and above
 * the composer, so short content still pins the composer to the bottom. Pure;
 * currently referenced only by `AppShell.test.tsx`.
 */
export function calculateNativeSpacerRows({
  shellRows,
  introRows,
  composerRows,
  staticRows,
  liveRows,
}: {
  shellRows: number;
  introRows: number;
  composerRows: number;
  staticRows: number;
  liveRows: number;
}): number {
  const availableBodyRows = Math.max(0, shellRows - introRows - composerRows);
  const visibleBodyContentRows = Math.max(0, staticRows) + Math.max(0, liveRows);
  return Math.max(0, availableBodyRows - visibleBodyContentRows);
}

/**
 * Gap between the header and composer before any transcript exists, bounded by
 * `availableRows` and by the rows left after header + composer. One row in
 * compact layouts or terminals of 18 rows or fewer, otherwise the height-tier
 * constant. Pure; currently referenced only by tests.
 */
export function calculateColdStartSpacerRows({
  shellRows,
  headerRows,
  composerRows,
  layoutMode,
  availableRows,
}: {
  shellRows: number;
  headerRows: number;
  composerRows: number;
  layoutMode: LayoutMode;
  availableRows: number;
}): number {
  if (availableRows <= 0) return 0;

  const rowsAfterHeaderAndComposer = Math.max(0, shellRows - headerRows - composerRows);
  const preferredRows =
    layoutMode === "compact" || shellRows <= 18
      ? 1
      : shellRows >= 36
        ? TALL_HEADER_TO_COMPOSER_GAP_ROWS
        : shellRows >= 28
          ? MEDIUM_HEADER_TO_COMPOSER_GAP_ROWS
          : COMPACT_HEADER_TO_COMPOSER_GAP_ROWS;

  return Math.max(0, Math.min(availableRows, rowsAfterHeaderAndComposer, preferredRows));
}

/** One blank row under the header, except in compact layouts / terminals of 18 rows or fewer. Pure; test-only. */
export function calculateHeaderToContentGapRows(layout: Layout): number {
  if (layout.mode === "compact" || layout.rows <= 18) return 0;
  return 1;
}

/** Replaces the whole shell when the terminal is below `MIN_TERMINAL_COLS` x `MIN_TERMINAL_ROWS`. */
function CrampedView({ layout }: { layout: Layout }) {
  const theme = useTheme();
  return (
    <Box width={getShellWidth(layout.cols)} height={1} overflow="hidden">
      <Text color={theme.error} wrap="truncate">
        Resize to at least {MIN_TERMINAL_COLS}×{MIN_TERMINAL_ROWS}
      </Text>
    </Box>
  );
}

/**
 * Clone `element` with `availableRows`, `activePanelLayout` and `panelLayout`
 * props, recursing into fragments. Lets a panel passed directly as `panel`
 * (as the AppShell integration tests do with `ProviderPicker`) receive its size
 * as props. Components that do not declare these props (e.g. `OverlayPanels`)
 * ignore them; such panels read the layout contexts instead. Non-elements are
 * returned unchanged.
 */
function injectPanelLayout(
  element: React.ReactNode,
  availableRows: number,
  activePanelLayout: ActivePanelLayout,
  panelLayout: PanelLayout,
): React.ReactNode {
  if (!React.isValidElement(element)) {
    return element;
  }
  if (element.type === React.Fragment) {
    const fragment = element as React.ReactElement<{ children?: React.ReactNode }>;
    return React.cloneElement(
      fragment,
      fragment.props,
      React.Children.map(fragment.props.children, (child) =>
        injectPanelLayout(child, availableRows, activePanelLayout, panelLayout),
      ),
    );
  }
  return React.cloneElement(
    element as React.ReactElement<{
      availableRows?: number;
      activePanelLayout?: ActivePanelLayout;
      panelLayout?: PanelLayout;
    }>,
    { availableRows, activePanelLayout, panelLayout },
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

function AppShellInner({
  layout,
  screen,
  authState,
  workspaceLabel,
  workspaceRoot = null,
  runtimeSummary = null,
  staticEvents,
  activeEvents,
  uiState,
  panel,
  mainPanel,
  mainPanelMode = "viewport",
  composer,
  composerRows,
  panelHint,
  verboseMode = false,
  clearCount = 0,
  headerConfig = HEADER_CONFIG_DEFAULTS,
  updateAvailable = null,
}: AppShellProps) {
  renderDebug.useRenderDebug("AppShell", {
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
    layoutEpoch: layout.layoutEpoch,
    screen,
    authState,
    workspaceLabel,
    workspaceRoot,
    runtimeSummary,
    staticEvents,
    activeEvents,
    uiState,
    composer,
    composerRows,
    verboseMode,
  });
  renderDebug.useLifecycleDebug("AppShell", {
    screen,
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
  });

  const shellWidth = getShellWidth(layout.cols);
  const shellHeight = getShellHeight(layout.rows);
  const contentWidth = getContentWidth(layout.cols);

  const showComposer = true;
  const showMainPanel = screen === "main" && mainPanel !== undefined && mainPanel !== null;
  const showMainPanelFullOutput = showMainPanel && mainPanelMode === "full-output";
  const showTimeline = screen === "main" && !showMainPanel;
  const showPanelStage = screen !== "main";
  const timelineHasBeenVisible = useRef(false);
  if (showTimeline) timelineHasBeenVisible.current = true;
  // Short terminals with an overlay open: force the compact header (and cap its
  // width) so the panel stage keeps as many rows as possible.
  const headerLayout =
    showPanelStage && layout.rows <= 24
      ? { ...layout, cols: Math.min(layout.cols, 71), mode: "compact" as const }
      : layout;
  const headerAvailableRows = Math.max(
    0,
    shellHeight -
      (composerRows ?? HEADER_CONSTRAINTS.defaultComposerRows) -
      HEADER_CONSTRAINTS.overlayContentReserveRows -
      HEADER_CONSTRAINTS.liveSafetyRows,
  );
  const headerRows = measureTopHeaderRows(
    headerLayout,
    headerConfig,
    !!updateAvailable,
    headerAvailableRows,
    contentWidth,
  );
  const previousMeasurements = useRef<{
    timelineRows: number;
    composerRows: number;
    shellHeight: number;
    shellWidth: number;
  } | null>(null);

  const effectiveShowComposer = showComposer;
  const showPanelHint =
    showPanelStage && panelHint && shellHeight - (composerRows ?? 4) - headerRows >= 3;
  const panelHintRows = showPanelHint ? 2 : 0;

  // ─── App Layout Budget ────────────────────────────────────────────────────

  const appLayoutBudget = computeAppLayoutBudget({
    cols: layout.cols,
    rows: layout.rows,
    composerRows,
    panelHintRows,
    headerRows,
  });

  const headerToContentGapRows = appLayoutBudget.headerGapRows;
  const bottomChromeRows = appLayoutBudget.bottomChromeBudget.totalRows;

  const finalTimelineRows = appLayoutBudget.transcriptRows;
  const finalShellHeight = shellHeight;
  const finalShellWidth = shellWidth;

  // Guard invalid measurements, while accepting a legitimate zero-row stage:
  // in extremely short windows the editor can consume the whole shell.
  const { finalTimelineRows: resolvedTimelineRows } = useMemo(() => {
    const prev = previousMeasurements.current;
    const isValid =
      shellHeight > 0 &&
      shellWidth > 0 &&
      Number.isFinite(shellHeight) &&
      Number.isFinite(shellWidth) &&
      Number.isFinite(finalTimelineRows) &&
      finalTimelineRows >= 0;

    if (!isValid && prev) {
      return {
        finalTimelineRows: prev.timelineRows,
      };
    }

    return {
      finalTimelineRows: Math.max(2, finalTimelineRows),
    };
  }, [shellHeight, shellWidth, finalTimelineRows]);

  // Record the committed measurement after render so the guard above compares
  // against what is actually on screen.
  useEffect(() => {
    previousMeasurements.current = {
      timelineRows: resolvedTimelineRows,
      composerRows: bottomChromeRows,
      shellHeight: finalShellHeight,
      shellWidth: finalShellWidth,
    };
  }, [resolvedTimelineRows, bottomChromeRows, finalShellHeight, finalShellWidth]);

  const panelStagePaddingY = appLayoutBudget.panelStagePaddingY;

  const panelAvailableRows = appLayoutBudget.panelRows;

  // Inner size of a bordered panel box inside the stage. The border (and its
  // title row) is dropped below 7 rows and the header row below 9, so tiny
  // terminals still get at least one content row.
  const activePanelLayout = useMemo<ActivePanelLayout>(() => {
    const panelBoxHeight = Math.max(0, resolvedTimelineRows - 2 * panelStagePaddingY);
    const showBorder = panelBoxHeight >= 7;
    const borderRows = showBorder ? 2 : 0;
    const borderCols = showBorder ? 4 : 0;
    const panelTitleRows = showBorder ? 1 : 0;
    const panelHeaderRows = panelBoxHeight >= 9 ? 1 : 0;
    const panelChromeRows = borderRows + panelTitleRows + panelHeaderRows;

    const availableRows = Math.max(1, panelBoxHeight - panelChromeRows);
    const availableCols = Math.max(1, contentWidth - borderCols);

    return {
      width: contentWidth,
      height: panelBoxHeight,
      availableRows,
      availableCols,
    };
  }, [resolvedTimelineRows, panelStagePaddingY, contentWidth]);

  const panelLayout = useMemo<PanelLayout>(() => {
    return {
      mode: appLayoutBudget.mode,
      availableRows: appLayoutBudget.activePanelRows,
      availableCols: appLayoutBudget.activePanelCols,
    };
  }, [appLayoutBudget.mode, appLayoutBudget.activePanelRows, appLayoutBudget.activePanelCols]);

  if (layout.isCramped) return <CrampedView layout={layout} />;

  // Native chat owns its own history. Overlay-only shells must never mount a
  // second transcript. Legacy callers retain an already visible Timeline to
  // preserve its scroll state, freezing it while a panel owns the viewport.
  const mainContent = (
    <AppLayoutBudgetContext.Provider value={appLayoutBudget}>
      <Box flexDirection="column" width={contentWidth} height="100%">
        {appLayoutBudget.headerRows > 0 && (
          <MemoizedTopHeader
            authState={authState}
            workspaceLabel={workspaceLabel}
            layout={headerLayout}
            availableRows={headerAvailableRows}
            availableColumns={contentWidth}
            runtimeSummary={runtimeSummary}
            headerConfig={headerConfig}
            updateAvailable={updateAvailable}
          />
        )}

        {headerToContentGapRows > 0 && <Box height={headerToContentGapRows} />}

        <Box
          flexDirection="column"
          height={resolvedTimelineRows}
          overflow="hidden"
          display={showTimeline ? "flex" : "none"}
        >
          {(showTimeline || timelineHasBeenVisible.current) && (
            <Timeline
              visible={showTimeline}
              key={`timeline-${clearCount}`}
              staticEvents={staticEvents}
              activeEvents={activeEvents}
              layout={layout}
              uiState={uiState}
              viewportRows={resolvedTimelineRows}
              verboseMode={verboseMode}
              authState={authState}
              workspaceLabel={workspaceLabel}
              workspaceRoot={workspaceRoot}
              contentSized
              showIntro={false}
            />
          )}
        </Box>

        {showMainPanel && (
          <Box
            flexDirection="column"
            height={resolvedTimelineRows}
            overflow="hidden"
            justifyContent="center"
          >
            {mainPanel}
          </Box>
        )}

        {showPanelStage && (
          <Box
            flexDirection="column"
            height={resolvedTimelineRows}
            overflow="hidden"
            paddingY={panelStagePaddingY}
          >
            <PanelAvailableRowsContext.Provider value={panelAvailableRows}>
              <ActivePanelLayoutContext.Provider value={activePanelLayout}>
                <PanelLayoutContext.Provider value={panelLayout}>
                  {process.env.UBUME_DEBUG_LAYOUT === "1" && (
                    <Box>
                      <Text color="red">
                        DEBUG layout: rows={layout.rows} cols={layout.cols} mode={layout.mode}{" "}
                        headerRows={headerRows} panelRows={panelAvailableRows} bottomChromeRows=
                        {appLayoutBudget.bottomChromeBudget.totalRows}
                      </Text>
                    </Box>
                  )}
                  {injectPanelLayout(panel, panelAvailableRows, activePanelLayout, panelLayout)}
                </PanelLayoutContext.Provider>
              </ActivePanelLayoutContext.Provider>
            </PanelAvailableRowsContext.Provider>
          </Box>
        )}

        {showPanelHint && panelHint}

        {effectiveShowComposer && (
          <Box flexDirection="column" flexShrink={0}>
            {composer}
          </Box>
        )}
      </Box>
    </AppLayoutBudgetContext.Provider>
  );

  // Full-output mode: natural height, with no fixed shell height or clipping.
  if (showMainPanelFullOutput) {
    const fullOutputContent = (
      <Box flexDirection="column" width={contentWidth}>
        <MemoizedTopHeader
          authState={authState}
          workspaceLabel={workspaceLabel}
          layout={layout}
          availableColumns={contentWidth}
          runtimeSummary={runtimeSummary}
          headerConfig={headerConfig}
          updateAvailable={updateAvailable}
        />

        {headerToContentGapRows > 0 && <Box height={headerToContentGapRows} />}

        {mainPanel}

        {showComposer && (
          <Box flexDirection="column" flexShrink={0}>
            {composer}
          </Box>
        )}
      </Box>
    );

    if (shellWidth > contentWidth) {
      return (
        <Box flexDirection="column" width="100%" alignItems="center">
          {fullOutputContent}
        </Box>
      );
    }
    return fullOutputContent;
  }

  if (shellWidth > contentWidth) {
    return (
      <Box flexDirection="column" width="100%" height={finalShellHeight} alignItems="center">
        {mainContent}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" height={finalShellHeight}>
      {mainContent}
    </Box>
  );
}

/**
 * Memoized shell. The comparator returns true (skip render) only when every
 * compared prop is unchanged; see the module header for why it exists and the
 * rules for adding props. `panel`/`panelHint` are ignored on the main screen and
 * `mainPanel` is always compared.
 */
export const AppShell = memo(AppShellInner, (prev, next) => {
  const panelPropsEqual =
    next.screen === "main"
      ? prev.mainPanel === next.mainPanel
      : prev.panel === next.panel && prev.panelHint === next.panelHint;

  return (
    prev.layout.cols === next.layout.cols &&
    prev.layout.rows === next.layout.rows &&
    prev.layout.mode === next.layout.mode &&
    prev.layout.layoutEpoch === next.layout.layoutEpoch &&
    prev.screen === next.screen &&
    prev.authState === next.authState &&
    prev.workspaceLabel === next.workspaceLabel &&
    prev.workspaceRoot === next.workspaceRoot &&
    prev.runtimeSummary === next.runtimeSummary &&
    prev.staticEvents === next.staticEvents &&
    prev.activeEvents === next.activeEvents &&
    prev.uiState === next.uiState &&
    prev.composerRows === next.composerRows &&
    prev.composer === next.composer &&
    prev.mainPanel === next.mainPanel &&
    prev.mainPanelMode === next.mainPanelMode &&
    prev.verboseMode === next.verboseMode &&
    prev.clearCount === next.clearCount &&
    prev.updateAvailable === next.updateAvailable &&
    panelPropsEqual
  );
});
