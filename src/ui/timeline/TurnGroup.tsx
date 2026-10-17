/**
 * React (Ink) component rendering of one transcript turn, plus the shared
 * `TurnOpacity` / `TurnRunPhase` types and `resolveTurnRunPhase`.
 *
 * Production status: the app does not mount `<TurnGroup>`. Both transcript
 * surfaces (`TranscriptShell`, `Timeline`) render measured rows from
 * `measure/` via `TimelineRowView`, and only those rows drive viewport and
 * live-window heights. This component tree is exercised by tests
 * (`TurnGroup.test.tsx`). It shares text helpers with the row builders
 * (`progressEntries`, `runActivityView`, `MemoizedRenderMessage` →
 * `buildMarkdownRows`), so markdown and reasoning text wrap identically, but
 * its card chrome is NOT row-for-row equivalent — e.g. actions render here as
 * bordered `DashCard`s, whereas `buildActionEventRows` emits a single compact
 * line. Do not treat this file as the reference for measured heights.
 *
 * `resolveTurnRunPhase` and the exported types ARE on the production path:
 * `timelineItems.ts` uses them to build render state for every turn.
 */
import { Box, Text } from "ink";
import { memo, useMemo } from "react";
import { formatDuration, wrapCommandText, wrapPlainText } from "../../core/shared/text.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { normalizePlanReviewMarkdown } from "../../core/workspace/planStorage.js";
import type { RunFileActivity } from "../../core/workspace/workspaceActivity.js";
import type {
  AssistantEvent,
  RunEvent,
  RunProgressBlock,
  RunResponseSegment,
  RunToolActivity,
  UIState,
  UserPromptEvent,
} from "../../session/types.js";
import {
  getAssistantContent,
  getResponseSegmentText,
  getRunPlanText,
} from "../../session/types.js";
import { getUsableShellWidth, transcriptContentIndent } from "../layout.js";
import { MemoizedRenderMessage, parseMarkdown } from "../render/Markdown.js";
import { useTheme } from "../theme.js";
import { ActionRequiredBlock } from "./ActionRequiredBlock.js";
import { AgentBlock } from "./AgentBlock.js";
import { DashCard } from "./DashCard.js";
import { formatProgressBlockBodyLines } from "./progressEntries.js";
import {
  coalesceConsecutiveThinking,
  getFriendlyActionLabel,
  normalizeCommand,
  selectVisibleRunActivity,
} from "./runActivityView.js";

/** Visual emphasis of a turn relative to the active one (see `createTurnOpacityResolver`). */
export type TurnOpacity = "active" | "recent" | "dim";

interface TurnGroupProps {
  cols: number;
  turnIndex: number;
  user: UserPromptEvent;
  run: RunEvent | null;
  assistant: AssistantEvent | null;
  opacity: TurnOpacity;
  question: string | null;
  runPhase: TurnRunPhase;
  streamPreviewRows: number;
  streamMode: "assistant-first";
  verboseMode?: boolean;
  workspaceRoot?: string | null;
}

// ─── User Input Card ─────────────────────────────────────────────────────────
// User prompt wrapped in a rounded DashCard border.

function UserInputCard({ prompt, cols, dim }: { prompt: string; cols: number; dim: boolean }) {
  const theme = useTheme();
  const borderColor = theme.border;
  const contentWidth = Math.max(1, cols - 7);
  const lines = wrapPlainText(sanitizeTerminalOutput(prompt), contentWidth);

  return (
    <DashCard cols={cols} title="PROMPT" borderColor={borderColor}>
      {lines.map((line, i) => (
        <Text key={i} color={dim ? theme.textDim : theme.text}>
          {i === 0 ? "❯ " : "  "}
          {line}
        </Text>
      ))}
    </DashCard>
  );
}

const MemoizedUserInputCard = memo(
  UserInputCard,
  (prev, next) => prev.prompt === next.prompt && prev.cols === next.cols && prev.dim === next.dim,
);

// ─── Impact Summary ──────────────────────────────────────────────────────────
// Compact file-change summary replacing FileScanCard + ActivityCard

function ImpactSummary({ run }: { run: RunEvent }) {
  const theme = useTheme();
  const summary = run.activitySummary;
  const hasFiles = run.touchedFileCount > 0;
  const hasTools = run.toolActivities.length > 0;

  if (!hasFiles && !hasTools) return null;

  const recentFiles = summary?.recent ?? run.activity.slice(-6);
  const hasDeletes = (summary?.deleted ?? 0) > 0;

  const opLabel = (op: string) => {
    switch (op) {
      case "created":
        return "CREATED ";
      case "modified":
        return "MODIFIED";
      case "deleted":
        return "DELETED ";
      default:
        return op.toUpperCase().padEnd(8);
    }
  };

  const opColor = (op: string) => {
    switch (op) {
      case "created":
        return theme.success;
      case "deleted":
        return theme.error;
      default:
        return theme.info;
    }
  };

  return (
    <Box flexDirection="column" width="100%" paddingX={1} marginTop={0}>
      {hasDeletes && <Text color={theme.warning}>{"⚠ Destructive changes detected:"}</Text>}
      {hasFiles && (
        <>
          <Text color={theme.textDim}>{"  Changes:"}</Text>
          {recentFiles.map((file: RunFileActivity, i: number) => {
            const diffInfo =
              file.addedLines != null || file.removedLines != null
                ? ` (+${file.addedLines ?? 0} -${file.removedLines ?? 0})`
                : "";
            return (
              <Text key={i}>
                <Text color={theme.textDim}>{"    "}</Text>
                <Text color={opColor(file.operation)}>{opLabel(file.operation)}</Text>
                <Text color={theme.text}> {file.path}</Text>
                <Text color={theme.textDim}>{diffInfo}</Text>
              </Text>
            );
          })}
        </>
      )}
      <Text color={theme.textDim}>
        {"  "}
        <Text color={theme.success}>{"✔ "}</Text>
        {run.touchedFileCount > 0 &&
          `${run.touchedFileCount} file${run.touchedFileCount === 1 ? "" : "s"}`}
        {hasTools &&
          `${hasFiles ? " • " : ""}${run.toolActivities.length} action${run.toolActivities.length === 1 ? "" : "s"}`}
        {run.durationMs != null && ` • ${formatDuration(run.durationMs)}`}
      </Text>
    </Box>
  );
}

// ─── Verbose Cards (only shown in verbose mode) ──────────────────────────────

function FileScanCard({ run, cols }: { run: RunEvent; cols: number }) {
  const theme = useTheme();
  const { visible, hiddenCount } = selectVisibleRunActivity(run);
  const badge = `${run.touchedFileCount} file${run.touchedFileCount === 1 ? "" : "s"}`;

  return (
    <DashCard cols={cols} title="Scanning workspace ..." rightBadge={badge}>
      {hiddenCount > 0 && <Text color={theme.textDim}>{`... ${hiddenCount} more`}</Text>}
      {visible.map((file, i) => (
        <Text key={i} color={theme.success}>
          {"● "}
          <Text color={theme.text}>{file.path}</Text>
        </Text>
      ))}
    </DashCard>
  );
}

const COMPACT_PROCESSING_BODY_LINE_CAP = 4;
const VISIBLE_THINKING_SOURCES = new Set(["reasoning", "todo"]);

// ─── Unified Event Stream Card ───────────────────────────────────────────────

type ResolvedStreamEvent =
  | { kind: "thinking"; streamSeq: number; block: RunProgressBlock }
  | { kind: "action"; streamSeq: number; tool: RunToolActivity }
  | { kind: "response"; streamSeq: number; segment: RunResponseSegment }
  | { kind: "plan"; streamSeq: number; planText: string; approved: boolean };

// React-path counterpart of measure/streamRows.ts `collectStreamEvents`. It is
// NOT identical: here a completed reasoning block is revealed mid-run (only
// active ones are hidden), whereas the measured path defers all reasoning
// until the run finishes to keep live block order append-only.
function resolveStreamEvents(
  run: RunEvent,
  assistant: AssistantEvent | null,
  streaming: boolean,
): ResolvedStreamEvent[] {
  const blocksById = new Map<string, RunProgressBlock>();
  for (const entry of run.progressEntries ?? []) {
    for (const block of entry.blocks) blocksById.set(block.id, block);
  }
  const toolsById = new Map(run.toolActivities.map((tool) => [tool.id, tool] as const));
  const segmentsById = new Map((run.responseSegments ?? []).map((seg) => [seg.id, seg] as const));

  const items = (run.streamItems ?? []).slice().sort((a, b) => a.streamSeq - b.streamSeq);
  const resolved: ResolvedStreamEvent[] = [];
  for (const item of items) {
    if (item.kind === "thinking") {
      const block = blocksById.get(item.refId);
      if (
        block &&
        block.text.trim().length > 0 &&
        !(run.status === "running" && block.status === "active")
      ) {
        resolved.push({ kind: "thinking", streamSeq: item.streamSeq, block });
      }
    } else if (item.kind === "action") {
      const tool = toolsById.get(item.refId);
      if (tool) resolved.push({ kind: "action", streamSeq: item.streamSeq, tool });
    } else if (item.kind === "response") {
      const segment = segmentsById.get(item.refId);
      if (segment) resolved.push({ kind: "response", streamSeq: item.streamSeq, segment });
    } else if (item.kind === "plan") {
      const planText =
        run.plan?.id === item.refId ? getRunPlanText(run.plan) : (run.approvedPlan ?? "");
      if (planText.trim()) {
        resolved.push({
          kind: "plan",
          streamSeq: item.streamSeq,
          planText,
          approved: Boolean(run.approvedPlan),
        });
      }
    }
  }

  // Backward-compat fallback for older session data that predates streamItems.
  // New runs always use the streamItems path above.
  if (resolved.length === 0 && items.length === 0) {
    let legacySeq = 0;
    for (const entry of run.progressEntries ?? []) {
      if (!VISIBLE_THINKING_SOURCES.has(entry.source)) continue;
      for (const block of entry.blocks) {
        if (!block.text.trim()) continue;
        if (run.status === "running" && block.status === "active") continue;
        legacySeq += 1;
        resolved.push({ kind: "thinking", streamSeq: legacySeq, block });
      }
    }

    for (const tool of run.toolActivities ?? []) {
      legacySeq += 1;
      resolved.push({ kind: "action", streamSeq: legacySeq, tool });
    }

    for (const segment of run.responseSegments ?? []) {
      if (!getResponseSegmentText(segment).trim() && !streaming) continue;
      legacySeq += 1;
      resolved.push({ kind: "response", streamSeq: legacySeq, segment });
    }
  }

  // First-render fallback: the assistant may have produced text before the
  // run has received a stream item, especially with older persisted data.
  if (resolved.length === 0 && (getAssistantContent(assistant).length > 0 || streaming)) {
    const content = getAssistantContent(assistant);
    resolved.push({
      kind: "response",
      streamSeq: 1,
      segment: {
        id: `synthetic-${run.id}`,
        streamSeq: 1,
        chunks: [content],
        status: streaming ? "active" : "completed",
        startedAt: run.startedAt,
      },
    });
  }

  return coalesceConsecutiveThinking(resolved);
}

function PlanPanel({
  planText,
  cols,
  approved,
  workspaceRoot,
}: {
  planText: string;
  cols: number;
  approved: boolean;
  workspaceRoot?: string | null;
}) {
  const theme = useTheme();
  const contentWidth = Math.max(1, getUsableShellWidth(cols, 4));

  const formatted = useMemo(() => {
    const normalized = normalizePlanReviewMarkdown(planText, workspaceRoot);
    return parseMarkdown(normalized);
  }, [planText, workspaceRoot]);

  return (
    <DashCard
      cols={cols}
      title="Plan"
      rightBadge={approved ? "approved" : undefined}
      borderColor={theme.accent}
      titleColor={theme.text}
      badgeColor={theme.success}
    >
      <MemoizedRenderMessage segments={formatted} width={contentWidth} brightHeadings />
    </DashCard>
  );
}

const MemoizedPlanPanel = memo(
  PlanPanel,
  (prev, next) =>
    prev.planText === next.planText &&
    prev.cols === next.cols &&
    prev.approved === next.approved &&
    prev.workspaceRoot === next.workspaceRoot,
);

function ActionEventCard({
  cols,
  tool,
  opacity,
  isLiveCursorTarget,
}: {
  cols: number;
  tool: RunToolActivity;
  opacity: TurnOpacity;
  isLiveCursorTarget: boolean;
}) {
  const theme = useTheme();
  const dim = opacity !== "active";
  const actionNormalized = normalizeCommand(tool.command);
  const actionLabel = getFriendlyActionLabel(actionNormalized);

  const statusIcon = tool.status === "failed" ? "✕" : tool.status === "completed" ? "✔" : "▸";
  const statusColor =
    tool.status === "failed"
      ? theme.error
      : tool.status === "completed"
        ? theme.success
        : theme.info;
  const borderColor = dim
    ? theme.border
    : tool.status === "running"
      ? theme.borderFocused
      : theme.border;
  const detailText =
    isLiveCursorTarget && tool.status === "running"
      ? "▌"
      : tool.summary?.trim()
        ? tool.summary
        : " ";
  const detailColor =
    isLiveCursorTarget && tool.status === "running" ? theme.accent : theme.textMuted;
  const duration =
    tool.completedAt != null ? formatDuration(tool.completedAt - tool.startedAt) : null;

  const commandBodyWidth = Math.max(1, cols - 6);
  const commandLines = wrapCommandText(actionNormalized, commandBodyWidth);

  return (
    <DashCard
      cols={cols}
      title="action"
      rightBadge={duration || undefined}
      borderColor={borderColor}
    >
      {actionLabel ? (
        <>
          <Box>
            <Text color={statusColor}>{statusIcon + " "}</Text>
            <Text color={dim ? theme.textDim : theme.text}>{actionLabel}</Text>
          </Box>
          {commandLines.map((line, i) => (
            <Text key={i} color={theme.textMuted}>
              {"  "}
              {line || " "}
            </Text>
          ))}
        </>
      ) : (
        <>
          {commandLines.map((line, i) => (
            <Box key={i}>
              <Text color={i === 0 ? statusColor : undefined}>
                {i === 0 ? statusIcon + " " : "  "}
              </Text>
              <Text color={dim ? theme.textDim : theme.text}>{line || " "}</Text>
            </Box>
          ))}
          <Text color={theme.textMuted}>{"   "}</Text>
        </>
      )}
      <Text color={detailColor}>
        {"  "}
        {detailText}
      </Text>
    </DashCard>
  );
}

const MemoizedActionEventCard = memo(
  ActionEventCard,
  (prev, next) =>
    prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.command === next.tool.command &&
    prev.tool.completedAt === next.tool.completedAt &&
    prev.tool.summary === next.tool.summary &&
    prev.cols === next.cols &&
    prev.opacity === next.opacity &&
    prev.isLiveCursorTarget === next.isLiveCursorTarget,
);

function CodexThinkingBlock({
  block,
  cols,
  isLiveCursorTarget,
  verboseMode,
}: {
  block: RunProgressBlock;
  cols: number;
  isLiveCursorTarget: boolean;
  verboseMode: boolean;
}) {
  const theme = useTheme();
  const contentWidth = Math.max(1, getUsableShellWidth(cols, transcriptContentIndent + 1));

  return (
    <Box flexDirection="column" width="100%" paddingLeft={transcriptContentIndent} paddingRight={1}>
      <Text color={theme.textMuted} bold>
        Reasoning
      </Text>
      {formatProgressBlockBodyLines(block.text, contentWidth)
        .slice(0, verboseMode ? undefined : COMPACT_PROCESSING_BODY_LINE_CAP)
        .map((line, i) => (
          <Text key={i} color={theme.textDim}>
            {line || " "}
          </Text>
        ))}
      {isLiveCursorTarget && block.status === "active" && <Text color={theme.accent}>▌</Text>}
    </Box>
  );
}

function CodexResponseBlock({
  run,
  segment,
  cols,
  streaming,
  isLast,
  isLiveCursorTarget,
}: {
  run: RunEvent;
  segment: RunResponseSegment;
  cols: number;
  streaming: boolean;
  isLast: boolean;
  isLiveCursorTarget: boolean;
}) {
  const theme = useTheme();
  const contentWidth = Math.max(1, getUsableShellWidth(cols, transcriptContentIndent + 1));

  const formatted = useMemo(() => {
    return parseMarkdown(getResponseSegmentText(segment), {
      streaming: segment.status === "active",
      cacheKey: `react-${run.id}-${segment.id}`,
    });
  }, [segment, run.id]);

  const segmentStreaming = segment.status === "active";

  return (
    <Box flexDirection="column" width="100%" paddingLeft={transcriptContentIndent} paddingRight={1}>
      <Text color={theme.textMuted} bold>
        Ubume
      </Text>
      {run.status === "failed" && !streaming && isLast && (
        <Box flexDirection="column">
          {wrapPlainText(sanitizeTerminalOutput(run.errorMessage ?? run.summary), contentWidth).map(
            (row, i) => (
              <Text key={i} color={theme.error}>
                {i === 0 ? `✕ ${row}` : `  ${row}`}
              </Text>
            ),
          )}
        </Box>
      )}
      <MemoizedRenderMessage segments={formatted} width={contentWidth} />
      {isLiveCursorTarget && segmentStreaming && <Text color={theme.accent}>▌</Text>}
    </Box>
  );
}

const StreamEventList = memo(
  function StreamEventList({
    cols,
    run,
    assistant,
    runPhase,
    opacity,
    verboseMode,
    workspaceRoot,
  }: {
    cols: number;
    run: RunEvent;
    assistant: AssistantEvent | null;
    runPhase: TurnRunPhase;
    opacity: TurnOpacity;
    verboseMode: boolean;
    workspaceRoot?: string | null;
  }) {
    const streaming = runPhase === "streaming";
    const events = useMemo(
      () => resolveStreamEvents(run, assistant, streaming),
      [run, assistant, streaming],
    );

    return (
      <Box flexDirection="column" width="100%">
        {events.map((event, index) => {
          const isLast = index === events.length - 1;
          const isLiveCursorTarget = run.status === "running" && isLast;

          return (
            <Box
              key={`${event.kind}-${event.streamSeq}`}
              flexDirection="column"
              marginTop={index > 0 ? 1 : 0}
            >
              {event.kind === "thinking" && (
                <CodexThinkingBlock
                  block={event.block}
                  cols={cols}
                  isLiveCursorTarget={isLiveCursorTarget}
                  verboseMode={verboseMode}
                />
              )}
              {event.kind === "action" && (
                <MemoizedActionEventCard
                  cols={cols}
                  tool={event.tool}
                  opacity={opacity}
                  isLiveCursorTarget={isLiveCursorTarget}
                />
              )}
              {event.kind === "response" && (
                <CodexResponseBlock
                  run={run}
                  segment={event.segment}
                  cols={cols}
                  streaming={streaming}
                  isLast={isLast}
                  isLiveCursorTarget={isLiveCursorTarget}
                />
              )}
              {event.kind === "plan" && (
                <MemoizedPlanPanel
                  planText={event.planText}
                  cols={cols}
                  approved={event.approved}
                  workspaceRoot={workspaceRoot}
                />
              )}
            </Box>
          );
        })}

        {run.status !== "running" && !verboseMode && (
          <Box marginTop={1}>
            <ImpactSummary run={run} />
          </Box>
        )}
      </Box>
    );
  },
  (prev, next) =>
    prev.cols === next.cols &&
    prev.run === next.run &&
    prev.assistant === next.assistant &&
    prev.runPhase === next.runPhase &&
    prev.opacity === next.opacity &&
    prev.verboseMode === next.verboseMode &&
    prev.workspaceRoot === next.workspaceRoot,
);

// ─── TurnGroup ───────────────────────────────────────────────────────────────

/**
 * One turn as React components: prompt card, unified stream (or a bare
 * `AgentBlock` when there is no run), verbose file-scan card, and the pending
 * question card. `streamPreviewRows` / `streamMode` are accepted but unused.
 */
export function TurnGroup({
  cols,
  turnIndex,
  user,
  run,
  assistant,
  opacity,
  question,
  runPhase,
  verboseMode = false,
  workspaceRoot,
}: TurnGroupProps) {
  return (
    <Box flexDirection="column" width="100%" marginBottom={1}>
      <MemoizedUserInputCard prompt={user.prompt} cols={cols} dim={opacity === "dim"} />

      {run && (
        <Box marginTop={1}>
          <StreamEventList
            cols={cols}
            run={run}
            assistant={assistant}
            runPhase={runPhase}
            opacity={opacity}
            verboseMode={verboseMode}
            workspaceRoot={workspaceRoot}
          />
        </Box>
      )}

      {!run && assistant && (
        <Box marginTop={1}>
          <AgentBlock
            cols={cols}
            turnIndex={turnIndex}
            assistant={assistant}
            run={null}
            streaming={false}
            dim={opacity === "dim"}
            runPhase="final"
          />
        </Box>
      )}

      {run && run.status !== "running" && verboseMode && (
        <>
          {run.touchedFileCount > 0 && <FileScanCard run={run} cols={cols} />}
          {/* ActivityCard is skipped because actions are now in the unified stream */}
        </>
      )}

      {question && <ActionRequiredBlock cols={cols} turnIndex={turnIndex} question={question} />}
    </Box>
  );
}

/** Rendering phase of a turn's run: no run, waiting for output, streaming, or final. */
export type TurnRunPhase = "none" | "thinking" | "streaming" | "final";

/**
 * Derive a turn's run phase from its run status and the global UI state.
 *
 * Note: during ANSWER_VISIBLE this reports "final" while the run is still
 * `running`. Height-affecting decisions that must not fire on a live run (e.g.
 * `compactActionBursts`) therefore key off `run.status`, not this phase.
 */
export function resolveTurnRunPhase(
  run: RunEvent | null,
  assistant: AssistantEvent | null,
  uiState: UIState,
  turnId: number,
): TurnRunPhase {
  if (!run) return "none";
  if (run.status !== "running") return "final";

  if (uiState.kind === "RESPONDING" && uiState.turnId === turnId) {
    return "streaming";
  }

  if (uiState.kind === "ANSWER_VISIBLE" && uiState.turnId === turnId) {
    return "final";
  }

  if (uiState.kind === "THINKING" && uiState.turnId === turnId) {
    return "thinking";
  }

  // Defensive fallback to prevent blank/stale turn cards during rapid state churn.
  if (getAssistantContent(assistant).trim()) {
    return "streaming";
  }

  return "thinking";
}
