/**
 * React (Ink) card for an assistant answer that has no associated run.
 *
 * Part of the React component path: `TurnGroup` renders it only for turns with
 * an assistant event but no `RunEvent`, and the app itself does not mount
 * `TurnGroup` in production (the transcript renders measured rows from
 * `measure/`). The markdown body still goes through `MemoizedRenderMessage`,
 * so its text rows match the measured markdown rows; the surrounding card,
 * cursor and status lines are not measured anywhere.
 */
import { Box, Text } from "ink";
import { memo, useDeferredValue, useMemo } from "react";
import { formatDuration, wrapPlainText } from "../../core/shared/text.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { RUN_OUTPUT_TRUNCATION_NOTICE } from "../../session/chatLifecycle.js";
import type { AssistantEvent, RunEvent } from "../../session/types.js";
import { getAssistantContent } from "../../session/types.js";
import { getUsableShellWidth } from "../layout.js";
import { MemoizedRenderMessage, parseMarkdown } from "../render/Markdown.js";
import { useTheme } from "../theme.js";
import { DashCard } from "./DashCard.js";

interface AgentBlockProps {
  cols: number;
  assistant: AssistantEvent | null;
  run: RunEvent | null;
  streaming: boolean;
  turnIndex: number;
  dim?: boolean;
  runPhase?: "streaming" | "final";
  streamingPreviewRows?: number;
  streamingMode?: "assistant-first";
}

const MemoizedMessageBody = memo(
  function MessageBody({
    segments,
    width,
  }: {
    segments: ReturnType<typeof parseMarkdown>;
    width: number;
  }) {
    return <MemoizedRenderMessage segments={segments} width={width} />;
  },
  (prev, next) => prev.segments === next.segments && prev.width === next.width,
);

const StreamingCursor = memo(function StreamingCursor() {
  const theme = useTheme();
  return (
    <Box width="100%" paddingLeft={2}>
      <Text color={theme.accent}>{"▌"}</Text>
    </Box>
  );
});

/**
 * Assistant answer inside a `DashCard` titled with the run's model (or
 * "Codex"), with a status/duration badge, failure/cancel notices and a
 * streaming cursor. `turnIndex`, `streamingPreviewRows` and `streamingMode`
 * are accepted but unused.
 */
export function AgentBlock({
  cols,
  assistant,
  run,
  streaming,
  dim = false,
  runPhase = streaming ? "streaming" : "final",
}: AgentBlockProps) {
  const theme = useTheme();
  const content = getAssistantContent(assistant);
  const deferredContent = useDeferredValue(content);
  // During streaming, use content directly for immediate rendering.
  // When not streaming, defer large final content to avoid blocking input.
  const renderContent = streaming ? content : deferredContent;
  const contentWidth = Math.max(1, getUsableShellWidth(cols, 4));

  // The cacheKey lets parseMarkdown reuse the already-parsed prefix of an
  // append-only stream instead of re-parsing the whole answer per delta.
  const pipelineState = useMemo(() => {
    const formatted = parseMarkdown(renderContent, {
      streaming,
      cacheKey: `agent-${assistant?.id ?? run?.id ?? 0}`,
    });
    return { length: renderContent.length, formatted };
  }, [renderContent, streaming, assistant?.id, run?.id]);

  const failureMessage =
    run?.status === "failed" ? sanitizeTerminalOutput(run.errorMessage ?? run.summary) : null;
  const cancelMessage = run?.status === "canceled" ? sanitizeTerminalOutput(run.summary) : null;

  const runStatus =
    runPhase === "streaming"
      ? "streaming"
      : run?.status === "completed"
        ? "complete"
        : (run?.status ?? "running");
  const rightBadge =
    run?.durationMs != null && runPhase !== "streaming"
      ? `${runStatus} • ${formatDuration(run.durationMs)}`
      : runStatus;
  const heading = run?.runtime.model ? run.runtime.model.toUpperCase().replace(/-/g, " ") : "Codex";

  const borderColor = dim
    ? theme.border
    : runPhase === "streaming"
      ? theme.borderFocused
      : theme.border;

  return (
    <DashCard cols={cols} title={heading} rightBadge={rightBadge} borderColor={borderColor}>
      {!streaming && failureMessage && (
        <Box flexDirection="column" width="100%">
          {wrapPlainText(failureMessage, contentWidth).map((row, index) => (
            <Text key={index} color={theme.error}>
              {index === 0 ? `✕ ${row || " "}` : row || " "}
            </Text>
          ))}
        </Box>
      )}

      {pipelineState.length > 0 && (
        <Box flexDirection="column" width="100%">
          <MemoizedMessageBody segments={pipelineState.formatted} width={contentWidth} />
        </Box>
      )}

      {streaming && <StreamingCursor />}

      {!streaming && run && run.status !== "running" && (
        <Box flexDirection="column" width="100%">
          {run.status === "canceled" && cancelMessage ? (
            <Text color={theme.warning}>{cancelMessage}</Text>
          ) : run.status === "completed" && pipelineState.length === 0 ? (
            <Text color={theme.textDim}>{"(no output)"}</Text>
          ) : null}
          {run.truncatedOutput && <Text color={theme.textDim}>{RUN_OUTPUT_TRUNCATION_NOTICE}</Text>}
        </Box>
      )}
    </DashCard>
  );
}
