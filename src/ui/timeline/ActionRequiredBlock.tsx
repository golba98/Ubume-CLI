/**
 * React (Ink) card for an `AWAITING_USER_ACTION` verification question.
 *
 * Part of the React component path rooted at `TurnGroup`, which the app does
 * not mount in production: the transcript renders measured rows, and the
 * measured equivalent of this card is `buildActionRequiredRows` in
 * `measure/eventRows.ts`. The two are not row-for-row identical (this uses an
 * Ink border box with margins), so changes here do not affect viewport
 * measurement.
 */
import { Box, Text } from "ink";
import { wrapPlainText } from "../../core/shared/text.js";
import { getUsableShellWidth } from "../layout.js";
import { useTheme } from "../theme.js";

interface ActionRequiredBlockProps {
  cols: number;
  turnIndex: number;
  question: string;
}

/** Bordered "[N] ACTION REQUIRED" card showing the wrapped question text. */
export function ActionRequiredBlock({ cols, turnIndex, question }: ActionRequiredBlockProps) {
  const theme = useTheme();
  const contentWidth = Math.max(1, getUsableShellWidth(cols, 6));

  const wrappedContent = question.split("\n").flatMap((line) => {
    const rows = wrapPlainText(line, contentWidth);
    return rows.length > 0 ? rows : [""];
  });

  return (
    <Box
      borderStyle="single"
      borderColor={theme.borderFocused}
      flexDirection="column"
      marginBottom={1}
      width="100%"
    >
      <Box width="100%" justifyContent="space-between" overflow="hidden" paddingX={1}>
        <Text color={theme.text} bold>{`[${turnIndex}] ACTION REQUIRED`}</Text>
        <Text color={theme.text} bold>
          {"⚡"}
        </Text>
      </Box>
      <Box flexDirection="column" paddingX={2} marginTop={1} marginBottom={1} width="100%">
        <Text color={theme.text} bold>
          {"Verification Question"}
        </Text>
        {wrappedContent.map((row, index) => (
          <Text key={`content-${index}`} color={theme.text}>
            {row || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
