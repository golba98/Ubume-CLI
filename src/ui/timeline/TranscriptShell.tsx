/**
 * Main-screen transcript: finalized content in Ink `<Static>` (written once to
 * the terminal's native scrollback) plus a live region for the running turn,
 * followed by the notice line and the composer.
 *
 * Data flow: events → render items (`timelineItems.ts`) → measured rows. The
 * static half is built incrementally by `staticTranscriptCache.ts`; the live
 * half (running turn only) is rebuilt per flush by `buildNativeTranscriptParts`
 * and tail-windowed by `windowLiveRows`. Rows render through `TimelineRowView`.
 *
 * Height constraints (all row-count math, valid only because each measured row
 * is one terminal line):
 * - Live output must stay strictly shorter than the terminal; otherwise Ink
 *   clears screen + scrollback on every frame (see `liveViewportWindow.ts`).
 * - A spacer pads short transcripts so the composer sits at the bottom.
 *
 * Remount boundaries: the outer component keys the inner one on `clearCount`
 * and `repaintGeneration`, so `/clear` and width repaints get a fresh
 * `<Static>` and a fresh static cache. Screen clearing itself is owned by
 * `core/terminal/clearFrameBoundary.ts`, not by this component. While hidden
 * behind an overlay (`visible === false`) the last visible events/UI state are
 * held, so streaming updates do not rebuild the transcript rows while hidden.
 */
import { Box, Static, Text, useStdout } from "ink";
import type React from "react";
import { memo, useEffect, useMemo, useRef } from "react";
import type { RuntimeSummary } from "../../config/runtimeConfig.js";
import type { StartupHeaderMiddleLine, StartupLogoRendering } from "../../config/settings.js";
import { formatWorkspaceBrandingPath, type StartupLogoStyle } from "../../config/settings.js";
import type { CodexAuthState } from "../../core/codex/codexAuth.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { TimelineEvent, UIState } from "../../session/types.js";
import {
  getShellHeight,
  getShellWidth,
  resolveStartupHeaderMode,
  type TerminalViewport,
} from "../layout.js";
import {
  LOGO_COMPACT,
  LOGO_COMPACT_MIN_COLS,
  LOGO_LARGE,
  LOGO_MEDIUM,
  selectLogoVariant,
} from "../render/logoVariants.js";
import { StartupGraphicRow } from "../render/StartupGraphicRow.js";
import {
  type StartupLogoAnimationFrame,
  shouldPlayStartupAnimation,
} from "../render/startupAnimation.js";
import { type StartupLogoSize, selectStartupLogoSize } from "../render/startupLogoLayout.js";
import { useStartupLogoAnimation } from "../render/useStartupLogoAnimation.js";
import { useStartupLogoGraphic } from "../render/useStartupLogoGraphic.js";
import { useTheme } from "../theme.js";
import { LIVE_WINDOW_SAFETY_ROWS, windowLiveRows } from "./liveViewportWindow.js";
import { wrapRows } from "./measure/rows.js";
import { buildCompactStartupRows } from "./measure/startupBrandingRows.js";
import {
  buildStaticTranscript,
  createStaticTranscriptCache,
  type StaticTranscriptCache,
} from "./staticTranscriptCache.js";
import { TimelineRowView } from "./TimelineRows.js";
import {
  buildActiveRenderItems,
  buildIntroRenderItem,
  buildStaticRenderItems,
  buildTimelineItems,
} from "./timelineItems.js";
import {
  buildNativeTranscriptParts,
  type NativeTranscriptRowItem,
  type TimelineRow,
} from "./timelineMeasure.js";

interface TranscriptShellProps {
  layout: TerminalViewport;
  authState: CodexAuthState;
  workspaceLabel: string;
  workspaceRoot?: string | null;
  runtimeSummary?: RuntimeSummary | null;
  /** Startup branding presentation (`normal` banner by default). */
  logoStyle?: StartupLogoStyle;
  startupAnimation?: boolean;
  onStartupLiveChange?: (live: boolean) => void;
  startupHeaderMiddleLine?: StartupHeaderMiddleLine;
  startupLogoRendering?: StartupLogoRendering;
  startupModelLabel?: string | null;
  startupUsageLabel?: string | null;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
  composer: React.ReactNode;
  composerRows?: number;
  notice?: string | null;
  verboseMode?: boolean;
  clearCount?: number;
  repaintGeneration?: number;
  visible?: boolean;
}

export function isTranscriptEvent(event: TimelineEvent): boolean {
  return (
    event.type === "user" ||
    event.type === "assistant" ||
    event.type === "run" ||
    event.type === "shell"
  );
}

function isHomeScreenState({
  staticEvents,
  activeEvents,
  uiState,
}: {
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
}): boolean {
  return (
    uiState.kind === "IDLE" &&
    !staticEvents.some(isTranscriptEvent) &&
    !activeEvents.some(isTranscriptEvent)
  );
}

// Startup tracing only: names the logo variant for the "homeRender" debug event.
function getLogoVariantName(
  rows: readonly string[],
): "large" | "medium" | "compact" | "wordmark" | "none" {
  if (rows.length === 0) return process.env["UBUME_NO_ASCII_LOGO"] === "1" ? "none" : "wordmark";
  if (rows === LOGO_LARGE || rows.join("\n") === LOGO_LARGE.join("\n")) return "large";
  if (rows === LOGO_MEDIUM || rows.join("\n") === LOGO_MEDIUM.join("\n")) return "medium";
  if (rows === LOGO_COMPACT || rows.join("\n") === LOGO_COMPACT.join("\n")) return "compact";
  return "wordmark";
}

function getLogoHiddenReason({
  startupHeaderMode,
  logoVariant,
  width,
}: {
  startupHeaderMode: ReturnType<typeof resolveStartupHeaderMode>;
  logoVariant: ReturnType<typeof getLogoVariantName>;
  width: number;
}): string | null {
  if (startupHeaderMode === "tiny") return "terminal-too-small";
  if (process.env["UBUME_NO_ASCII_LOGO"] === "1") return "UBUME_NO_ASCII_LOGO";
  if (logoVariant === "wordmark") return `no-ascii-variant-fits-width-${width}`;
  if (logoVariant === "none") return `no-logo-variant-fits-width-${width}`;
  return null;
}

function TranscriptShellInner({
  layout,
  authState,
  workspaceLabel,
  workspaceRoot = null,
  runtimeSummary = null,
  logoStyle = "normal",
  startupHeaderMiddleLine = "provider",
  startupModelLabel = null,
  startupUsageLabel = null,
  staticEvents,
  activeEvents,
  uiState,
  composer,
  composerRows,
  notice = null,
  verboseMode = false,
  clearCount = 0,
  visible = true,
  logoFrame,
  logoImageId,
  logoSize,
  onStartupLiveChange,
  presentation,
}: TranscriptShellProps & {
  logoFrame: StartupLogoAnimationFrame;
  logoImageId: number | null;
  logoSize: StartupLogoSize | null;
  presentation: { committed: boolean };
}) {
  const theme = useTheme();
  const startupHeaderMode = useMemo(
    () =>
      resolveStartupHeaderMode({
        cols: layout.cols,
        rows: layout.rows,
        introRows: 8,
        composerRows: composerRows ?? 5,
      }),
    [composerRows, layout.cols, layout.rows],
  );
  const homeScreenActive = visible && isHomeScreenState({ staticEvents, activeEvents, uiState });
  const compactStyle = isCompactLogoStyle(logoStyle);
  const shellWidth = compactStyle ? getCompactShellWidth(layout.cols) : getShellWidth(layout.cols);
  const introInnerWidth = Math.max(compactStyle ? 1 : 10, shellWidth - 2);
  const selectedLogoRows =
    startupHeaderMode === "tiny"
      ? []
      : startupHeaderMode === "large"
        ? selectLogoVariant(introInnerWidth)
        : introInnerWidth >= LOGO_COMPACT_MIN_COLS
          ? LOGO_COMPACT
          : [];
  const selectedLogoVariant = getLogoVariantName(selectedLogoRows);
  const logoHiddenReason = getLogoHiddenReason({
    startupHeaderMode,
    logoVariant: selectedLogoVariant,
    width: introInnerWidth,
  });
  const startupTraceKeyRef = useRef<string | null>(null);
  // Stable snapshot of the transcript inputs; hold the last visible one while
  // an overlay hides the shell. Identity only changes when the reducer
  // replaces one of these arrays, never on a keystroke or a stream flush.
  const liveTranscript = useMemo(
    () => ({ staticEvents, activeEvents, uiState }),
    [staticEvents, activeEvents, uiState],
  );
  const visibleTranscriptRef = useRef(liveTranscript);
  if (visible) {
    visibleTranscriptRef.current = liveTranscript;
  }
  const renderedTranscript = visibleTranscriptRef.current;
  const renderedStaticEvents = renderedTranscript.staticEvents;
  const renderedActiveEvents = renderedTranscript.activeEvents;
  const renderedUiState = renderedTranscript.uiState;
  // Keep compact branding reactive while the whole body fits the live viewport.
  // Once committed, Static remains monotonic across resizes; /clear resets it.
  const conversationViewportRows = getConversationViewportRows(layout.rows, composerRows, notice);

  const staticTimelineItems = useMemo(
    () => buildTimelineItems(renderedStaticEvents),
    [renderedStaticEvents],
  );
  const activeTimelineItems = useMemo(
    () => buildTimelineItems(renderedActiveEvents),
    [renderedActiveEvents],
  );
  const staticTurnIds = useMemo(
    () => staticTimelineItems.flatMap((item) => (item.type === "turn" ? [item.turnId] : [])),
    [staticTimelineItems],
  );
  const activeTurnIds = useMemo(
    () => activeTimelineItems.flatMap((item) => (item.type === "turn" ? [item.turnId] : [])),
    [activeTimelineItems],
  );
  const allTurnIds = useMemo(
    () => [...staticTurnIds, ...activeTurnIds],
    [staticTurnIds, activeTurnIds],
  );
  const activeTurnId = activeTurnIds[0] ?? null;

  // Normal remains static from its first frame. Compact branding and startup
  // notices stay live with short conversations, then enter scrollback together
  // when the complete body no longer fits. Theme changes recolor the live header.
  const introItem = useMemo(
    () =>
      buildIntroRenderItem({
        authState,
        workspaceLabel,
        layout,
        providerLabel: runtimeSummary?.providerLabel ?? null,
        modelLabel: runtimeSummary?.modelLabel ?? runtimeSummary?.model ?? null,
        workspacePath: formatWorkspaceBrandingPath(workspaceRoot),
        logoStyle,
        middleLine: startupHeaderMiddleLine,
        startupModelLabel,
        usageLabel: startupUsageLabel,
        startupHeaderMode,
        logoSize,
      }),
    [
      authState,
      layout,
      logoSize,
      logoStyle,
      startupHeaderMiddleLine,
      startupModelLabel,
      startupUsageLabel,
      runtimeSummary?.modelLabel,
      runtimeSummary?.model,
      runtimeSummary?.providerLabel,
      startupHeaderMode,
      workspaceLabel,
      workspaceRoot,
    ],
  );

  // Static half: intro + finalized turns, built incrementally. The cache ref
  // lives in this keyed instance, so /clear and width repaints (which remount
  // the shell) start from an empty cache.
  const staticCacheRef = useRef<StaticTranscriptCache | null>(null);
  const staticTranscript = useMemo(() => {
    const cache =
      staticCacheRef.current ?? (staticCacheRef.current = createStaticTranscriptCache());
    return buildStaticTranscript(
      cache,
      [
        introItem,
        ...buildStaticRenderItems(staticTimelineItems, allTurnIds, activeTurnId, null, null),
      ],
      { totalWidth: shellWidth, verboseMode, workspaceRoot },
    );
  }, [
    activeTurnId,
    allTurnIds,
    introItem,
    shellWidth,
    staticTimelineItems,
    verboseMode,
    workspaceRoot,
  ]);

  // Live half: only the running turn, rebuilt per streaming flush.
  const activeTranscript = useMemo(
    () =>
      buildNativeTranscriptParts(
        buildActiveRenderItems(activeTimelineItems, allTurnIds, renderedUiState),
        {
          totalWidth: shellWidth,
          verboseMode,
          debugLabel: "transcript-shell-native",
          workspaceRoot,
        },
      ),
    [activeTimelineItems, allTurnIds, renderedUiState, shellWidth, verboseMode, workspaceRoot],
  );

  const nativeTranscript = useMemo(
    () => ({
      staticItems: [...staticTranscript.staticItems, ...activeTranscript.staticItems],
      liveRows: [...staticTranscript.liveRows, ...activeTranscript.liveRows],
    }),
    [activeTranscript, staticTranscript],
  );
  const liveWindowRows = Math.max(1, conversationViewportRows - LIVE_WINDOW_SAFETY_ROWS);
  const bodyRows =
    nativeTranscript.staticItems.reduce((sum, item) => sum + item.rows.length, 0) +
    nativeTranscript.liveRows.length;
  // Commit once the complete header/body no longer fits; Static never shrinks.
  if (
    compactStyle &&
    bodyRows > liveWindowRows &&
    (renderedStaticEvents.some(isTranscriptEvent) || renderedActiveEvents.some(isTranscriptEvent))
  )
    presentation.committed = true;
  const compactHome = compactStyle && !presentation.committed;
  onStartupLiveChange?.(compactHome && visible);
  const committedRows = useMemo(
    () =>
      compactHome
        ? 0
        : nativeTranscript.staticItems.reduce((total, item) => total + item.rows.length, 0),
    [compactHome, nativeTranscript.staticItems],
  );
  // The whole running turn is measured live (see appendNativeTurnParts), but
  // only its tail is rendered: Ink clears the terminal *and scrollback* on any
  // frame whose live output exceeds the viewport, which yanks a user who
  // scrolled up back to the bottom on every streaming tick. The full turn is
  // committed to <Static> at finalize, so nothing is lost from scrollback.
  const visibleLiveRows = useMemo(() => {
    if (!compactHome) return windowLiveRows(nativeTranscript.liveRows, liveWindowRows);
    const header = wrapRows(
      buildCompactStartupRows(introItem, introInnerWidth, logoFrame)!,
      shellWidth,
      true,
      introItem.key,
      true,
    );
    const headerRows = header.slice(0, liveWindowRows);
    const notices = nativeTranscript.staticItems
      .filter((item) => item.key !== introItem.key)
      .flatMap((item) => item.rows);
    const body = [...notices, ...nativeTranscript.liveRows];
    return [...headerRows, ...windowLiveRows(body, liveWindowRows - headerRows.length)];
  }, [
    compactHome,
    introItem,
    introInnerWidth,
    logoFrame,
    shellWidth,
    liveWindowRows,
    nativeTranscript,
  ]);
  const liveRowsHidden = compactHome
    ? 0
    : nativeTranscript.liveRows.length - visibleLiveRows.length;
  // Bottom-align the composer while the transcript is shorter than the screen.
  const spacerRows = Math.max(0, conversationViewportRows - committedRows - visibleLiveRows.length);

  useEffect(() => {
    const nextKey = [
      layout.cols,
      layout.rows,
      layout.mode,
      startupHeaderMode,
      homeScreenActive ? "home" : "transcript",
      staticEvents.length,
      activeEvents.length,
      uiState.kind,
      selectedLogoVariant,
      clearCount,
    ].join("|");
    if (startupTraceKeyRef.current === nextKey) return;
    startupTraceKeyRef.current = nextKey;
    renderDebug.traceEvent("startup", "homeRender", {
      cols: layout.cols,
      rows: layout.rows,
      layoutMode: layout.mode,
      activeRoot: "TranscriptShell",
      messageCount: [...staticEvents, ...activeEvents].filter(isTranscriptEvent).length,
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      uiStateKind: uiState.kind,
      selectedLayoutMode: startupHeaderMode,
      selectedLogoVariant,
      logoBranchSelected: selectedLogoVariant !== "none" && selectedLogoVariant !== "wordmark",
      logoHiddenReason,
      composerCount: visible ? 1 : 0,
      footerCount: visible ? 1 : 0,
      homeScreenRendererUsed: homeScreenActive,
      staticItemCount: staticEvents.length,
      liveRowCount: activeEvents.length,
      liveRowsHidden,
      clearCount,
    });
  }, [
    activeEvents,
    clearCount,
    homeScreenActive,
    layout.cols,
    layout.mode,
    layout.rows,
    liveRowsHidden,
    logoHiddenReason,
    selectedLogoVariant,
    startupHeaderMode,
    staticEvents,
    uiState.kind,
    visible,
  ]);

  return (
    <Box flexDirection="column" width="100%" display={visible ? "flex" : "none"}>
      <Static
        key={`native-static-${clearCount}`}
        items={compactHome ? [] : nativeTranscript.staticItems}
      >
        {(item: NativeTranscriptRowItem) => <NativeRowsItem key={item.key} rows={item.rows} />}
      </Static>
      {compactHome && (
        <NativeRowsItem rows={visibleLiveRows} logoImageId={logoImageId} logoSize={logoSize} />
      )}
      {spacerRows > 0 && <Box height={spacerRows} />}
      {!compactHome && <NativeRowsItem rows={visibleLiveRows} />}

      {visible && notice && (
        <Box width="100%" paddingX={1}>
          <Text color={theme.success} wrap="truncate">
            {notice}
          </Text>
        </Box>
      )}
      {visible && composer}
    </Box>
  );
}

function isCompactLogoStyle(style: StartupLogoStyle | undefined): boolean {
  return style === "minimal" || style === "simple";
}
/** Compact styles never let the shell reach the terminal's last column. */
function getCompactShellWidth(cols: number): number {
  return Math.max(1, Math.min(getShellWidth(cols), cols - 1));
}
function getConversationViewportRows(
  rows: number,
  composerRows: number | undefined,
  notice: string | null | undefined,
): number {
  return Math.max(2, getShellHeight(rows) - (composerRows ?? 0) - (notice ? 1 : 0));
}
/** Rows the live header leaves for startup notices so they are never windowed out entirely. */
const STARTUP_BODY_RESERVE_ROWS = 1;

/** Main-chat transcript + composer; remounted per `/clear` and width repaint (see below). */
export const TranscriptShell = memo(function TranscriptShell(props: TranscriptShellProps) {
  const { stdout } = useStdout();
  const presentation = useRef({ clearCount: props.clearCount, committed: false });
  if (presentation.current.clearCount !== props.clearCount)
    presentation.current = { clearCount: props.clearCount, committed: false };
  // The mark's size lives above the resize/clear remount: it is the hysteresis
  // baseline for the next resize, and freezes once the header enters scrollback
  // (Static never re-renders, so a later size could not apply to it anyway).
  const logoSizeRef = useRef<StartupLogoSize | null>(null);
  if (isCompactLogoStyle(props.logoStyle) && !presentation.current.committed) {
    const { cols, rows } = props.layout;
    const liveWindowRows =
      getConversationViewportRows(rows, props.composerRows, props.notice) - LIVE_WINDOW_SAFETY_ROWS;
    logoSizeRef.current = selectStartupLogoSize({
      innerWidth: getCompactShellWidth(cols) - 2,
      terminalRows: rows,
      availableRows: liveWindowRows - STARTUP_BODY_RESERVE_ROWS,
      metadataRows: props.startupHeaderMiddleLine === "hidden" ? 2 : 3,
      previous: logoSizeRef.current,
    });
  }
  const logoSize = isCompactLogoStyle(props.logoStyle) ? logoSizeRef.current : null;
  const canAnimate =
    props.visible !== false &&
    !props.staticEvents.some(isTranscriptEvent) &&
    !props.activeEvents.some(isTranscriptEvent) &&
    props.uiState.kind === "IDLE" &&
    shouldPlayStartupAnimation({
      stdout: { isTTY: stdout.isTTY },
      env: process.env,
      logoStyle: props.logoStyle ?? "normal",
      animationEnabled: props.startupAnimation ?? true,
      logoSize,
    });
  const logoFrame = useStartupLogoAnimation(canAnimate);
  // Keep raster state above the resize/clear remount, just like animation state.
  const logoImageId = useStartupLogoGraphic(
    logoFrame,
    props.startupLogoRendering ?? "auto",
    logoSize !== null && props.visible !== false && !presentation.current.committed,
    undefined,
    logoSize ?? undefined,
  );
  // repaintGeneration must fold into the outer remount key (not just <Static>'s
  // own key) — Ink only reliably re-flushes already-printed <Static> content on
  // a genuine fresh mount of the whole subtree, confirmed empirically: keying
  // away only the inner <Static> node did not trigger Ink's isStaticDirty/
  // onImmediateRender escape hatch the same way a full remount does.
  return (
    <TranscriptShellInner
      key={`clear-${props.clearCount ?? 0}-repaint-${props.repaintGeneration ?? 0}`}
      {...props}
      logoFrame={logoFrame}
      logoImageId={logoImageId}
      logoSize={logoSize}
      presentation={presentation.current}
    />
  );
});

/** A column of measured rows, one Ink line each. */
function NativeRowsItem({
  rows,
  logoImageId = null,
  logoSize = null,
}: {
  rows: TimelineRow[];
  logoImageId?: number | null;
  logoSize?: StartupLogoSize | null;
}) {
  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        const match = /-compact-(\d+)$/.exec(row.key);
        const index = match ? Number(match[1]) : -1;
        return logoImageId !== null && logoSize && index >= 0 && index < logoSize.rows ? (
          <StartupGraphicRow
            key={row.key}
            row={row}
            imageId={logoImageId}
            index={index}
            size={logoSize}
          />
        ) : (
          <TimelineRowView key={row.key} row={row} />
        );
      })}
    </Box>
  );
}
