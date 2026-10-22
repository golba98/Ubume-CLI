/**
 * End-to-end Claude approval bridge: a fake `claude` speaks the stream-json control protocol
 * and really performs approved Write/Bash actions in a workspace whose path contains spaces.
 * This reproduces the original failure (Write denied, compound shell denied) through the real
 * subprocess runner, stdin protocol and parser.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunToolActivity } from "../../session/types.js";
import {
  createFakeExecutable,
  FAKE_STDIO_READER,
  type FakeExecutable,
} from "../../test/fakeExecutable.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import type {
  BackendRunHandlers,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../providers/types.js";
import type { NativeSessionReference } from "../workspace/conversationStore.js";
import {
  buildClaudeCodeArgs,
  resetAnthropicRouteValidationCacheForTests,
  runClaudeCodeWithRunner,
} from "./anthropic.js";
import type { ProviderChatRequest } from "./types.js";

const FAKE_CLAUDE = `${FAKE_STDIO_READER}
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
log({ event: "argv", argv: process.argv.slice(2) });
const waiting = new Map();
let started = false;
process.stdin.on("end", () => { log({ event: "stdin-end" }); process.exit(0); });
const request = (id, tool, input) =>
  send({ type: "control_request", request_id: id,
    request: { subtype: "can_use_tool", tool_name: tool, input, tool_use_id: "tu-" + id } });
const ask = (id, tool, input) => new Promise((resolve) => { waiting.set(id, resolve); request(id, tool, input); });
const perform = (tool, input) => {
  if (tool === "Write") {
    fs.mkdirSync(path.dirname(input.file_path), { recursive: true });
    fs.writeFileSync(input.file_path, input.content);
    return { ok: true, text: "File created successfully at: " + input.file_path };
  }
  if (tool === "Bash") {
    const r = cp.spawnSync("/bin/sh", ["-c", input.command], { cwd: process.cwd(), encoding: "utf8" });
    return { ok: r.status === 0, text: JSON.stringify({ stdout: r.stdout, stderr: r.stderr, status: r.status }) };
  }
  return { ok: true, text: fs.readdirSync(process.cwd()).sort().join("\\n") };
};
const step = async (s, i) => {
  const id = s.id || "req-" + i;
  send({ type: "assistant", message: { id: "m-" + id, content: [{ type: "tool_use", id: "tu-" + id, name: s.tool, input: s.input }] } });
  let outcome = { behavior: "allow" };
  if (!s.autoAllowed) {
    if (s.duplicate) request(id, s.tool, s.input);
    outcome = await ask(id, s.tool, s.input);
  }
  const done = outcome.behavior === "allow"
    ? perform(s.tool, outcome.updatedInput || s.input)
    : { ok: false, text: outcome.message };
  log({ event: "tool", id, tool: s.tool, ok: done.ok, text: done.text });
  send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-" + id, content: done.text, is_error: !done.ok }] } });
};
const run = async () => {
  send({ type: "system", subtype: "init", session_id: "fake-session" });
  if (scenario.mode === "hang") { request("hang-1", "Write", { file_path: "never.txt", content: "" }); return; }
  if (scenario.mode === "exit-pending") {
    request("exit-1", "Write", { file_path: "never.txt", content: "" });
    setTimeout(() => process.exit(3), 100);
    return;
  }
  if (scenario.mode === "concurrent") await Promise.all(scenario.steps.map(step));
  else for (const [i, s] of scenario.steps.entries()) await step(s, i);
  send({ type: "assistant", message: { id: "final", content: [{ type: "text", text: scenario.final }] } });
  send({ type: "result", subtype: "success", is_error: false, result: scenario.final, session_id: "fake-session", permission_denials: [] });
};
onLine((message) => {
  if (message.type === "user" && !started) {
    started = true;
    log({ event: "prompt", content: message.message.content });
    void run();
  } else if (message.type === "control_response") {
    log({ event: "response", response: message.response });
    const resolve = waiting.get(message.response.request_id);
    if (resolve) { waiting.delete(message.response.request_id); resolve(message.response.response); }
  }
});
`;

let root: string;
let workspace: string;
let fake: FakeExecutable | null = null;

beforeEach(() => {
  resetAnthropicRouteValidationCacheForTests();
  root = mkdtempSync(join(tmpdir(), "ubume claude bridge "));
  workspace = join(root, "23-Ubume Minecraft tester", "2-Claude");
  mkdirSync(workspace, { recursive: true });
});
afterEach(() => {
  fake?.cleanup();
  fake = null;
  rmSync(root, { recursive: true, force: true });
});

function claudeRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    prompt: "Build the Minecraft clone",
    workspaceRoot: workspace,
    runtime: { ...TEST_RUNTIME, mode: "auto-edit" },
    route: { providerId: "anthropic", modelId: "haiku", backendKind: "claude-code-auth" },
    approvalSurface: "interactive",
    ...overrides,
  };
}

interface RunOutcome {
  response?: string;
  error?: string;
  tools: RunToolActivity[];
  progress: string[];
  sessions: NativeSessionReference[];
  asked: ToolApprovalRequest[];
}

function runFake(
  scenario: unknown,
  decide: (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<ToolApprovalDecision>,
  request = claudeRequest(),
  onStart?: (cancel: () => void) => void,
): Promise<RunOutcome> {
  fake = createFakeExecutable("claude", FAKE_CLAUDE, scenario);
  const outcome: RunOutcome = { tools: [], progress: [], sessions: [], asked: [] };
  return new Promise((resolve) => {
    let stopped: Promise<void> = Promise.resolve();
    const settle = () => void stopped.then(() => resolve(outcome));
    const handlers: BackendRunHandlers = {
      onResponse: (response) => {
        outcome.response = response;
        settle();
      },
      onError: (message) => {
        outcome.error = message;
        settle();
      },
      onRunControl: (control) => {
        stopped = control.stopped;
      },
      onProgress: (update) => outcome.progress.push(update.text),
      onToolActivity: (tool) => outcome.tools.push(tool),
      onNativeSession: (session) => outcome.sessions.push(session),
      onToolApproval: (approval, signal) => {
        outcome.asked.push(approval);
        return decide(approval, signal);
      },
    };
    const cancel = runClaudeCodeWithRunner(request, handlers, undefined, fake!.path);
    onStart?.(() => {
      cancel();
      settle();
    });
  });
}

function logged(event: string): Array<Record<string, unknown>> {
  return (fake!.readLog() as Array<Record<string, unknown>>).filter(
    (entry) => entry.event === event,
  );
}

test("the original failure: Write, compound shell, pipeline and denial complete through Ubume approvals", async () => {
  const index = join(workspace, "index.html");
  const decisions: ToolApprovalDecision[] = [
    "allow-once", // Write index.html
    "allow-for-run", // mkdir -p src && touch src/main.ts
    // second identical mkdir is reused without asking
    "allow-once", // build || echo | cat
    "deny", // Write secrets.txt
  ];
  const outcome = await runFake(
    {
      final: "Game scaffolded.",
      steps: [
        { tool: "Read", input: { path: "." }, autoAllowed: true },
        { tool: "Write", input: { file_path: index, content: "<!doctype html><title>MC</title>" } },
        { tool: "Bash", input: { command: "mkdir -p src && touch src/main.ts && pwd" } },
        { tool: "Bash", input: { command: "mkdir -p src && touch src/main.ts && pwd" } },
        {
          tool: "Bash",
          input: { command: 'npm run build 2>/dev/null || echo "build && failed" | cat' },
        },
        { tool: "Write", input: { file_path: join(workspace, "secrets.txt"), content: "x" } },
      ],
    },
    async () => decisions.shift() ?? "deny",
  );

  expect(outcome.error).toBeUndefined();
  expect(outcome.response).toBe("Game scaffolded.");
  expect(readFileSync(index, "utf8")).toContain("<title>MC</title>");
  expect(existsSync(join(workspace, "src", "main.ts"))).toBe(true);
  expect(existsSync(join(workspace, "secrets.txt"))).toBe(false);

  // Exactly four prompts: the repeated identical command reused the run-scoped approval.
  expect(outcome.asked.map((approval) => approval.command ?? approval.paths[0])).toEqual([
    "index.html",
    "mkdir -p src && touch src/main.ts && pwd",
    'npm run build 2>/dev/null || echo "build && failed" | cat',
    "secrets.txt",
  ]);
  expect(outcome.asked[0]).toMatchObject({ kind: "file", provider: "Claude Code", workspace });
  expect(outcome.asked[1]).toMatchObject({ kind: "command" });

  // Real execution in a path with spaces: stdout, stderr and exit status are preserved.
  const tools = logged("tool");
  const mkdir = JSON.parse(String(tools[2]!.text));
  expect(mkdir).toEqual({ stdout: `${workspace}\n`, stderr: "", status: 0 });
  const pipeline = JSON.parse(String(tools[4]!.text));
  expect(pipeline).toMatchObject({ stdout: "build && failed\n", status: 0 });
  expect(tools[5]).toMatchObject({ tool: "Write", ok: false });

  // The denial reached Claude as a denial and is labeled as the user's choice.
  const denied = outcome.tools.find((tool) => tool.id === "tu-req-5" && tool.status === "failed");
  expect(denied?.summary).toBe("Denied by you in Ubume");

  // Protocol shape: prompt on stdin (not argv), host prompts over stdio, mapped mode.
  const argv = logged("argv")[0]!.argv as string[];
  expect(argv).toContain("--input-format");
  expect(argv[argv.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
  expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  expect(argv).not.toContain("--permission-prompts");
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(argv).not.toContain("Build the Minecraft clone");
  expect(logged("prompt")[0]!.content).toBe("Build the Minecraft clone");
  expect(logged("stdin-end")).toHaveLength(1);
  expect(outcome.sessions[0]?.sessionId).toBe("fake-session");
  expect(outcome.progress[0]).toMatch(/Claude Code permissions: acceptEdits/);
});

test("concurrent requests are answered in order, never overlapping, and duplicates once", async () => {
  let open = 0;
  let maxOpen = 0;
  const outcome = await runFake(
    {
      mode: "concurrent",
      final: "done",
      steps: [
        { id: "a", tool: "Write", input: { file_path: "a.txt", content: "a" }, duplicate: true },
        { id: "b", tool: "Write", input: { file_path: "b.txt", content: "b" } },
      ],
    },
    async () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 30));
      open--;
      return "allow-once";
    },
  );
  expect(outcome.response).toBe("done");
  expect(maxOpen).toBe(1);
  expect(outcome.asked.map((approval) => approval.paths[0])).toEqual(["a.txt", "b.txt"]);
  const responses = logged("response").map(
    (entry) => (entry.response as { request_id: string }).request_id,
  );
  expect(responses).toEqual(["a", "b"]);
  expect(existsSync(join(workspace, "a.txt")) && existsSync(join(workspace, "b.txt"))).toBe(true);
});

test("cancelling while an approval is pending withdraws it and stops the provider", async () => {
  let signal: AbortSignal | undefined;
  let cancelRun: (() => void) | undefined;
  const outcome = await runFake(
    { mode: "hang" },
    (_approval, approvalSignal) => {
      signal = approvalSignal;
      queueMicrotask(() => cancelRun?.());
      return new Promise(() => undefined);
    },
    claudeRequest(),
    (cancel) => {
      cancelRun = cancel;
    },
  );
  expect(signal?.aborted).toBe(true);
  expect(outcome.response).toBeUndefined();
  expect(logged("response")).toEqual([]);
  expect(existsSync(join(workspace, "never.txt"))).toBe(false);
});

test("a provider exit while an approval is pending withdraws the prompt and reports failure", async () => {
  let signal: AbortSignal | undefined;
  const outcome = await runFake({ mode: "exit-pending" }, (_approval, approvalSignal) => {
    signal = approvalSignal;
    return new Promise(() => undefined);
  });
  expect(signal?.aborted).toBe(true);
  expect(outcome.error).toBeDefined();
  expect(outcome.response).toBeUndefined();
});

test("headless runs keep print mode with the prompt in argv and never ask the host", () => {
  const args = buildClaudeCodeArgs(claudeRequest({ approvalSurface: undefined }));
  expect(args).not.toContain("--input-format");
  expect(args).not.toContain("--permission-prompt-tool");
  expect(args.at(-1)).toBe("Build the Minecraft clone");
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
});

test("plan intent and read-only mode reach Claude as plan and dontAsk", () => {
  const mode = (request: ProviderChatRequest) => {
    const args = buildClaudeCodeArgs(request);
    return args[args.indexOf("--permission-mode") + 1];
  };
  expect(mode(claudeRequest({ runIntent: "plan" }))).toBe("plan");
  expect(mode(claudeRequest({ runtime: { ...TEST_RUNTIME, mode: "suggest" } }))).toBe("dontAsk");
  expect(mode(claudeRequest({ runtime: { ...TEST_RUNTIME, mode: "full-auto" } }))).toBe("auto");
});
