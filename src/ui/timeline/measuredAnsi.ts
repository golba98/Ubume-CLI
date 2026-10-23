/** Serialize already measured rows without creating a React/Yoga node per span. */
import type { Theme } from "../../config/settings.js";
import { getToneColor } from "./TimelineRows.js";
import type { TimelineRow } from "./timelineMeasure.js";

type ColorDepth = 0 | 4 | 8 | 24;
const themeCaches = new WeakMap<Theme, Map<number, WeakMap<TimelineRow, string>>>();

/** Respect the same terminal capabilities as ordinary Ink text. */
export function measuredColorDepth(
  stdout: { isTTY?: boolean; getColorDepth?: (env?: NodeJS.ProcessEnv) => number },
  env: NodeJS.ProcessEnv = process.env,
): ColorDepth {
  const forced = env.FORCE_COLOR;
  if (forced === "0" || forced === "false") return 0;
  const minimum = forced === undefined ? 0 : forced === "3" ? 24 : forced === "2" ? 8 : 4;
  if (!minimum && (Object.hasOwn(env, "NO_COLOR") || !stdout.isTTY || env.TERM === "dumb"))
    return 0;
  const depth = Math.max(
    minimum,
    stdout.getColorDepth?.(env) ??
      (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")
        ? 24
        : env.TERM?.includes("256color")
          ? 8
          : env.TERM === "dumb"
            ? 0
            : 4),
  );
  return depth >= 24 ? 24 : depth >= 8 ? 8 : depth >= 4 ? 4 : 0;
}

function colorCode(color: string | undefined, background: boolean, depth: number): string {
  if (!color || !/^#[\da-f]{6}$/i.test(color)) return "";
  const value = Number.parseInt(color.slice(1), 16);
  const r = value >> 16,
    g = (value >> 8) & 255,
    b = value & 255;
  if (depth >= 24) return `${background ? 48 : 38};2;${r};${g};${b}`;
  const palette =
    r === g && g === b
      ? r < 8
        ? 16
        : r > 248
          ? 231
          : 232 + Math.round(((r - 8) / 247) * 24)
      : 16 +
        36 * Math.round((r / 255) * 5) +
        6 * Math.round((g / 255) * 5) +
        Math.round((b / 255) * 5);
  if (depth >= 8) return `${background ? 48 : 38};5;${palette}`;
  const cube = palette - 16;
  const channels =
    palette >= 232
      ? (Array(3).fill(((palette - 232) * 10 + 8) / 255) as number[])
      : [Math.floor(cube / 36) / 5, Math.floor((cube % 36) / 6) / 5, (cube % 6) / 5];
  const maximum = Math.max(...channels);
  const ansi =
    maximum === 0
      ? 30
      : 30 +
        ((Math.round(channels[2]!) << 2) |
          (Math.round(channels[1]!) << 1) |
          Math.round(channels[0]!)) +
        (maximum === 1 ? 60 : 0);
  return String(ansi + (background ? 10 : 0));
}
export function measuredRowsToAnsi(
  rows: readonly TimelineRow[],
  theme: Theme,
  colors: boolean | ColorDepth,
): string {
  const depth = typeof colors === "boolean" ? (colors ? 24 : 0) : colors;
  let levels = themeCaches.get(theme);
  if (!levels) {
    levels = new Map();
    themeCaches.set(theme, levels);
  }
  let cache = levels.get(depth);
  if (!cache) {
    cache = new WeakMap();
    levels.set(depth, cache);
  }
  return rows
    .map((row) => {
      if (!depth) return row.spans.map((span) => span.text).join("");
      const existing = cache.get(row);
      if (existing !== undefined) return existing;
      const result = row.spans
        .map((span) => {
          const codes = [
            colorCode(getToneColor(theme, span.tone), false, depth),
            colorCode(getToneColor(theme, span.backgroundTone), true, depth),
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
