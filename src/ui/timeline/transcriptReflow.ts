/** Cooperative preparation of finalized rows. Provider/session state is never touched. */
import { traceResize } from "../../core/perf/resizeTrace.js";
import type { PreparedStaticFrame } from "../../core/terminal/preparedStaticFrame.js";
import type { RenderTimelineItem } from "./measure/types.js";
import type { StaticTranscriptBuildOptions } from "./staticTranscriptCache.js";
import {
  buildNativeTranscriptParts,
  type NativeTranscriptParts,
  type TimelineRow,
} from "./timelineMeasure.js";

export interface TranscriptPreparation {
  key: string;
  items: readonly RenderTimelineItem[];
  parts: Map<string, NativeTranscriptParts>;
  output: string;
  count: number;
  frame: PreparedStaticFrame | null;
}
export interface TranscriptReflowState {
  width: number | null;
  target: string;
  request: number;
  recentRows: TimelineRow[];
  prepared: TranscriptPreparation | null;
}
export function createTranscriptReflowState(): TranscriptReflowState {
  return { width: null, target: "", request: 0, recentRows: [], prepared: null };
}

/** Each item is atomic; yield between items to give input/provider reads a turn. */
export function prepareTranscriptReflow(
  items: readonly RenderTimelineItem[],
  options: StaticTranscriptBuildOptions,
  onReady: (parts: Map<string, NativeTranscriptParts>, output: string) => void,
  {
    sliceMs = 4,
    build = buildNativeTranscriptParts,
    encode = (_parts: NativeTranscriptParts): string => "",
  } = {},
): () => void {
  let canceled = false;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const parts = new Map<string, NativeTranscriptParts>();
  const encoded: string[] = [];
  const step = () => {
    timer = null;
    if (canceled) return;
    const start = performance.now();
    do {
      const item = items[index++];
      if (!item) break;
      const result = build([item], options);
      parts.set(item.key, result);
      encoded.push(encode(result));
    } while (index < items.length && performance.now() - start < sliceMs);
    traceResize("historySlice", {
      durationMs: performance.now() - start,
      items: index,
      width: options.totalWidth,
    });
    if (index < items.length) timer = setTimeout(step, 0);
    else if (!canceled) onReady(parts, encoded.join(""));
  };
  timer = setTimeout(step, 0);
  return () => {
    canceled = true;
    if (timer !== null) clearTimeout(timer);
    parts.clear();
    encoded.length = 0;
  };
}
