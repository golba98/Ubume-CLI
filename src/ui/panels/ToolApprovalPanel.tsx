/**
 * Approval prompt for a tool call a provider escalated to the user (the
 * `tool-approval` screen): local model runs and Claude Code. Shows the provider,
 * tool, command or file, workspace and the provider's reason, and offers
 * Allow once / Allow this exact action for this run / Deny.
 *
 * Owns only the highlighted option index. The decision goes to `onSelect`;
 * `src/app/overlays/OverlayPanels.tsx` resolves the pending approval with it.
 * "Allow for run" is hidden when `request.allowForRun === false`.
 *
 * Focus: registers `focusId` with `autoFocus`; input is handled only while
 * focused. Keys: Up/k and Down/j/Tab move, Enter decides, 1-3 pick an option
 * directly, Esc denies, Ctrl+C calls `onCancelRun` (the app denies and cancels the run).
 */

import { basename } from "node:path";
import { Box, Text, useFocus, useInput } from "ink";
import { useState } from "react";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../core/providers/types.js";
import { useTheme } from "../theme.js";

/** All decisions in display order; filtered per request. */
const OPTIONS: Array<{ label: string; value: ToolApprovalDecision }> = [
  { label: "Allow once", value: "allow-once" },
  { label: "Allow this exact action for this run", value: "allow-for-run" },
  { label: "Deny", value: "deny" },
];

/** Tool-approval prompt; see the module header for keys. */
export function ToolApprovalPanel({
  focusId,
  request,
  onSelect,
  onCancelRun,
}: {
  focusId: string;
  request: ToolApprovalRequest;
  onSelect: (decision: ToolApprovalDecision) => void;
  onCancelRun?: () => void;
}) {
  const theme = useTheme();
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });
  const [selected, setSelected] = useState(0);
  const options = OPTIONS.filter(
    (option) => request.allowForRun !== false || option.value !== "allow-for-run",
  );
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return onCancelRun?.();
      if (key.escape) return onSelect("deny");
      if (key.upArrow || input === "k") return setSelected((value) => Math.max(0, value - 1));
      if (key.downArrow || key.tab || input === "j")
        return setSelected((value) => Math.min(options.length - 1, value + 1));
      if (key.return) return onSelect(options[Math.min(selected, options.length - 1)]!.value);
      const picked = /^[1-9]$/.test(input) ? options[Number(input) - 1] : undefined;
      if (picked) onSelect(picked.value);
    },
    { isActive: isFocused },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={2}
      paddingY={1}
      width="100%"
    >
      <Text color={theme.warning} bold>
        {(request.provider ?? "Local model").toUpperCase()} PERMISSION
      </Text>
      <Text color={theme.text}>
        {request.provider ?? "The local model"} wants to{" "}
        {request.kind === "command"
          ? "run a shell command"
          : request.kind === "file"
            ? `use ${request.tool} on a file`
            : `run ${request.tool}`}
        .
      </Text>
      {request.description && <Text color={theme.textMuted}>{request.description}</Text>}
      {request.command && <Text color={theme.textMuted}>Command: {request.command}</Text>}
      {request.paths.map((path) => (
        <Text key={path} color={theme.textMuted}>
          {request.kind === "file" ? "File" : "Path"}: {path}
        </Text>
      ))}
      {request.workspace && (
        <Text color={theme.textDim}>Workspace: {basename(request.workspace)}</Text>
      )}
      {request.reason && <Text color={theme.textDim}>Reason: {request.reason}</Text>}
      {request.outsideWorkspace && (
        <Text color={theme.warning}>This path is outside the workspace.</Text>
      )}
      {(request.tool === "run_shell" || request.kind === "command") && (
        <Text color={theme.warning}>
          Shell commands can affect files, processes, and the network.
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Text
            key={option.value}
            color={index === selected ? theme.accent : theme.textMuted}
            bold={index === selected}
          >
            {index === selected ? "› " : "  "}
            {index + 1}. {option.label}
          </Text>
        ))}
      </Box>
      <Text color={theme.textDim}>
        ↑/↓ or j/k to navigate · Enter or 1-{options.length} to select · Esc to deny
      </Text>
    </Box>
  );
}
