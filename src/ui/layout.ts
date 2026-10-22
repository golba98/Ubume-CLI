/**
 * Terminal geometry for the whole UI: layout modes, shell/content widths, the
 * header/transcript/composer row budget, the resize-aware viewport hook, and the
 * React contexts that hand panel sizes from `AppShell` to the overlay panels.
 *
 * Layout modes (`computeMode`): `compact` when the terminal is ≤ 24 rows or
 * ≤ 100 columns; `expanded` at ≥ 140 columns and ≥ 30 rows; `regular` otherwise.
 * Below `MIN_TERMINAL_COLS` × `MIN_TERMINAL_ROWS` the shell shows a "cramped"
 * placeholder instead of the UI.
 *
 * Everything here is pure except `useTerminalViewport` (subscribes to stdout
 * `resize`) and the context hooks. Repainting the screen on resize is owned by
 * `core/terminal/clearFrameBoundary.ts`, not by this module: the viewport hook only
 * reports dimensions, coalescing bursts without starving updates during a drag.
 */

import { useStdout } from "ink";
import { createContext, useContext, useEffect, useState } from "react";
import * as renderDebug from "../core/perf/renderDebug.js";
import { traceResize } from "../core/perf/resizeTrace.js";
import { createResizeScheduler } from "../core/terminal/resizeScheduler.js";
import { setTerminalResizing } from "../core/terminal/terminalControl.js";

export const MIN_TERMINAL_COLS = 8;
export const MIN_TERMINAL_ROWS = 3;
export const MIN_VIEWPORT_COLS = 1;
export const MIN_VIEWPORT_ROWS = 1;
export const RESIZE_INTERVAL_MS = 16;
const STARTUP_TINY_MIN_COLS = 40;
const STARTUP_TINY_MIN_ROWS = 14;
const STARTUP_FULL_MIN_COLS = 100; // matches LOGO_LARGE_MIN_COLS in logoVariants.ts
const STARTUP_FULL_MIN_BODY_ROWS = 4;
const STARTUP_FULL_SAFE_PADDING_ROWS = 1;
export const transcriptContentIndent = 4; // 2 for DashCard border + 2 for prompt prefix
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 24;
const CONTENT_GUTTER = Object.freeze({ startsAfter: 99, share: 0.08, maximum: 12 });

export type LayoutMode = "compact" | "regular" | "expanded";
export type StartupHeaderMode = "large" | "compact" | "tiny";

export interface Layout {
  cols: number;
  rows: number;
  mode: LayoutMode;
}

export type PanelLayout = {
  mode: "compact" | "regular" | "expanded";
  availableRows: number;
  availableCols: number;
};

type BottomChromeBudget = {
  runtimeMetadataRows: number;
  composerRows: number;
  transientStatusRows: number;
  bottomPaddingRows: number;
  totalRows: number;
};

type AppLayoutBudget = {
  mode: LayoutMode;
  rows: number;
  cols: number;

  headerRows: number;
  headerGapRows: number;
  panelStagePaddingY: number;

  activePanelRows: number;
  activePanelCols: number;

  bottomChromeBudget: BottomChromeBudget;
  composerRows: number;

  showNormalLogo: boolean;
  showCompactHeader: boolean;
  placeMetadataBesideLogo: boolean;
  placeMetadataBelowLogo: boolean;
  transcriptRows: number;
  panelRows: number;
  showPanelColumnHeaders: boolean;
};

export const PanelAvailableRowsContext = createContext<number | undefined>(undefined);
export const AppLayoutBudgetContext = createContext<AppLayoutBudget | undefined>(undefined);
export const PanelLayoutContext = createContext<PanelLayout | undefined>(undefined);

export interface ActivePanelLayout {
  width: number;
  height: number;
  availableRows: number;
  availableCols: number;
}

export const ActivePanelLayoutContext = createContext<ActivePanelLayout | undefined>(undefined);

export function usePanelAvailableRows(): number | undefined {
  return useContext(PanelAvailableRowsContext);
}

export function useAppLayoutBudget(): AppLayoutBudget | undefined {
  return useContext(AppLayoutBudgetContext);
}

export function useActivePanelLayout(): ActivePanelLayout | undefined {
  return useContext(ActivePanelLayoutContext);
}

export function usePanelLayout(): PanelLayout | undefined {
  return useContext(PanelLayoutContext);
}

export interface TerminalViewport extends Layout {
  rawCols?: number;
  rawRows?: number;
  contentWidth: number;
  isCramped: boolean;
  unstable: boolean;
  layoutEpoch: number;
  isResizing: boolean;
}

// ─── Dimension helpers ────────────────────────────────────────────────────────

function isValidDimension(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (!isValidDimension(value)) {
    // If even the fallback is invalid, use an absolute floor.
    return isValidDimension(fallback) ? Math.floor(fallback) : 10;
  }

  return Math.floor(value);
}

function clampAllocation(value: number | undefined, fallback: number, limit: number): number {
  const resolved = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(limit, Math.max(0, Math.floor(resolved)));
}

function isRenderableViewport(cols: number | undefined, rows: number | undefined): boolean {
  return (
    isValidDimension(cols) &&
    isValidDimension(rows) &&
    Math.floor(cols) >= MIN_VIEWPORT_COLS &&
    Math.floor(rows) >= MIN_VIEWPORT_ROWS
  );
}

/** Returns true if the terminal is below the minimum supported size for a full UI. */
function isCrampedTerminal(cols: number | undefined, rows: number | undefined): boolean {
  const safeCols = normalizeDimension(cols, DEFAULT_COLUMNS);
  const safeRows = normalizeDimension(rows, DEFAULT_ROWS);
  return safeCols < MIN_TERMINAL_COLS || safeRows < MIN_TERMINAL_ROWS;
}

/**
 * Leave a 1-column gutter so box-drawing borders never land exactly on the
 * terminal edge, which can trigger a horizontal scrollbar in some Windows hosts.
 */
export function getShellWidth(cols: number | undefined): number {
  return Math.max(1, normalizeDimension(cols, DEFAULT_COLUMNS) - 1);
}

/**
 * Returns the responsive width of the main content area. Large/maximized
 * terminals retain a small gutter but continue growing with the viewport.
 */
export function getContentWidth(cols: number | undefined): number {
  const shellWidth = getShellWidth(cols);
  const gutter = Math.min(
    CONTENT_GUTTER.maximum,
    Math.round(Math.max(0, shellWidth - CONTENT_GUTTER.startsAfter) * CONTENT_GUTTER.share),
  );
  return shellWidth - gutter;
}

export function getUsableShellWidth(cols: number | undefined, reservedColumns = 0): number {
  const shellWidth = getShellWidth(cols);
  return Math.max(1, shellWidth - clampAllocation(reservedColumns, 0, shellWidth));
}

/**
 * Leave a 1-row gutter so renders do not land exactly on the terminal bottom
 * edge, which can trigger viewport scroll drift in some hosts.
 */
export function getShellHeight(rows: number | undefined): number {
  return Math.max(1, normalizeDimension(rows, DEFAULT_ROWS) - 1);
}

interface StartupHeaderModeParams {
  cols: number | undefined;
  rows: number | undefined;
  introRows: number;
  composerRows: number;
}

export function resolveStartupHeaderMode({
  cols,
  rows,
  introRows,
  composerRows,
}: StartupHeaderModeParams): StartupHeaderMode {
  const safeCols = normalizeDimension(cols, DEFAULT_COLUMNS);
  const safeRows = normalizeDimension(rows, DEFAULT_ROWS);

  if (safeCols < STARTUP_TINY_MIN_COLS || safeRows < STARTUP_TINY_MIN_ROWS) {
    return "tiny";
  }

  const shellHeight = getShellHeight(safeRows);
  const fullStartupRows =
    introRows + composerRows + STARTUP_FULL_MIN_BODY_ROWS + STARTUP_FULL_SAFE_PADDING_ROWS;

  if (safeCols >= STARTUP_FULL_MIN_COLS && shellHeight >= fullStartupRows) {
    return "large";
  }

  return "compact";
}

function computeMode(cols: number, rows: number): LayoutMode {
  if (rows <= 24 || cols <= 100) {
    return "compact";
  }
  if (cols >= 140 && rows >= 30) {
    return "expanded";
  }
  return "regular";
}

export function isDecorativeLayoutMode(mode: LayoutMode): boolean {
  return mode === "expanded";
}

interface AppLayoutBudgetParams {
  cols: number | undefined;
  rows: number | undefined;
  composerRows?: number;
  panelHintRows?: number;
  headerRows?: number;
  headerGapRows?: number;
}

export function computeAppLayoutBudget({
  cols,
  rows,
  composerRows,
  panelHintRows = 0,
  headerRows,
  headerGapRows,
}: AppLayoutBudgetParams): AppLayoutBudget {
  const safeCols = normalizeDimension(cols, DEFAULT_COLUMNS);
  const safeRows = normalizeDimension(rows, DEFAULT_ROWS);
  const mode = computeMode(safeCols, safeRows);
  const shellHeight = getShellHeight(safeRows);

  const showNormalLogo =
    process.env["UBUME_NO_ASCII_LOGO"] !== "1" &&
    (mode === "regular" || mode === "expanded" || (mode === "compact" && safeCols >= 72));

  const showCompactHeader = !showNormalLogo;

  const placeMetadataBesideLogo = showNormalLogo && safeCols >= 95;

  const placeMetadataBelowLogo = showNormalLogo && !placeMetadataBesideLogo;

  // Explicit measurements include the footer and bottom padding (see measureBottomComposerRows).
  const measuredBottomRows = clampAllocation(composerRows, mode === "compact" ? 4 : 6, shellHeight);
  const runtimeMetadataRows = measuredBottomRows > 0 ? 1 : 0;
  const transientStatusRows = 0;
  const bottomPaddingRows = mode === "compact" || measuredBottomRows <= 1 ? 0 : 1;
  const resolvedComposerRows = Math.max(
    0,
    measuredBottomRows - runtimeMetadataRows - bottomPaddingRows,
  );
  const afterComposer = Math.max(0, shellHeight - measuredBottomRows);
  const resolvedHeaderRows = clampAllocation(
    headerRows,
    showNormalLogo ? 6 : 1,
    Math.max(0, afterComposer - 1),
  );
  const resolvedHintRows = clampAllocation(
    panelHintRows,
    0,
    Math.max(0, afterComposer - resolvedHeaderRows - 1),
  );
  const remaining = Math.max(0, afterComposer - resolvedHeaderRows - resolvedHintRows);
  const resolvedHeaderGapRows = clampAllocation(
    headerGapRows,
    mode === "compact" ? 0 : 1,
    Math.max(0, remaining - 1),
  );
  const panelStagePaddingY = mode === "compact" || remaining - resolvedHeaderGapRows < 4 ? 0 : 1;
  const bottomChromeBudget: BottomChromeBudget = {
    runtimeMetadataRows,
    composerRows: resolvedComposerRows,
    transientStatusRows,
    bottomPaddingRows,
    totalRows: runtimeMetadataRows + resolvedComposerRows + transientStatusRows + bottomPaddingRows,
  };
  const baseReservedRows =
    resolvedHeaderRows +
    resolvedHeaderGapRows +
    panelStagePaddingY * 2 +
    bottomChromeBudget.totalRows +
    resolvedHintRows;

  const activePanelRows = Math.max(0, shellHeight - baseReservedRows);
  const contentWidth = getContentWidth(safeCols);

  const isCompact = mode === "compact";
  const borderRows = 2;
  const titleRows = 1;
  const headerRowsInPanel = isCompact ? 0 : 1;
  const panelChromeRows = borderRows + titleRows + headerRowsInPanel;
  const innerAvailableRows = Math.max(1, activePanelRows - panelChromeRows);

  const borderCols = 4;
  const innerAvailableCols = Math.max(1, contentWidth - borderCols);

  return {
    mode,
    rows: safeRows,
    cols: safeCols,
    headerRows: resolvedHeaderRows,
    headerGapRows: resolvedHeaderGapRows,
    panelStagePaddingY,
    activePanelRows: innerAvailableRows,
    activePanelCols: innerAvailableCols,
    bottomChromeBudget,
    composerRows: resolvedComposerRows,
    showNormalLogo,
    showCompactHeader,
    placeMetadataBesideLogo,
    placeMetadataBelowLogo,
    transcriptRows: activePanelRows,
    panelRows: innerAvailableRows,
    showPanelColumnHeaders: mode === "expanded",
  };
}

export function createLayoutSnapshot(
  cols: number | undefined,
  rows: number | undefined,
  fallback: Layout = {
    cols: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS,
    mode: computeMode(DEFAULT_COLUMNS, DEFAULT_ROWS),
  },
): TerminalViewport {
  const nextCols = normalizeDimension(cols, fallback.cols);
  const nextRows = normalizeDimension(rows, fallback.rows);

  const stableLayout = {
    cols: nextCols,
    rows: nextRows,
    mode: computeMode(nextCols, nextRows),
  };

  const isCramped = isCrampedTerminal(nextCols, nextRows);
  const contentWidth = getContentWidth(nextCols);

  return {
    ...stableLayout,
    contentWidth,
    isCramped,
    unstable: false,
    layoutEpoch: 0,
    isResizing: false,
  };
}

export function createTerminalViewport(
  cols: number | undefined,
  rows: number | undefined,
  fallback?: TerminalViewport,
  isResizing = false,
): TerminalViewport {
  const fallbackLayout = fallback
    ? { cols: fallback.cols, rows: fallback.rows, mode: fallback.mode }
    : undefined;
  const unstable = !isRenderableViewport(cols, rows);
  const stableLayout =
    unstable && fallbackLayout ? fallbackLayout : createLayoutSnapshot(cols, rows, fallbackLayout);

  const isCramped = isCrampedTerminal(stableLayout.cols, stableLayout.rows);
  const contentWidth = getContentWidth(stableLayout.cols);

  return {
    ...stableLayout,
    rawCols: cols,
    rawRows: rows,
    contentWidth,
    isCramped,
    unstable,
    layoutEpoch: fallback?.layoutEpoch ?? 0,
    isResizing,
  };
}

export function advanceTerminalViewport(
  current: TerminalViewport,
  cols: number | undefined,
  rows: number | undefined,
  isResizing = false,
): TerminalViewport {
  const next = createTerminalViewport(cols, rows, current, isResizing);

  if (process.env.UBUME_LAYOUT_DEBUG === "1") {
    renderDebug.traceEvent("layout", "advanceViewport", {
      cols: next.cols,
      rows: next.rows,
      contentWidth: next.contentWidth,
      isCramped: next.isCramped,
      isResizing: next.isResizing,
      mode: next.mode,
    });
  }

  if (!next.unstable && current.unstable) {
    return {
      ...next,
      layoutEpoch: current.layoutEpoch + 1,
    };
  }

  return {
    ...next,
    layoutEpoch: current.layoutEpoch,
  };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/** React hook — returns live layout that ignores transient invalid restore sizes. */
/**
 * Current terminal viewport, updated on stdout `resize`.
 *
 * The first notification commits immediately. A frame scheduler coalesces further
 * events without delaying updates until dragging stops. Invalid sizes retain the
 * last renderable viewport; all measurements come from this process's stdout.
 */
export function useTerminalViewport(): TerminalViewport {
  const { stdout } = useStdout();
  const [viewport, setViewport] = useState<TerminalViewport>(() =>
    createTerminalViewport(stdout.columns, stdout.rows),
  );

  useEffect(() => {
    const commit = (isResizing = false) => {
      setViewport((current) => {
        const nextViewport = advanceTerminalViewport(
          current,
          stdout.columns,
          stdout.rows,
          isResizing,
        );
        if (
          current.cols === nextViewport.cols &&
          current.rows === nextViewport.rows &&
          current.mode === nextViewport.mode &&
          current.unstable === nextViewport.unstable &&
          current.layoutEpoch === nextViewport.layoutEpoch &&
          current.rawCols === nextViewport.rawCols &&
          current.rawRows === nextViewport.rawRows &&
          current.isResizing === nextViewport.isResizing
        ) {
          renderDebug.traceFlickerEvent("measurementUpdate", {
            result: "skipped",
            cols: nextViewport.cols,
            rows: nextViewport.rows,
            mode: nextViewport.mode,
            unstable: nextViewport.unstable,
            isResizing: nextViewport.isResizing,
          });
          return current;
        }

        renderDebug.traceFlickerEvent("measurementUpdate", {
          result: "updated",
          cols: nextViewport.cols,
          rows: nextViewport.rows,
          mode: nextViewport.mode,
          unstable: nextViewport.unstable,
          isResizing: nextViewport.isResizing,
        });
        return nextViewport;
      });
    };

    const onResize = () => {
      renderDebug.traceEvent("terminal", "viewportHookResize", {
        cols: stdout.columns,
        rows: stdout.rows,
        renderable: isRenderableViewport(stdout.columns, stdout.rows),
      });
      renderDebug.traceLayoutValidity("useTerminalViewport", {
        rawCols: stdout.columns,
        rawRows: stdout.rows,
      });

      scheduler.request();
    };
    const scheduler = createResizeScheduler({
      intervalMs: RESIZE_INTERVAL_MS,
      commit: () => {
        setTerminalResizing(false);
        traceResize("dimensions", { cols: stdout.columns, rows: stdout.rows });
        commit(false);
      },
    });

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      scheduler.dispose();
      setTerminalResizing(false);
    };
  }, [stdout]);

  useEffect(() => {
    traceResize("reactCommit", { cols: viewport.rawCols, rows: viewport.rawRows });
  }, [viewport]);
  return viewport;
}

/**
 * Calculate available vertical rows for active panels, falling back to a layout-based
 * budget if availableRows is not explicitly provided.
 */
export function getAvailableRowsForPanel(layout: Layout, passedAvailableRows?: number): number {
  if (passedAvailableRows !== undefined) {
    return passedAvailableRows;
  }

  return computeAppLayoutBudget({ cols: layout.cols, rows: layout.rows }).panelRows;
}

/** Inputs for {@link resolvePickerPanelGeometry}; every layout source is optional. */
export interface PickerPanelGeometryInput {
  /** Terminal layout; when absent a 120×24 regular terminal is assumed. */
  layout?: Layout & { contentWidth?: number };
  /** Explicit panel layout (prop), which wins over everything else. */
  panelLayout?: PanelLayout;
  /** Panel layout provided by `AppShell` through `PanelLayoutContext`. */
  contextPanelLayout?: PanelLayout;
  /** Measured panel box (prop, else `ActivePanelLayoutContext`). */
  activePanelLayout?: ActivePanelLayout;
  /** Explicit row budget (prop, else `PanelAvailableRowsContext`). */
  availableRows?: number;
  /** Smallest outer panel width when it is derived from the terminal width. */
  minPanelWidth: number;
  /** Smallest usable column count when it is derived from the terminal width. */
  minAvailableCols: number;
}

/** Resolved size of a picker panel. */
export interface PickerPanelGeometry {
  shellWidth: number;
  panelLayout: PanelLayout;
  /** Outer width of the bordered panel. */
  panelWidth: number;
  /** Usable text width inside the panel's border and padding. */
  innerWidth: number;
}

const FALLBACK_PICKER_LAYOUT: Layout & { contentWidth?: number } = {
  cols: 120,
  rows: DEFAULT_ROWS,
  mode: "regular",
};

/**
 * Resolves how much room a picker panel (model or provider picker) has.
 *
 * Precedence for the panel layout: explicit `panelLayout` prop → the shell's
 * `PanelLayoutContext` → derived from the measured panel box, or, failing that,
 * from the terminal size. Panels mounted by `AppShell` always receive the context;
 * the fallbacks keep a picker usable when it is rendered on its own (tests,
 * isolated previews).
 */
export function resolvePickerPanelGeometry(input: PickerPanelGeometryInput): PickerPanelGeometry {
  const layout = input.layout ?? FALLBACK_PICKER_LAYOUT;
  const active = input.activePanelLayout;
  const shellWidth = getShellWidth(layout.cols);

  let panelLayout = input.panelLayout ??
    input.contextPanelLayout ?? {
      mode: layout.mode,
      availableRows: active
        ? active.availableRows
        : getAvailableRowsForPanel(layout, input.availableRows),
      availableCols: active
        ? active.availableCols
        : Math.max(input.minAvailableCols, shellWidth - 4),
    };

  const desiredPanelWidth = active
    ? active.width
    : Math.max(input.minPanelWidth, Math.min(layout.contentWidth ?? shellWidth, shellWidth - 2));
  // 4 = round border (2) + paddingX={1} on both sides (2). The reservation is kept
  // even when a very short terminal makes the provider picker drop its border.
  const panelWidth = Math.max(1, clampAllocation(desiredPanelWidth, shellWidth, shellWidth));
  const innerWidth = Math.max(
    1,
    clampAllocation(
      panelLayout.availableCols,
      Math.max(1, panelWidth - 4),
      Math.max(1, panelWidth - 4),
    ),
  );
  if (panelLayout.availableCols !== innerWidth)
    panelLayout = { ...panelLayout, availableCols: innerWidth };

  return { shellWidth, panelLayout, panelWidth, innerWidth };
}

/**
 * {@link resolvePickerPanelGeometry} with the shell's layout contexts filled in.
 * Explicit props passed in `input` take precedence over the contexts.
 */
export function usePickerPanelGeometry(
  input: Omit<PickerPanelGeometryInput, "contextPanelLayout">,
): PickerPanelGeometry {
  const contextPanelLayout = usePanelLayout();
  const contextActiveLayout = useActivePanelLayout();
  const contextAvailableRows = usePanelAvailableRows();
  return resolvePickerPanelGeometry({
    ...input,
    contextPanelLayout,
    activePanelLayout: input.activePanelLayout ?? contextActiveLayout,
    availableRows: input.availableRows ?? contextAvailableRows,
  });
}
