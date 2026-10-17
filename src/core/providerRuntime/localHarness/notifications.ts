/**
 * Adapts Harness notifications to Ubume callbacks using explicit process and active-run
 * ownership. Event handlers update per-run text, reasoning, tools and usage; only the owning
 * runtime completes or fails a run.
 */

import { randomUUID } from "node:crypto";
import { traceLocalStream } from "../../perf/debugLog.js";
import type { BackendRunHandlers } from "../../providers/types.js";
import type { LocalHarnessSessionMetadata } from "../../workspace/conversationStore.js";
import type { ProviderChatRequest } from "../types.js";
import { normalizedArgs } from "./bridgePolicy.js";
import { formatModelRequestFailure } from "./messages.js";

export interface HarnessNotification {
  sessionId?: string;
  status?: string;
  event?: { seq?: number; type?: string; data?: Record<string, unknown> };
  childSessionId?: string;
  parentSessionId?: string;
}

export interface HarnessRunState {
  sessionId: string;
  handlers: BackendRunHandlers;
  request: ProviderChatRequest;
  text: string;
  runningSeen: boolean;
  settled: boolean;
  completing?: boolean;
  toolArguments: Map<string, { tool: string; arguments: Record<string, unknown> }>;
  reasoningText: Map<string, string>;
  approvals: Set<string>;
  sessionMetadata: LocalHarnessSessionMetadata;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  abortCleanup: () => void;
  turnFailure?: string;
  lastUsage?: {
    inputTokens: number;
    outputTokens: number;
    contextTokens: number;
    contextWindow: number | null;
    exact: boolean;
  };
  /** Why the last model turn stopped (`max-tokens`, `stop`, `aborted`, …), from the finish chunk or turn/end. */
  stopReason?: string;
  /** Number of output-window continuations issued inside this logical Ubume run. */
  continuationCount: number;
  /** Assistant-text length at the start of the current model turn. */
  windowStartTextLength: number;
  /** Tool-event count at the start of the current model turn. */
  windowStartToolEventCount: number;
  /** Run-wide count used to detect useful progress across output windows. */
  toolEventCount: number;
  /** Run-wide reasoning delta count, used to select the corrective continuation prompt. */
  reasoningEventCount: number;
  /** Reasoning delta count at the start of the current model turn. */
  windowStartReasoningEventCount: number;
  /** Consecutive max-token windows that produced neither assistant text nor tool activity. */
  consecutiveNoProgressWindows: number;
  /** Prevents a cancellation race from enqueueing another continuation prompt. */
  cancelled: boolean;
}

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isRecord } from "../../shared/values.js";
import { commandFrom } from "./bridgePolicy.js";
import {
  MAX_DISPLAY_REASONING_CHARS,
  REASONING_TRUNCATED_PREFIX,
  textFromContent,
} from "./messages.js";

interface NotificationProcess {
  child: ChildProcessWithoutNullStreams | null;
  active: HarnessRunState | null;
  checkMemory: (child: ChildProcessWithoutNullStreams, rss: number | null) => void;
  failActive: (error: Error) => void;
  tryRecoverExhaustedTurn: (state: HarnessRunState) => boolean;
  completeActive: () => Promise<void>;
  emitUsage: (state: HarnessRunState, usage: Record<string, unknown>) => void;
}

/**
 * Routes only the owning child/session's notifications; stale or settled runs cannot consume new
 * events.
 */
export function routeNotification(
  method: string,
  params: HarnessNotification,
  process: NotificationProcess,
  sourceChild?: ChildProcessWithoutNullStreams,
): void {
  if (sourceChild && sourceChild !== process.child) return;
  if (method === "harness.memory") {
    if (process.child && typeof (params as { rssBytes?: unknown }).rssBytes === "number") {
      process.checkMemory(process.child, (params as { rssBytes: number }).rssBytes);
    }
    return;
  }
  const state = process.active;
  const ownsNotification =
    params.sessionId === state?.sessionId || params.parentSessionId === state?.sessionId;
  if (!state || !ownsNotification || state.settled) return;
  if (method === "subagent.started" || method === "subagent.finished") {
    const childId = params.childSessionId ?? "subagent";
    const finished = method === "subagent.finished";
    state.handlers.onToolActivity?.({
      id: `local-subagent-${childId}`,
      command: `Subagent ${childId}`,
      status: finished ? (params.status === "error" ? "failed" : "completed") : "running",
      startedAt: Date.now(),
      ...(finished ? { completedAt: Date.now() } : {}),
    });
    state.toolEventCount += 1;
    return;
  }
  if (method === "session.status") {
    if (params.status === "running") state.runningSeen = true;
    if (params.status === "idle" && state.runningSeen) {
      if (state.turnFailure) process.failActive(new Error(state.turnFailure));
      else if (process.tryRecoverExhaustedTurn(state)) return;
      else void process.completeActive();
    }
    return;
  }
  if (method !== "session.event" || !params.event) return;
  const event = params.event;
  const data = event.data ?? {};
  if (event.type?.startsWith("compaction/")) {
    onCompaction(process, state, event);
    return;
  }
  if (event.type === "llm/retry") {
    onModelRetry(process, state, event);
    return;
  }
  if (event.type === "turn/end" && isRecord(data.reason)) {
    onTurnEnd(process, state, event);
    return;
  }
  if (event.type === "assistant/chunk" && isRecord(data.chunk)) {
    onAssistantChunk(process, state, event);
    return;
  }
  if (event.type === "assistant/message") {
    onAssistantMessage(process, state, event);
    return;
  }
  if (event.type === "tool/call") {
    onToolStart(process, state, event);
    return;
  }
  if (event.type === "tool/result" && isRecord(data.message)) {
    onToolResult(process, state, event);
    return;
  }
}

function onCompaction(
  _process: NotificationProcess,
  state: HarnessRunState,
  event: NonNullable<HarnessNotification["event"]>,
): void {
  const data = event.data ?? {};

  const ended = event.type?.endsWith("/end");
  const failure = ended && typeof data.error === "string" ? data.error : null;
  state.handlers.onProgress?.({
    id: "local-harness-compaction",
    source: "transcript",
    text:
      failure !== null
        ? `Local Harness could not compact the conversation (${failure}); continuing with the full context.`
        : ended
          ? "Local Harness compacted the conversation context."
          : "Local Harness is compacting conversation context.",
  });
  if (ended && failure === null && state.lastUsage) {
    state.handlers.onContextUsage?.({ ...state.lastUsage, compacted: true });
  }
  return;
}

function onModelRetry(
  _process: NotificationProcess,
  state: HarnessRunState,
  event: NonNullable<HarnessNotification["event"]>,
): void {
  const data = event.data ?? {};

  const failure =
    isRecord(data.failure) && typeof data.failure.message === "string"
      ? data.failure.message
      : "model request failed";
  const attempt = typeof data.retry === "number" ? data.retry : 1;
  const limit = typeof data.maxRetries === "number" ? `/${data.maxRetries}` : "";
  state.handlers.onProgress?.({
    id: "local-harness-retry",
    source: "transcript",
    text: `Local model request failed (${failure}); retrying ${attempt}${limit}…`,
  });
  return;
}

function onTurnEnd(
  _process: NotificationProcess,
  state: HarnessRunState,
  event: NonNullable<HarnessNotification["event"]>,
): void {
  const data = event.data ?? {};
  if (!isRecord(data.reason)) return;

  const reason = data.reason;
  if (reason.kind === "error") {
    const failure = isRecord(reason.error) ? reason.error : {};
    const message =
      typeof failure.message === "string"
        ? failure.message
        : "The Local Harness model request failed.";
    state.turnFailure = formatModelRequestFailure(message, failure.code, state.request);
  } else if (reason.kind === "blocked") {
    state.turnFailure = "The Local Harness blocked this turn before completion.";
  } else if (typeof reason.kind === "string") {
    state.stopReason = reason.kind;
  }
  return;
}

function onAssistantChunk(
  process: NotificationProcess,
  state: HarnessRunState,
  event: NonNullable<HarnessNotification["event"]>,
): void {
  const data = event.data ?? {};
  if (!isRecord(data.chunk)) return;

  const chunk = data.chunk;
  if (chunk.type === "text-delta" && typeof chunk.text === "string") {
    state.text += chunk.text;
    state.handlers.onAssistantDelta?.(chunk.text);
  } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
    state.reasoningEventCount += 1;
    const step = typeof data.step === "number" ? data.step : 0;
    const index = typeof chunk.index === "number" ? chunk.index : 0;
    const reasoningKey = `${step}:${index}`;
    const previousDisplay = state.reasoningText.get(reasoningKey) ?? "";
    const previous = previousDisplay.startsWith(REASONING_TRUNCATED_PREFIX)
      ? previousDisplay.slice(REASONING_TRUNCATED_PREFIX.length)
      : previousDisplay;
    const combined = `${previous}${chunk.text}`;
    const text =
      combined.length > MAX_DISPLAY_REASONING_CHARS
        ? `${REASONING_TRUNCATED_PREFIX}${combined.slice(-MAX_DISPLAY_REASONING_CHARS)}`
        : combined;
    state.reasoningText.set(reasoningKey, text);
    state.handlers.onProgress?.({
      id: `local-reasoning-${state.sessionId}-${step}-${index}`,
      source: "reasoning",
      text,
    });
  } else if (chunk.type === "usage" && isRecord(chunk.usage)) {
    process.emitUsage(state, chunk.usage);
  } else if (chunk.type === "finish") {
    const kind =
      isRecord(chunk.reason) && typeof chunk.reason.kind === "string" ? chunk.reason.kind : null;
    const replay =
      isRecord(chunk.replayState) && isRecord(chunk.replayState.response)
        ? chunk.replayState.response
        : null;
    const stopReason =
      kind ??
      (replay?.stopReason === "length"
        ? "max-tokens"
        : typeof replay?.stopReason === "string"
          ? replay.stopReason
          : null);
    if (stopReason) state.stopReason = stopReason;
  }
  return;
}

function onAssistantMessage(
  process: NotificationProcess,
  state: HarnessRunState,
  event: NonNullable<HarnessNotification["event"]>,
): void {
  const data = event.data ?? {};

  if (isRecord(data.usage)) process.emitUsage(state, data.usage);
  // Some compatible servers emit only a final assistant/message for a turn.
  // Append it when this window has not already streamed text, while avoiding
  // replay of the same turn after text-delta chunks.
  if (state.text.length === state.windowStartTextLength && isRecord(data.message)) {
    const finalText = textFromContent(data.message.content);
    if (finalText) {
      state.text += finalText;
      state.handlers.onAssistantDelta?.(finalText);
    }
  }
  return;
}

function onToolStart(
  _process: NotificationProcess,
  state: HarnessRunState,
  event: NonNullable<HarnessNotification["event"]>,
): void {
  const data = event.data ?? {};

  const callId = String(data.callId ?? event.seq ?? randomUUID());
  const tool = String(data.name ?? "tool");
  let args: Record<string, unknown> = {};
  try {
    args = normalizedArgs(JSON.parse(String(data.arguments ?? "{}")));
  } catch {
    /* malformed args stay empty */
  }
  state.toolArguments.set(callId, { tool, arguments: args });
  state.toolEventCount = (state.toolEventCount ?? 0) + 1;
  traceLocalStream("harness.tool.call", {
    sessionId: state.sessionId,
    callId,
    tool,
    arguments: args,
  });
  state.handlers.onToolActivity?.({
    id: `local-tool-${callId}`,
    command: commandFrom(tool, args),
    status: "running",
    startedAt: Date.now(),
  });
  return;
}

function onToolResult(
  _process: NotificationProcess,
  state: HarnessRunState,
  event: NonNullable<HarnessNotification["event"]>,
): void {
  const data = event.data ?? {};
  if (!isRecord(data.message)) return;

  const source = isRecord(data.message.source) ? data.message.source : {};
  const callId = String(source.callId ?? event.seq ?? "result");
  const known = state.toolArguments.get(callId);
  const failed = isRecord(data.error);
  state.handlers.onToolActivity?.({
    id: `local-tool-${callId}`,
    command: known ? commandFrom(known.tool, known.arguments) : "Harness tool",
    status: failed ? "failed" : "completed",
    startedAt: Date.now(),
    completedAt: Date.now(),
    output: textFromContent(data.message.content),
    summary:
      textFromContent(data.message.content).slice(0, 2_000) ||
      (failed ? "Tool failed" : "Tool completed"),
  });
  state.toolEventCount += 1;
  state.toolArguments.delete(callId);
}
