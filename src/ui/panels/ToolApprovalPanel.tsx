/** Bounded permission evidence and stable-ID choices. App owns Ctrl+C and request settlement. */
import { Box, Text, useFocus, useStdout } from "ink";
import { useMemo, useState } from "react";
import { toolApprovalActions, toolApprovalRequestId } from "../../core/providers/toolApproval.js";
import type { ToolApprovalRequest, ToolApprovalSelection } from "../../core/providers/types.js";
import { useActivePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";
import {
  approvalEvidenceRows,
  visibleApprovalText,
  wrapApprovalText,
} from "./toolApprovalLayout.js";
import { useToolApprovalInput } from "./useToolApprovalInput.js";

export function ToolApprovalPanel({
  focusId,
  request,
  onSelect,
}: {
  focusId: string;
  request: ToolApprovalRequest;
  onSelect: (selection: ToolApprovalSelection) => void;
}) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const active = useActivePanelLayout();
  useFocus({ id: focusId, autoFocus: true });
  const requestId = toolApprovalRequestId(request);
  const options = useMemo(() => toolApprovalActions(request), [request]);
  const initialId =
    options.find((action) => action.decision === "allow-once")?.id ?? options[0]?.id;
  const [selection, setSelection] = useState({ requestId, id: initialId });
  const [scroll, setScroll] = useState({ requestId, offset: 0 });
  const selected =
    selection.requestId === requestId
      ? Math.max(
          0,
          options.findIndex((action) => action.id === selection.id),
        )
      : Math.max(
          0,
          options.findIndex((action) => action.id === initialId),
        );
  const width = Math.max(6, active?.width ?? stdout.columns ?? 80);
  const innerWidth = Math.max(2, width - 4);
  const maxHeight = Math.max(4, active?.height ?? (stdout.rows ?? 24) - 2);
  const evidenceRows = useMemo(
    () => approvalEvidenceRows(request, innerWidth),
    [request, innerWidth],
  );
  const optionLines = useMemo(
    () =>
      options.flatMap((option, index) =>
        wrapApprovalText(`${index + 1}. ${option.label}`, innerWidth - 2).map((text, line) => ({
          text: `${line === 0 && index === selected ? "> " : "  "}${text}`,
          index,
        })),
      ),
    [options, selected, innerWidth],
  );
  const warning = request.kind === "command" || request.tool === "run_shell";
  // Border, title, two help rows and optional warning are pinned, never flex-shrunk.
  const chrome = 5 + (warning ? 1 : 0);
  const optionRows = Math.min(Math.max(1, optionLines.length), Math.max(1, maxHeight - chrome - 1));
  const selectedLabelRows = useMemo(
    () =>
      wrapApprovalText(
        `Selected action (full label):\n${options[selected]?.label ?? ""}`,
        innerWidth,
      ),
    [options, selected, innerWidth],
  );
  const evidence =
    optionLines.filter((line) => line.index === selected).length > optionRows
      ? [...evidenceRows, ...selectedLabelRows]
      : evidenceRows;
  const detailRows = Math.min(evidence.length, Math.max(0, maxHeight - chrome - optionRows));
  const maxOffset = Math.max(0, evidence.length - detailRows);
  const offset = Math.min(scroll.requestId === requestId ? scroll.offset : 0, maxOffset);
  const firstSelected = Math.max(
    0,
    optionLines.findIndex((line) => line.index === selected),
  );
  const optionStart = Math.max(0, Math.min(firstSelected, optionLines.length - optionRows));
  const height = Math.min(maxHeight, chrome + detailRows + optionRows);
  useToolApprovalInput({
    requestId,
    options,
    selected,
    onSelect,
    onNavigate: (index) => setSelection({ requestId, id: options[index]?.id }),
    details: {
      offset,
      maxOffset,
      rows: detailRows,
      onScroll: (next) => setScroll({ requestId, offset: next }),
    },
  });

  const row = (text: string, color = theme.textMuted, bold = false) => (
    <Box height={1} flexShrink={0}>
      <Text color={color} bold={bold} wrap="truncate">
        {text || " "}
      </Text>
    </Box>
  );
  const shortcut = options.length
    ? options.length === 1
      ? "1"
      : `1–${Math.min(9, options.length)}`
    : "";
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
    >
      {row(
        `${visibleApprovalText((request.provider ?? "Local model").toUpperCase())} PERMISSION`,
        theme.warning,
        true,
      )}
      <Box flexDirection="column" height={detailRows} flexShrink={0} overflow="hidden">
        {evidence.slice(offset, offset + detailRows).map((line, index) => (
          <Box key={offset + index} flexShrink={0}>
            {row(line)}
          </Box>
        ))}
      </Box>
      {warning && row("Shell commands affect files, processes and network.", theme.warning)}
      <Box flexDirection="column" height={optionRows} flexShrink={0} overflow="hidden">
        {options.length
          ? optionLines.slice(optionStart, optionStart + optionRows).map((line, index) => (
              <Box key={optionStart + index} flexShrink={0}>
                {row(
                  line.text,
                  line.index === selected ? theme.text : theme.textMuted,
                  line.index === selected,
                )}
              </Box>
            ))
          : row("No supported actions. Esc denies.", theme.warning)}
      </Box>
      {row(
        options.length
          ? `↑↓/j/k · Enter${shortcut ? ` or ${shortcut}` : ""} select · Esc deny`
          : "Enter or Esc denies",
        theme.textDim,
      )}
      {row(
        `${maxOffset ? `Details ${offset + 1}–${Math.min(evidence.length, offset + detailRows)}/${evidence.length} · PgUp/PgDn Home/End` : ""}${optionLines.length > optionRows ? ` · Action ${selected + 1}/${options.length}` : ""}`,
        theme.textDim,
      )}
    </Box>
  );
}
