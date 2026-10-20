/**
 * Public facade for timeline measurement (`./measure/`).
 *
 * Measurement is the last stage of the render pipeline: session events →
 * render items (`timelineItems.ts`) → measured `TimelineRow[]` (this facade) →
 * rendered rows (`TimelineRows.tsx`, consumed by `TranscriptShell` and
 * `Timeline`). Every row is exactly one terminal line at the requested width,
 * so a row count *is* a height; the viewport, the live-row window and Ink's
 * `<Static>` scrollback all rely on that.
 *
 * Callers outside `ui/timeline/` should import from here rather than reaching
 * into `measure/*`. The facade also owns the public cache-reset API
 * (`resetTimelineMeasureCaches`, called at `/clear` and conversation resume);
 * `__*ForTests` exports are test-only hooks into module-level caches/counters.
 */
export {
  __clearTimelineMeasureCachesForTests,
  __getStaticRowCacheSizeForTests,
  __getStreamingBlockRowCacheSizeForTests,
  resetTimelineMeasureCaches,
} from "./measure/caches.js";
export { buildFrameElisionRow } from "./measure/cards.js";
export {
  __getNativeTurnBuildCountForTests,
  __resetNativeTurnBuildCountForTests,
  buildNativeTranscriptParts,
} from "./measure/nativeTranscript.js";
export { __wrapStyledSpansForTests } from "./measure/rows.js";
export { buildStableTimelineSnapshot, buildTimelineSnapshot } from "./measure/stableSnapshot.js";
export {
  buildCompactStartupRows,
  buildMinimalStartupRows,
  buildSimpleStartupRows,
} from "./measure/startupBrandingRows.js";
export { buildActionEventRows, compactActionBursts } from "./measure/streamRows.js";
export type {
  BuiltTimelineItem,
  NativeTranscriptParts,
  NativeTranscriptRowItem,
  StreamEvent,
  TimelineRow,
  TimelineRowFrame,
  TimelineRowSpan,
  TimelineSnapshot,
  TimelineTone,
} from "./measure/types.js";
