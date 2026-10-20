/** Kitty placeholders are ordinary Ink cells; the frame writer supplies their image. */
import { Box, Text } from "ink";
import { kittyPlaceholderRow } from "../../core/terminal/startupGraphics.js";
import { useTheme } from "../theme.js";
import { getToneColor } from "../timeline/TimelineRows.js";
import type { TimelineRow } from "../timeline/timelineMeasure.js";
import {
  BASE_STARTUP_LOGO_SIZE,
  type StartupLogoSize,
  startupMetadataOffset,
} from "./startupLogoLayout.js";

export function StartupGraphicRow({
  row,
  imageId,
  index,
  padding = 1,
  size = BASE_STARTUP_LOGO_SIZE,
}: {
  row: TimelineRow;
  imageId: number;
  index: number;
  padding?: number;
  size?: StartupLogoSize;
}) {
  const theme = useTheme();
  // Wrapped compact rows add one pad cell before the shared logo/metadata region.
  let skip = padding + startupMetadataOffset(size);
  const metadata = row.spans.flatMap((span) => {
    const count = Math.min(skip, span.text.length);
    skip -= count;
    return span.text.length > count ? [{ ...span, text: span.text.slice(count) }] : [];
  });
  return (
    <Box width="100%" overflow="hidden">
      <Text>
        {" ".repeat(padding)}
        <Text color={`#${imageId.toString(16).padStart(6, "0")}`}>
          {kittyPlaceholderRow(imageId, index, size.columns)}
        </Text>
        {" ".repeat(size.gap)}
        {metadata.map((span, i) => (
          <Text key={i} color={getToneColor(theme, span.tone)} bold={span.bold}>
            {span.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
