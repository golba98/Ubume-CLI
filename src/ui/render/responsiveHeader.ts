/** One pure allocation shared by startup measurement, row building and graphics. */
import type { StartupLogoStyle } from "../../config/settings.js";
import { getLogoWidth, LOGO_COMPACT } from "./logoVariants.js";
import { type StartupLogoSize, selectStartupLogoSize } from "./startupLogoLayout.js";
import { MAX_WORDMARK_ROWS, WORDMARK_COLUMNS, WORDMARK_ROWS } from "./wordmarkArt.js";

const COMPACT_IDENTITY_COLUMNS = getLogoWidth(LOGO_COMPACT);

export const HEADER_CONSTRAINTS = Object.freeze({
  referenceColumns: 97,
  referenceRows: 22,
  metadataColumns: 24,
  contentReserveRows: 1,
  minimumWordmarkRows: WORDMARK_ROWS,
  classicContentReserveRows: 4,
  overlayContentReserveRows: 6,
  defaultComposerRows: 4,
  viewportGutterRows: 1,
  liveSafetyRows: 1,
});
export interface ResponsiveHeaderInput {
  innerWidth: number;
  terminalRows: number;
  availableRows: number;
  metadataRows: number;
  style: StartupLogoStyle;
  previous?: StartupLogoSize | null;
  hideLogo?: boolean;
}
export interface ResponsiveHeader {
  logo: "wordmark" | "developer" | "identity" | "none";
  size: StartupLogoSize | null;
  arrangement: "beside" | "stacked";
  metadataRows: number;
  metadataWidth: number;
  topRows: number;
  bottomRows: number;
  totalRows: number;
}

export function computeResponsiveHeader(input: ResponsiveHeaderInput): ResponsiveHeader {
  const valid =
    [input.innerWidth, input.terminalRows, input.availableRows, input.metadataRows].every(
      Number.isFinite,
    ) && input.terminalRows > 0;
  const width = valid ? Math.max(0, Math.floor(input.innerWidth)) : 0;
  const available = valid ? Math.max(0, Math.floor(input.availableRows)) : 0;
  const metadataRows =
    valid && width > 0 ? Math.min(available, Math.max(0, Math.floor(input.metadataRows))) : 0;
  let size: StartupLogoSize | null = null;
  let arrangement: ResponsiveHeader["arrangement"] = "beside";
  if (!input.hideLogo && width > 0 && available > 0) {
    if (input.style !== "normal") {
      size = selectStartupLogoSize({ ...input, metadataRows });
    } else {
      const budget =
        WORDMARK_ROWS *
        Math.min(
          width / HEADER_CONSTRAINTS.referenceColumns,
          input.terminalRows / HEADER_CONSTRAINTS.referenceRows,
        );
      const previous = input.previous;
      // Reserve extra conversation space from decoration only. Identity text
      // still uses the full header allocation in very short windows.
      const decorationRows = Math.max(
        0,
        available -
          (HEADER_CONSTRAINTS.classicContentReserveRows - HEADER_CONSTRAINTS.contentReserveRows),
      );
      const keep =
        previous &&
        previous.rows >= HEADER_CONSTRAINTS.minimumWordmarkRows &&
        previous.rows <= MAX_WORDMARK_ROWS &&
        previous.columns === Math.round((WORDMARK_COLUMNS * previous.rows) / WORDMARK_ROWS) &&
        Math.abs(budget - previous.rows) < 0.75;
      const target = Math.min(
        MAX_WORDMARK_ROWS,
        keep ? previous.rows : Math.max(WORDMARK_ROWS, Math.round(budget)),
        Math.round((WORDMARK_ROWS * input.terminalRows) / HEADER_CONSTRAINTS.referenceRows),
        decorationRows,
      );
      for (let rows = target; rows >= HEADER_CONSTRAINTS.minimumWordmarkRows; rows--) {
        const columns = Math.round((WORDMARK_COLUMNS * rows) / WORDMARK_ROWS);
        const gap = Math.max(2, Math.round(columns / 24));
        if (columns + gap + HEADER_CONSTRAINTS.metadataColumns <= width && rows >= metadataRows) {
          size = { columns, rows, gap };
          break;
        }
        if (columns <= width && rows + metadataRows <= decorationRows) {
          size = { columns, rows, gap: 0 };
          arrangement = "stacked";
          break;
        }
      }
      // Native lettering cannot be compressed without losing its counters.
      // Use the established compact identity when its real region cannot fit.
      if (
        !size &&
        COMPACT_IDENTITY_COLUMNS + 2 + HEADER_CONSTRAINTS.metadataColumns <= width &&
        metadataRows <= available
      ) {
        size = { columns: COMPACT_IDENTITY_COLUMNS, rows: 1, gap: 2 };
      }
    }
  }
  const bodyRows =
    arrangement === "stacked"
      ? (size?.rows ?? 0) + metadataRows
      : Math.max(size?.rows ?? 0, metadataRows);
  const spare = Math.max(0, available - bodyRows);
  const topRows =
    input.style === "normal" && size && size.rows >= WORDMARK_ROWS && spare >= 2 ? 1 : 0;
  const bottomRows = input.style === "normal" && size && spare > topRows ? 1 : 0;
  return {
    logo: size
      ? input.style === "normal"
        ? size.rows === 1
          ? "identity"
          : "wordmark"
        : "developer"
      : "none",
    size,
    arrangement,
    metadataRows,
    metadataWidth: Math.max(
      0,
      width - (arrangement === "beside" && size ? size.columns + size.gap : 0),
    ),
    topRows,
    bottomRows,
    totalRows: bodyRows + topRows + bottomRows,
  };
}
