/** Lossless soft wrapping for approval evidence. Never parse or rewrite a shell command. */
import type { ToolApprovalRequest } from "../../core/providers/types.js";
import { getTextUnits } from "../../core/shared/text.js";

/** Controls are shown as escapes rather than executed or silently removed. LF remains a line break. */
export function visibleApprovalText(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (char) =>
    char === "\t"
      ? "\\t"
      : char === "\r"
        ? "\\r"
        : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

export function wrapApprovalText(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let cells = 0;
  for (const unit of getTextUnits(visibleApprovalText(text))) {
    if (unit.text === "\n") {
      rows.push(row);
      row = "";
      cells = 0;
    } else {
      if (row && cells + unit.width > Math.max(1, width)) {
        rows.push(row);
        row = "";
        cells = 0;
      }
      row += unit.text;
      cells += unit.width;
    }
  }
  rows.push(row);
  return rows;
}

/** All approval evidence remains reachable in the bounded details viewport. */
export function approvalEvidenceRows(request: ToolApprovalRequest, width: number): string[] {
  const text = [
    `${request.provider ?? "The local model"} wants to ${request.kind === "command" ? "run a shell command" : `use ${request.tool}`}.`,
    request.description,
    ...(request.command !== undefined ? [`Command: ${request.command}`] : []),
    ...(request.details && request.details !== "{}" ? [`Input: ${request.details}`] : []),
    ...request.paths.map((path) => `${request.kind === "file" ? "File" : "Path"}: ${path}`),
    request.workspace ? `Workspace: ${request.workspace}` : undefined,
    request.reason ? `Reason: ${request.reason}` : undefined,
    request.outsideWorkspace ? "This path is outside the workspace." : undefined,
    request.restriction,
    /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(request.command ?? "")
      ? "Control characters above are displayed as literal escapes."
      : undefined,
  ]
    .filter((line): line is string => line !== undefined && line !== "")
    .join("\n");
  return wrapApprovalText(text, width);
}
