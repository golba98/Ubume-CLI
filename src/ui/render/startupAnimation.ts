/** Theme-neutral developer mark at any cell size. No terminal writes or color codes. */

import type { StartupLogoStyle } from "../../config/settings.js";
import {
  type LogoCellSize,
  STARTUP_LOGO_BASE_SIZE,
} from "../../core/shared/startupLogoDimensions.js";
import { type LogoPose, logoHalfCell } from "./startupLogoAsset.js";

export type StartupLogoTone = "logoPrimary" | "logoSecondary" | "text";
export interface StartupLogoCell {
  char: string;
  tone: StartupLogoTone;
}
export interface StartupLogoGrid {
  width: number;
  height: number;
  rows: ReadonlyArray<ReadonlyArray<StartupLogoCell | null>>;
}

/** Built from the same vector paths as the graphical asset, at any cell size. */
export function buildStartupLogoGrid(
  leftOffset: number | null = 0,
  rightOffset: number | null = 0,
  size: LogoCellSize = STARTUP_LOGO_BASE_SIZE,
): StartupLogoGrid {
  const rows: Array<Array<StartupLogoCell | null>> = Array.from({ length: size.rows }, () =>
    Array.from({ length: size.columns }, () => null),
  );
  for (const part of ["left", "slash", "right"] as const) {
    const offset = part === "slash" ? 0 : part === "left" ? leftOffset : rightOffset;
    if (offset === null) continue;
    for (let row = 0; row < size.rows; row++)
      for (let col = 0; col < size.columns; col++) {
        const top = logoHalfCell(part, col, row * 2, offset, size);
        const bottom = logoHalfCell(part, col, row * 2 + 1, offset, size);
        if (top || bottom)
          rows[row]![col] = Object.freeze({
            char: top && bottom ? "█" : top ? "▀" : "▄",
            tone: part === "slash" ? "text" : part === "left" ? "logoPrimary" : "logoSecondary",
          });
      }
  }
  return Object.freeze({
    width: size.columns,
    height: size.rows,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
}

export function startupLogoRowText(grid: StartupLogoGrid, row: number): string {
  return grid.rows[row]?.map((cell) => cell?.char ?? " ").join("") ?? "";
}

export interface StartupLogoAnimationFrame {
  readonly index: number;
  readonly atMs: number;
  readonly pose: LogoPose;
  readonly impact: boolean;
}

export const STARTUP_ANIMATION_DURATION = 520;
const easeOut = (value: number) => 1 - (1 - Math.max(0, Math.min(1, value))) ** 3;
export function startupLogoPose(atMs: number): LogoPose {
  return {
    left: atMs < 80 ? null : 20 * (1 - easeOut((atMs - 80) / 240)),
    right: atMs < 160 ? null : 20 * (1 - easeOut((atMs - 160) / 240)),
  };
}
/** At most 25 updates/second. */
export const STARTUP_LOGO_FRAMES: readonly StartupLogoAnimationFrame[] = Object.freeze(
  Array.from({ length: STARTUP_ANIMATION_DURATION / 40 + 1 }, (_, index) => {
    const atMs = index * 40;
    return Object.freeze({
      index,
      atMs,
      pose: Object.freeze(startupLogoPose(atMs)),
      impact: atMs >= 400 && atMs < 480,
    });
  }),
);
export const FINAL_STARTUP_LOGO_FRAME = STARTUP_LOGO_FRAMES[STARTUP_LOGO_FRAMES.length - 1]!;

// One entry per (size, frame); 8 sizes × 14 frames is the realistic ceiling.
const MAX_CACHED_GRIDS = 128;
const grids = new Map<string, StartupLogoGrid>();
/** Geometry is constructed once per size and frame, never during each render. */
export function startupLogoGrid(
  frame: StartupLogoAnimationFrame,
  size: LogoCellSize = STARTUP_LOGO_BASE_SIZE,
): StartupLogoGrid {
  const key = `${size.columns}x${size.rows}:${frame.index}`;
  let grid = grids.get(key);
  if (!grid) {
    grid = buildStartupLogoGrid(frame.pose.left, frame.pose.right, size);
    grids.set(key, grid);
    if (grids.size > MAX_CACHED_GRIDS) grids.delete(grids.keys().next().value!);
  }
  return grid;
}
export const NO_STARTUP_ANIMATION_ENV = "UBUME_NO_STARTUP_ANIMATION";

export interface StartupAnimationDecision {
  stdout: { isTTY?: boolean };
  env: Record<string, string | undefined>;
  logoStyle: StartupLogoStyle;
  animationEnabled: boolean;
  /** The responsive layout's choice; no mark means nothing to animate. */
  logoSize: LogoCellSize | null;
}

export function shouldPlayStartupAnimation({
  stdout,
  env,
  logoStyle,
  animationEnabled,
  logoSize,
}: StartupAnimationDecision): boolean {
  return Boolean(
    animationEnabled &&
      (logoStyle === "minimal" || logoStyle === "simple") &&
      env[NO_STARTUP_ANIMATION_ENV] !== "1" &&
      stdout.isTTY &&
      logoSize,
  );
}
