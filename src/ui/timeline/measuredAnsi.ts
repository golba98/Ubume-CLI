/** Serialize already measured rows without creating a React/Yoga node per span. */
import type { Theme } from "../../config/settings.js";
import { getToneColor } from "./TimelineRows.js";
import type { TimelineRow } from "./timelineMeasure.js";

const themeCaches = new WeakMap<Theme, WeakMap<TimelineRow, string>>();
function colorCode(color: string | undefined, background = false): string {
  if (!color || !/^#[\da-f]{6}$/i.test(color)) return "";
  const value = Number.parseInt(color.slice(1), 16);
  return `${background ? 48 : 38};2;${value >> 16};${(value >> 8) & 255};${value & 255}`;
}
export function measuredRowsToAnsi(
  rows: readonly TimelineRow[],
  theme: Theme,
  colors: boolean,
): string {
  let cache = themeCaches.get(theme);
  if (!cache) {
    cache = new WeakMap();
    themeCaches.set(theme, cache);
  }
  return rows
    .map((row) => {
      if (!colors) return row.spans.map((span) => span.text).join("");
      const existing = cache.get(row);
      if (existing !== undefined) return existing;
      const result = row.spans
        .map((span) => {
          const codes = [
            colorCode(getToneColor(theme, span.tone)),
            colorCode(getToneColor(theme, span.backgroundTone), true),
            span.bold ? "1" : "",
            span.italic ? "3" : "",
            span.underline ? "4" : "",
            span.strikethrough ? "9" : "",
          ].filter(Boolean);
          return codes.length ? `\x1b[${codes.join(";")}m${span.text}\x1b[0m` : span.text;
        })
        .join("");
      cache.set(row, result);
      return result;
    })
    .join("\n");
}
