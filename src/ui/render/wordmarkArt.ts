/** The canonical wordmark at its native cell size; never resample font glyphs into pixels. */
import { getLogoWidth, LOGO_LARGE } from "./logoVariants.js";

export const WORDMARK_COLUMNS = getLogoWidth(LOGO_LARGE);
export const WORDMARK_ROWS = LOGO_LARGE.length;
/** Enlarged lettering dominated large windows and stepped its strokes; native only. */
export const MAX_WORDMARK_ROWS = WORDMARK_ROWS;

/** Native output is byte-for-byte original. */
export function wordmarkArt(rows: number): readonly string[] {
  if (!Number.isInteger(rows) || rows < WORDMARK_ROWS || rows > MAX_WORDMARK_ROWS)
    throw new RangeError(`Invalid wordmark height ${rows}`);
  return LOGO_LARGE;
}

/** Theme bands follow the same rounded source-cell boundaries as the lettering. */
export function wordmarkBand(row: number, rows: number): number {
  return row < Math.round(rows / 3) ? 0 : row < Math.round((rows * 2) / 3) ? 1 : 2;
}
