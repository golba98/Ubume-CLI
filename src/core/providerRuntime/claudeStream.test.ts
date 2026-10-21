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
      id: "claude-max-tokens-msg_1",
      source: "stderr",
      text: "Claude reached its output limit (128,000 tokens) before finishing this step; Claude Code continues automatically.",
    },
  ]);
});
