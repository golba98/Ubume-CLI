import { expect, test } from "bun:test";
import type { BackendProgressUpdate } from "../providers/types.js";
import { createClaudeStreamParser } from "./claudeStream.js";

const line = (event: Record<string, unknown>) =>
  `${JSON.stringify({ type: "stream_event", event })}\n`;

test("a step that hits the output limit explains the long wait and the automatic continuation", () => {
  const progress: BackendProgressUpdate[] = [];
  const parser = createClaudeStreamParser({
    onResponse: () => undefined,
    onError: () => undefined,
    onProgress: (update) => progress.push(update),
  });
  parser.push(line({ type: "message_start", message: { id: "msg_1" } }));
  parser.push(line({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
  parser.push(
    line({
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
      usage: { output_tokens: 128000 },
    }),
  );
  parser.push(line({ type: "message_delta", delta: { stop_reason: "end_turn" } }));
  expect(progress).toEqual([
    {
      id: "claude-thinking-msg_1-0",
      source: "reasoning",
      text: "Thinking… (Claude has not shared its reasoning)",
    },
    {
      id: "claude-max-tokens-msg_1",
      source: "stderr",
      text: "Claude reached its output limit (128,000 tokens) before finishing this step; Claude Code continues automatically.",
    },
  ]);
});

function collect() {
  const progress: BackendProgressUpdate[] = [];
  const parser = createClaudeStreamParser({
    onResponse: () => undefined,
    onError: () => undefined,
    onProgress: (update) => progress.push(update),
  });
  return { parser, progress };
}

test("API retries are reported in place instead of leaving a silent run", () => {
  const { parser, progress } = collect();
  const retry = (attempt: number) =>
    `${JSON.stringify({
      type: "system",
      subtype: "api_retry",
      attempt,
      max_retries: 10,
      retry_delay_ms: 2400,
      error_status: 529,
      error: "overloaded",
    })}\n`;
  parser.push(retry(1));
  parser.push(retry(2));
  expect(progress.map((update) => update.id)).toEqual(["claude-api-retry", "claude-api-retry"]);
  expect(progress[1]).toEqual({
    id: "claude-api-retry",
    source: "stderr",
    text: "Claude API request failed (HTTP 529): overloaded. Claude Code is retrying (attempt 2 of 10) in 2s.",
  });
});

test("hidden thinking shows a placeholder that real reasoning replaces under the same id", () => {
  const { parser, progress } = collect();
  parser.push(line({ type: "message_start", message: { id: "msg_2" } }));
  parser.push(
    line({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking" } }),
  );
  parser.push(line({ type: "content_block_start", index: 2, content_block: { type: "thinking" } }));
  parser.push(
    line({
      type: "content_block_delta",
      index: 2,
      delta: { type: "thinking_delta", thinking: "Plan the chunk mesher." },
    }),
  );
  expect(progress).toEqual([
    {
      id: "claude-thinking-msg_2-1",
      source: "reasoning",
      text: "Thinking… (Claude has not shared its reasoning)",
    },
    {
      id: "claude-thinking-msg_2-2",
      source: "reasoning",
      text: "Thinking… (Claude has not shared its reasoning)",
    },
    { id: "claude-thinking-msg_2-2", source: "reasoning", text: "Plan the chunk mesher." },
  ]);
});

test("large streamed tool input reports coarse progress with the target file", () => {
  const { parser, progress } = collect();
  parser.push(line({ type: "message_start", message: { id: "msg_3" } }));
  parser.push(
    line({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_1", name: "Write", input: {} },
    }),
  );
  const delta = (partial: string) =>
    line({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: partial },
    });
  parser.push(delta('{"file_path":"/work/2-Claude/index.html","content":"'));
  const chunk = "x".repeat(1024);
  for (let i = 0; i < 20; i++) parser.push(delta(chunk));
  // ~20 KB streamed in 1 KB deltas: two updates (8 KB, 16 KB), not one per delta.
  expect(progress.map((update) => update.text)).toEqual([
    "Claude is preparing Write index.html (8 KB of input so far)…",
    "Claude is preparing Write index.html (16 KB of input so far)…",
  ]);
  expect(new Set(progress.map((update) => update.id))).toEqual(
    new Set(["claude-tool-input-msg_3-0"]),
  );
});

test("denials Ubume answered itself are not reported as permission-policy blocks", () => {
  const progress: BackendProgressUpdate[] = [];
  const parser = createClaudeStreamParser(
    { onResponse: () => undefined, onError: () => undefined, onProgress: (u) => progress.push(u) },
    { approvals: "interactive", hostHandledTools: ["ExitPlanMode"] },
  );
  const result = (denials: unknown[]) =>
    `${JSON.stringify({ type: "result", subtype: "success", result: "plan", permission_denials: denials })}\n`;
  parser.push(result([{ tool_name: "ExitPlanMode", tool_use_id: "t1", tool_input: {} }]));
  expect(progress).toEqual([]);
  parser.push(
    result([
      { tool_name: "ExitPlanMode", tool_use_id: "t1", tool_input: {} },
      { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "rm -rf build" } },
    ]),
  );
  expect(progress.map((update) => update.text)).toEqual([
    "1 tool request was denied (by you or by Claude's permission policy). Review its response before continuing.",
  ]);
});

test("empty thinking deltas do not blank the hidden-thinking placeholder", () => {
  const { parser, progress } = collect();
  parser.push(line({ type: "message_start", message: { id: "msg_4" } }));
  parser.push(line({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
  parser.push(
    line({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "" },
    }),
  );
  expect(progress.map((update) => update.text)).toEqual([
    "Thinking… (Claude has not shared its reasoning)",
  ]);
});
