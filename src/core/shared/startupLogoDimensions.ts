/** A cell region reserved for compact startup artwork and its image placements. */
export interface LogoCellSize {
  readonly columns: number;
  readonly rows: number;
}

/** Terminal cells per logo row: the 120×72 artwork at a typical ~10×24 px cell. */
export const STARTUP_LOGO_COLUMNS_PER_ROW = 4;

/** The smallest region; also the fixed size of the Logo Rendering preview. */
export const STARTUP_LOGO_BASE_SIZE: LogoCellSize = Object.freeze({
  columns: 3 * STARTUP_LOGO_COLUMNS_PER_ROW,
  rows: 3,
});
