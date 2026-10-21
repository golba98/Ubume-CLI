import type { BackendRunHandlers } from "../providers/types.js";
import { isRecord } from "../shared/values.js";
import { createJsonLines } from "./jsonLines.js";

/** AGY has event/step_update envelopes, not Claude or Codex message events. */
export function createAntigravityStreamParser(handlers: BackendRunHandlers) {
  let text = "";
  let response: string | undefined;
  let failure: string | undefined;
  let sessionId: string | undefined;
  let terminal = false;
  let plain = "";
  const tools = new Map<string, { startedAt: number; command: string }>();
  const lines = createJsonLines(
    (record) => {
      if (typeof record.conversation_id === "string") sessionId = record.conversation_id;
      if (record.event === "result" && isRecord(record.result)) {
        const result = record.result;
        terminal = true;
        if (typeof result.conversation_id === "string") sessionId = result.conversation_id;
        if (result.status !== "SUCCESS")
          failure =
            typeof result.error === "string"
              ? result.error
              : `AGY ended with status ${String(result.status)}.`;
        else if (typeof result.response === "string") response = result.response;
        if (
          isRecord(result.usage) &&
          typeof result.usage.input_tokens === "number" &&
          typeof result.usage.output_tokens === "number"
        ) {
          handlers.onContextUsage?.({
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
            contextTokens: result.usage.input_tokens,
            contextWindow: null,
            exact: true,
          });
        }
      } else if (record.event === "step_update" && isRecord(record.step_update)) {
        const step = record.step_update;
        const id = `agy-${String(step.conversation_id ?? sessionId ?? "run")}-${String(step.step_index)}`;
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          text += step.text_delta;
          handlers.onAssistantDelta?.(step.text_delta);
        }
        if (step.step_type === "tool") {
          const info = isRecord(step.tool_info) ? step.tool_info : {};
          const params = isRecord(info.parameters) ? info.parameters : {};
          const completed = step.state === "DONE";
          const duration =
            typeof step.duration_seconds === "number" ? step.duration_seconds * 1000 : 0;
          const tool = tools.get(id) ?? {
            startedAt: Date.now() - (completed ? duration : 0),
            command:
              typeof params.CommandLine === "string"
                ? params.CommandLine
                : `${String(step.tool_name ?? info.name ?? "AGY tool")} ${JSON.stringify(params)}`,
          };
          if (!tools.has(id)) handlers.onToolActivity?.({ id, ...tool, status: "running" });
          tools.set(id, tool);
          if (completed) {
            const output = typeof info.output === "string" ? info.output : "";
            handlers.onToolActivity?.({
              id,
              ...tool,
              status: info.error ? "failed" : "completed",
              completedAt: Date.now(),
              output,
              summary: output.split("\n")[0]?.slice(0, 200),
            });
          }
        }
      }
    },
    (line) => {
      if (plain.length < 65536)
        plain += `${plain ? "\n" : ""}${line.slice(0, 65536 - plain.length)}`;
    },
  );
  return {
    push: lines.push,
    flush: lines.flush,
    get error() {
      return lines.error;
    },
    get failure() {
      return (
        failure ??
        (lines.records && !terminal ? "AGY closed before a final result was received." : undefined)
      );
    },
    get sessionId() {
      return sessionId;
    },
    get productive() {
      return text.length > 0 || tools.size > 0;
    },
    finalText: () => response ?? (lines.records ? text : plain),
  };
}
