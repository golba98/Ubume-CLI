/**
 * React (Ink) rounded "dash card" frame: `╭── title ─── badge ──╮`, `│ … │`
 * content, `╰───╯`.
 *
 * Used by the React component path (`TurnGroup`, `AgentBlock`), which the app
 * does not mount in production. The production transcript renders the measured
 * equivalent, `buildDashCardRows` in `measure/cards.ts`, whose top-border
 * arithmetic mirrors `buildTopBorder` below. Keep the two in step if the card
 * shape changes, but note only the measured version drives viewport heights.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { getTextWidth } from "../../core/shared/text.js";
import { useTheme } from "../theme.js";

interface DashCardProps {
  cols: number;
  title: string;
  rightBadge?: string;
  borderColor?: string;
  titleColor?: string;
  badgeColor?: string;
  children: ReactNode;
}

/**
 * Render `children` inside a rounded card sized from `cols`. Border, title and
 * badge colors default to theme border/muted/dim. Header and footer rows use
 * `wrap="truncate"` so they never wrap onto a second line.
 */
export function DashCard({
  cols,
  title,
  rightBadge,
  borderColor,
  titleColor,
  badgeColor,
  children,
}: DashCardProps) {
  const theme = useTheme();
  const border = borderColor ?? theme.border;
  const tColor = titleColor ?? theme.textMuted;
  const bColor = badgeColor ?? theme.textDim;

  // Account for AppShell gutter (-1) and Timeline paddingX={1} (-2)
  const w = cols - 3;

  const topLine = buildTopBorder(w, title, rightBadge);
  const bottomFill = "─".repeat(Math.max(1, w - 2));

  return (
    <Box flexDirection="column" width="100%">
      <Text wrap="truncate">
        <Text color={border}>{"╭── "}</Text>
        <Text color={tColor} bold>
          {topLine.title}
        </Text>
        <Text color={border}>{topLine.badge ? " " + topLine.fill + " " : " " + topLine.fill}</Text>
        {topLine.badge ? (
          <>
            <Text color={bColor}>{topLine.badge}</Text>
            <Text color={border}>{" ──╮"}</Text>
          </>
        ) : (
          <Text color={border}>{"──╮"}</Text>
        )}
      </Text>
      <Box flexDirection="row" width="100%">
        <Text color={border}>{"│ "}</Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {children}
        </Box>
        <Text color={border}>{" │"}</Text>
      </Box>
      <Text wrap="truncate" color={border}>
        {"╰" + bottomFill + "╯"}
      </Text>
    </Box>
  );
}

/** Compute the dash fill that stretches the top border to `w` columns (minimum 1 dash). */
function buildTopBorder(
  w: number,
  title: string,
  badge?: string,
): { title: string; fill: string; badge: string | null } {
  // Layout: "╭── " + title + " " + fill + " " + badge + " ──╮"
  // Or:     "╭── " + title + " " + fill + "──╮"
  const prefix = 4; // "╭── "
  const suffix = badge ? 4 : 3; // " ──╮" with badge spacing, or "──╮"
  const titleWidth = getTextWidth(title);
  const badgeWidth = badge ? getTextWidth(badge) : 0;
  const spacing = badge ? 2 : 1; // the title-only variant has no trailing gap before the corner

  const available = w - prefix - titleWidth - spacing - badgeWidth - suffix;
  const fillCount = Math.max(1, available);
  const fill = "─".repeat(fillCount);

  return { title, fill, badge: badge ?? null };
}
