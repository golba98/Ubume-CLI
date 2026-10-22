import type { StartupHeaderMiddleLine } from "../../config/settings.js";
/**
 * First stage of timeline rendering: session events → render items.
 *
 * Groups `TimelineEvent`s into turns (by `turnId`) and standalone events, then
 * decorates them as keyed `RenderTimelineItem`s with per-render state (turn
 * opacity, run phase, pending question). Both `Timeline` and `TranscriptShell`
 * build their items here before handing them to measurement. Also provides
 * small `UIState` predicates used for viewport/finalize bookkeeping.
 *
 * Item keys (`turn-<turnId>`, `event-<id>`, `ubume-intro`) prefix every row
 * and cache key downstream, so they must stay stable. Pure; no caching.
 */

import type { StartupLogoStyle } from "../../config/settings.js";
import { APP_VERSION } from "../../config/settings.js";
import type { CodexAuthState } from "../../core/codex/codexAuth.js";
import { getAuthStateLabel } from "../../core/codex/codexAuth.js";
import { formatUbumeVersionLabel } from "../../core/version/channel.js";
import {
  getRunPlanText,
  type RunEvent,
  type TimelineEvent,
  type UIState,
} from "../../session/types.js";
import type { Layout, StartupHeaderMode } from "../layout.js";
import type { StartupLogoSize } from "../render/startupLogoLayout.js";

import type {
  IntroRenderTimelineItem,
  RenderTimelineItem,
  StandaloneTimelineEvent,
  TimelineItem,
  TurnTimelineItem,
} from "./measure/types.js";
import { resolveTurnRunPhase, type TurnOpacity } from "./TurnGroup.js";

// ─── Viewport helpers ────────────────────────────────────────────────────────

export function isStandaloneEvent(event: TimelineEvent): event is StandaloneTimelineEvent {
  return event.type === "system" || event.type === "error" || event.type === "shell";
}

/** The turn the UI state is about (thinking, responding, awaiting action, error…), or null. */
export function getActiveTurnId(uiState: UIState): number | null {
  return uiState.kind === "THINKING" ||
    uiState.kind === "RESPONDING" ||
    uiState.kind === "ANSWER_VISIBLE" ||
    uiState.kind === "AWAITING_USER_ACTION" ||
    uiState.kind === "ERROR"
    ? uiState.turnId
    : null;
}

export function isBusyUiState(uiState: UIState): boolean {
  return (
    uiState.kind === "THINKING" ||
    uiState.kind === "RESPONDING" ||
    uiState.kind === "ANSWER_VISIBLE" ||
    uiState.kind === "SHELL_RUNNING"
  );
}

export function getRunningTurnIds(events: TimelineEvent[]): number[] {
  return events
    .filter((event): event is RunEvent => event.type === "run" && event.status === "running")
    .map((event) => event.turnId);
}

export function getFinalizedTurnIds(events: TimelineEvent[]): number[] {
  return events
    .filter((event): event is RunEvent => event.type === "run" && event.status !== "running")
    .map((event) => event.turnId);
}

/**
 * True when the most recent finished run's last stream item is a completed,
 * non-empty plan. `Timeline` uses it to skip finalize-continuity anchoring, so
 * a run that ends in a plan keeps following the tail.
 */
export function latestFinalizedRunEndsWithPlan(events: TimelineEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "run" || event.status === "running") {
      continue;
    }

    const lastStreamItem = (event.streamItems ?? [])
      .slice()
      .sort((left, right) => left.streamSeq - right.streamSeq)
      .at(-1);
    return (
      lastStreamItem?.kind === "plan" &&
      event.plan?.status === "completed" &&
      getRunPlanText(event.plan).trim().length > 0
    );
  }

  return false;
}

/**
 * Detect the commit where a run finalizes: the UI went from busy to not busy
 * and some previously running turn is now among the finalized ones.
 */
export function hasFinalizeTransition(params: {
  previousRunningTurnIds: number[];
  nextRunningTurnIds: number[];
  nextFinalizedTurnIds: number[];
  previousBusy: boolean;
  nextBusy: boolean;
}): boolean {
  if (!params.previousBusy || params.nextBusy) return false;
  return params.previousRunningTurnIds.some(
    (turnId) =>
      !params.nextRunningTurnIds.includes(turnId) && params.nextFinalizedTurnIds.includes(turnId),
  );
}

// ─── Timeline item builders ───────────────────────────────────────────────────

/**
 * Group events into turn items (in first-appearance order) and standalone
 * system/error/shell items. Turns without a user prompt are dropped, so
 * `turnIndex` numbering counts every turn seen, including dropped ones.
 */
export function buildTimelineItems(events: TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const turns = new Map<number, TurnTimelineItem>();
  let nextTurnIndex = 1;

  for (const event of events) {
    if (isStandaloneEvent(event)) {
      items.push({ type: "event", event });
      continue;
    }

    const turnId = event.turnId;
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        type: "turn",
        turnId,
        turnIndex: nextTurnIndex++,
        user: null,
        run: null,
        assistant: null,
      };
      turns.set(turnId, turn);
      items.push(turn);
    }

    if (event.type === "user") {
      turn.user = event;
    } else if (event.type === "run") {
      turn.run = event;
    } else if (event.type === "assistant") {
      turn.assistant = event;
    }
  }

  return items.filter(
    (item) => item.type === "event" || item.user !== null || item.assistant !== null,
  );
}

export type TurnOpacityResolver = (turnId: number, activeTurnId: number | null) => TurnOpacity;

/**
 * Build a resolver once per render pass so resolving every turn's opacity is
 * O(turns) instead of O(turns²) (two indexOf scans per turn). Semantics match
 * resolveTurnOpacity exactly, including the "absent id → index -1" behaviour.
 */
export function createTurnOpacityResolver(turnIds: number[]): TurnOpacityResolver {
  const indexById = new Map<number, number>();
  turnIds.forEach((id, index) => indexById.set(id, index));
  const lastTurnId = turnIds[turnIds.length - 1];
  return (turnId, activeTurnId) => {
    if (turnIds.length === 0) return "dim";
    if (activeTurnId === null) {
      return turnId === lastTurnId ? "recent" : "dim";
    }
    const activeIndex = indexById.get(activeTurnId) ?? -1;
    const currentIndex = indexById.get(turnId) ?? -1;
    if (currentIndex === activeIndex) return "active";
    if (currentIndex === activeIndex - 1) return "recent";
    return "dim";
  };
}

/**
 * Opacity of one turn: "active" for the active turn, "recent" for the one
 * before it (or the last turn when nothing is active), "dim" otherwise.
 */
export function resolveTurnOpacity(
  turnIds: number[],
  turnId: number,
  activeTurnId: number | null,
): TurnOpacity {
  return createTurnOpacityResolver(turnIds)(turnId, activeTurnId);
}

/**
 * Render items for finalized (static) events. Run phase is resolved against an
 * IDLE UI state, and items are unpadded. `turnIds` should list all turns
 * (static + active) so opacity is relative to the whole transcript.
 */
export function buildStaticRenderItems(
  items: TimelineItem[],
  turnIds: number[],
  activeTurnId: number | null,
  questionTurnId: number | null,
  question: string | null,
): RenderTimelineItem[] {
  const resolveOpacity = createTurnOpacityResolver(turnIds);
  return items.map((item) => {
    if (item.type === "event") {
      return {
        key: `event-${item.event.id}`,
        type: "event",
        padded: false,
        event: item.event,
      };
    }

    return {
      key: `turn-${item.turnId}`,
      type: "turn",
      padded: false,
      item,
      renderState: {
        opacity: resolveOpacity(item.turnId, activeTurnId),
        question: questionTurnId === item.turnId ? question : null,
        runPhase: resolveTurnRunPhase(item.run, item.assistant, { kind: "IDLE" }, item.turnId),
      },
    };
  });
}

/**
 * Render items for in-flight events, with run phase, opacity and the pending
 * question derived from the live `uiState`. Standalone events here are padded.
 */
export function buildActiveRenderItems(
  items: TimelineItem[],
  turnIds: number[],
  uiState: UIState,
): RenderTimelineItem[] {
  const activeTurnId = getActiveTurnId(uiState);
  const questionTurnId = uiState.kind === "AWAITING_USER_ACTION" ? uiState.turnId : null;
  const question = uiState.kind === "AWAITING_USER_ACTION" ? uiState.question : null;
  const resolveOpacity = createTurnOpacityResolver(turnIds);

  return items.map((item) => {
    if (item.type === "event") {
      return {
        key: `event-${item.event.id}`,
        type: "event",
        padded: true,
        event: item.event,
      };
    }

    return {
      key: `turn-${item.turnId}`,
      type: "turn",
      padded: false,
      item,
      renderState: {
        opacity: resolveOpacity(item.turnId, activeTurnId),
        question: questionTurnId === item.turnId ? question : null,
        runPhase: resolveTurnRunPhase(item.run, item.assistant, uiState, item.turnId),
      },
    };
  });
}

export function formatAuthLabel(authState: CodexAuthState): string {
  const raw = getAuthStateLabel(authState);
  return raw.length > 0 ? raw[0]!.toUpperCase() + raw.slice(1) : raw;
}

/** The startup header item (logo + version/workspace/provider-or-auth lines). */
export function buildIntroRenderItem(params: {
  authState: CodexAuthState;
  workspaceLabel: string;
  layout: Layout;
  startupHeaderMode?: StartupHeaderMode;
  providerLabel?: string | null;
  /** Display label for the active model; omitted when none is resolved. */
  modelLabel?: string | null;
  middleLine?: StartupHeaderMiddleLine;
  startupModelLabel?: string | null;
  usageLabel?: string | null;
  /** Tilde-shortened workspace path used by the compact logo styles. */
  workspacePath?: string | null;
  /** Startup branding presentation; defaults to the classic banner. */
  logoStyle?: StartupLogoStyle;
  /** Responsive compact mark size (see `render/startupLogoLayout.ts`). */
  logoSize?: StartupLogoSize | null;
  headerLayout?: import("../render/responsiveHeader.js").ResponsiveHeader;
}): IntroRenderTimelineItem {
  return {
    key: "ubume-intro",
    type: "intro",
    padded: true,
    intro: {
      version: formatUbumeVersionLabel(APP_VERSION),
      layoutMode: params.layout.mode,
      startupHeaderMode: params.startupHeaderMode,
      authLabel: formatAuthLabel(params.authState),
      workspaceLabel: params.workspaceLabel,
      providerLabel: params.providerLabel ?? null,
      modelLabel: params.modelLabel ?? null,
      middleLine: params.middleLine,
      startupModelLabel: params.startupModelLabel,
      usageLabel: params.usageLabel,
      workspacePath: params.workspacePath ?? null,
      logoStyle: params.logoStyle ?? "normal",
      logoSize: params.logoSize,
      headerLayout: params.headerLayout,
    },
  };
}
