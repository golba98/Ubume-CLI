/**
 * End-to-end Mistral Vibe ACP bridge: a fake `vibe-acp` speaks newline-delimited JSON-RPC and
 * really performs approved shell and file actions in a workspace whose path contains spaces.
 * This reproduces the headless failure (every approval auto-denied) through the real subprocess
 * runner and shows the requests reaching Ubume's approval handler instead.
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
import { runMistralVibe } from "./mistralVibe.js";
import type { ProviderChatRequest } from "./types.js";
import { toVibeApprovalRequest, vibePermissionOutcome } from "./vibeAcp.js";

const FAKE_ACP = `${FAKE_STDIO_READER}
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
log({ event: "argv", argv: process.argv.slice(2), model: process.env.VIBE_ACTIVE_MODEL || null });
if (scenario.failInit) { process.stderr.write("vibe-acp: config error\\n"); process.exit(2); }
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (sessionId, body) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
const waiting = new Map();
let nextId = 0;
let promptId = null;
let sessionId = "acp-session";
const OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];
const MODES = { currentModeId: "ask", availableModes: ["ask", "accept-edits", "smart-approve", "auto-approve"].map((id) => ({ id, name: id })) };
const ask = (method, params, duplicate) => new Promise((resolve) => {
  const id = "agent-" + ++nextId;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
  // A transport-level resend of the same request id must not produce a second prompt.
  if (duplicate) send({ jsonrpc: "2.0", id, method, params });
});
process.stdin.on("end", () => { log({ event: "stdin-end" }); process.exit(0); });
const perform = (s) => {
  if (s.kind === "execute") {
    const r = cp.spawnSync("/bin/sh", ["-c", s.rawInput.command], { cwd: process.cwd(), encoding: "utf8" });
    return { ok: r.status === 0, text: JSON.stringify({ stdout: r.stdout, stderr: r.stderr, status: r.status }) };
  }
  const file = path.resolve(process.cwd(), s.rawInput.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s.rawInput.content);
  return { ok: true, text: "Wrote " + s.rawInput.path };
};
const step = async (s, i) => {
  const id = s.id || "call-" + i;
  update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: s.title, kind: s.kind, status: "pending", rawInput: s.rawInput, locations: s.rawInput.path ? [{ path: path.resolve(process.cwd(), s.rawInput.path) }] : [] });
  let allowed = true;
  if (s.ask) {
    const params = { sessionId, toolCall: { toolCallId: id }, options: OPTIONS };
    const response = await ask("session/request_permission", params, s.duplicate);
    log({ event: "permission", id, outcome: response.result && response.result.outcome });
    const outcome = response.result && response.result.outcome;
    allowed = outcome && outcome.outcome === "selected" && outcome.optionId.startsWith("allow");
  }
  const done = allowed ? perform(s) : { ok: false, text: "User rejected the tool call" };
  log({ event: "tool", id, ok: done.ok, text: done.text });
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: done.ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: done.text } }] });
};
const runTurn = async (id) => {
  if (scenario.mode === "hang") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "h1", title: "Write never.txt", kind: "edit", rawInput: { path: "never.txt", content: "" } });
    const response = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "h1" }, options: OPTIONS });
    log({ event: "permission", id: "h1", outcome: response.result && response.result.outcome });
    return;
  }
  if (scenario.mode === "exit-pending") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "x1", title: "Write never.txt", kind: "edit", rawInput: { path: "never.txt", content: "" } });
    send({ jsonrpc: "2.0", id: "agent-x", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "x1" }, options: OPTIONS } });
    setTimeout(() => process.exit(3), 100);
    return;
  }
  if (scenario.unsupported) {
    const response = await ask("fs/read_text_file", { sessionId, path: "x" });
    log({ event: "unsupported", error: response.error });
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning the game." } });
  if (scenario.mode === "concurrent") await Promise.all(scenario.steps.map(step));
  else for (const [i, s] of scenario.steps.entries()) await step(s, i);
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: scenario.final } });
  reply(id, { stopReason: "end_turn" });
};
onLine((message) => {
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    if (resolve) { waiting.delete(message.id); resolve(message); }
    else log({ event: "response", message });
    return;
  }
  log({ event: "call", method: message.method, params: message.params });
  if (message.method === "initialize") {
    // The real vibe-acp rejects initialize without clientInfo.version.
    const info = message.params.clientInfo;
    if (!info || typeof info.version !== "string")
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid params" } });
    return reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: scenario.loadSession !== false } });
  }
  if (message.method === "session/new") return reply(message.id, { sessionId, modes: MODES });
  if (message.method === "session/load") {
    if (scenario.loadFails)
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Session not found" } });
    sessionId = message.params.sessionId;
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } });
    return reply(message.id, { modes: MODES });
  }
  if (message.method === "session/set_mode") return reply(message.id, {});
  if (message.method === "session/prompt") { promptId = message.id; void runTurn(message.id); return; }
  if (message.method === "session/cancel") {
    if (promptId !== null) reply(promptId, { stopReason: "cancelled" });
    return;
  }
});
`;

const FAKE_HEADLESS_VIBE = `
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  log({ event: "headless", argv: process.argv.slice(2), prompt: Buffer.concat(chunks).toString() });
  process.stdout.write(JSON.stringify({ role: "assistant", content: "headless reply" }) + "\\n");
});
`;

let root: string;
let workspace: string;
let acp: FakeExecutable | null = null;
let headless: FakeExecutable | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ubume vibe acp "));
  workspace = join(root, "23-Ubume Minecraft tester", "4-Mistral");
  mkdirSync(workspace, { recursive: true });
});
afterEach(() => {
  acp?.cleanup();
  headless?.cleanup();
  acp = null;
  headless = null;
  rmSync(root, { recursive: true, force: true });
});

function vibeRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    prompt: "Build the Minecraft clone",
    workspaceRoot: workspace,
    runtime: { ...TEST_RUNTIME, mode: "auto-edit" },
    route: { providerId: "mistral", modelId: "Vibe default", backendKind: "mistral-vibe-cli-auth" },
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
  deltas: string[];
}

function runFake(
  scenario: unknown,
  decide: (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<ToolApprovalDecision>,
  request = vibeRequest(),
  onStart?: (cancel: () => void) => void,
): Promise<RunOutcome> {
  acp = createFakeExecutable("vibe-acp", FAKE_ACP, scenario);
  headless = createFakeExecutable("vibe", FAKE_HEADLESS_VIBE);
  const outcome: RunOutcome = { tools: [], progress: [], sessions: [], asked: [], deltas: [] };
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
      onAssistantDelta: (chunk) => outcome.deltas.push(chunk),
      onToolActivity: (tool) => outcome.tools.push(tool),
      onNativeSession: (session) => outcome.sessions.push(session),
      onToolApproval: (approval, signal) => {
        outcome.asked.push(approval);
        return decide(approval, signal);
      },
    };
    const cancel = runMistralVibe(request, handlers, {
      resolveExecutable: async () => headless!.path,
      env: { ...process.env, VIBE_ACP_EXECUTABLE: acp!.path },
    });
    onStart?.(() => {
      cancel();
      settle();
    });
  });
}

function logged(fake: FakeExecutable | null, event: string): Array<Record<string, unknown>> {
  return (fake!.readLog() as Array<Record<string, unknown>>).filter(
    (entry) => entry.event === event,
  );
}

test("Vibe's shell and file requests reach Ubume's approval prompt and run once approved", async () => {
  const decisions: ToolApprovalDecision[] = [
    "allow-once", // write index.html
    "allow-for-run", // mkdir && node
    // the identical second command is reused without asking
    "allow-once", // build || echo | cat
    "deny", // write secrets.txt
  ];
  const command = 'mkdir -p src && node -e "console.log(1+1)"';
  const outcome = await runFake(
    {
      final: "Game scaffolded.",
      steps: [
        {
          kind: "edit",
          title: "Write index.html",
          ask: true,
          rawInput: { path: "index.html", content: "<!doctype html>" },
        },
        { kind: "execute", title: "bash", ask: true, rawInput: { command } },
        { kind: "execute", title: "bash", ask: true, rawInput: { command } },
        {
          kind: "execute",
          title: "bash",
          ask: true,
          rawInput: { command: 'npm run build 2>/dev/null || echo "build && failed" | cat' },
        },
        {
          kind: "edit",
          title: "Write secrets.txt",
          ask: true,
          rawInput: { path: "secrets.txt", content: "x" },
        },
      ],
    },
    async () => decisions.shift() ?? "deny",
  );

  expect(outcome.error).toBeUndefined();
  expect(outcome.response).toBe("Game scaffolded.");
  expect(readFileSync(join(workspace, "index.html"), "utf8")).toBe("<!doctype html>");
  expect(existsSync(join(workspace, "src"))).toBe(true);
  expect(existsSync(join(workspace, "secrets.txt"))).toBe(false);

  // Four prompts: the repeated identical command was answered from the run-scoped cache.
  expect(outcome.asked).toHaveLength(4);
  expect(outcome.asked[0]).toMatchObject({
    provider: "Mistral Vibe",
    kind: "file",
    paths: ["index.html"],
    allowForRun: true,
  });
  expect(outcome.asked[1]).toMatchObject({ kind: "command", command });
  expect(outcome.asked[2]?.command).toBe(
    'npm run build 2>/dev/null || echo "build && failed" | cat',
  );

  const tools = logged(acp, "tool");
  expect(tools.map((tool) => tool.ok)).toEqual([true, true, true, true, false]);
  expect(String(tools[1]?.text)).toContain('"stdout":"2\\n"');
  // Never a persistent option.
  const outcomes = logged(acp, "permission").map((entry) => entry.outcome);
  expect(outcomes).toEqual([
    { outcome: "selected", optionId: "allow_once" },
    { outcome: "selected", optionId: "allow_once" },
    { outcome: "selected", optionId: "allow_once" },
    { outcome: "selected", optionId: "allow_once" },
    { outcome: "selected", optionId: "reject_once" },
  ]);

  const calls = logged(acp, "call").map((entry) => entry.method);
  expect(calls).toEqual(["initialize", "session/new", "session/set_mode", "session/prompt"]);
  expect(logged(acp, "call")[2]?.params).toMatchObject({ modeId: "accept-edits" });
  expect(logged(acp, "call")[3]?.params).toMatchObject({
    prompt: [{ type: "text", text: "Build the Minecraft clone" }],
  });
  expect(logged(acp, "stdin-end")).toHaveLength(1);
  expect(outcome.sessions.at(-1)).toMatchObject({ source: "vibe", sessionId: "acp-session" });
  expect(outcome.progress.some((text) => text.includes("through vibe-acp"))).toBe(true);
  expect(outcome.progress).toContain("Planning the game.");
  expect(outcome.tools.filter((tool) => tool.status === "failed")).toHaveLength(1);
});

test("concurrent and duplicate permission requests are answered one at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const outcome = await runFake(
    {
      mode: "concurrent",
      final: "done",
      steps: [
        {
          id: "a",
          kind: "execute",
          title: "bash",
          ask: true,
          duplicate: true,
          rawInput: { command: "echo a" },
        },
        { id: "b", kind: "execute", title: "bash", ask: true, rawInput: { command: "echo b" } },
      ],
    },
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return "allow-once";
    },
  );
  expect(outcome.response).toBe("done");
  expect(maxActive).toBe(1);
  expect(outcome.asked.map((request) => request.command)).toEqual(["echo a", "echo b"]);
});

test("cancelling while an approval is visible withdraws it and stops Vibe", async () => {
  let seenSignal: AbortSignal | undefined;
  const outcome = await runFake(
    { mode: "hang" },
    (_request, signal) => {
      seenSignal = signal;
      return new Promise(() => undefined);
    },
    vibeRequest(),
    (cancel) => {
      const timer = setInterval(() => {
        if (seenSignal) {
          clearInterval(timer);
          cancel();
        }
      }, 10);
    },
  );
  expect(seenSignal?.aborted).toBe(true);
  expect(outcome.response).toBeUndefined();
  expect(existsSync(join(workspace, "never.txt"))).toBe(false);
});

test("Vibe exiting while an approval is visible withdraws it and reports the failure", async () => {
  let seenSignal: AbortSignal | undefined;
  const outcome = await runFake({ mode: "exit-pending" }, (_request, signal) => {
    seenSignal = signal;
    return new Promise(() => undefined);
  });
  expect(seenSignal?.aborted).toBe(true);
  expect(outcome.error).toBe("Mistral Vibe exited before finishing the turn.");
  expect(logged(headless, "headless")).toHaveLength(0);
});

test("a vibe-acp startup failure falls back to headless Vibe once, before any prompt", async () => {
  const outcome = await runFake({ failInit: true }, async () => "allow-once");
  expect(outcome.response).toBe("headless reply");
  expect(outcome.progress.some((text) => text.includes("vibe-acp could not start"))).toBe(true);
  const runs = logged(headless, "headless");
  expect(runs).toHaveLength(1);
  expect(runs[0]?.argv).toContain("--agent");
  expect(outcome.asked).toHaveLength(0);
});

test("unsupported agent requests get a JSON-RPC method-not-found error", async () => {
  const outcome = await runFake({ unsupported: true, final: "ok", steps: [] }, async () => "deny");
  expect(outcome.response).toBe("ok");
  expect(logged(acp, "unsupported")[0]?.error).toMatchObject({ code: -32601 });
});

test("resuming loads the native session, hides its replayed history and sends only the new prompt", async () => {
  const history = [
    { role: "user" as const, content: "first" },
    { role: "assistant" as const, content: "ok" },
  ];
  const { createHash } = await import("node:crypto");
  const outcome = await runFake(
    { final: "continued", steps: [] },
    async () => "deny",
    vibeRequest({
      prompt: "next",
      conversationHistory: history,
      nativeSessions: [
        {
          source: "vibe",
          sessionId: "saved-session",
          modelId: "Vibe default",
          throughMessageCount: 2,
          transcriptHash: createHash("sha256").update(JSON.stringify(history)).digest("hex"),
        },
      ],
    }),
  );
  expect(outcome.response).toBe("continued");
  expect(outcome.deltas.join("")).not.toContain("OLD HISTORY");
  const calls = logged(acp, "call");
  expect(calls.map((entry) => entry.method)).toContain("session/load");
  expect(calls.find((entry) => entry.method === "session/prompt")?.params).toMatchObject({
    sessionId: "saved-session",
    prompt: [{ type: "text", text: "next" }],
  });
});

test("headless, plan and read-only runs stay on vibe -p", async () => {
  for (const request of [
    vibeRequest({ approvalSurface: undefined }),
    vibeRequest({ runIntent: "plan" }),
    vibeRequest({ runtime: { ...TEST_RUNTIME, mode: "suggest" } }),
  ]) {
    const outcome = await runFake({ final: "unused", steps: [] }, async () => "deny", request);
    expect(outcome.response).toBe("headless reply");
    expect(logged(acp, "argv")).toHaveLength(0);
    acp?.cleanup();
    headless?.cleanup();
  }
  acp = null;
  headless = null;
});

test("approval mapping never reuses decisions without input or outside the workspace", () => {
  const escaping = toVibeApprovalRequest(
    {
      toolCallId: "t1",
      kind: "edit",
      title: "Write",
      rawInput: { path: "../escape.txt", content: "x" },
      startedAt: 0,
    },
    workspace,
  );
  expect(escaping).toMatchObject({ outsideWorkspace: true, allowForRun: false, kind: "file" });
  const opaque = toVibeApprovalRequest(
    { toolCallId: "t2", title: "mcp tool", startedAt: 0 },
    workspace,
  );
  expect(opaque).toMatchObject({ allowForRun: false, kind: "tool", signature: "vibe:t2" });
  // Vibe's real shell title repeats the command; the prompt names the tool once.
  const shell = toVibeApprovalRequest(
    {
      toolCallId: "t3",
      kind: "execute",
      title: "bash: ls && node -e 1",
      rawInput: { command: "ls && node -e 1" },
      startedAt: 0,
    },
    workspace,
  );
  expect(shell).toMatchObject({ tool: "bash", command: "ls && node -e 1", kind: "command" });
  expect(shell.description).toBeUndefined();
  expect(vibePermissionOutcome([{ optionId: "allow_always", kind: "allow_always" }], true)).toEqual(
    { outcome: "cancelled" },
  );
});
