/**
 * Bordered "Update available" card shown beside the logo in the wide/medium
 * `TopHeader` layouts.
 *
 * Pure presentation (props + theme). `UPDATE_CARD_ROWS` is exported so the
 * header's row measurement matches the rendered card; keep it in sync with the
 * number of `<Text>` lines below.
 */
import { Box, Text } from "ink";
import { clampVisualText } from "../../core/shared/text.js";
import { formatVersionLabel, UBUME_UPDATE_COMMAND } from "../../core/version/updateCheck.js";
import { useTheme } from "../theme.js";

export const UPDATE_CARD_CONTENT_ROWS = 4; // title + available + using + command
export const UPDATE_CARD_ROWS = UPDATE_CARD_CONTENT_ROWS + 2; // +2 for top/bottom border rows

interface UpdateAvailableCardProps {
  latestVersion: string;
  currentVersion: string;
  updateCommand?: string;
  /** Total box width including borders. Long lines are truncated to fit. */
  width?: number;
}

/** Four content lines inside a round border; each line is clamped to the inner width when `width` is set. */
export function UpdateAvailableCard({
  latestVersion,
  currentVersion,
  updateCommand = UBUME_UPDATE_COMMAND,
  width,
}: UpdateAvailableCardProps) {
  const theme = useTheme();
  const command = `Run: ${updateCommand}`;
  // Inner content width = boxWidth - 2 (left/right border cols)
  const innerWidth = width !== undefined ? Math.max(8, width - 2) : undefined;

  function clamp(text: string): string {
    return innerWidth !== undefined ? clampVisualText(text, innerWidth) : text;
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      flexDirection="column"
      width={width}
      flexShrink={0}
    >
      <Text color={theme.text} bold>
        {clamp("Update available")}
      </Text>
      <Text color={theme.textMuted}>{clamp(`Ubume ${formatVersionLabel(latestVersion)}`)}</Text>
      <Text color={theme.textMuted}>{clamp(`Using ${formatVersionLabel(currentVersion)}`)}</Text>
      <Text color={theme.textDim}>{clamp(command)}</Text>
    </Box>
  );
}
