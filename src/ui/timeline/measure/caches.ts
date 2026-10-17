/**
 * Module-level caches for timeline measurement.
 *
 * Why caching matters here beyond speed: `TimelineRowView` and
 * `TimelineRowsView` memoize on row *object identity*, so returning the same
 * `TimelineRow` object for unchanged content is what keeps streaming flushes
 * from re-rendering (and re-emitting) the whole transcript. Builders in this
 * folder therefore go through these caches rather than allocating fresh rows.
 *
 * Ownership/lifecycle: all caches are process-global and keyed by transcript
 * item keys + width (+ content tokens where content can change). Width and
 * verbosity are baked into keys, so resizes simply miss rather than serve
 * stale rows. Several caches are LRU-bounded (Map insertion order = recency);
 * `_staticRowCache`, `_blankRowCache`, `_completedActionRowCache`,
 * `_completedActionTokenById`, `_wrappedBlankRowCache` and
 * `_actionDisplayCache` are unbounded and rely on `resetTimelineMeasureCaches()`
 * at `/clear` and conversation resume to be emptied. The `_`-prefixed exports
 * are internal to `measure/`; outside callers use the `timelineMeasure.ts`
 * facade.
 */
import * as renderDebug from "../../../core/perf/renderDebug.js";
import { resetMarkdownCaches } from "../../render/markdownCache.js";
import type { ActionDisplayDescriptor, TimelineRow } from "./types.js";

const ROW_CONTENT_CACHE_LIMIT = 2500;

/** LRU (2500 entries) of individual rows keyed by key+width+frame+span content; see `createRow`. */
export const _rowContentCache = new Map<string, TimelineRow>();

/** Insert/refresh `row` in `_rowContentCache` as most-recent, evicting the oldest past the limit. */
export function rememberRow(cacheKey: string, row: TimelineRow): TimelineRow {
  if (_rowContentCache.has(cacheKey)) {
    _rowContentCache.delete(cacheKey);
  }
  _rowContentCache.set(cacheKey, row);
  if (_rowContentCache.size > ROW_CONTENT_CACHE_LIMIT) {
    const oldestKey = _rowContentCache.keys().next().value;
    if (oldestKey !== undefined) {
      _rowContentCache.delete(oldestKey);
    }
  }
  return row;
}

/** Blank (all-space) rows keyed by `${key}:${width}`; see `createBlankRow`. */
export const _blankRowCache = new Map<string, TimelineRow>();

// ─── Row cache ────────────────────────────────────────────────────────────────

// Per-entry row cache for completed (non-streaming) timeline entries, used by
// `buildTimelineSnapshot` via `getStaticRows`. Keys are built by the caller
// (stableSnapshot.ts). Turn keys include item key, inner width, verbosity, run
// phase, opacity, workspace root and a plan signature — so they are
// automatically invalidated when any of those change — but deliberately omit
// content tokens: completed turns are treated as immutable, so cached rows are
// valid for the same key. Intro/event keys carry their payload fields.
// Unbounded until `resetTimelineMeasureCaches()`.
export const _staticRowCache = new Map<string, TimelineRow[]>();

const STREAMING_BLOCK_ROW_CACHE_LIMIT = 200;

/** LRU (200 entries) of per-block rows (thinking, response, running action); keys carry content tokens. */
export let _streamingBlockRowCache = new Map<string, TimelineRow[]>();

/** Rows of finished action events keyed by their display token (see streamRows `buildActionEventRows`). */
export const _completedActionRowCache = new Map<string, TimelineRow[]>();

/** Last display token per `${keyPrefix}:${toolId}`; only used to trace completed-row invalidations. */
export const _completedActionTokenById = new Map<string, string>();

const FROZEN_ROW_GROUP_CACHE_LIMIT = 1200;

// LRU (1200 entries) of row groups for the stable/active snapshot path
// (stableSnapshot.ts) and action-summary cards; keys carry content tokens.
const _frozenRowGroupCache = new Map<string, TimelineRow[]>();

// Padded/wrapped copies of rows (see rows.ts `wrapRows`), keyed first by the
// source row object so entries die with their source row; reassigned (not
// cleared) on reset because a WeakMap cannot be cleared.
export let _wrappedRowCache = new WeakMap<TimelineRow, Map<string, TimelineRow>>();

/** Item-margin blank rows appended by `wrapRows`, keyed by `${keyPrefix}:${totalWidth}:margin`. */
export const _wrappedBlankRowCache = new Map<string, TimelineRow>();

/**
 * Last action display descriptor per `${keyPrefix}:${toolId}`. Returning the
 * cached descriptor object when nothing visible changed keeps the descriptor
 * identity stable across streaming flushes.
 */
export const _actionDisplayCache = new Map<string, ActionDisplayDescriptor>();

/** djb2-xor string hash, base-36. Not cryptographic; used only inside cache keys. */
function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Compact content fingerprint (`length:hash`) for embedding arbitrarily long
 * text in a cache key without storing the text itself. Collisions are
 * theoretically possible but would require equal length and equal hash.
 */
export function textCacheToken(value: string | null | undefined): string {
  const text = value ?? "";
  return `${text.length}:${hashString(text)}`;
}

/** Serialize key parts into one cache key string (JSON, so part boundaries are unambiguous). */
export function rowCacheKey(parts: unknown[]): string {
  return JSON.stringify(parts);
}

/** LRU lookup in `_streamingBlockRowCache`, calling `build` on a miss. */
export function getCachedStreamingBlockRows(
  cacheKey: string,
  build: () => TimelineRow[],
): TimelineRow[] {
  const cached = _streamingBlockRowCache.get(cacheKey);
  if (cached) {
    _streamingBlockRowCache.delete(cacheKey);
    _streamingBlockRowCache.set(cacheKey, cached);
    return cached;
  }

  const rows = build();
  _streamingBlockRowCache.set(cacheKey, rows);
  while (_streamingBlockRowCache.size > STREAMING_BLOCK_ROW_CACHE_LIMIT) {
    const oldestKey = _streamingBlockRowCache.keys().next().value;
    if (oldestKey === undefined) break;
    _streamingBlockRowCache.delete(oldestKey);
  }
  return rows;
}

/** LRU lookup in the frozen row-group cache, calling `build` on a miss. */
export function getCachedFrozenRows(cacheKey: string, build: () => TimelineRow[]): TimelineRow[] {
  const cached = _frozenRowGroupCache.get(cacheKey);
  if (cached) {
    _frozenRowGroupCache.delete(cacheKey);
    _frozenRowGroupCache.set(cacheKey, cached);
    return cached;
  }

  const rows = build();
  _frozenRowGroupCache.set(cacheKey, rows);
  while (_frozenRowGroupCache.size > FROZEN_ROW_GROUP_CACHE_LIMIT) {
    const oldestKey = _frozenRowGroupCache.keys().next().value;
    if (oldestKey === undefined) break;
    _frozenRowGroupCache.delete(oldestKey);
  }
  return rows;
}

/**
 * Drop every module-level row cache. Called at the /clear and conversation
 * resume boundaries: the caches are keyed by transcript item keys and would
 * otherwise keep rows for turns that no longer exist for the whole process.
 */
export function resetTimelineMeasureCaches(): void {
  resetMarkdownCaches();
  _rowContentCache.clear();
  _staticRowCache.clear();
  _blankRowCache.clear();
  _streamingBlockRowCache.clear();
  _completedActionRowCache.clear();
  _completedActionTokenById.clear();
  _frozenRowGroupCache.clear();
  _wrappedRowCache = new WeakMap<TimelineRow, Map<string, TimelineRow>>();
  _wrappedBlankRowCache.clear();
  _actionDisplayCache.clear();
}

export function __clearTimelineMeasureCachesForTests(): void {
  resetTimelineMeasureCaches();
}

export function __getStreamingBlockRowCacheSizeForTests(): number {
  return _streamingBlockRowCache.size;
}

export function __getStaticRowCacheSizeForTests(): number {
  return _staticRowCache.size;
}

/**
 * Non-evicting lookup in `_staticRowCache`, calling `build` on a miss. `details`
 * only feeds the env-gated render-debug traces (hit/miss per item).
 */
export function getStaticRows(
  cacheKey: string,
  build: () => TimelineRow[],
  details: {
    itemKey: string;
    itemType: string;
    innerWidth: number;
    runPhase?: string;
    opacity?: string;
  },
): TimelineRow[] {
  const cached = _staticRowCache.get(cacheKey);
  const cache = cached ? "hit" : "miss";
  renderDebug.traceEvent("timeline", "rowGeneration", { ...details, cache });
  const { itemKey: _itemKey, innerWidth: _innerWidth, ...eventDetails } = details;
  renderDebug.traceEvent("timeline", cached ? "staticCacheHit" : "staticCacheMiss", {
    cacheKey,
    ...eventDetails,
  });
  if (cached) return cached;
  const rows = build();
  _staticRowCache.set(cacheKey, rows);
  return rows;
}
