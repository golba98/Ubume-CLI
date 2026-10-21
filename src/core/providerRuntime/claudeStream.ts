import type { BackendRunHandlers } from "../providers/types.js";
import { isRecord } from "../shared/values.js";
import { classifyClaudeToolDenial } from "./claudePermissions.js";
import { createJsonLines } from "./jsonLines.js";

interface StreamJsonAssistantEvent {
  type: "assistant";
  message: {
    content?: Array<{ type?: string; text?: string; partial?: boolean }>;
  };
}

/**
 * Parses one stdout line from `claude -p --output-format stream-json`.
 * Returns:
 *   string  — extracted assistant text delta
 *   null    — valid JSON but no text to emit (tool event, system event, etc.)
 *   false   — parse error; caller should fall back to plain-text mode
 */
export function tryParseStreamJsonDelta(line: string): string | null | false {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  if (event["type"] !== "assistant") return null;
  const msg = event["message"];
  if (typeof msg !== "object" || msg === null) return null;
  const content = (msg as StreamJsonAssistantEvent["message"]).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
  return text || null;
}

/** One `message.content` block in Claude Code's stream-json output. */
interface ClaudeStreamBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: { command?: unknown };
  tool_use_id?: string;
  content?: string | Array<{ text?: string }>;
  is_error?: boolean;
}

/**
 * Creates per-stream tool state and forwards Claude tool lifecycle events to Ubume callbacks.
 */
export function createClaudeToolParser(handlers: BackendRunHandlers): (line: string) => void {
  const tools = new Map<string, { command: string; startedAt: number }>();
  return (line) => {
    let event: { message?: { content?: unknown } } | null;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const blocks = event?.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks as Array<ClaudeStreamBlock | null>) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        const command =
          typeof block.input?.command === "string"
            ? block.input.command
            : `${block.name ?? "tool"} ${JSON.stringify(block.input ?? {})}`;
        const tool = { command, startedAt: tools.get(block.id)?.startedAt ?? Date.now() };
        tools.set(block.id, tool);
        handlers.onToolActivity?.({ id: block.id, ...tool, status: "running" });
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const tool = tools.get(block.tool_use_id) ?? {
          command: "Claude tool",
          startedAt: Date.now(),
        };
        const output =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((entry) => entry?.text ?? JSON.stringify(entry)).join("\n")
              : "";
        const denial = block.is_error ? classifyClaudeToolDenial(output) : null;
        handlers.onToolActivity?.({
          id: block.tool_use_id,
          ...tool,
          status: block.is_error ? "failed" : "completed",
          completedAt: Date.now(),
          output,
          summary: denial ?? output.split("\n")[0]?.slice(0, 200),
        });
        tools.delete(block.tool_use_id);
      }
    }
  };
}

export interface ClaudeStreamParserOptions {
  /** Whether a person can answer Claude's permission prompts in this run. */
  approvals?: "interactive" | "none";
  /** Receives stream-json control-protocol records (permission requests and cancels). */
  onControl?: (record: Record<string, unknown>) => boolean;
  /** Called once Claude reports its terminal result for the turn. */
  onResult?: () => void;
}

/** Claude snapshots reconcile against partial messages; terminal results own the final answer. */
export function createClaudeStreamParser(
  handlers: BackendRunHandlers,
  options: ClaudeStreamParserOptions = {},
) {
  let accumulated = "";
  let final: string | undefined;
  let failure: string | undefined;
  let sessionId: string | undefined;
  let productive = false;
  let protocolStarted = false;
  let terminal = false;
  let messageId = "";
  let anonymousMessage = 0;
  const messages = new Map<string, string>();
  const thinking = new Map<string, string>();
  const tools = createClaudeToolParser(handlers);
  const plain: string[] = [];
  let plainChars = 0;
  const emit = (text: string) => {
    if (text) {
      accumulated += text;
      handlers.onAssistantDelta?.(text);
    }
  };
  const framing = createJsonLines(
    (record) => {
      if (
        (record.type === "control_request" || record.type === "control_cancel_request") &&
        options.onControl?.(record)
      )
        return;
      if (record.type === "control_response") return;
      if (record.type === "stream_event" || (record.type === "system" && record.subtype === "init"))
        protocolStarted = true;
      if (typeof record.session_id === "string") sessionId = record.session_id;
      tools(JSON.stringify(record));
      if (
        record.type === "assistant" &&
        isRecord(record.message) &&
        Array.isArray(record.message.content) &&
        record.message.content.some((block) => isRecord(block) && block.type === "tool_use")
      )
        productive = true;
      if (record.type === "system" && record.subtype === "permission_denied") {
        handlers.onProgress?.({
          id: "claude-permission",
          source: "stderr",
          text:
            options.approvals === "interactive"
              ? "Claude's permission policy blocked a tool without asking."
              : "Claude denied a tool that needed approval; no approval prompt is available in this run.",
        });
      }
      if (record.type === "result") {
        terminal = true;
        if (
          record.is_error === true ||
          (typeof record.subtype === "string" && record.subtype.startsWith("error"))
        ) {
          failure =
            [record.result, ...(Array.isArray(record.errors) ? record.errors : [])]
              .filter((item): item is string => typeof item === "string")
              .join("\n") || "Claude reported an execution error.";
        } else if (typeof record.result === "string") final = record.result;
        if (Array.isArray(record.permission_denials) && record.permission_denials.length) {
          const count = record.permission_denials.length;
          const requests = `${count} tool request${count === 1 ? " was" : "s were"} denied`;
          handlers.onProgress?.({
            id: "claude-permission",
            source: "stderr",
            text:
              options.approvals === "interactive"
                ? `${requests} (by you or by Claude's permission policy). Review its response before continuing.`
                : `${requests} because no approval prompt is available in this run. Review its response before continuing.`,
          });
        }
        options.onResult?.();
        return;
      }
      if (record.parent_tool_use_id) return;
      if (record.type === "stream_event" && isRecord(record.event)) {
        const event = record.event;
        if (event.type === "message_start" && isRecord(event.message))
          messageId = String(event.message.id ?? "partial");
        // Some models think silently for minutes; say why a long wait ended in a continuation.
        if (
          event.type === "message_delta" &&
          isRecord(event.delta) &&
          event.delta.stop_reason === "max_tokens"
        ) {
          const tokens =
            isRecord(event.usage) && typeof event.usage.output_tokens === "number"
              ? ` (${event.usage.output_tokens.toLocaleString("en-US")} tokens)`
              : "";
          handlers.onProgress?.({
            id: `claude-max-tokens-${messageId || "partial"}`,
            source: "stderr",
            text: `Claude reached its output limit${tokens} before finishing this step; Claude Code continues automatically.`,
          });
        }
        if (event.type === "content_block_delta" && isRecord(event.delta)) {
          if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
            messageId ||= "partial";
            messages.set(messageId, (messages.get(messageId) ?? "") + event.delta.text);
            emit(event.delta.text);
          } else if (
            event.delta.type === "thinking_delta" &&
            typeof event.delta.thinking === "string"
          ) {
            const id = `claude-thinking-${messageId}-${String(event.index ?? 0)}`;
            const text = (thinking.get(id) ?? "") + event.delta.thinking;
            thinking.set(id, text);
            handlers.onProgress?.({ id, source: "reasoning", text });
          }
        }
      } else if (record.type === "assistant" && isRecord(record.message)) {
        const text = tryParseStreamJsonDelta(JSON.stringify(record));
        if (!text) return;
        const id =
          typeof record.message.id === "string"
            ? record.message.id
            : messageId || `snapshot-${++anonymousMessage}`;
        const prior = messages.get(id) ?? "";
        if (text.startsWith(prior)) emit(text.slice(prior.length));
        messages.set(id, text);
        messageId = "";
      }
    },
    (line) => {
      if (plainChars < 65536) {
        plain.push(line.slice(0, 65536 - plainChars));
        plainChars += line.length;
      }
    },
  );
  return {
    push: framing.push,
    flush: framing.flush,
    get records() {
      return framing.records;
    },
    get error() {
      return framing.error;
    },
    get failure() {
      return (
        failure ??
        (protocolStarted && !terminal
          ? "Claude closed before a final result was received."
          : undefined)
      );
    },
    get sessionId() {
      return sessionId;
    },
    get productive() {
      return productive || accumulated.length > 0;
    },
    finalText: () => final ?? (framing.records ? accumulated : plain.join("\n")),
  };
}
