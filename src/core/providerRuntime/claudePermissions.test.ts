import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../providers/types.js";
import {
  claudeHelpSupportsHostApprovals,
  parseClaudePermissionModesFromHelp,
} from "./claudeCodeDiscovery.js";
import {
  CLAUDE_APPROVAL_UNAVAILABLE_MESSAGE,
  CLAUDE_USER_DENIED_MESSAGE,
  type ClaudeCanUseToolRequest,
  classifyClaudeToolDenial,
  createClaudeApprovalBridge,
  isOutsideWorkspace,
  parseClaudeControlMessage,
  resolveClaudePermissionMode,
  toToolApprovalRequest,
} from "./claudePermissions.js";

const root = mkdtempSync(join(tmpdir(), "ubume claude perms "));
const workspace = join(root, "2 Claude workspace");
const outside = join(root, "outside");
mkdirSync(workspace);
mkdirSync(outside);
symlinkSync(outside, join(workspace, "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HELP = `  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" (the SDK host or
                                        --permission-prompt-tool) or "none"
  --input-format <format>               Input format (only works with --print):
  -p, --print                           Print response and exit`;

function canUse(
  toolName: string,
  input: Record<string, unknown>,
  requestId = "req-1",
): ClaudeCanUseToolRequest {
  return { requestId, toolName, input };
}

function controlRecord(requestId: string, toolName: string, input: Record<string, unknown>) {
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input,
      tool_use_id: `tu-${requestId}`,
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Ubume modes map to Claude's native permission modes and never to bypass", () => {
  const expectMode = (
    mode: string,
    intent: "normal" | "plan" | "approved-execution" | undefined,
    expected: string,
  ) => expect(resolveClaudePermissionMode(mode, intent).mode as string).toBe(expected);
  expectMode("suggest", "normal", "dontAsk");
  // Ubume "Auto" uses Claude's native auto mode (its classifier still gates risky actions).
  expectMode("auto-edit", "normal", "auto");
  expectMode("auto-edit", "approved-execution", "auto");
  expectMode("full-auto", "normal", "auto");
  expectMode("full-auto", "plan", "plan");
  expectMode("auto-edit", "plan", "plan");
  expectMode("unknown", undefined, "default");
  for (const mode of ["suggest", "auto-edit", "full-auto", "anything"])
    for (const intent of ["normal", "plan", "approved-execution"] as const)
      expect(resolveClaudePermissionMode(mode, intent).mode).not.toBe("bypassPermissions");
});

test("an older CLI without the requested mode falls back without broadening and reports it", () => {
  expect(resolveClaudePermissionMode("full-auto", "normal", ["default", "plan"])).toEqual({
    mode: "default",
    requested: "auto",
  });
  expect(
    resolveClaudePermissionMode("auto-edit", "normal", ["acceptEdits", "default", "plan"]),
  ).toEqual({ mode: "acceptEdits", requested: "auto" });
  expect(resolveClaudePermissionMode("auto-edit", "normal", null).mode).toBe("auto");
});

test("Claude 2.1's choices (no `default`) fall back to manual, never to an invalid mode", () => {
  const choices = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
  expect(resolveClaudePermissionMode("unknown", "normal", choices)).toEqual({
    mode: "manual",
    requested: "default",
  });
  expect(resolveClaudePermissionMode("auto-edit", "normal", choices).mode).toBe("auto");
  expect(resolveClaudePermissionMode("suggest", "normal", choices).mode).toBe("dontAsk");
  expect(resolveClaudePermissionMode("full-auto", "plan", choices).mode).toBe("plan");
});

test("discovery parses the installed CLI's permission-mode choices and host-approval support", () => {
  expect(parseClaudePermissionModesFromHelp(HELP)).toEqual([
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "manual",
    "dontAsk",
    "plan",
  ]);
  expect(claudeHelpSupportsHostApprovals(HELP)).toBe(true);
  expect(claudeHelpSupportsHostApprovals("  -p, --print  Print response")).toBe(false);
  expect(parseClaudePermissionModesFromHelp("  -p, --print")).toBeNull();
});

test("control messages are recognized; ordinary stream records are not", () => {
  expect(parseClaudeControlMessage({ type: "assistant", message: {} })).toBeNull();
  expect(parseClaudeControlMessage(controlRecord("r", "Write", { file_path: "a" }))).toEqual({
    kind: "can-use-tool",
    request: { requestId: "r", toolName: "Write", input: { file_path: "a" }, toolUseId: "tu-r" },
  });
  expect(parseClaudeControlMessage({ type: "control_cancel_request", request_id: "r" })).toEqual({
    kind: "cancel",
    requestId: "r",
  });
  expect(
    parseClaudeControlMessage({
      type: "control_request",
      request_id: "x",
      request: { subtype: "mcp_message" },
    }),
  ).toEqual({ kind: "other-request", requestId: "x", subtype: "mcp_message" });
});

test("a Write into a workspace whose path contains spaces is shown as a file edit", () => {
  const approval = toToolApprovalRequest(
    canUse("Write", { file_path: join(workspace, "index.html"), content: "<html>" }),
    workspace,
  );
  expect(approval).toMatchObject({
    tool: "Write",
    kind: "file",
    provider: "Claude Code",
    workspace,
    paths: ["index.html"],
    allowForRun: true,
  });
  expect(approval.outsideWorkspace).toBeUndefined();
  expect(approval.command).toBeUndefined();
  const nested = toToolApprovalRequest(
    canUse("Write", { file_path: "src/game/world.ts", content: "" }),
    workspace,
  );
  expect(nested.paths).toEqual(["src/game/world.ts"]);
  expect(toToolApprovalRequest(canUse("Edit", { file_path: "a.ts" }), workspace).kind).toBe("file");
});

test("traversal and symlinks that leave the workspace are flagged and never session-cacheable", () => {
  for (const file_path of [
    "../outside/x.txt",
    join(outside, "x.txt"),
    "escape/x.txt",
    join(workspace, "escape", "new", "deep.txt"),
  ]) {
    const approval = toToolApprovalRequest(canUse("Write", { file_path }), workspace);
    expect(approval.outsideWorkspace).toBe(true);
    expect(approval.allowForRun).toBe(false);
  }
  expect(isOutsideWorkspace("./src/../index.html", workspace)).toBe(false);
  expect(isOutsideWorkspace(join(workspace, "not-yet", "made.txt"), workspace)).toBe(false);
});

test("compound and quoted shell commands are shown verbatim, never split or reinterpreted", () => {
  for (const command of [
    `cd "${workspace}" && pwd`,
    "npm run build || echo failed",
    "git status | head -5",
    'echo "a && b || c | d"',
  ]) {
    const approval = toToolApprovalRequest(
      canUse("Bash", { command, description: "Run it" }),
      workspace,
    );
    expect(approval.kind).toBe("command");
    expect(approval.command).toBe(command);
    expect(approval.description).toBe("Run it");
  }
  // Signatures are exact: a different command (even only quoting) never matches.
  const a = toToolApprovalRequest(canUse("Bash", { command: "echo a && b" }), workspace);
  const b = toToolApprovalRequest(canUse("Bash", { command: 'echo "a && b"' }), workspace);
  expect(a.signature).not.toBe(b.signature);
  // Key order does not affect the signature.
  expect(
    toToolApprovalRequest(canUse("Write", { file_path: "a", content: "x" }), workspace).signature,
  ).toBe(
    toToolApprovalRequest(canUse("Write", { content: "x", file_path: "a" }), workspace).signature,
  );
});

test("Claude's escalation reason is carried into the prompt", () => {
  const approval = toToolApprovalRequest(
    { ...canUse("Bash", { command: "rm -rf build" }), decisionReason: "Matched ask rule" },
    workspace,
  );
  expect(approval.reason).toBe("Matched ask rule");
});

function bridgeHarness(decide?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>) {
  const writes: Array<{
    subtype: string;
    request_id: string;
    response: Record<string, unknown>;
  }> = [];
  const asked: ToolApprovalRequest[] = [];
  const signals: AbortSignal[] = [];
  let open = 0;
  let maxOpen = 0;
  const waiting: boolean[] = [];
  const bridge = createClaudeApprovalBridge({
    workspaceRoot: workspace,
    write: (line) => {
      writes.push(JSON.parse(line).response);
      return true;
    },
    onAwaitingUser: (value) => waiting.push(value),
    ...(decide
      ? {
          onToolApproval: async (request, signal) => {
            asked.push(request);
            if (signal) signals.push(signal);
            open++;
            maxOpen = Math.max(maxOpen, open);
            try {
              return await decide(request);
            } finally {
              open--;
            }
          },
        }
      : {}),
  });
  return { bridge, writes, asked, signals, waiting, maxOpen: () => maxOpen };
}

test("allow-once answers with the original input and deny returns the user's denial", async () => {
  const decisions: ToolApprovalDecision[] = ["allow-once", "deny"];
  const h = bridgeHarness(async () => decisions.shift()!);
  const input = { file_path: join(workspace, "index.html"), content: "<html>" };
  h.bridge.handle(controlRecord("a", "Write", input));
  h.bridge.handle(controlRecord("b", "Write", input));
  await tick();
  await tick();
  expect(h.writes).toEqual([
    {
      subtype: "success",
      request_id: "a",
      response: { behavior: "allow", updatedInput: input },
    },
    {
      subtype: "success",
      request_id: "b",
      response: { behavior: "deny", message: CLAUDE_USER_DENIED_MESSAGE },
    },
  ]);
  expect(h.waiting).toEqual([true, false, true, false]);
});

test("allow-for-run reuses only the identical action; a different command asks again", async () => {
  const h = bridgeHarness(async () => "allow-for-run");
  h.bridge.handle(controlRecord("1", "Bash", { command: "npm run build && npm test" }));
  await tick();
  h.bridge.handle(controlRecord("2", "Bash", { command: "npm run build && npm test" }));
  await tick();
  h.bridge.handle(controlRecord("3", "Bash", { command: "npm run build && rm -rf /" }));
  await tick();
  expect(h.asked.map((request) => request.command)).toEqual([
    "npm run build && npm test",
    "npm run build && rm -rf /",
  ]);
  expect(h.writes.map((write) => write.response.behavior)).toEqual(["allow", "allow", "allow"]);
});

test("allow-for-run on an outside-workspace path is not remembered", async () => {
  const h = bridgeHarness(async () => "allow-for-run");
  const input = { file_path: join(outside, "x.txt"), content: "" };
  h.bridge.handle(controlRecord("1", "Write", input));
  await tick();
  h.bridge.handle(controlRecord("2", "Write", input));
  await tick();
  expect(h.asked).toHaveLength(2);
});

test("concurrent requests are asked one at a time, in order; duplicates are ignored", async () => {
  const pending: Array<(decision: ToolApprovalDecision) => void> = [];
  const h = bridgeHarness(
    (_request) => new Promise<ToolApprovalDecision>((resolve) => pending.push(resolve)),
  );
  h.bridge.handle(controlRecord("1", "Write", { file_path: "a.txt" }));
  h.bridge.handle(controlRecord("1", "Write", { file_path: "a.txt" }));
  h.bridge.handle(controlRecord("2", "Bash", { command: "ls && pwd" }));
  await tick();
  expect(h.asked).toHaveLength(1);
  expect(h.bridge.pending).toBe(2);
  pending.shift()!("allow-once");
  await tick();
  await tick();
  expect(h.asked.map((request) => request.tool)).toEqual(["Write", "Bash"]);
  pending.shift()!("deny");
  await tick();
  expect(h.writes.map((write) => [write.request_id, write.response.behavior])).toEqual([
    ["1", "allow"],
    ["2", "deny"],
  ]);
  expect(h.maxOpen()).toBe(1);
  expect(h.bridge.pending).toBe(0);
});

test("dispose withdraws the visible prompt and writes nothing to a closed process", async () => {
  const h = bridgeHarness(() => new Promise<ToolApprovalDecision>(() => undefined));
  h.bridge.handle(controlRecord("1", "Write", { file_path: "a.txt" }));
  h.bridge.handle(controlRecord("2", "Write", { file_path: "b.txt" }));
  await tick();
  h.bridge.dispose();
  await tick();
  expect(h.signals[0]?.aborted).toBe(true);
  expect(h.asked).toHaveLength(1);
  expect(h.writes).toEqual([]);
  expect(h.bridge.pending).toBe(0);
  expect(h.waiting.at(-1)).toBe(false);
  // Late records after disposal are swallowed, not answered.
  expect(h.bridge.handle(controlRecord("3", "Write", { file_path: "c.txt" }))).toBe(true);
  expect(h.writes).toEqual([]);
});

test("a provider cancel withdraws the matching request without answering it", async () => {
  const pending: Array<(decision: ToolApprovalDecision) => void> = [];
  const h = bridgeHarness(() => new Promise((resolve) => pending.push(resolve)));
  h.bridge.handle(controlRecord("1", "Bash", { command: "sleep 100" }));
  h.bridge.handle(controlRecord("2", "Bash", { command: "echo queued" }));
  await tick();
  h.bridge.handle({ type: "control_cancel_request", request_id: "1" });
  await tick();
  expect(h.signals[0]?.aborted).toBe(true);
  expect(h.asked.map((request) => request.command)).toEqual(["sleep 100", "echo queued"]);
  pending[1]!("allow-once");
  await tick();
  expect(h.writes.map((write) => write.request_id)).toEqual(["2"]);
});

test("without an approval handler every escalation is denied with an accurate reason", async () => {
  const h = bridgeHarness();
  h.bridge.handle(controlRecord("1", "Write", { file_path: "a.txt" }));
  await tick();
  expect(h.writes[0]?.response).toEqual({
    behavior: "deny",
    message: CLAUDE_APPROVAL_UNAVAILABLE_MESSAGE,
  });
});

test("unsupported control requests get an error response instead of hanging Claude", () => {
  const h = bridgeHarness(async () => "allow-once");
  h.bridge.handle({
    type: "control_request",
    request_id: "m",
    request: { subtype: "mcp_message" },
  });
  expect(h.writes[0]).toMatchObject({ subtype: "error", request_id: "m" });
});

test("permission outcomes are labeled apart from ordinary tool failures", () => {
  expect(classifyClaudeToolDenial(CLAUDE_USER_DENIED_MESSAGE)).toBe("Denied by you in Ubume");
  expect(
    classifyClaudeToolDenial(
      "no approval surface in this session; permission request denied automatically",
    ),
  ).toBe("Denied: no approval prompt available in this run");
  expect(
    classifyClaudeToolDenial("Permission to use Bash with command rm -rf / has been denied."),
  ).toBe("Blocked by Claude's permission policy");
  expect(classifyClaudeToolDenial("Exit code 1\nnpm ERR! missing script: build")).toBeNull();
  expect(classifyClaudeToolDenial("EACCES: permission denied, open '/etc/passwd'")).toBeNull();
});

test("unknown decisions and malformed shell requests cannot produce a Claude allow response", async () => {
  const writes: Record<string, unknown>[] = [];
  const bridge = createClaudeApprovalBridge({
    workspaceRoot: workspace,
    onToolApproval: async () => "unknown" as ToolApprovalDecision,
    write: (line) => {
      writes.push(JSON.parse(line).response.response);
      return true;
    },
  });
  for (const [id, input] of [
    ["unknown", { command: "printf test" }],
    ["malformed", { command: 42 }],
  ] as const) {
    bridge.handle({
      type: "control_request",
      request_id: id,
      request: { subtype: "can_use_tool", tool_name: "Bash", input },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes.map((response) => response.behavior)).toEqual(["deny", "deny"]);
  bridge.dispose();
});
