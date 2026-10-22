import { expect, test } from "bun:test";
import type { RunToolActivity } from "../../session/types.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import type {
  CommandResult,
  CommandSpec,
  CommandStreamHandlers,
  runCommand,
} from "../process/commandRunner.js";
import type { BackendRunHandlers } from "../providers/types.js";
import { runClaudeCodeWithRunner } from "./anthropic.js";
import { parseAgyModelsOutput, runAntigravityWithRunner } from "./antigravity.js";
import { createAntigravityStreamParser } from "./antigravityStream.js";
import { createClaudeStreamParser } from "./claudeStream.js";
import { createJsonLines } from "./jsonLines.js";
import { createVibeStreamParser, runMistralVibe } from "./mistralVibe.js";
import {
  completedNativeSession,
  isMissingNativeSession,
  nativeContinuation,
} from "./nativeContinuation.js";
import type { ProviderChatRequest } from "./types.js";

function sink() {
  const deltas: string[] = [],
    progress: string[] = [],
    tools: RunToolActivity[] = [];
  const handlers: BackendRunHandlers = {
    onResponse() {},
    onError() {},
    onAssistantDelta: (d) => deltas.push(d),
    onProgress: (p) => progress.push(p.text),
    onToolActivity: (t) => tools.push(t),
  };
  return { deltas, progress, tools, handlers };
}
const request: ProviderChatRequest = {
  prompt: "fixture",
  workspaceRoot: "/tmp",
  runtime: TEST_RUNTIME,
  route: { providerId: "anthropic", modelId: "haiku", backendKind: "claude-code-auth" },
};
function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 0,
    endedAt: 1,
    durationMs: 1,
    userMessage: "Command completed.",
    ...overrides,
  };
}

test("JSON framing accepts every possible split and a final record without newline", () => {
  const text = '{"text":"雪 🐦"}\n{"text":"second"}';
  for (let split = 0; split <= text.length; split++) {
    const records: unknown[] = [];
    const parser = createJsonLines((record) => records.push(record));
    parser.push(text.slice(0, split));
    parser.push(text.slice(split));
    parser.flush();
    expect(records).toEqual([{ text: "雪 🐦" }, { text: "second" }]);
  }
});

test("malformed and oversized protocol records fail explicitly without unbounded buffering", () => {
  for (const input of ['{"broken":}\n', '{"text":"' + "a".repeat(40)]) {
    const parser = createJsonLines(
      () => {},
      () => {},
      32,
    );
    parser.push(input);
    parser.flush();
    expect(parser.error).toBeDefined();
    parser.push("a".repeat(100_000));
    expect(parser.records).toBe(0);
  }
});

test("Claude reconciles partials, repeated snapshots and final results without JSON leakage", () => {
  const s = sink(),
    parser = createClaudeStreamParser(s.handlers);
  const events = [
    { type: "system", subtype: "init", session_id: "claude-session" },
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "雪" } },
    },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hello 雪" }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hello 雪" }] } },
    { type: "result", subtype: "success", result: "Hello 雪", is_error: false },
  ];
  const serialized = events.map((event) => JSON.stringify(event)).join("\n");
  for (let offset = 0; offset < serialized.length; offset += 7)
    parser.push(serialized.slice(offset, offset + 7));
  parser.flush();
  expect(s.deltas.join("")).toBe("Hello 雪");
  expect(parser.finalText()).toBe("Hello 雪");
  expect(parser.sessionId).toBe("claude-session");
});

test("Claude anonymous complete messages and subagent messages do not corrupt the main answer", () => {
  const s = sink(),
    parser = createClaudeStreamParser(s.handlers);
  for (const event of [
    { type: "assistant", message: { content: [{ type: "text", text: "First" }] } },
    {
      type: "assistant",
      parent_tool_use_id: "sub",
      message: { content: [{ type: "text", text: "Private subagent text" }] },
    },
    { type: "assistant", message: { content: [{ type: "text", text: "Second" }] } },
  ])
    parser.push(JSON.stringify(event) + "\n");
  expect(s.deltas.join("")).toBe("FirstSecond");
});

test("Claude initialized streams require a terminal result even after assistant text", () => {
  const parser = createClaudeStreamParser(sink().handlers);
  parser.push('{"type":"system","subtype":"init","session_id":"s"}\n');
  parser.push(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"I will run the next tool."}]}}',
  );
  parser.flush();
  expect(parser.failure).toContain("before a final result");
});

test("Claude structured failures on stdout cannot be reported as successful answers", async () => {
  const output = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Fixture authentication expired"],
  });
  const outcome = await new Promise<string>((resolve, reject) =>
    runClaudeCodeWithRunner(
      request,
      { onResponse: reject, onError: resolve },
      (() => ({
        child: null,
        cancel() {},
        result: Promise.resolve(result({ stdout: output })),
      })) as unknown as typeof runCommand,
      "fixture",
    ),
  );
  expect(outcome).toContain("authentication expired");
  expect(outcome).not.toContain('"type"');
});

test("a Claude timeout cannot disable effort based on assistant prose or tool output", async () => {
  const model = {
    id: "fixture",
    modelId: "fixture",
    label: "Fixture",
    description: null,
    defaultReasoningLevel: "high",
    supportedReasoningLevels: [{ id: "high", label: "High", description: null }],
  };
  const outcome = await new Promise<{ message: string; kind?: string }>((resolve, reject) =>
    runClaudeCodeWithRunner(
      {
        ...request,
        route: { ...request.route, modelId: "fixture", reasoning: "high" },
        modelDescriptor: model,
      },
      {
        onResponse: reject,
        onError: (message, _raw, evidence) => resolve({ message, kind: evidence?.kind }),
      },
      (() => ({
        child: null,
        cancel() {},
        result: Promise.resolve(
          result({
            status: "timeout",
            exitCode: null,
            durationMs: 120_000,
            stdout:
              JSON.stringify({
                type: "assistant",
                message: {
                  content: [{ type: "text", text: "The expected effort is substantial." }],
                },
              }) + "\n",
            userMessage: "Command timed out before it could finish.",
          }),
        ),
      })) as unknown as typeof runCommand,
      "fixture",
    ),
  );
  expect(outcome.kind).toBe("timeout");
  expect(outcome.message).not.toContain("rejected effort");
  expect(model.supportedReasoningLevels.map((level) => level.id)).toEqual(["high"]);
});

test("AGY streams incremental text including identical consecutive fragments and DONE suffixes", () => {
  const s = sink(),
    parser = createAntigravityStreamParser(s.handlers);
  for (const [state, delta] of [
    ["ACTIVE", "ha"],
    ["ACTIVE", "ha"],
    ["DONE", "!"],
  ])
    parser.push(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "g1",
          step_index: 1,
          state,
          step_type: "agent_response",
          text_delta: delta,
        },
      }) + "\n",
    );
  parser.push(
    JSON.stringify({
      event: "result",
      result: { conversation_id: "g1", status: "SUCCESS", response: "haha!" },
    }),
  );
  parser.flush();
  expect(s.deltas.join("")).toBe("haha!");
  expect(parser.finalText()).toBe("haha!");
  expect(parser.sessionId).toBe("g1");
});

for (const status of ["ERROR", "WAITING", "INTERRUPTED", "CANCELED", "RUNNING", "INVALID"]) {
  test(`AGY ${status} terminal status is not a successful response`, () => {
    const parser = createAntigravityStreamParser(sink().handlers);
    parser.push(
      JSON.stringify({ event: "result", result: { status, error: `fixture ${status}` } }),
    );
    parser.flush();
    expect(parser.failure).toContain(status);
  });
}

test("AGY reports incomplete structured streams and native tool failures", () => {
  const s = sink(),
    parser = createAntigravityStreamParser(s.handlers);
  parser.push(
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_type: "tool",
        step_index: 3,
        state: "DONE",
        duration_seconds: 0.567,
        tool_name: "run_command",
        tool_info: {
          parameters: { CommandLine: "fixture command" },
          output: "denied",
          error: { type: "permission" },
        },
      },
    }) + "\n",
  );
  expect(s.tools.map((t) => t.status)).toEqual(["running", "failed"]);
  expect(s.tools[1]!.completedAt! - s.tools[1]!.startedAt).toBe(567);
  expect(parser.failure).toContain("before a final result");
});

test("Vibe current-turn-only resume emits typed reasoning, effects, answer and exact session ID", () => {
  const s = sink(),
    parser = createVibeStreamParser(s.handlers, { startAfterUserPrompt: "not replayed" });
  for (const record of [
    { type: "reasoning", id: "reason", text: "Working" },
    {
      type: "effect",
      id: "tool",
      title: "Run test",
      state: { status: "failed", duration_ms: 567, output_text: "permission denied" },
    },
    {
      type: "message",
      id: "answer",
      role: "assistant",
      content: [{ type: "text", text: "Current answer" }],
    },
    {
      type: "message",
      id: "answer",
      role: "assistant",
      content: [{ type: "text", text: "Current answer" }],
    },
  ])
    parser.push(
      JSON.stringify({
        ...record,
        generation_status: "completed",
        session_id: "exact-vibe-session",
      }) + "\n",
    );
  expect(parser.finalText()).toBe("Current answer");
  expect(s.deltas).toEqual(["Current answer"]);
  expect(s.progress).toEqual(["Working"]);
  expect(s.tools.map((t) => t.status)).toEqual(["running", "failed"]);
  expect(parser.sessionId).toBe("exact-vibe-session");
});

test("native continuation requires a completed matching dialogue and model", () => {
  const reference = completedNativeSession(request, "claude", "s1", "answer");
  const next = {
    ...request,
    conversationHistory: [
      { role: "user" as const, content: "fixture" },
      { role: "assistant" as const, content: "answer" },
    ],
    nativeSessions: [reference],
  };
  expect(nativeContinuation(next, "claude")?.sessionId).toBe("s1");
  expect(
    nativeContinuation({ ...next, route: { ...next.route, modelId: "other" } }, "claude"),
  ).toBeUndefined();
  expect(
    nativeContinuation(
      { ...next, conversationHistory: [{ role: "user", content: "other chat" }] },
      "claude",
    ),
  ).toBeUndefined();
  expect(
    nativeContinuation(
      { ...next, nativeSessions: [{ source: "claude", sessionId: "legacy" }] },
      "claude",
    ),
  ).toBeUndefined();
});

for (const provider of ["anthropic", "google"] as const) {
  test(`${provider} missing native session retries once after teardown with the saved dialogue`, async () => {
    const source = provider === "anthropic" ? "claude" : "antigravity";
    const reference = completedNativeSession(request, source, "missing-session", "prior answer");
    const next: ProviderChatRequest = {
      ...request,
      prompt: "next prompt",
      route: { ...request.route, providerId: provider },
      conversationHistory: [
        { role: "user", content: "fixture" },
        { role: "assistant", content: "prior answer" },
      ],
      nativeSessions: [reference],
    };
    let release: () => void = () => {};
    const firstStopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const specs: string[][] = [];
    const runner = ((spec: CommandSpec) => {
      specs.push(spec.args);
      return {
        child: null,
        cancel() {},
        stopped: specs.length === 1 ? firstStopped : Promise.resolve(),
        result: Promise.resolve(
          specs.length === 1
            ? result({ status: "failed", exitCode: 1, stderr: "Session missing-session not found" })
            : result({
                stdout:
                  provider === "anthropic"
                    ? '{"type":"result","subtype":"success","result":"recovered"}'
                    : '{"event":"result","result":{"status":"SUCCESS","response":"recovered"}}',
              }),
        ),
      };
    }) as unknown as typeof runCommand;
    let stopped = Promise.resolve();
    const outcome = new Promise<string>((resolve, reject) => {
      const handlers: BackendRunHandlers = {
        onRunControl: (c) => {
          stopped = c.stopped;
        },
        onResponse: resolve,
        onError: reject,
      };
      if (provider === "anthropic") runClaudeCodeWithRunner(next, handlers, runner, "fixture");
      else
        runAntigravityWithRunner(
          next,
          handlers,
          runner,
          "fixture",
          process.platform,
          parseAgyModelsOutput("haiku  Haiku"),
        );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(specs).toHaveLength(1);
    expect(specs[0]).toContain(provider === "anthropic" ? "--resume" : "--conversation");
    release();
    expect(await outcome).toBe("recovered");
    await stopped;
    expect(specs).toHaveLength(2);
    expect(specs[1]).not.toContain("missing-session");
    expect(specs[1]!.at(-1)).toContain("prior answer");
  });
}

for (const provider of ["anthropic", "google", "mistral"] as const) {
  test(`${provider} never passes a short command deadline to an unlimited agent task`, async () => {
    let stopped = Promise.resolve();
    const output =
      provider === "anthropic"
        ? { type: "result", subtype: "success", result: "long task completed" }
        : provider === "google"
          ? { event: "result", result: { status: "SUCCESS", response: "long task completed" } }
          : {
              type: "message",
              id: "answer",
              session_id: "v1",
              role: "assistant",
              content: [{ type: "text", text: "long task completed" }],
            };
    const runner = ((spec: CommandSpec, handlers?: CommandStreamHandlers) => {
      expect(spec.timeoutMs).toBe(0);
      handlers?.onStdout?.(JSON.stringify(output));
      return {
        child: null,
        stopped: Promise.resolve(),
        cancel() {},
        result: Promise.resolve(result({ durationMs: 700_000 })),
      };
    }) as unknown as typeof runCommand;
    const next: ProviderChatRequest = {
      ...request,
      route: {
        ...request.route,
        providerId: provider,
        modelId: provider === "mistral" ? "Vibe default" : "haiku",
      },
    };
    const text = await new Promise<string>((resolve, reject) => {
      const handlers: BackendRunHandlers = {
        onRunControl: (c) => {
          stopped = c.stopped;
        },
        onResponse: resolve,
        onError: reject,
      };
      if (provider === "anthropic") runClaudeCodeWithRunner(next, handlers, runner, "fixture");
      else if (provider === "google")
        runAntigravityWithRunner(
          next,
          handlers,
          runner,
          "fixture",
          process.platform,
          parseAgyModelsOutput("haiku  Haiku"),
        );
      else
        runMistralVibe(next, handlers, {
          runCommandImpl: runner,
          resolveExecutable: async () => "fixture",
          findSessionImpl: async () => null,
        });
    });
    await stopped;
    expect(text).toBe("long task completed");
  });
}

test("missing-session recovery never retries authentication, throttling or timeout failures", () => {
  for (const message of [
    "Authentication expired: session not found",
    "429 rate limit: session not found",
    "Quota exhausted: session not found",
    "Network outage: session not found",
  ]) {
    expect(isMissingNativeSession(result({ status: "failed", stderr: message }))).toBe(false);
  }
  expect(isMissingNativeSession(result({ status: "timeout", stderr: "Session not found" }))).toBe(
    false,
  );
  expect(isMissingNativeSession(result({ status: "failed", stderr: "Session not found" }))).toBe(
    true,
  );
});
