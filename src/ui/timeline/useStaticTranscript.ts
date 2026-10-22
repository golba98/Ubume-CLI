import { useEffect, useMemo, useReducer, useRef } from "react";
import { traceResize } from "../../core/perf/resizeTrace.js";
import { createRow, fitSpansToWidth } from "./measure/rows.js";
import type { RenderTimelineItem } from "./measure/types.js";
import {
  buildStaticTranscript,
  createStaticTranscriptCache,
  type StaticTranscriptBuildOptions,
} from "./staticTranscriptCache.js";
import type { buildNativeTranscriptParts } from "./timelineMeasure.js";
import { prepareTranscriptReflow, type TranscriptReflowState } from "./transcriptReflow.js";

/** The shared preparation survives the Static remount; its session owner does not. */
export function useStaticTranscript(
  items: RenderTimelineItem[],
  options: StaticTranscriptBuildOptions,
  shared: TranscriptReflowState,
  reportPending?: (pending: boolean) => void,
  encode?: (parts: ReturnType<typeof buildNativeTranscriptParts>) => string,
  visible = true,
) {
  const cache = useRef(createStaticTranscriptCache());
  const [revision, refresh] = useReducer((n: number) => n + 1, 0);
  const key = `${options.totalWidth}|${options.verboseMode}|${options.workspaceRoot}`;
  shared.target = key;
  const canPrepare = shared.prepared?.key === key && shared.prepared.items === items;
  const pending =
    shared.width !== null &&
    (shared.width !== options.totalWidth || (cache.current.generation === "" && revision === 0)) &&
    items.length > 8 &&
    !canPrepare;
  reportPending?.(pending);
  useEffect(() => {
    if (!pending || !visible) return;
    const request = ++shared.request;
    return prepareTranscriptReflow(
      items,
      options,
      (parts, output) => {
        if (shared.target !== key || shared.request !== request) return;
        shared.prepared = {
          key,
          items,
          parts,
          output,
          count: [...parts.values()].reduce((n, value) => n + value.staticItems.length, 0),
          frame: null,
        };
        traceResize("historyReady", { width: options.totalWidth });
        refresh();
      },
      { encode },
    );
  }, [pending, items, key, options, shared, encode, visible]);
  return useMemo(() => {
    if (pending) {
      // A huge last answer must not be measured synchronously just to show a
      // temporary historical tail. Preserve its styles, fit its existing rows
      // to this viewport, then replace them with the complete prepared reflow.
      return {
        prepared: null,
        staticItems: [],
        liveRows: shared.recentRows.map((row) =>
          createRow(
            row.key,
            fitSpansToWidth(row.spans, options.totalWidth),
            options.totalWidth,
            row.frame,
          ),
        ),
      };
    }
    shared.width = options.totalWidth;
    const prepared = shared.prepared?.key === key ? shared.prepared.parts : undefined;
    const result = buildStaticTranscript(cache.current, items, options, prepared);
    const tail = [];
    let count = 0;
    for (let i = result.staticItems.length - 1; i >= 0 && count < 80; i--) {
      const rows = result.staticItems[i]!.rows.slice(-(80 - count));
      tail.unshift(...rows);
      count += rows.length;
    }
    shared.recentRows = tail;
    return { ...result, prepared: shared.prepared?.key === key ? shared.prepared : null };
  }, [items, options, pending, shared, key, revision]);
}
