/**
 * Debug-only tracing for rendering and layout (enabled with UBUME debug
 * environment flags; see core/perf/renderDebug). Nothing here changes app
 * behaviour: startup timing, render counts, UI-state transitions, blank
 * frames and root measurement changes are only logged.
 */

import { useEffect, useRef } from "react";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { PlanFlowState } from "../../session/planFlow.js";
import type { Screen, TimelineEvent, UIState } from "../../session/types.js";
import type { InterruptHint } from "../../ui/chrome/composer/composerModel.js";
import type { StartupHeaderMode, TerminalViewport } from "../../ui/layout.js";

interface UseAppDebugTracingContext {
  terminalLayout: TerminalViewport;
  activeRootComponent: "TranscriptShell" | "AppShell";
  screen: Screen;
  startupHeaderMode: StartupHeaderMode;
  staticEvents: TimelineEvent[];
  activeEvents: TimelineEvent[];
  uiState: UIState;
  inputValue: string;
  interruptHint: InterruptHint | null;
  cursor: number;
  busy: boolean;
  composerRows: number;
  planFlow: PlanFlowState;
  mode: "suggest" | "auto-edit" | "full-auto";
  model: string;
  reasoningLevel: string;
}

export function useAppDebugTracing(context: UseAppDebugTracingContext) {
  const {
    terminalLayout,
    activeRootComponent,
    screen,
    startupHeaderMode,
    staticEvents,
    activeEvents,
    uiState,
    inputValue,
    interruptHint,
    cursor,
    busy,
    composerRows,
    planFlow,
    mode,
    model,
    reasoningLevel,
  } = context;

  const previousStartupTraceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const nextKey = [
      terminalLayout.cols,
      terminalLayout.rows,
      terminalLayout.mode,
      activeRootComponent,
      screen,
      startupHeaderMode,
      staticEvents.length,
      activeEvents.length,
      uiState.kind,
    ].join("|");
    if (previousStartupTraceKeyRef.current === nextKey) return;
    previousStartupTraceKeyRef.current = nextKey;
    renderDebug.traceEvent("startup", "state", {
      cols: terminalLayout.cols,
      rows: terminalLayout.rows,
      layoutMode: terminalLayout.mode,
      activeRoot: activeRootComponent,
      screen,
      startupHeaderMode,
      logoBranchSelected: startupHeaderMode === "large",
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      uiStateKind: uiState.kind,
    });
  }, [
    activeEvents.length,
    activeRootComponent,
    screen,
    startupHeaderMode,
    staticEvents.length,
    terminalLayout.cols,
    terminalLayout.mode,
    terminalLayout.rows,
    uiState.kind,
  ]);

  renderDebug.useRenderDebug("Root", {
    screen,
    activeRoot: activeRootComponent,
    uiStateKind: uiState.kind,
    staticEvents,
    activeEvents,
    activeEventsLength: activeEvents.length,
    inputValue,
    interruptHint,
    cursor,
    busy,
    composerRows,
    startupHeaderMode,
    logoBranchSelected: startupHeaderMode === "large",
    cols: terminalLayout.cols,
    rows: terminalLayout.rows,
    layoutMode: terminalLayout.mode,
    layoutEpoch: terminalLayout.layoutEpoch,
    planFlowKind: planFlow.kind,
    mode,
    model,
    reasoningLevel,
  });
  renderDebug.useLifecycleDebug("App", {
    screen,
    uiStateKind: uiState.kind,
  });
  renderDebug.traceLayoutValidity("Root", {
    cols: terminalLayout.cols,
    rows: terminalLayout.rows,
    rawCols: terminalLayout.rawCols,
    rawRows: terminalLayout.rawRows,
    composerRows,
  });
  const previousUiStateKindRef = useRef(uiState.kind);
  useEffect(() => {
    const previousKind = previousUiStateKindRef.current;
    if (previousKind !== uiState.kind) {
      renderDebug.traceStateTransition({
        component: "App",
        prevKind: previousKind,
        nextKind: uiState.kind,
        activeEventsLength: activeEvents.length,
        staticEventsLength: staticEvents.length,
        screen,
      });
      previousUiStateKindRef.current = uiState.kind;
    }
  }, [activeEvents.length, screen, staticEvents.length, uiState.kind]);
  const previousEventCountRef = useRef(staticEvents.length + activeEvents.length);
  useEffect(() => {
    const previousCount = previousEventCountRef.current;
    const nextCount = staticEvents.length + activeEvents.length;
    if (previousCount > 0 && nextCount === 0) {
      renderDebug.traceBlankFrame("Root", {
        reason: "event-count-dropped-to-zero",
        previousCount,
        staticEventsLength: staticEvents.length,
        activeEventsLength: activeEvents.length,
        uiStateKind: uiState.kind,
        screen,
      });
    }
    previousEventCountRef.current = nextCount;
  }, [activeEvents.length, screen, staticEvents.length, uiState.kind]);
  const previousRootMeasurements = useRef<{
    composerRows: number;
    cols: number;
    rows: number;
    layoutEpoch: number;
  } | null>(null);
  useEffect(() => {
    const previous = previousRootMeasurements.current;
    const changed: string[] = [];
    if (!previous) {
      changed.push("mount");
    } else {
      if (previous.composerRows !== composerRows) changed.push("composerRows");
      if (previous.cols !== terminalLayout.cols) changed.push("width");
      if (previous.rows !== terminalLayout.rows) changed.push("height");
      if (previous.layoutEpoch !== terminalLayout.layoutEpoch) changed.push("layoutEpoch");
    }
    if (changed.length > 0) {
      renderDebug.traceEvent("layout", "rootMeasurementUpdate", {
        reason: changed.join(","),
        composerRows,
        cols: terminalLayout.cols,
        rows: terminalLayout.rows,
        layoutEpoch: terminalLayout.layoutEpoch,
      });
    }
    previousRootMeasurements.current = {
      composerRows,
      cols: terminalLayout.cols,
      rows: terminalLayout.rows,
      layoutEpoch: terminalLayout.layoutEpoch,
    };
  }, [composerRows, terminalLayout.cols, terminalLayout.layoutEpoch, terminalLayout.rows]);
}
