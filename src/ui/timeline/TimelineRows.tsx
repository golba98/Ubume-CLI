/**
 * Renders measured `TimelineRow`s as Ink elements — the final stage of the
 * render pipeline.
 *
 * Each row must render as exactly one terminal line: the row builders have
 * already wrapped and padded spans to the target width, so this component must
 * not add padding, margins or borders of its own, and builders must never emit
 * a row wider than the width it is rendered at (Ink's default text wrapping
 * would then spill it onto extra lines). Anything that changed a row's
 * on-screen height here would desynchronize the viewport and live-window math
 * that count rows.
 *
 * Tones are theme-neutral in measured rows and resolved to theme colors only
 * here, so a theme change needs no re-measurement. Memoization relies on row
 * object identity, which the measurement caches keep stable for unchanged rows.
 */
import { Box, Text } from "ink";
import { memo, useEffect } from "react";

import * as renderDebug from "../../core/perf/renderDebug.js";

import { useTheme } from "../theme.js";

import type { TimelineRow, TimelineTone } from "./timelineMeasure.js";

// ─── Row rendering ────────────────────────────────────────────────────────────

/** Map a theme-neutral `TimelineTone` to the active theme's color (undefined = terminal default). */
export function getToneColor(
  theme: ReturnType<typeof useTheme>,
  tone: TimelineTone | undefined,
): string | undefined {
  switch (tone) {
    case "text":
      return theme.text;
    case "dim":
      return theme.textDim;
    case "muted":
      return theme.textMuted;
    case "accent":
      return theme.accent;
    case "info":
      return theme.info;
    case "error":
      return theme.error;
    case "warning":
      return theme.warning;
    case "success":
      return theme.success;
    case "borderSubtle":
      return theme.border;
    case "borderActive":
      return theme.borderFocused;
    case "panel":
      return theme.surface;
    case "star":
      return theme.warning;
    case "provider":
      return theme.provider;
    case "model":
      return theme.model;
    case "logoPrimary":
      return theme.logoPrimary;
    case "logoSecondary":
      return theme.logoSecondary;
    case "logoShadow":
      return theme.logoShadow;
    default:
      return undefined;
  }
}

/**
 * One measured row as one Ink line. Re-renders only when the row object
 * identity changes. Action rows (key contains `-action-`) additionally emit
 * flicker/lifecycle traces for the env-gated render debugger.
 */
export const TimelineRowView = memo(
  function TimelineRowView({ row }: { row: TimelineRow }) {
    const isActionRow = row.key.includes("-action-");
    renderDebug.useRenderDebug("TimelineRow", {
      rowKey: row.key,
      row,
    });
    if (isActionRow) {
      renderDebug.traceFlickerEvent("timelineRowRender", {
        rowKey: row.key,
        spanToken: row.spans.map((span) => span.text).join("|"),
      });
    }

    useEffect(() => {
      if (!isActionRow) return;
      renderDebug.traceFlickerEvent("timelineRowMount", { rowKey: row.key });
      renderDebug.traceLifecycleEvent("ActionRow", "mount", { rowKey: row.key });
      renderDebug.traceLifecycleEvent("ActionBlock", "mount", { rowKey: row.key });
      return () => {
        renderDebug.traceFlickerEvent("timelineRowUnmount", { rowKey: row.key });
        renderDebug.traceLifecycleEvent("ActionRow", "unmount", { rowKey: row.key });
        renderDebug.traceLifecycleEvent("ActionBlock", "unmount", { rowKey: row.key });
      };
    }, [isActionRow, row.key]);

    const theme = useTheme();

    return (
      <Box width="100%" overflow="hidden">
        {/* Rows are measured to exactly one line. Between a terminal shrink and
            the layout settling, a frame is drawn with the previous, wider rows:
            wrapping those cost ~1s of grapheme measurement on large live
            headers and briefly doubled their height; truncation is O(width). */}
        <Text wrap="truncate-end">
          {row.spans.map((span, index) => (
            <Text
              key={index}
              color={getToneColor(theme, span.tone)}
              backgroundColor={getToneColor(theme, span.backgroundTone)}
              bold={span.bold}
              italic={span.italic}
              underline={span.underline}
              strikethrough={span.strikethrough}
            >
              {span.text}
            </Text>
          ))}
        </Text>
      </Box>
    );
  },
  (prev, next) => prev.row === next.row,
);

/** Shallow element-identity comparison of two row arrays. */
export function rowArraysEqual(left: TimelineRow[], right: TimelineRow[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Render a row list (used by `Timeline` for its viewport slice). Skips the
 * re-render when a freshly sliced array holds the same row objects.
 */
export const TimelineRowsView = memo(
  function TimelineRowsView({ rows }: { rows: TimelineRow[] }) {
    return (
      <>
        {rows.map((row) => (
          <TimelineRowView key={row.key} row={row} />
        ))}
      </>
    );
  },
  (prev, next) => rowArraysEqual(prev.rows, next.rows),
);
