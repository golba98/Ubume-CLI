/**
 * `/usage` overlay (`usage-panel` screen): renders the active provider's usage
 * snapshot (rows built by `usagePanelRows.ts`) in a scrollable, bordered box
 * with a footer showing refresh/scroll hints.
 *
 * State: local scroll `offset` and a `clock` that ticks every second so
 * relative times ("resets in …") and the refresh cooldown stay current; the
 * interval is cleared on unmount. The usage view, cooldown and callbacks come
 * from `src/app/providers/useProviderUsage.ts`.
 *
 * Focus: registers `focusId` with `autoFocus`; input is handled only while
 * focused. Keys: R refreshes (ignored while a fetch is in flight or during the
 * cooldown), Up/k and Down/j scroll by a row, PageUp/PageDown by a page, Esc or
 * q closes.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { Theme } from "../../config/settings.js";
import type { UsageViewState } from "../../core/usage/usageService.js";
import { usePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";
import { buildUsageFooterRows, buildUsagePanelRows, type UsageRowTone } from "./usagePanelRows.js";

interface UsagePanelProps {
  focusId: string;
  view: UsageViewState;
  /** Epoch ms when R contacts the provider again; 0 when refresh is always allowed. */
  refreshAvailableAt: number;
  onRefresh: () => void;
  onClose: () => void;
  /** Test seam for a deterministic clock. */
  now?: () => number;
  /** IANA time zone for absolute times; defaults to the system zone. Test seam. */
  timeZone?: string;
}

/** Map a semantic row tone to a theme color (unknown tones use `theme.text`). */
function toneColor(theme: Theme, tone: UsageRowTone): string {
  switch (tone) {
    case "muted":
      return theme.textMuted;
    case "dim":
      return theme.textDim;
    case "accent":
      return theme.accent;
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "error":
      return theme.error;
    default:
      return theme.text;
  }
}

/** Account usage for the active provider. R refreshes, Esc closes, arrows scroll. */
export function UsagePanel({
  focusId,
  view,
  refreshAvailableAt,
  onRefresh,
  onClose,
  now = Date.now,
  timeZone,
}: UsagePanelProps) {
  const theme = useTheme();
  const panelLayout = usePanelLayout();
  const compact = panelLayout?.mode === "compact" || (panelLayout?.availableRows ?? 24) < 16;
  // The layout budget already excludes this panel's border, padding and title row.
  const width = Math.max(12, panelLayout?.availableCols ?? 76);
  const availableRows = panelLayout?.availableRows ?? 20;
  const [clock, setClock] = useState(now);
  const [offset, setOffset] = useState(0);
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });

  useEffect(() => {
    const timer = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(timer);
  }, [now]);

  const rows = useMemo(
    () => buildUsagePanelRows(view, { width, now: clock, compact, timeZone }),
    [view, width, clock, compact, timeZone],
  );
  const footerOptions = { width, now: clock, timeZone, refreshAvailableAt };
  // Size the body against the footer it would need when scrolling (the widest variant).
  const reservedFooter = buildUsageFooterRows(view, { ...footerOptions, scrollable: true });
  // Non-compact layouts budget one extra row, used as the gap above the footer.
  const footerGap = compact ? 0 : 1;
  const height = Math.max(3, availableRows - reservedFooter.length - footerGap);
  const maxOffset = Math.max(0, rows.length - height);
  const visibleOffset = Math.min(offset, maxOffset);
  const visible = rows.slice(visibleOffset, visibleOffset + height);
  const footer = buildUsageFooterRows(view, { ...footerOptions, scrollable: maxOffset > 0 });
  const cooldownMs = refreshAvailableAt - clock;

  useInput(
    (input, key) => {
      if (key.escape || input === "q") {
        onClose();
        return;
      }
      if (input === "r" || input === "R") {
        if (!view.inFlight && cooldownMs <= 0) onRefresh();
        return;
      }
      // Functional updates so key repeats faster than a render still accumulate.
      const scrollBy = (delta: number) =>
        setOffset((current) =>
          Math.max(0, Math.min(maxOffset, Math.min(current, maxOffset) + delta)),
        );
      if (key.upArrow || input === "k") scrollBy(-1);
      else if (key.downArrow || input === "j") scrollBy(1);
      else if (key.pageUp) scrollBy(-height);
      else if (key.pageDown) scrollBy(height);
    },
    { isActive: isFocused },
  );

  const title = view.snapshot ? `Usage · ${view.snapshot.providerLabel}` : "Provider Usage";

  return (
    <Box
      borderStyle="round"
      borderColor={theme.borderFocused}
      flexDirection="column"
      paddingX={1}
      width="100%"
    >
      <Text color={theme.accent} bold wrap="truncate">
        {view.inFlight && view.snapshot ? `${title} · refreshing…` : title}
      </Text>
      {visible.map((row) => (
        <Text key={row.key} color={toneColor(theme, row.tone)} bold={row.bold} wrap="truncate">
          {row.text || " "}
        </Text>
      ))}
      <Box marginTop={footerGap} flexDirection="column">
        {footer.map((row) => (
          <Text key={row.key} color={toneColor(theme, row.tone)} wrap="truncate">
            {row.text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
