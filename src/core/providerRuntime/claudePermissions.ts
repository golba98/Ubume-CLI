/**
 * Claude Code permission integration: maps Ubume's execution mode to Claude's native
 * `--permission-mode`, and bridges Claude's stream-json `can_use_tool` control requests
 * (`--permission-prompt-tool stdio`) into Ubume's shared tool-approval handler.
 *
 * Claude itself evaluates every tool call (including compound shell commands and protected
 * paths); Ubume only answers the requests Claude escalates. Approvals are never broadened:
 * "allow for run" reuses a decision only for the byte-identical tool input.
 */

import type {
  BackendRunHandlers,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../providers/types.js";
import { isRecord } from "../shared/values.js";
import {
  canonicalJson,
  createProviderApprovalQueue,
  displayWorkspacePath,
  isOutsideWorkspace,
} from "./providerApprovalQueue.js";

export type ClaudePermissionMode =
  | "default"
  | "manual"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "plan";

export interface ClaudePermissionModeResolution {
  mode: ClaudePermissionMode;
  /** The mode Ubume wanted before falling back for an older CLI. */
  requested: ClaudePermissionMode;
}

/**
 * Maps Ubume's mode/run intent to Claude's permission mode. Auto and Full Access use Claude's
 * native `auto` mode, whose classifier still asks about (or blocks) risky actions; Read-only
 * uses `dontAsk` so anything Claude would ask about is denied instead of prompting.
 * `bypassPermissions` is never produced, and a fallback for an older CLI never broadens:
 * `auto` falls back to `acceptEdits`, anything else to Claude's manual-approval mode.
 * `supported` is the CLI's advertised choice list, when discovery saw one.
 */
export function resolveClaudePermissionMode(
  mode: string,
  runIntent: "normal" | "plan" | "approved-execution" | undefined,
  supported?: readonly string[] | null,
): ClaudePermissionModeResolution {
  const requested: ClaudePermissionMode =
    runIntent === "plan"
      ? "plan"
      : mode === "suggest"
        ? "dontAsk"
        : mode === "auto-edit" || mode === "full-auto"
          ? "auto"
          : "default";
  if (!supported?.length || supported.includes(requested)) return { mode: requested, requested };
  // Claude 2.1 renamed `default` to `manual`.
  const manual: ClaudePermissionMode = supported.includes("manual") ? "manual" : "default";
  return {
    mode: requested === "auto" && supported.includes("acceptEdits") ? "acceptEdits" : manual,
    requested,
  };
}

/** One escalated `can_use_tool` control request from Claude's stdout. */
export interface ClaudeCanUseToolRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  decisionReason?: string;
  blockedPath?: string;
}

export type ClaudeControlMessage =
  | { kind: "can-use-tool"; request: ClaudeCanUseToolRequest }
  | { kind: "cancel"; requestId: string }
  | { kind: "other-request"; requestId: string; subtype: string };

/** Recognizes the control-protocol records Claude writes to stdout; returns null for others. */
export function parseClaudeControlMessage(
  record: Record<string, unknown>,
): ClaudeControlMessage | null {
  if (record.type === "control_cancel_request" && typeof record.request_id === "string")
    return { kind: "cancel", requestId: record.request_id };
  if (record.type !== "control_request" || typeof record.request_id !== "string") return null;
  const body = record.request;
  if (!isRecord(body)) return null;
  if (body.subtype !== "can_use_tool" || typeof body.tool_name !== "string")
    return {
      kind: "other-request",
      requestId: record.request_id,
      subtype: String(body.subtype ?? "unknown"),
    };
  if (!body.tool_name.trim() || !isRecord(body.input))
    return {
      kind: "other-request",
      requestId: record.request_id,
      subtype: "malformed can_use_tool",
    };
  return {
    kind: "can-use-tool",
    request: {
      requestId: record.request_id,
      toolName: body.tool_name,
      input: isRecord(body.input) ? body.input : {},
      ...(typeof body.tool_use_id === "string" ? { toolUseId: body.tool_use_id } : {}),
      ...(typeof body.decision_reason === "string" ? { decisionReason: body.decision_reason } : {}),
      ...(typeof body.blocked_path === "string" ? { blockedPath: body.blocked_path } : {}),
    },
  };
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);

export { isOutsideWorkspace };

/** Converts a Claude control request into the provider-neutral approval prompt. */
export function toToolApprovalRequest(
  request: ClaudeCanUseToolRequest,
  workspaceRoot: string,
): ToolApprovalRequest {
  const { input, toolName } = request;
  const kind = COMMAND_TOOLS.has(toolName) ? "command" : FILE_TOOLS.has(toolName) ? "file" : "tool";
  const rawPaths = [input.file_path, input.notebook_path, input.path, request.blockedPath].filter(
    (value, index, all): value is string =>
      typeof value === "string" && value.length > 0 && all.indexOf(value) === index,
  );
  const outsideWorkspace = rawPaths.some((path) => isOutsideWorkspace(path, workspaceRoot));
  const command = kind === "command" && typeof input.command === "string" ? input.command : null;
  if (kind === "command" && (command === null || !command.trim()))
    throw new Error("Claude shell permission is missing its command");
  return {
    tool: toolName,
    ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
    signature: `${toolName}:${canonicalJson(input)}`,
    details: JSON.stringify(
      Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "command" && key !== "description"),
      ),
    ),
    ...(command !== null ? { command } : {}),
    paths: rawPaths.map((path) => displayWorkspacePath(path, workspaceRoot)),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(kind === "tool" ? { description: JSON.stringify(input) } : {}),
    // Exact-match reuse only; never offered for paths outside the workspace.
    allowForRun: !outsideWorkspace,
    provider: "Claude Code",
    workspace: workspaceRoot,
    kind,
    ...(outsideWorkspace ? { outsideWorkspace } : {}),
    ...(request.decisionReason ? { reason: request.decisionReason } : {}),
  };
}

export const CLAUDE_USER_DENIED_MESSAGE = "The user denied this action in Ubume.";
/** Answer to `ExitPlanMode` in a plan run: Ubume's plan review is the only approval. */
export const CLAUDE_PLAN_CAPTURED_MESSAGE =
  "Ubume captured this plan and will present it to the user for review; the user approves it in Ubume, not here. Stay in plan mode: do not implement anything and do not call ExitPlanMode again. End your turn now with the complete plan as your final message.";
export const CLAUDE_APPROVAL_UNAVAILABLE_MESSAGE =
  "Ubume could not show an approval prompt for this action, so it was denied.";

/**
 * Labels a failed Claude tool result that was a permission outcome rather than an execution
 * failure; returns null for ordinary errors (non-zero exits, filesystem errors).
 */
export function classifyClaudeToolDenial(output: string): string | null {
  if (output.includes(CLAUDE_USER_DENIED_MESSAGE)) return "Denied by you in Ubume";
  if (output.includes(CLAUDE_APPROVAL_UNAVAILABLE_MESSAGE) || /no approval surface/i.test(output))
    return "Denied: no approval prompt available in this run";
  if (/outside (of )?(the )?(allowed |working |project )?(working )?director/i.test(output))
    return "Blocked: path is outside the allowed workspace";
  if (
    /permission to use .+ has been denied|denied by (your )?permission (settings|rules)/i.test(
      output,
    )
  )
    return "Blocked by Claude's permission policy";
  return null;
}

/** Serializes one stream-json control response line. */
export function claudeControlResponse(
  requestId: string,
  response: Record<string, unknown>,
): string {
  return `${JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  })}\n`;
}

function claudeControlError(requestId: string, error: string): string {
  return `${JSON.stringify({
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error },
  })}\n`;
}

export interface ClaudeApprovalBridgeOptions {
  workspaceRoot: string;
  onToolApproval?: BackendRunHandlers["onToolApproval"];
  /** Writes one line to Claude's stdin; returns false once stdin is closed. */
  write: (line: string) => boolean;
  /** Reports whether Ubume is waiting on the user, so quiet-provider notices pause. */
  onAwaitingUser?: (waiting: boolean) => void;
  onDecision?: (request: ToolApprovalRequest, decision: ToolApprovalDecision | "cached") => void;
  /** The run's intent; plan runs answer `ExitPlanMode` themselves instead of prompting. */
  runIntent?: "normal" | "plan" | "approved-execution";
  /** Receives the plan from a plan run's `ExitPlanMode` request. */
  onPlanCaptured?: (plan: string) => void;
}

/**
 * Answers Claude's permission requests one at a time. Duplicate request ids are ignored, a
 * cancel withdraws a queued or visible request, and `dispose` (process exit or run cancel)
 * withdraws everything without writing to the closed stdin.
 */
export function createClaudeApprovalBridge(options: ClaudeApprovalBridgeOptions) {
  const queue = createProviderApprovalQueue<ClaudeCanUseToolRequest>({
    onToolApproval: options.onToolApproval,
    toApproval: (request) => toToolApprovalRequest(request, options.workspaceRoot),
    respond: (request, outcome) =>
      options.write(
        claudeControlResponse(
          request.requestId,
          outcome === "allow"
            ? { behavior: "allow", updatedInput: request.input }
            : {
                behavior: "deny",
                message:
                  outcome === "deny"
                    ? CLAUDE_USER_DENIED_MESSAGE
                    : CLAUDE_APPROVAL_UNAVAILABLE_MESSAGE,
              },
        ),
      ),
    onAwaitingUser: options.onAwaitingUser,
    onDecision: options.onDecision,
  });

  return {
    /** Handles a control record; returns true when the record belonged to the protocol. */
    handle(record: Record<string, unknown>): boolean {
      const message = parseClaudeControlMessage(record);
      if (!message) return false;
      if (queue.disposed) return true;
      if (message.kind === "other-request") {
        options.write(
          claudeControlError(message.requestId, `Unsupported control request: ${message.subtype}`),
        );
        return true;
      }
      if (message.kind === "cancel") {
        queue.withdraw(message.requestId);
        return true;
      }
      if (options.runIntent === "plan" && message.request.toolName === "ExitPlanMode") {
        // Approving here would let Claude leave plan mode and implement inside the planning
        // run, and duplicate Ubume's plan review. Keep the plan and keep Claude in plan mode.
        const plan = message.request.input.plan;
        if (typeof plan === "string" && plan.trim()) options.onPlanCaptured?.(plan);
        options.write(
          claudeControlResponse(message.request.requestId, {
            behavior: "deny",
            message: CLAUDE_PLAN_CAPTURED_MESSAGE,
          }),
        );
        return true;
      }
      queue.enqueue(message.request.requestId, message.request);
      return true;
    },
    get pending(): number {
      return queue.pending;
    },
    dispose(): void {
      queue.dispose();
    },
  };
}
