import assert from "node:assert/strict";
import test from "node:test";
import type { RunToolActivity } from "../../session/types.js";
import { createCodexJsonStreamParser } from "./codexJsonStream.js";
import type { BackendProgressUpdate } from "./types.js";

test("streams incremental agent_message growth as assistant deltas", () => {
  const assistant: string[] = [];
  const observedFinalAnswers: string[] = [];
  const parser = createCodexJsonStreamParser({
    onAssistantDelta: (chunk) => assistant.push(chunk),
    onFinalAnswerObserved: (response) => observedFinalAnswers.push(response),
  });

  assert.equal(
    parser.feedLine(
      JSON.stringify({
        type: "item.started",
        item: { id: "msg-1", type: "agent_message", text: "Hello" },
      }),
    ),
    true,
  );
  assert.equal(
    parser.feedLine(
      JSON.stringify({
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: "Hello world" },
      }),
    ),
    true,
  );
  assert.equal(
    parser.feedLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Hello world!" },
      }),
    ),
    true,
  );
  assert.equal(
    parser.feedLine(
      JSON.stringify({
        type: "turn.completed",
      }),
    ),
    true,
  );

  assert.deepEqual(assistant, ["Hello", " world", "!"]);
  assert.deepEqual(observedFinalAnswers, ["Hello world!"]);
  assert.equal(parser.getFinalResponse(), "Hello world!");
});

test("surfaces command execution lifecycle as tool activity", () => {
  const toolActivities: RunToolActivity[] = [];
  const parser = createCodexJsonStreamParser({
    onToolActivity: (activity) => toolActivities.push(activity),
  });

  parser.feedLine(
    JSON.stringify({
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "rg --files",
        status: "in_progress",
        aggregated_output: "",
      },
    }),
  );
  parser.feedLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "rg --files",
        status: "completed",
        aggregated_output: "src/app.tsx\nsrc/ui/Timeline.tsx\n",
        exit_code: 0,
      },
    }),
  );

  assert.equal(toolActivities.length, 2);
  assert.equal(toolActivities[0]?.status, "running");
  assert.equal(toolActivities[0]?.command, "rg --files");
  assert.equal(toolActivities[1]?.status, "completed");
  assert.match(toolActivities[1]?.summary ?? "", /src\/app\.tsx/i);
});

test("emits progress updates for todo_list and reasoning items", () => {
  const progress: BackendProgressUpdate[] = [];
  const parser = createCodexJsonStreamParser({
    onProgress: (update) => progress.push(update),
  });

  parser.feedLine(
    JSON.stringify({
      type: "item.updated",
      item: {
        id: "todo-1",
        type: "todo_list",
        items: [
          { text: "Inspect workspace", completed: true },
          { text: "Write file", completed: false },
        ],
      },
    }),
  );
  parser.feedLine(
    JSON.stringify({
      type: "item.updated",
      item: {
        id: "reason-1",
        type: "reasoning",
        text: "Verifying the generated output\n\nChecking edge cases",
      },
    }),
  );

  assert.deepEqual(progress, [
    { id: "todo-1", source: "todo", text: "Todo 1/2: Write file" },
    {
      id: "reason-1",
      source: "reasoning",
      text: "Verifying the generated output\n\nChecking edge cases",
    },
  ]);
});

test("reuses the same progress id when a structured update grows", () => {
  const progress: BackendProgressUpdate[] = [];
  const parser = createCodexJsonStreamParser({
    onProgress: (update) => progress.push(update),
  });

  parser.feedLine(
    JSON.stringify({
      type: "item.updated",
      item: {
        id: "reason-7",
        type: "reasoning",
        text: "Inspecting the config",
      },
    }),
  );
  parser.feedLine(
    JSON.stringify({
      type: "item.updated",
      item: {
        id: "reason-7",
        type: "reasoning",
        text: "Inspecting the config\n\nComparing runtime defaults",
      },
    }),
  );

  assert.deepEqual(progress, [
    { id: "reason-7", source: "reasoning", text: "Inspecting the config" },
    {
      id: "reason-7",
      source: "reasoning",
      text: "Inspecting the config\n\nComparing runtime defaults",
    },
  ]);
});

test("captures turn failures from structured events", () => {
  const parser = createCodexJsonStreamParser({});

  parser.feedLine(
    JSON.stringify({
      type: "turn.failed",
      error: { message: "Permission denied" },
    }),
  );

  assert.equal(parser.getFailureMessage(), "Permission denied");
});

test("returns false for non-json lines so callers can fall back to transcript parsing", () => {
  const parser = createCodexJsonStreamParser({});

  assert.equal(parser.feedLine("assistant"), false);
  assert.equal(parser.hasStructuredEvents(), false);
});

test("nonfatal error items do not fail a complete structured plan", () => {
  const progress: BackendProgressUpdate[] = [];
  const final: string[] = [];
  const parser = createCodexJsonStreamParser({
    onProgress: (event) => progress.push(event),
    onFinalAnswerObserved: (response) => final.push(response),
  });
  const plan = "<proposed_plan>\n1. Inspect.\n2. Fix and test.\n</proposed_plan>";
  for (const event of [
    { type: "item.completed", item: { id: "warning", type: "error", message: "Nonfatal warning" } },
    { type: "item.completed", item: { id: "plan", type: "agent_message", text: plan } },
    { type: "turn.completed" },
  ])
    parser.feedLine(JSON.stringify(event));
  assert.equal(parser.getFailureMessage(), null);
  assert.equal(parser.getFinalResponse(), plan);
  assert.deepEqual(final, [plan]);
  assert.deepEqual(progress, [{ id: "warning", source: "stderr", text: "Nonfatal warning" }]);
});

for (const type of ["error", "turn.failed"]) {
  test(`Codex ${type} remains fatal even when plan text was streamed`, () => {
    const parser = createCodexJsonStreamParser({});
    parser.feedLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "plan", type: "agent_message", text: "A plan" },
      }),
    );
    parser.feedLine(JSON.stringify({ type, message: "Fatal", error: { message: "Fatal" } }));
    assert.equal(parser.getFailureMessage(), "Fatal");
  });
}
