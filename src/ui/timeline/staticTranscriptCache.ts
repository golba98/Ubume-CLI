/**
 * Incremental cache for the `<Static>` (finalized) half of `TranscriptShell`.
 * See the doc on `MAX_RETAINED_STATIC_TURNS` below for the design and
 * retention rules.
 *
 * Ownership: the cache object is created and held in a ref by
 * `TranscriptShellInner`, which is remounted on `/clear` and width repaints,
 * so those boundaries start from an empty cache. A generation string
 * (width | verbose | workspaceRoot) additionally drops all entries when any of
 * those inputs change.
 */
import type {
  AssistantEvent,
  ErrorEvent,
  RunEvent,
  ShellEvent,
  SystemEvent,
  UserPromptEvent,
} from "../../session/types.js";
import type { RenderTimelineItem } from "./measure/types.js";
import type { TurnOpacity } from "./TurnGroup.js";
import {
  buildNativeTranscriptParts,
  type NativeTranscriptParts,
  type NativeTranscriptRowItem,
  type TimelineRow,
} from "./timelineMeasure.js";

/**
 * Incremental row builder for the finalized (static) half of the transcript.
 *
 * Ink's <Static> prints each item once and never re-renders it, and finalized
 * timeline events are immutable, so rebuilding every past turn's rows on each
 * React commit (every keystroke, every streaming flush) is pure waste that
 * grows with session length. This cache keys rows by the render item's key
 * and revalidates by event identity plus the derived opacity, so a commit
 * that changes nothing in the static half costs one Map lookup per item.
 *
 * Retention: only the newest MAX_RETAINED_STATIC_TURNS turns keep row objects.
 * Older turns print once on a fresh mount, then emit placeholder items so the <Static> item
 * count stays monotonic — Ink advances its printed index by items.length, so a
 * shrinking list would swallow the next newly finalized turn. A turn that
 * leaves the window keeps exactly the item keys it had while retained; those
 * keys survive generation changes so the count never drops. Their rows are
 * already in the terminal's scrollback. Resume and width-resize remounts use a
 * fresh cache, printing the complete transcript before evicting older rows.
 */
export const MAX_RETAINED_STATIC_TURNS = 200;

// Shared by every elided turn, so it is frozen: a stray push would otherwise corrupt
// all of them. The cast restores the mutable type `NativeTranscriptRowItem.rows` uses.
const EMPTY_ROWS = Object.freeze<TimelineRow[]>([]) as TimelineRow[];

interface CachedTurnEntry {
  kind: "turn";
  user: UserPromptEvent | null;
  run: RunEvent | null;
  assistant: AssistantEvent | null;
  opacity: TurnOpacity;
  items: NativeTranscriptRowItem[];
}

interface CachedEventEntry {
  kind: "event";
  event: SystemEvent | ErrorEvent | ShellEvent;
  items: NativeTranscriptRowItem[];
}

type CachedEntry = CachedTurnEntry | CachedEventEntry;

export interface StaticTranscriptBuildOptions {
  totalWidth: number;
  verboseMode: boolean;
  workspaceRoot: string | null;
}

/** Mutable cache state; create with `createStaticTranscriptCache` and pass to `buildStaticTranscript`. */
export interface StaticTranscriptCache {
  generation: string;
  entries: Map<string, CachedEntry>;
  /** Item keys of turns outside the retention window; kept across generations. */
  placeholders: Map<string, string[]>;
}

export function createStaticTranscriptCache(): StaticTranscriptCache {
  return { generation: "", entries: new Map(), placeholders: new Map() };
}

function staticTranscriptGeneration(options: StaticTranscriptBuildOptions): string {
  return `${options.totalWidth}|${options.verboseMode ? 1 : 0}|${options.workspaceRoot ?? ""}`;
}

// Identity comparison relies on finalized events being immutable (see above):
// same event objects + same opacity means the rows cannot have changed.
function isCacheHit(cached: CachedEntry, item: RenderTimelineItem): boolean {
  if (item.type === "event") return cached.kind === "event" && cached.event === item.event;
  if (item.type !== "turn" || cached.kind !== "turn") return false;
  return (
    cached.user === item.item.user &&
    cached.run === item.item.run &&
    cached.assistant === item.item.assistant &&
    cached.opacity === item.renderState.opacity
  );
}

// Only fully static output is cached: a running turn, a pending question, or
// any live rows mean the next commit may render differently.
function isCacheable(item: RenderTimelineItem, liveRowCount: number): boolean {
  if (item.type === "event") return true;
  if (item.type !== "turn") return false;
  return (
    item.item.run?.status !== "running" && item.renderState.question === null && liveRowCount === 0
  );
}

/**
 * Build native row items for the given render items, reusing cached rows for
 * every item whose inputs are unchanged. Output is identical to a single
 * batched buildNativeTranscriptParts call over the same items, except that
 * turns outside the retention window carry empty rows.
 *
 * Mutates `cache` (generation reset, new entries, placeholders, and pruning of
 * entries whose items no longer appear). Intro items are rebuilt on every
 * call, uncached here (row-level caches still apply).
 */
export function buildStaticTranscript(
  cache: StaticTranscriptCache,
  renderItems: RenderTimelineItem[],
  options: StaticTranscriptBuildOptions,
  prepared?: ReadonlyMap<string, NativeTranscriptParts>,
): { staticItems: NativeTranscriptRowItem[]; liveRows: TimelineRow[] } {
  const generation = staticTranscriptGeneration(options);
  if (cache.generation !== generation) {
    cache.generation = generation;
    cache.entries.clear();
  }

  const buildOptions = {
    totalWidth: options.totalWidth,
    verboseMode: options.verboseMode,
    workspaceRoot: options.workspaceRoot,
    debugLabel: "transcript-shell-static",
  };
  const partsFor = (item: RenderTimelineItem) =>
    prepared?.get(item.key) ?? buildNativeTranscriptParts([item], buildOptions);
  const staticItems: NativeTranscriptRowItem[] = [];
  const liveRows: TimelineRow[] = [];
  const seen = new Set<string>();

  let turnCount = 0;
  for (const item of renderItems) if (item.type === "turn") turnCount += 1;
  const firstRetainedTurnOrdinal = Math.max(0, turnCount - MAX_RETAINED_STATIC_TURNS);
  let turnOrdinal = 0;

  for (const item of renderItems) {
    if (item.type === "intro") {
      staticItems.push(...partsFor(item).staticItems);
      continue;
    }

    if (item.type === "turn") {
      const ordinal = turnOrdinal;
      turnOrdinal += 1;
      if (ordinal < firstRetainedTurnOrdinal) {
        let keys = cache.placeholders.get(item.key);
        if (!keys) {
          // A fresh Static instance has printed nothing. Emit old turns once
          // before evicting their rows, including after resume and width resize.
          const emit = !cache.entries.has(item.key);
          const initial = cache.entries.get(item.key)?.items ?? partsFor(item).staticItems;
          if (emit) staticItems.push(...initial);
          // Leaving the window: keep this turn's item keys so the count stays
          // exactly what Ink already printed, including the initial historical reflush.
          keys = initial.map((entry) => entry.key);
          cache.placeholders.set(item.key, keys);
          cache.entries.delete(item.key);
          if (emit) continue;
        }
        for (const key of keys) staticItems.push({ key, rows: EMPTY_ROWS });
        continue;
      }
    }

    const cached = cache.entries.get(item.key);
    if (cached && isCacheHit(cached, item)) {
      staticItems.push(...cached.items);
      seen.add(item.key);
      continue;
    }

    const parts = partsFor(item);
    staticItems.push(...parts.staticItems);
    liveRows.push(...parts.liveRows);
    if (!isCacheable(item, parts.liveRows.length)) continue;

    cache.entries.set(
      item.key,
      item.type === "event"
        ? { kind: "event", event: item.event, items: parts.staticItems }
        : {
            kind: "turn",
            user: item.item.user,
            run: item.item.run,
            assistant: item.item.assistant,
            opacity: item.renderState.opacity,
            items: parts.staticItems,
          },
    );
    seen.add(item.key);
  }

  if (cache.entries.size > seen.size) {
    for (const key of cache.entries.keys()) {
      if (!seen.has(key)) cache.entries.delete(key);
    }
  }

  return { staticItems, liveRows };
}
