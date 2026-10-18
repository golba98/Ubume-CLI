/**
 * Incrementally parses Codex JSONL events into assistant, reasoning, tool, and lifecycle
 * callbacks.
 */

import type { RunToolActivity } from "../../session/types.js";
import { normalizeLineBreaks } from "../shared/text.js";
import type { BackendProgressUpdate } from "./types.js";

type CodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | {
      type: "turn.completed";
      usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
    }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "error"; message?: string }
  | { type: "item.started" | "item.updated" | "item.completed"; item: CodexThreadItem };

type CodexThreadItem =
  | {
      id: string;
      type: "agent_message";
      text: string;
    }
  | {
      id: string;
      type: "reasoning";
      text: string;
    }
  | {
      id: string;
      type: "command_execution";
      command: string;
      status: "in_progress" | "completed" | "failed";
      aggregated_output?: string;
      exit_code?: number;
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server: string;
      tool: string;
      status: "in_progress" | "completed" | "failed";
      error?: { message?: string };
      result?: unknown;
    }
  | {
      id: string;
      type: "web_search";
      query: string;
    }
  | {
      id: string;
      type: "todo_list";
      items: Array<{ text: string; completed: boolean }>;
    }
  | {
      id: string;
      type: "file_change";
      changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
      status: "completed" | "failed";
    }
  | {
      id: string;
      type: "error";
      message: string;
    };

interface CodexJsonStreamHandlers {
  onThreadStarted?: (id: string) => void;
  onAssistantDelta?: (chunk: string) => void;
  onFinalAnswerObserved?: (response: string) => void;
  onProgress?: (update: BackendProgressUpdate) => void;
  onToolActivity?: (activity: RunToolActivity) => void;
}

function normalizeProgressText(text: string | undefined): string | null {
  if (!text) return null;
  const normalized = normalizeLineBreaks(text)
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return normalized || null;
}

function firstMeaningfulLine(text: string | undefined): string | null {
  if (!text) return null;
  const line = normalizeLineBreaks(text)
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? null;
}

function summarizeCommandExecution(
  item: Extract<CodexThreadItem, { type: "command_execution" }>,
): string {
  const firstLine = firstMeaningfulLine(item.aggregated_output);
  if (item.status === "failed") {
    if (firstLine) return firstLine;
    if (item.exit_code != null) return `Exit code ${item.exit_code}`;
    return "Failed";
  }
  if (firstLine) return firstLine;
  if (item.exit_code != null) return `Exit code ${item.exit_code}`;
  return item.status === "completed" ? "Completed" : "Running";
}

function summarizeTodoList(item: Extract<CodexThreadItem, { type: "todo_list" }>): string | null {
  if (!item.items.length) return null;
  const completedCount = item.items.filter((entry) => entry.completed).length;
  const nextPending = item.items.find((entry) => !entry.completed);
  if (nextPending) {
    return `Todo ${completedCount}/${item.items.length}: ${nextPending.text}`;
  }
  return `Todo ${completedCount}/${item.items.length}: all tasks complete`;
}

function summarizeReasoning(item: Extract<CodexThreadItem, { type: "reasoning" }>): string | null {
  return normalizeProgressText(item.text);
}

function summarizeFileChange(
  item: Extract<CodexThreadItem, { type: "file_change" }>,
): string | null {
  if (!item.changes.length) return null;
  const [first] = item.changes;
  if (item.changes.length === 1 && first) {
    const verb = first.kind === "add" ? "Created" : first.kind === "delete" ? "Deleted" : "Updated";
    return `${verb} ${first.path}`;
  }
  return `Applied ${item.changes.length} file changes`;
}

function mapToolActivity(
  item: Extract<
    CodexThreadItem,
    {
      type: "command_execution" | "mcp_tool_call" | "web_search";
    }
  >,
  phase: "item.started" | "item.updated" | "item.completed",
  existing: RunToolActivity | undefined,
): RunToolActivity {
  const startedAt = existing?.startedAt ?? Date.now();

  if (item.type === "command_execution") {
    const status = item.status === "in_progress" ? "running" : item.status;
    return {
      id: item.id,
      command: item.command,
      status,
      startedAt,
      completedAt: status === "running" ? null : Date.now(),
      summary: status === "running" ? undefined : summarizeCommandExecution(item),
      ...(item.aggregated_output === undefined ? {} : { output: item.aggregated_output }),
    };
  }

  if (item.type === "mcp_tool_call") {
    return {
      id: item.id,
      command: `${item.server}:${item.tool}`,
      status: item.status === "in_progress" ? "running" : item.status,
      startedAt,
      completedAt: item.status === "in_progress" ? null : Date.now(),
      ...(item.result === undefined
        ? {}
        : { output: typeof item.result === "string" ? item.result : JSON.stringify(item.result) }),
      summary:
        item.status === "failed"
          ? (item.error?.message ?? "Failed")
          : item.status === "completed"
            ? "Completed"
            : undefined,
    };
  }

  return {
    id: item.id,
    command: `web search: ${item.query}`,
    status: phase === "item.completed" ? "completed" : "running",
    startedAt,
    completedAt: phase === "item.completed" ? Date.now() : null,
    summary: phase === "item.completed" ? "Completed" : undefined,
  };
}

/**
 * Creates per-run structured event state. Call feedLine with complete JSONL lines; the caller
 * owns chunk buffering and trailing-line handling.
 */
export function createCodexJsonStreamParser(handlers: CodexJsonStreamHandlers) {
  const assistantTextById = new Map<string, string>();
  const progressTextById = new Map<string, string>();
  const toolActivityById = new Map<string, RunToolActivity>();
  let sawEvent = false;
  let finalResponse = "";
  let finalAnswerObserved = false;
  let failureMessage: string | null = null;

  const emitProgress = (
    key: string,
    source: BackendProgressUpdate["source"],
    summary: string | null | undefined,
  ) => {
    const next = normalizeProgressText(summary ?? "");
    if (!next) return;
    if (progressTextById.get(key) === next) return;
    progressTextById.set(key, next);
    handlers.onProgress?.({ id: key, source, text: next });
  };

  // Codex JSON stream sends cumulative text per item ID rather than deltas.
  // We track the last emitted text and emit only the newly appended suffix.
  const emitAssistantText = (itemId: string, nextText: string) => {
    const previous = assistantTextById.get(itemId) ?? "";
    assistantTextById.set(itemId, nextText);
    finalResponse = nextText;

    if (!nextText) return;
    if (!previous) {
      handlers.onAssistantDelta?.(nextText);
      return;
    }

    if (nextText.startsWith(previous)) {
      const delta = nextText.slice(previous.length);
      if (delta) {
        handlers.onAssistantDelta?.(delta);
      }
    }
  };

  const upsertTool = (
    item: Extract<
      CodexThreadItem,
      {
        type: "command_execution" | "mcp_tool_call" | "web_search";
      }
    >,
    phase: "item.started" | "item.updated" | "item.completed",
  ) => {
    const next = mapToolActivity(item, phase, toolActivityById.get(item.id));
    toolActivityById.set(item.id, next);
    handlers.onToolActivity?.(next);
  };

  const handleItem = (
    phase: "item.started" | "item.updated" | "item.completed",
    item: CodexThreadItem,
  ) => {
    switch (item.type) {
      case "agent_message":
        emitAssistantText(item.id, item.text ?? "");
        break;
      case "reasoning":
        emitProgress(item.id, "reasoning", summarizeReasoning(item));
        break;
      case "todo_list":
        emitProgress(item.id, "todo", summarizeTodoList(item));
        break;
      case "command_execution":
        upsertTool(item, phase);
        emitProgress(
          item.id,
          "tool",
          item.status === "in_progress"
            ? `Running ${item.command}`
            : summarizeCommandExecution(item),
        );
        break;
      case "mcp_tool_call":
        upsertTool(item, phase);
        emitProgress(
          item.id,
          "tool",
          item.status === "in_progress"
            ? `Calling ${item.server}:${item.tool}`
            : (item.error?.message ?? `Completed ${item.server}:${item.tool}`),
        );
        break;
      case "web_search":
        upsertTool(item, phase);
        emitProgress(item.id, "tool", `Searching web: ${item.query}`);
        break;
      case "file_change":
        emitProgress(item.id, "activity", summarizeFileChange(item));
        break;
      case "error":
        // Error items are non-fatal diagnostics. Only turn.failed and a
        // top-level stream error establish a failed run.
        emitProgress(item.id, "stderr", item.message);
        break;
    }
  };

  return {
    feedLine(line: string): boolean {
      const trimmed = line.trim();
      if (!trimmed) return false;

      let event: CodexThreadEvent;
      try {
        event = JSON.parse(trimmed) as CodexThreadEvent;
      } catch {
        return false;
      }

      if (!event || typeof event !== "object" || typeof event.type !== "string") {
        return false;
      }

      sawEvent = true;

      switch (event.type) {
        case "thread.started":
          if (typeof event.thread_id === "string") handlers.onThreadStarted?.(event.thread_id);
          break;
        case "item.started":
        case "item.updated":
        case "item.completed":
          handleItem(event.type, event.item);
          break;
        case "turn.completed":
          if (!finalAnswerObserved && finalResponse) {
            finalAnswerObserved = true;
            handlers.onFinalAnswerObserved?.(finalResponse);
          }
          break;
        case "turn.failed":
          failureMessage = event.error?.message ?? "Turn failed";
          break;
        case "error":
          failureMessage = event.message ?? "Stream error";
          break;
        default:
          break;
      }

      return true;
    },
    getFinalResponse(): string {
      return finalResponse;
    },
    getFailureMessage(): string | null {
      return failureMessage;
    },
    hasStructuredEvents(): boolean {
      return sawEvent;
    },
  };
}
