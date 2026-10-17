/**
 * Shared types for timeline measurement and render items.
 *
 * Measured output: `TimelineRow` (one terminal line of styled spans),
 * `BuiltTimelineItem` / `TimelineSnapshot` (rows grouped per render item, used
 * by the `Timeline` viewport) and `NativeTranscriptParts` (rows split into
 * `<Static>` items vs live rows, used by `TranscriptShell`).
 *
 * Render-item input: `TimelineItem` (events grouped into turns by
 * `timelineItems.ts`) and `RenderTimelineItem` (a keyed item plus per-render
 * state such as opacity, run phase and pending question). Item keys feed every
 * row key and cache key, so they must be stable across renders.
 */
import type {
  RunEvent,
  RunProgressBlock,
  RunResponseSegment,
  RunToolActivity,
  ShellEvent,
} from "../../../session/types.js";

// ─── Exported types ───────────────────────────────────────────────────────────

/**
 * Theme-neutral color role for a span. Resolved to a concrete theme color only
 * at render time (`getToneColor` in TimelineRows.tsx), so rows never need
 * re-measuring on a theme change.
 */
export type TimelineTone =
  | "text"
  | "dim"
  | "muted"
  | "accent"
  | "info"
  | "error"
  | "warning"
  | "success"
  | "borderSubtle"
  | "borderActive"
  | "panel"
  | "star"
  | "logoPrimary"
  | "logoSecondary"
  | "logoShadow";

/** A run of text with uniform styling. `text` must not contain newlines. */
export interface TimelineRowSpan {
  text: string;
  tone?: TimelineTone;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  backgroundTone?: TimelineTone;
}

/**
 * Marks a row as part of one bordered card so the live-region window can tell
 * whether a slice lands inside a frame. `id` is shared by every row of a card.
 */
export interface TimelineRowFrame {
  id: string;
  role: "top" | "content" | "bottom";
}

/**
 * Exactly one terminal line. Builders pad `spans` to the full target width
 * (`createRow`), so a row list's length is its rendered height. `key` is the
 * React key and must be unique within a rendered list and stable across
 * rebuilds; some keys are also inspected by substring (`-action-`,
 * `-codex-response-`) for opacity, tracing and finalize anchoring.
 */
export interface TimelineRow {
  key: string;
  spans: TimelineRowSpan[];
  frame?: TimelineRowFrame;
}

/** Rows produced for one render item; `rowCount === rows.length`. */
export interface BuiltTimelineItem {
  key: string;
  rows: TimelineRow[];
  rowCount: number;
}

/**
 * Flattened measurement for the `Timeline` viewport: per-item rows (for
 * item-level anchoring on reflow) plus the concatenated `rows`.
 */
export interface TimelineSnapshot {
  items: BuiltTimelineItem[];
  rows: TimelineRow[];
  totalRows: number;
  itemCount: number;
}

/**
 * Result of `buildStableTimelineSnapshot`. `frozenRows` + `liveRows` equal
 * `snapshot.rows`; the current builder places every row in `frozenRows`.
 */
export interface StableTimelineSnapshot {
  snapshot: TimelineSnapshot;
  frozenRows: TimelineRow[];
  liveRows: TimelineRow[];
}

/** One `<Static>` item: a keyed group of rows printed once to scrollback. */
export interface NativeTranscriptRowItem {
  key: string;
  rows: TimelineRow[];
}

/**
 * `TranscriptShell` input: finalized content as append-only `<Static>` items,
 * and the running turn as `liveRows` (re-rendered every flush, tail-windowed).
 */
export interface NativeTranscriptParts {
  staticItems: NativeTranscriptRowItem[];
  liveRows: TimelineRow[];
}

// ─── Internal types & constants ──────────────────────────────────────────────

/** Word/whitespace token with inherited span styling; internal to `wrapStyledSpans`. */
export interface StyledToken {
  text: string;
  isWhitespace: boolean;
  isNewline: boolean;
  tone?: TimelineTone;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  backgroundTone?: TimelineTone;
}

/**
 * Everything that affects how one action (tool call) row looks. Its serialized
 * form is the action row cache key, so any new visible input must be added
 * here (and to `actionDisplayToken` in streamRows.ts).
 */
export interface ActionDisplayDescriptor {
  id: string;
  status: RunToolActivity["status"];
  label: string | null;
  command: string;
  duration: string;
  summary: string;
  icon: string;
  iconTone: TimelineTone;
  showLiveCursor: boolean;
  borderTone: TimelineTone;
  width: number;
  verbose: boolean;
}

// ─── Stream event types ───────────────────────────────────────────────────────

/**
 * One block of a run's unified stream, ordered by `streamSeq` (creation
 * order). `actionSummary` is synthetic: produced by `compactActionBursts` for
 * finalized turns only.
 */
export type StreamEvent =
  | { kind: "thinking"; streamSeq: number; block: RunProgressBlock }
  | { kind: "response"; streamSeq: number; segment: RunResponseSegment }
  | { kind: "action"; streamSeq: number; tool: RunToolActivity }
  | { kind: "actionSummary"; streamSeq: number; id: string; label: string; count: number }
  | { kind: "plan"; streamSeq: number; planText: string; approved: boolean };

import type {
  AssistantEvent,
  ErrorEvent,
  SystemEvent,
  UserPromptEvent,
} from "../../../session/types.js";
import type { Layout, StartupHeaderMode } from "../../layout.js";

import type { TurnOpacity, TurnRunPhase } from "../TurnGroup.js";

export type StandaloneTimelineEvent = SystemEvent | ErrorEvent | ShellEvent;

/** User prompt, run and assistant events sharing one `turnId`; `turnIndex` is 1-based display order. */
export interface TurnTimelineItem {
  type: "turn";
  turnId: number;
  turnIndex: number;
  user: UserPromptEvent | null;
  run: RunEvent | null;
  assistant: AssistantEvent | null;
}

export interface EventTimelineItem {
  type: "event";
  event: StandaloneTimelineEvent;
}

export type TimelineItem = TurnTimelineItem | EventTimelineItem;

export interface TurnRenderState {
  opacity: TurnOpacity;
  question: string | null;
  runPhase: TurnRunPhase;
}

export interface TurnRenderTimelineItem {
  key: string;
  type: "turn";
  padded: boolean;
  item: TurnTimelineItem;
  renderState: TurnRenderState;
}

export interface EventRenderTimelineItem {
  key: string;
  type: "event";
  padded: boolean;
  event: StandaloneTimelineEvent;
}

export interface IntroRenderTimelineItem {
  key: string;
  type: "intro";
  padded: boolean;
  intro: {
    version: string;
    layoutMode: Layout["mode"];
    startupHeaderMode?: StartupHeaderMode;
    authLabel: string;
    workspaceLabel: string;
    providerLabel?: string | null;
  };
}

/**
 * A keyed, render-ready timeline item. `padded` adds one column of horizontal
 * padding on each side when rows are wrapped (`wrapRows`), shrinking the inner
 * build width by 2.
 */
export type RenderTimelineItem =
  | IntroRenderTimelineItem
  | TurnRenderTimelineItem
  | EventRenderTimelineItem;

export type TurnRenderItem = Extract<RenderTimelineItem, { type: "turn" }>;
/** Width/verbosity inputs shared by the snapshot builders; `totalWidth` is the outer row width. */
export interface TimelineBuildOptions {
  totalWidth: number;
  verboseMode?: boolean;
  debugLabel?: string;
  workspaceRoot?: string | null;
}
