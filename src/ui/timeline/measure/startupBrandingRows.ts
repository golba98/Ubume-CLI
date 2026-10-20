/** Shared compact branding renderer: glyph geometry and metadata stay independent of themes. */
import { sanitizeTerminalOutput } from "../../../core/terminal/terminalSanitize.js";
import {
  FINAL_STARTUP_LOGO_FRAME,
  type StartupLogoAnimationFrame,
  startupLogoGrid,
} from "../../render/startupAnimation.js";
import {
  BASE_STARTUP_LOGO_SIZE,
  COMPACT_STARTUP_MIN_WIDTH,
  MIN_METADATA_COLUMNS,
  type StartupLogoSize,
  startupHeaderRows,
  startupMetadataOffset,
  startupMetadataTop,
} from "../../render/startupLogoLayout.js";
import { appendSpan, createRow, createSpan, fitSpansToWidth } from "./rows.js";
import type { IntroRenderTimelineItem, TimelineRow, TimelineRowSpan } from "./types.js";

/** Metadata column at the base (12×3) size. */
export const STARTUP_METADATA_OFFSET = startupMetadataOffset(BASE_STARTUP_LOGO_SIZE);
// Metadata must stay on one terminal row even when a filename contains newlines.
const safeText = (text: string) => sanitizeTerminalOutput(text).replace(/[\r\n\u2028\u2029]/g, " ");

/**
 * The responsive size when it fits this width. Callers without a layout choice
 * (or a committed header re-flushed at a narrower width) get the base size.
 */
function fittedLogoSize(item: IntroRenderTimelineItem, width: number): StartupLogoSize | null {
  if (width < COMPACT_STARTUP_MIN_WIDTH || item.intro.logoSize === null) return null;
  const size = item.intro.logoSize ?? BASE_STARTUP_LOGO_SIZE;
  return startupMetadataOffset(size) + MIN_METADATA_COLUMNS <= width
    ? size
    : BASE_STARTUP_LOGO_SIZE;
}

/** All compact styles use this renderer; only Normal bypasses it. */
export function buildCompactStartupRows(
  item: IntroRenderTimelineItem,
  width: number,
  frame: StartupLogoAnimationFrame = FINAL_STARTUP_LOGO_FRAME,
): TimelineRow[] | null {
  if (item.intro.logoStyle !== "minimal" && item.intro.logoStyle !== "simple") return null;
  const safeWidth = Math.max(1, width);
  const size = fittedLogoSize(item, safeWidth);
  const offset = startupMetadataOffset(size);
  const { intro } = item;
  const mode = intro.middleLine ?? "provider";
  const provider = createSpan(safeText(intro.providerLabel || "Provider unavailable"), "provider");
  const model = createSpan(
    safeText(intro.startupModelLabel || intro.modelLabel || "Model unavailable"),
    "model",
  );
  const middle: TimelineRowSpan[] =
    mode === "model"
      ? [model]
      : mode === "provider-model"
        ? [provider, createSpan(" · ", "muted"), model]
        : mode === "usage"
          ? [createSpan(safeText(intro.usageLabel || "Usage unavailable"), "text")]
          : mode === "hidden"
            ? []
            : [provider];
  const metadata = [
    [createSpan(safeText(`Ubume CLI v${intro.version}`), "text", { bold: true })],
    ...(mode === "hidden" ? [] : [middle]),
    [createSpan(safeText(intro.workspacePath ?? ""), "text")],
  ];
  // Hidden leaves two adjacent metadata rows, while the logo keeps its full region.
  // Taller marks center their metadata; the base size stays top-aligned.
  const top = startupMetadataTop(size, metadata.length);
  const grid = size ? startupLogoGrid(frame, size) : null;
  return Array.from({ length: startupHeaderRows(size, metadata.length) }, (_, row) => {
    const spans: TimelineRowSpan[] = [];
    if (grid && size) {
      for (const cell of grid.rows[row] ?? []) {
        appendSpan(
          spans,
          createSpan(cell?.char ?? " ", cell ? (frame.impact ? "text" : cell.tone) : undefined),
        );
      }
      appendSpan(spans, createSpan(" ".repeat(size.gap)));
    }
    // Clamp spans together so provider/model colors survive truncation without wrapping.
    const infoWidth = Math.max(1, safeWidth - offset);
    const fitted = fitSpansToWidth(metadata[row - top] ?? [], infoWidth);
    spans.push(...fitted);
    return createRow(`${item.key}-compact-${row}`, spans, safeWidth);
  });
}

export function buildMinimalStartupRows(
  item: IntroRenderTimelineItem,
  width: number,
): TimelineRow[] {
  return buildCompactStartupRows(
    { ...item, intro: { ...item.intro, logoStyle: "minimal" } },
    width,
  )!;
}

export function buildSimpleStartupRows(
  item: IntroRenderTimelineItem,
  width: number,
): TimelineRow[] {
  return buildCompactStartupRows(
    { ...item, intro: { ...item.intro, logoStyle: "simple" } },
    width,
  )!;
}
