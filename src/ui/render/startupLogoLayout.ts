/**
 * Responsive sizing for the compact (Minimal / Simple) startup mark. Pure and
 * deterministic: every renderer (solid cells, Kitty placeholders, inline image
 * tiles, rasterization) reads the region chosen here, so they never disagree.
 *
 * The mark keeps its base 12×3 footprint at every terminal size: three rows
 * match the metadata column beside it, and larger marks dominated the header.
 * Solid and graphical output share that footprint, so the layout never shifts
 * when an asynchronous raster replaces the solid fallback.
 */
import {
  type LogoCellSize,
  STARTUP_LOGO_BASE_SIZE,
  STARTUP_LOGO_COLUMNS_PER_ROW,
} from "../../core/shared/startupLogoDimensions.js";
import { KITTY_MAX_PLACEHOLDER_CELLS } from "../../core/terminal/startupGraphics.js";

export interface StartupLogoSize extends LogoCellSize {
  /** Blank cells between the mark and its metadata column. */
  readonly gap: number;
}

export interface StartupLogoLayoutInput {
  /** Columns available to the header row (shell width minus its padding). */
  innerWidth: number;
  /** Physical terminal rows: the proportional budget ignores transient composer growth. */
  terminalRows: number;
  /** Rows the live region can actually show; the header must fit inside them. */
  availableRows: number;
  /** Metadata rows beside the mark (two when the middle line is Hidden). */
  metadataRows: number;
  /** The previously selected size, for hysteresis across resize steps. */
  previous?: StartupLogoSize | null;
}

/** Below this inner width the mark is hidden and only metadata is shown. */
export const COMPACT_STARTUP_MIN_WIDTH = 40;
/** The metadata column never shrinks below this to make room for the mark. */
export const MIN_METADATA_COLUMNS = 24;
export const MIN_LOGO_ROWS = STARTUP_LOGO_BASE_SIZE.rows;
/** Grown marks dwarfed their three metadata rows; the base size is also the largest. */
export const MAX_LOGO_ROWS = Math.min(
  MIN_LOGO_ROWS,
  Math.floor(KITTY_MAX_PLACEHOLDER_CELLS / STARTUP_LOGO_COLUMNS_PER_ROW),
);
/** Share of the terminal height the mark may occupy. */
const HEIGHT_SHARE = 1 / 7;
/** Share of the header width the mark may occupy. */
const WIDTH_SHARE = 0.18;
/**
 * Hysteresis band, in logo rows: a size is kept until the proportional budget
 * moves this far beyond its own whole-row interval, so dragging a window edge
 * across a boundary does not make the mark flicker between two sizes.
 */
const HYSTERESIS_ROWS = 0.25;
/** Gap grows with the mark so large marks do not crowd their metadata. */
const GAP_COLUMNS_PER_LOGO_COLUMN = 1 / 8;
const MIN_GAP = 2;

function logoSize(rows: number): StartupLogoSize {
  const columns = rows * STARTUP_LOGO_COLUMNS_PER_ROW;
  return Object.freeze({
    columns,
    rows,
    gap: Math.max(MIN_GAP, Math.round(columns * GAP_COLUMNS_PER_LOGO_COLUMN)),
  });
}
const SIZES = new Map(
  Array.from({ length: MAX_LOGO_ROWS - MIN_LOGO_ROWS + 1 }, (_, i) => [
    MIN_LOGO_ROWS + i,
    logoSize(MIN_LOGO_ROWS + i),
  ]),
);
/** The size used when nothing else applies (preview panel, committed scrollback). */
export const BASE_STARTUP_LOGO_SIZE = SIZES.get(MIN_LOGO_ROWS)!;

/** Header rows occupied by the mark and its metadata together. */
export function startupHeaderRows(size: LogoCellSize | null, metadataRows: number): number {
  return Math.max(size?.rows ?? 0, metadataRows);
}
/** First metadata row: centered beside taller marks, top-aligned at the base size. */
export function startupMetadataTop(size: LogoCellSize | null, metadataRows: number): number {
  return Math.max(0, Math.floor(((size?.rows ?? metadataRows) - metadataRows) / 2));
}
/** Column where metadata starts. */
export function startupMetadataOffset(size: StartupLogoSize | null): number {
  return size ? size.columns + size.gap : 0;
}

function fits(size: StartupLogoSize, input: StartupLogoLayoutInput): boolean {
  return (
    size.columns + size.gap + MIN_METADATA_COLUMNS <= input.innerWidth &&
    startupHeaderRows(size, input.metadataRows) <= input.availableRows
  );
}

/**
 * Proportional budget in (fractional) logo rows. The smaller of the height and
 * width shares wins, so neither very wide nor very tall windows overgrow it.
 */
export function startupLogoBudget(innerWidth: number, terminalRows: number): number {
  return Math.min(
    terminalRows * HEIGHT_SHARE,
    (innerWidth * WIDTH_SHARE) / STARTUP_LOGO_COLUMNS_PER_ROW,
  );
}

/** Returns null when no mark fits; callers then render metadata only. */
export function selectStartupLogoSize(input: StartupLogoLayoutInput): StartupLogoSize | null {
  const { innerWidth, terminalRows, availableRows, metadataRows, previous } = input;
  if (
    ![innerWidth, terminalRows, availableRows, metadataRows].every(Number.isFinite) ||
    innerWidth < COMPACT_STARTUP_MIN_WIDTH ||
    terminalRows <= 0 ||
    availableRows <= 0
  )
    return null;
  const budget = startupLogoBudget(innerWidth, terminalRows);
  let target = Math.max(MIN_LOGO_ROWS, Math.min(MAX_LOGO_ROWS, Math.floor(budget)));
  const kept = previous ? SIZES.get(previous.rows) : undefined;
  if (
    kept &&
    previous?.columns === kept.columns &&
    budget >= kept.rows - HYSTERESIS_ROWS &&
    budget < kept.rows + 1 + HYSTERESIS_ROWS
  )
    target = kept.rows;
  // Hard constraints shrink the mark; they never grow it past the budget.
  for (let rows = target; rows >= MIN_LOGO_ROWS; rows--) {
    const size = SIZES.get(rows)!;
    if (fits(size, input)) return size;
  }
  return null;
}
