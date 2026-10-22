/**
 * Mistral Vibe over the Agent Client Protocol (`vibe-acp`): newline-delimited JSON-RPC 2.0 on the
 * child's stdio. Unlike headless `vibe -p`, ACP lets Vibe ask the host for permission
 * (`session/request_permission`), so interactive runs route those requests into Ubume's shared
 * approval prompt.
 *
 * Ubume never selects a persistent option (`allow_always*`), never sets the model through
 * `session/set_config_option` (Vibe persists that to the user's config; the routed model is
 * passed through the child environment instead), and never records a workspace trust decision.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { APP_VERSION } from "../../config/settings.js";
import type { BackendRunHandlers, ToolApprovalRequest } from "../providers/types.js";
import { isRecord } from "../shared/values.js";
import { createJsonLines } from "./jsonLines.js";
import {
  canonicalJson,
  createProviderApprovalQueue,
  displayWorkspacePath,
  isOutsideWorkspace,
} from "./providerApprovalQueue.js";

/** Vibe agents Ubume selects over ACP; `plan` runs stay on headless `-p`. */
export type VibeAcpMode = "accept-edits" | "smart-approve";

/**
 * Finds `vibe-acp` next to the resolved `vibe` executable (as installed by `uv tool`), either
 * beside the given path or beside its symlink target. `VIBE_ACP_EXECUTABLE` overrides.
 */
export function resolveVibeAcpExecutable(
  vibeExecutable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const configured = env.VIBE_ACP_EXECUTABLE?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  // A bare command name has no directory to look beside; never resolve against the cwd.
  if (!isAbsolute(vibeExecutable)) return null;
  const name = platform === "win32" ? "vibe-acp.exe" : "vibe-acp";
  const candidates = [join(dirname(vibeExecutable), name)];
  try {
    candidates.push(join(dirname(realpathSync(vibeExecutable)), name));
  } catch {
    // A bare or missing executable has no symlink target to inspect.
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  locations?: unknown;
  content?: unknown;
  rawOutput?: unknown;
  startedAt: number;
}

interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

interface AcpPermissionRequest {
  rpcId: string | number;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

const FILE_KINDS = new Set(["edit", "delete", "move"]);

function locationPaths(locations: unknown): string[] {
  if (!Array.isArray(locations)) return [];
  return locations.flatMap((location) =>
    isRecord(location) && typeof location.path === "string" && location.path ? [location.path] : [],
  );
}

/** Converts one ACP permission request into the provider-neutral approval prompt. */
export function toVibeApprovalRequest(
  toolCall: AcpToolCall,
  workspaceRoot: string,
): ToolApprovalRequest {
  const input = isRecord(toolCall.rawInput) ? toolCall.rawInput : null;
  const kind =
    toolCall.kind === "execute" ? "command" : FILE_KINDS.has(toolCall.kind ?? "") ? "file" : "tool";
  // Locations are absolute while rawInput paths may be relative; dedupe on the resolved path.
  const rawPaths = [
    ...new Map(
      [...locationPaths(toolCall.locations), input?.path, input?.file_path]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((path) => [resolve(workspaceRoot, path), path] as const),
    ).values(),
  ];
  const outsideWorkspace = rawPaths.some((path) => isOutsideWorkspace(path, workspaceRoot));
  const command = kind === "command" && typeof input?.command === "string" ? input.command : null;
  const title = toolCall.title?.trim() || "Vibe tool";
  // Vibe titles shell calls "bash: <command>"; the command is already shown on its own line.
  const commandTitle =
    command !== null && title.endsWith(command)
      ? title.slice(0, -command.length).replace(/[:\s]+$/, "") || "shell"
      : null;
  return {
    tool: commandTitle ?? title,
    // Without the tool's input there is nothing exact to match, so the id keeps it unique.
    signature: input
      ? `vibe:${toolCall.kind ?? "other"}:${canonicalJson(input)}`
      : `vibe:${toolCall.toolCallId}`,
    ...(command !== null ? { command } : {}),
    paths: rawPaths.map((path) => displayWorkspacePath(path, workspaceRoot)),
    ...(command !== null && commandTitle === null && title !== command
      ? { description: title }
      : {}),
    allowForRun: input !== null && !outsideWorkspace,
    provider: "Mistral Vibe",
    workspace: workspaceRoot,
    kind,
    ...(outsideWorkspace ? { outsideWorkspace } : {}),
  };
}

/**
 * Picks the ACP option for a decision. Only one-shot options are ever chosen; when Vibe offers
 * no `reject_once`, the request is cancelled, which Vibe treats as a denial.
 */
export function vibePermissionOutcome(
  options: readonly AcpPermissionOption[],
  allow: boolean,
): Record<string, unknown> {
  const option = options.find((item) => item.kind === (allow ? "allow_once" : "reject_once"));
  if (option) return { outcome: "selected", optionId: option.optionId };
  if (allow) {
    const reject = options.find((item) => item.kind === "reject_once");
    if (reject) return { outcome: "selected", optionId: reject.optionId };
  }
  return { outcome: "cancelled" };
}

function contentText(content: unknown): string {
  if (isRecord(content) && content.type === "text" && typeof content.text === "string")
    return content.text;
  return "";
}

function toolOutput(call: AcpToolCall): string {
  const parts = Array.isArray(call.content)
    ? call.content.flatMap((item) =>
        isRecord(item) && item.type === "content" ? [contentText(item.content)] : [],
      )
    : [];
  const text = parts.filter(Boolean).join("\n");
  if (text) return text;
  return typeof call.rawOutput === "string" ? call.rawOutput : "";
}

function toolLabel(call: AcpToolCall): string {
  const input = isRecord(call.rawInput) ? call.rawInput : null;
  const label =
    typeof input?.command === "string" ? input.command : call.title?.trim() || "Vibe tool";
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

function errorText(error: unknown): string {
  if (!isRecord(error)) return "Vibe ACP request failed.";
  const message = typeof error.message === "string" ? error.message : "Vibe ACP request failed.";
  const data = isRecord(error.data) && typeof error.data.details === "string" ? error.data : null;
  return data ? `${message}: ${data.details}` : message;
}

export interface VibeAcpTurnResult {
  stopReason: string;
  sessionId: string;
  text: string;
}

export interface VibeAcpTurnOptions {
  workspaceRoot: string;
  mode: VibeAcpMode;
  /** Prompt for a new session (including any recovered transcript). */
  freshPrompt: string;
  /** Prompt for a loaded native session, which already holds the history. */
  resumePrompt: string;
  resumeSessionId: string | null;
  /** Run handlers for progress, assistant text and tool activity. */
  handlers: BackendRunHandlers;
  onToolApproval?: BackendRunHandlers["onToolApproval"];
  onAwaitingUser?: (waiting: boolean) => void;
  /** Writes one line to the agent's stdin; returns false once stdin is closed. */
  write: (line: string) => boolean;
  onTurnEnd: (result: VibeAcpTurnResult) => void;
  /** `promptSent` tells the caller whether a fallback could run the prompt twice. */
  onFailure: (failure: { message: string; promptSent: boolean }) => void;
}

/**
 * Drives one prompt turn over ACP. `initialLine` (the `initialize` request) is sent as the
 * child's first stdin data; `push` receives stdout. Requests are answered one at a time, and
 * after `dispose` nothing more is written.
 */
export function createVibeAcpTurn(options: VibeAcpTurnOptions) {
  const { handlers, workspaceRoot } = options;
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  const toolCalls = new Map<string, AcpToolCall>();
  const openPermissions = new Map<string, AcpPermissionRequest>();
  let sessionId = "";
  let accepting = false;
  let promptSent = false;
  let disposed = false;
  let settled = false;
  let text = "";
  let thoughtSegment = 0;
  let thought = "";

  const writeLine = (message: Record<string, unknown>) => {
    if (!disposed) options.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const encodeRequest = (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
    return { line: `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, promise };
  };

  const call = (method: string, params: Record<string, unknown>) => {
    const request = encodeRequest(method, params);
    if (!disposed) options.write(request.line);
    return request.promise;
  };

  const approvals = createProviderApprovalQueue<AcpPermissionRequest>({
    onToolApproval: options.onToolApproval,
    toApproval: (request) => toVibeApprovalRequest(request.toolCall, workspaceRoot),
    respond: (request, outcome) => {
      openPermissions.delete(String(request.rpcId));
      writeLine({
        id: request.rpcId,
        result: { outcome: vibePermissionOutcome(request.options, outcome === "allow") },
      });
    },
    onAwaitingUser: options.onAwaitingUser,
  });

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    options.onFailure({ message, promptSent });
  };

  const endThought = () => {
    if (thought) thoughtSegment++;
    thought = "";
  };

  const emitTool = (call: AcpToolCall) => {
    if (call.status === "completed" || call.status === "failed") {
      const output = toolOutput(call);
      handlers.onToolActivity?.({
        id: call.toolCallId,
        command: toolLabel(call),
        status: call.status === "completed" ? "completed" : "failed",
        startedAt: call.startedAt,
        completedAt: Date.now(),
        output,
        summary: output.slice(0, 200) || call.status,
      });
      return;
    }
    handlers.onToolActivity?.({
      id: call.toolCallId,
      command: toolLabel(call),
      status: "running",
      startedAt: call.startedAt,
    });
  };

  const handleUpdate = (update: Record<string, unknown>) => {
    // A loaded session replays its history first; only this turn's updates are shown.
    if (!accepting) return;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const chunk = contentText(update.content);
      if (!chunk) return;
      endThought();
      text += chunk;
      handlers.onAssistantDelta?.(chunk);
      return;
    }
    if (kind === "agent_thought_chunk") {
      const chunk = contentText(update.content);
      if (!chunk) return;
      thought += chunk;
      handlers.onProgress?.({
        id: `vibe-acp-thought-${thoughtSegment}`,
        source: "reasoning",
        text: thought,
      });
      return;
    }
    if (kind === "plan" && Array.isArray(update.entries)) {
      const lines = update.entries.flatMap((entry) =>
        isRecord(entry) && typeof entry.content === "string"
          ? [`${entry.status === "completed" ? "[x]" : "[ ]"} ${entry.content}`]
          : [],
      );
      if (lines.length)
        handlers.onProgress?.({ id: "vibe-acp-plan", source: "todo", text: lines.join("\n") });
      return;
    }
    if ((kind === "tool_call" || kind === "tool_call_update") && update.toolCallId) {
      endThought();
      const id = String(update.toolCallId);
      const previous = toolCalls.get(id);
      const merged: AcpToolCall = { ...previous, toolCallId: id, startedAt: Date.now() };
      if (previous) merged.startedAt = previous.startedAt;
      for (const key of [
        "title",
        "kind",
        "status",
        "rawInput",
        "locations",
        "content",
        "rawOutput",
      ] as const) {
        if (update[key] !== undefined && update[key] !== null)
          (merged as unknown as Record<string, unknown>)[key] = update[key];
      }
      toolCalls.set(id, merged);
      emitTool(merged);
    }
  };

  const handleAgentRequest = (message: Record<string, unknown>) => {
    const rpcId = message.id as string | number;
    const params = isRecord(message.params) ? message.params : {};
    if (message.method !== "session/request_permission") {
      writeLine({
        id: rpcId,
        error: { code: -32601, message: `Method not supported by Ubume: ${message.method}` },
      });
      return;
    }
    const reported = isRecord(params.toolCall) ? params.toolCall : {};
    const id = String(reported.toolCallId ?? `permission-${String(rpcId)}`);
    const known = toolCalls.get(id);
    const toolCall: AcpToolCall = { ...known, toolCallId: id, startedAt: Date.now() };
    for (const key of ["title", "kind", "rawInput", "locations"] as const)
      if (reported[key] !== undefined && reported[key] !== null)
        (toolCall as unknown as Record<string, unknown>)[key] = reported[key];
    const permissionOptions = Array.isArray(params.options)
      ? params.options.flatMap((option) =>
          isRecord(option) && typeof option.optionId === "string" && typeof option.kind === "string"
            ? [{ optionId: option.optionId, kind: option.kind }]
            : [],
        )
      : [];
    const request = { rpcId, toolCall, options: permissionOptions };
    openPermissions.set(String(rpcId), request);
    approvals.enqueue(String(rpcId), request);
  };

  const handleMessage = (message: Record<string, unknown>) => {
    if (disposed) return;
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        handleAgentRequest(message);
        return;
      }
      if (message.method === "session/update" && isRecord(message.params)) {
        const update = message.params.update;
        if (isRecord(update)) handleUpdate(update);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiter.reject(new Error(errorText(message.error)));
    else waiter.resolve(isRecord(message.result) ? message.result : {});
  };

  const framing = createJsonLines(handleMessage);

  const initialize = encodeRequest("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "ubume", title: "Ubume", version: APP_VERSION },
  });

  const run = async () => {
    const init = await initialize.promise;
    const capabilities = isRecord(init.agentCapabilities) ? init.agentCapabilities : {};
    let modes: unknown;
    let prompt = options.freshPrompt;
    if (options.resumeSessionId && capabilities.loadSession === true) {
      try {
        const loaded = await call("session/load", {
          sessionId: options.resumeSessionId,
          cwd: workspaceRoot,
          mcpServers: [],
        });
        sessionId = options.resumeSessionId;
        modes = loaded.modes;
        prompt = options.resumePrompt;
      } catch {
        handlers.onProgress?.({
          id: "vibe-resume-retry",
          source: "stderr",
          text: "Saved Vibe session could not be resumed; continuing in a fresh session.",
        });
      }
    }
    if (!sessionId) {
      const created = await call("session/new", { cwd: workspaceRoot, mcpServers: [] });
      if (typeof created.sessionId !== "string" || !created.sessionId)
        throw new Error("Vibe ACP did not return a session id.");
      sessionId = created.sessionId;
      modes = created.modes;
    }
    const modeState = isRecord(modes) ? modes : {};
    if (modeState.currentModeId !== options.mode) {
      const available = Array.isArray(modeState.availableModes)
        ? modeState.availableModes.some((mode) => isRecord(mode) && mode.id === options.mode)
        : false;
      if (!available) throw new Error(`Vibe ACP does not offer the ${options.mode} agent.`);
      await call("session/set_mode", { sessionId, modeId: options.mode });
    }
    if (disposed) return;
    accepting = true;
    promptSent = true;
    const response = await call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    if (settled) return;
    settled = true;
    options.onTurnEnd({
      stopReason: typeof response.stopReason === "string" ? response.stopReason : "end_turn",
      sessionId,
      text,
    });
  };

  void run().catch((error: unknown) => {
    if (!disposed) fail(error instanceof Error ? error.message : String(error));
  });

  return {
    /** The `initialize` request, sent as the child's initial stdin data. */
    initialLine: initialize.line,
    push(chunk: string): void {
      framing.push(chunk);
      if (framing.error) fail(framing.error);
    },
    flush(): void {
      framing.flush();
    },
    get promptSent(): boolean {
      return promptSent;
    },
    get sessionId(): string {
      return sessionId;
    },
    get text(): string {
      return text;
    },
    /** Asks Vibe to stop the turn and withdraws any open permission request as cancelled. */
    cancel(): void {
      if (disposed) return;
      for (const request of openPermissions.values())
        writeLine({ id: request.rpcId, result: { outcome: { outcome: "cancelled" } } });
      openPermissions.clear();
      approvals.dispose();
      if (sessionId) writeLine({ method: "session/cancel", params: { sessionId } });
    },
    /** Stops all writes and rejects outstanding requests (process exit or teardown). */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      approvals.dispose();
      openPermissions.clear();
      for (const waiter of pending.values()) waiter.reject(new Error("Vibe ACP process ended."));
      pending.clear();
    },
  };
}
