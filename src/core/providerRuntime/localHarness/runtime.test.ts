import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { waitFor } from "../../../test/async.js";
import type { BackendRunHandlers } from "../../providers/types.js";
import { localRuntime } from "../local.js";
import { getProviderRuntime } from "../registry.js";
import type { ProviderChatRequest } from "../types.js";
import {
  buildLocalHarnessPromptContentBlocks,
  LocalHarnessProcess,
  type LocalHarnessRunner,
  localHarnessTestUtils,
  resetLocalHarnessProcessForTests,
} from "./runtime.js";

function request(modelId: string): ProviderChatRequest {
  return {
    prompt: "inspect the workspace",
    route: { providerId: "local", modelId, backendKind: "local-openai-compatible" },
    workspaceRoot: process.cwd(),
    runtime: {
      policy: {
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        writableRoots: [],
      },
    } as unknown as ProviderChatRequest["runtime"],
    localConfig: {
      enabled: true,
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "test-key",
      models: {
        [modelId]: {
          contextLength: 32_768,
          maxOutputTokens: 4_096,
          supportsStreaming: true,
          supportsToolCalls: true,
        },
      },
    },
  };
}

function runRuntime(
  req: ProviderChatRequest,
  handlers: Partial<BackendRunHandlers> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    localRuntime.run!(req, {
      onResponse: resolve,
      onError: (message) => reject(new Error(message)),
      ...handlers,
    });
  });
}

afterEach(() => resetLocalHarnessProcessForTests());

describe("Local Harness provider routing", () => {
  test("converts prompt images into Harness content blocks", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ubume-harness-image-"));
    const imagePath = join(tempDir, "clipboard.png");
    // 8-bit RGBA with no ancillary chunks, so the Harness stores it unchanged
    // instead of re-encoding it during normalization.
    writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    try {
      const blocks = await buildLocalHarnessPromptContentBlocks(tempDir, "describe this", [
        {
          path: imagePath,
          mediaType: "image/png",
          name: "clipboard.png",
          bytes: 70,
        },
      ]);
      assert.deepEqual(blocks[0], { type: "text", text: "describe this" });
      assert.equal(blocks[1]?.type, "image");
      if (blocks[1]?.type === "image") {
        assert.equal(blocks[1].attachment.mediaType, "image/png");
        assert.ok(blocks[1].attachment.attachmentId.length > 0);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("uses a stable salted fingerprint for credential change detection", () => {
    const first = localHarnessTestUtils.secretFingerprint("test-api-key");
    const repeated = localHarnessTestUtils.secretFingerprint("test-api-key");
    const changed = localHarnessTestUtils.secretFingerprint("different-api-key");

    assert.equal(first, repeated);
    assert.notEqual(first, changed);
    assert.equal(first.includes("test-api-key"), false);
    assert.match(first, /^[a-f0-9]{64}$/);
  });

  for (const model of [
    "Qwen3-Coder",
    "Ornith-32B",
    "Llama-4",
    "Gemma-3",
    "DeepSeek-R1",
    "GLM-5",
    "arbitrary-compatible-model",
  ]) {
    test(`${model} uses the generic Local Harness path`, async () => {
      const observed: ProviderChatRequest[] = [];
      const fake: LocalHarnessRunner = {
        run: async (req) => {
          observed.push(req);
          return "done";
        },
        shutdown: async () => undefined,
        terminate: () => undefined,
      };
      resetLocalHarnessProcessForTests(fake);
      assert.equal(await runRuntime(request(model)), "done");
      assert.deepEqual(
        observed.map((item) => item.route.providerId),
        ["local"],
      );
      assert.equal(observed[0]?.route.modelId, model);
    });
  }

  test("model name is not the routing decision", () => {
    assert.equal(getProviderRuntime("local"), localRuntime);
    assert.notEqual(getProviderRuntime("openai"), localRuntime);
    assert.notEqual(getProviderRuntime("anthropic"), localRuntime);
    assert.notEqual(getProviderRuntime("google"), localRuntime);
    assert.notEqual(getProviderRuntime("mistral"), localRuntime);
    assert.notEqual(getProviderRuntime("codexa-native"), localRuntime);
  });

  test("Local endpoint, model, and generation limits feed the generic Harness profile", () => {
    const resolved = localHarnessTestUtils.resolveHarnessConfig(request("Ornith-32B"));
    assert.deepEqual(resolved, {
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "test-key",
      model: "Ornith-32B",
      contextWindow: 32_768,
      maxTokens: 4_096,
      supportsVision: false,
      reasoningEffort: null,
    });
    const patch = localHarnessTestUtils.profilePatch(false);
    assert.match(patch, /ubume-local:/);
    assert.match(patch, /api: openai-completions/);
    assert.match(patch, /model: !!js process\.env\.UBUME_DSH_MODEL/);
    assert.match(patch, /id: llm-deepseek\n  disabled: true/);
    assert.match(patch, /defaultPreset: !!js process\.env\.UBUME_DSH_PERMISSION_PRESET/);
    assert.match(
      patch,
      /danger-full-access:\n        sandbox: danger-full-access\n        approval: never/,
    );
    assert.match(patch, /session scratch directory under \.ubume\/scratch\//);
    assert.match(patch, /\n        streamIdleTimeoutMs: 300000\n/);
    assert.match(
      patch,
      /\n        retryPolicy:\n          mode: normal\n          retryableCodes: \[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TRANSPORT\]\n/,
    );
    assert.doesNotMatch(patch, /retryableCodes: \[[^\]]*TIMEOUT/);
  });

  test("writable sessions get a scratch folder note without creating files; plan mode does not", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ubume-harness-scratch-"));
    try {
      const writable = { ...request("Qwen"), workspaceRoot };
      const note = localHarnessTestUtils.prepareSessionScratch(writable, "session-1", false);
      assert.match(note ?? "", /\.ubume\/scratch\/session-1\//);
      assert.equal(existsSync(join(workspaceRoot, ".ubume")), false);

      const planning = { ...writable, runIntent: "plan" } as ProviderChatRequest;
      assert.equal(localHarnessTestUtils.prepareSessionScratch(planning, "session-2", false), null);
      assert.equal(existsSync(join(workspaceRoot, ".ubume", "scratch", "session-2")), false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("Ubume permission modes map to the official Harness sandbox schema", () => {
    const req = request("Ornith-32B");
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "workspace-write");
    req.runtime.policy.sandboxMode = "read-only";
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "read-only");
    req.runtime.policy.sandboxMode = "danger-full-access";
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "danger-full-access");
    (req.runtime.policy as { sandboxMode: string }).sandboxMode = "full-access";
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "danger-full-access");
    req.runIntent = "plan";
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "read-only");
  });

  test("approved plan execution runs with a writable sandbox once plan mode is off", () => {
    const req = request("Ornith-32B");
    req.runIntent = "approved-execution";
    req.runtime.planMode = false;
    assert.equal(localHarnessTestUtils.resolveHarnessSandboxMode(req), "workspace-write");
  });

  test("an explicitly tool-incompatible Local model fails before Harness startup", async () => {
    const req = request("plain-chat-model");
    req.localConfig!.models!["plain-chat-model"]!.supportsToolCalls = false;
    await assert.rejects(
      new LocalHarnessProcess().run(
        req,
        { onResponse: () => undefined, onError: () => undefined },
        new AbortController().signal,
      ),
      /without tool\/function-calling support/,
    );
  });

  test("Unsloth cannot silently fall back to the LM Studio default endpoint", async () => {
    const req = request("Ornith-32B");
    req.route.localBackend = "unsloth";
    req.localConfig = { currentModel: "Ornith-32B", localBackend: "unsloth" };
    await assert.rejects(
      new LocalHarnessProcess().run(
        req,
        { onResponse: () => undefined, onError: () => undefined },
        new AbortController().signal,
      ),
      /selected Unsloth connection was not resolved/,
    );
  });

  test("Harness consumes the ephemeral resolved Local connection", () => {
    const req = request("Ornith-32B");
    req.route.localBackend = "unsloth";
    req.resolvedLocalAgentConfig = {
      localBackend: "unsloth",
      baseUrl: "http://127.0.0.1:8888/v1",
      apiKey: "ephemeral-key",
      modelId: "Ornith-32B",
      contextWindow: 128_000,
      maxTokens: 8_192,
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsVision: false,
    };
    assert.deepEqual(localHarnessTestUtils.resolveHarnessConfig(req), {
      baseUrl: "http://127.0.0.1:8888/v1",
      apiKey: "ephemeral-key",
      model: "Ornith-32B",
      contextWindow: 128_000,
      maxTokens: 8_192,
      supportsVision: false,
      reasoningEffort: null,
    });
  });

  test("Harness startup failure is isolated and actionable", async () => {
    const previous = process.env.UBUME_NODE_PATH;
    process.env.UBUME_NODE_PATH = "/definitely/missing/ubume-node";
    const runner = new LocalHarnessProcess();
    try {
      await assert.rejects(
        runner.run(
          request("Qwen"),
          { onResponse: () => undefined, onError: () => undefined },
          new AbortController().signal,
        ),
        /Local Harness startup failed[\s\S]*Qwen[\s\S]*127\.0\.0\.1:8080/,
      );
    } finally {
      runner.terminate();
      if (previous === undefined) delete process.env.UBUME_NODE_PATH;
      else process.env.UBUME_NODE_PATH = previous;
    }
  });

  for (const phase of ["initialize", "session/open"]) {
    test(`canceling stalled ${phase} tears down the child and allows a fresh run`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "ubume-harness-cancel-"));
      const stub = join(dir, "bridge.js");
      const previous = process.env.UBUME_NODE_PATH;
      writeFileSync(
        stub,
        `#!/usr/bin/env node
const readline = require("node:readline");
readline.createInterface({input:process.stdin}).on("line", line => {
 const m = JSON.parse(line);
 if (m.method === ${JSON.stringify(phase)}) return;
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{}})+"\\n");
 if (m.method === "shutdown") process.exit(0);
});
`,
      );
      chmodSync(stub, 0o755);
      process.env.UBUME_NODE_PATH = stub;
      const runner = new LocalHarnessProcess();
      const controller = new AbortController();
      try {
        const work = runner.run(
          { ...request("fixture"), workspaceRoot: dir },
          { onResponse() {}, onError() {} },
          controller.signal,
        );
        setTimeout(() => controller.abort(), 150);
        await assert.rejects(work, /cancel|abort/i);
        assert.equal((runner as unknown as { child: unknown }).child, null);
      } finally {
        await runner.shutdown();
        if (previous === undefined) delete process.env.UBUME_NODE_PATH;
        else process.env.UBUME_NODE_PATH = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("session/open disconnect includes redacted stderr and starts no prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubume-harness-disconnect-"));
    const stub = join(dir, "bridge.js");
    const previous = process.env.UBUME_NODE_PATH;
    writeFileSync(
      stub,
      `#!/usr/bin/env node
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
 const m = JSON.parse(line);
 if (m.method === "initialize") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{}})+"\\n");
 else { process.stderr.write("backend crashed test-key"); process.exit(7); }
});
`,
    );
    chmodSync(stub, 0o755);
    process.env.UBUME_NODE_PATH = stub;
    const runner = new LocalHarnessProcess();
    try {
      await assert.rejects(
        runner.run(
          { ...request("fixture"), workspaceRoot: dir },
          { onResponse() {}, onError() {} },
          new AbortController().signal,
        ),
        (error: Error) => {
          assert.match(error.message, /session\/open failed/);
          assert.match(error.message, /backend crashed/);
          assert.match(error.message, /\[redacted\]/);
          assert.doesNotMatch(error.message, /test-key/);
          return true;
        },
      );
    } finally {
      await runner.shutdown();
      if (previous === undefined) delete process.env.UBUME_NODE_PATH;
      else process.env.UBUME_NODE_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fingerprint change restarts the Harness without the old child clobbering the new one", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "ubume-harness-stub-"));
    const stubPath = join(stubDir, "stub-bridge.js");
    // Stands in for the spawned dsh process: replies to `initialize` late enough
    // that the previous generation's exit always lands inside the new
    // generation's startup window, like the real bridge's post-`shutdown` exit.
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env node",
        'let buffer = "";',
        'process.stdin.on("data", (chunk) => {',
        "  buffer += String(chunk);",
        "  let index;",
        '  while ((index = buffer.indexOf("\\n")) !== -1) {',
        "    const line = buffer.slice(0, index).trim();",
        "    buffer = buffer.slice(index + 1);",
        "    if (!line) continue;",
        "    let message;",
        "    try { message = JSON.parse(line); } catch { continue; }",
        "    if (message.id === undefined || message.method === undefined) continue;",
        '    const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\\n`);',
        '    if (message.method === "initialize") setTimeout(() => reply({ ok: true }), 500);',
        '    else if (message.method === "shutdown") { reply({ ok: true }); setTimeout(() => process.exit(0), 300); }',
        "    else reply({});",
        "  }",
        "});",
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);
    const previous = process.env.UBUME_NODE_PATH;
    process.env.UBUME_NODE_PATH = stubPath;
    const runner = new LocalHarnessProcess();
    const internals = runner as unknown as {
      ensureStarted(
        req: ProviderChatRequest,
        config: unknown,
        fingerprint: string,
        handlers: BackendRunHandlers,
      ): Promise<void>;
    };
    const handlers: BackendRunHandlers = { onResponse: () => undefined, onError: () => undefined };
    const req = request("Qwen");
    const config = localHarnessTestUtils.resolveHarnessConfig(req);
    try {
      await internals.ensureStarted(req, config, "fp-a", handlers);
      await internals.ensureStarted(req, config, "fp-b", handlers);
    } finally {
      await runner.shutdown();
      if (previous === undefined) delete process.env.UBUME_NODE_PATH;
      else process.env.UBUME_NODE_PATH = previous;
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test("forced lifecycle cleanup terminates an owned Harness child", () => {
    const runner = new LocalHarnessProcess();
    let killedWith: string | null = null;
    (runner as unknown as { child: unknown }).child = {
      exitCode: null,
      signalCode: null,
      kill: (signal: string) => {
        killedWith = signal;
      },
    };
    runner.terminate();
    assert.equal(killedWith, "SIGTERM");
  });

  test("1 GiB RSS guard stops the turn, invalidates its session, and releases the child", () => {
    const runner = new LocalHarnessProcess();
    const errors: Error[] = [];
    const sessionChanges: Array<{ sessionId: string; present: boolean }> = [];
    let killedWith: string | null = null;
    const child = {
      exitCode: null,
      signalCode: null,
      kill: (signal: string) => {
        killedWith = signal;
      },
    };
    const internals = runner as unknown as {
      child: unknown;
      active: unknown;
      transport: unknown;
      checkMemory(child: unknown, rssBytes: number): void;
    };
    internals.child = child;
    internals.transport = { close: () => undefined, request: async () => ({}) };
    internals.active = {
      sessionId: "session-1",
      settled: false,
      handlers: {
        onLocalHarnessSession: (session: unknown, sessionId: string) =>
          sessionChanges.push({ sessionId, present: session !== null }),
      },
      abortCleanup: () => undefined,
      reject: (error: Error) => errors.push(error),
    };
    internals.checkMemory(child, 1024 * 1024 * 1024 - 1);
    assert.equal(errors.length, 0);
    internals.checkMemory(child, 1024 * 1024 * 1024);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /1 GiB process RAM/);
    assert.deepEqual(sessionChanges, [{ sessionId: "session-1", present: false }]);
    assert.equal(killedWith, "SIGTERM");
    assert.equal(internals.child, null);
  });

  test("cancellation aborts the active Harness request", async () => {
    const observed: { signal?: AbortSignal } = {};
    const fake: LocalHarnessRunner = {
      run: (_req, _handlers, signal) => {
        observed.signal = signal;
        return new Promise(() => undefined);
      },
      shutdown: async () => undefined,
      terminate: () => undefined,
    };
    resetLocalHarnessProcessForTests(fake);
    const stop = localRuntime.run!(request("Qwen"), {
      onResponse: () => undefined,
      onError: () => undefined,
    });
    // The runtime module loads lazily on the first Local run; cancel once the request is active.
    await waitFor(() => observed.signal !== undefined, { label: "Harness request started" });
    stop();
    assert.equal(observed.signal?.aborted, true);
  });

  test("a run cancelled before the Harness starts never reaches the Harness", async () => {
    let started = false;
    resetLocalHarnessProcessForTests({
      run: () => {
        started = true;
        return new Promise(() => undefined);
      },
      shutdown: async () => undefined,
      terminate: () => undefined,
    });
    const outcomes: string[] = [];
    const stop = localRuntime.run!(request("Qwen"), {
      onResponse: () => outcomes.push("response"),
      onError: () => outcomes.push("error"),
    });
    stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(started, false);
    assert.deepEqual(outcomes, []);
  });
});

describe("Harness event projection and policy", () => {
  function activeProcess(overrides: Partial<BackendRunHandlers> = {}) {
    const process = new LocalHarnessProcess();
    const deltas: string[] = [];
    const progress: string[] = [];
    const progressIds: string[] = [];
    const tools: Array<{ id: string; status: string; command: string }> = [];
    const usage: number[] = [];
    const handlers: BackendRunHandlers = {
      onResponse: () => undefined,
      onError: () => undefined,
      onAssistantDelta: (chunk) => deltas.push(chunk),
      onProgress: (event) => {
        progress.push(event.text);
        progressIds.push(event.id);
      },
      onToolActivity: (event) =>
        tools.push({ id: event.id, status: event.status, command: event.command }),
      onContextUsage: (event) => usage.push(event.contextTokens),
      ...overrides,
    };
    (process as unknown as { active: unknown }).active = {
      sessionId: "session-1",
      handlers,
      request: request("Qwen"),
      text: "",
      runningSeen: true,
      settled: false,
      toolArguments: new Map(),
      reasoningText: new Map(),
      approvals: new Set(),
      continuationCount: 0,
      windowStartTextLength: 0,
      windowStartToolEventCount: 0,
      toolEventCount: 0,
      reasoningEventCount: 0,
      windowStartReasoningEventCount: 0,
      consecutiveNoProgressWindows: 0,
      cancelled: false,
      resolve: () => undefined,
      reject: () => undefined,
      abortCleanup: () => undefined,
    };
    return { process, deltas, progress, progressIds, tools, usage };
  }

  function notifier(fixture: ReturnType<typeof activeProcess>) {
    return (
      fixture.process as unknown as { onNotification(method: string, params: unknown): void }
    ).onNotification.bind(fixture.process);
  }

  function attachTransport(fixture: ReturnType<typeof activeProcess>) {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    (fixture.process as unknown as { transport: unknown }).transport = {
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        return method === "session/flush" ? { durable: true } : {};
      },
      close: () => undefined,
    };
    return requests;
  }

  function reasoningOnlyTurn(notify: ReturnType<typeof notifier>, outputTokens: number) {
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/chunk",
        data: { chunk: { type: "reasoning-delta", index: 0, text: "We have a massive request…" } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 2,
        type: "assistant/chunk",
        data: { chunk: { type: "usage", usage: { inputTokens: 8_570, outputTokens } } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 3,
        type: "assistant/chunk",
        data: {
          chunk: {
            type: "finish",
            reason: { kind: "max-tokens" },
            replayState: { response: { stopReason: "length" } },
          },
        },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 4,
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [{ type: "reasoning", text: "We have a massive request…" }],
          },
        },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 5, type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } },
    });
  }

  test("reasoning-only output exhaustion is continued and stops after two no-progress windows", () => {
    const errors: Error[] = [];
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { reject: (error: Error) => void } }).active.reject = (
      error,
    ) => errors.push(error);
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);

    reasoningOnlyTurn(notify, 4_096);
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(errors.length, 0, "the first exhaustion must not fail the run");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "session/prompt");
    assert.match(JSON.stringify(requests[0]?.params.contentBlocks), /ran out of output budget/i);
    assert.ok(fixture.progress.some((text) => /continuing automatically/i.test(text)));

    // The retry exhausts the budget again: fail with a self-diagnosing message.
    notify("session.status", { sessionId: "session-1", status: "running" });
    reasoningOnlyTurn(notify, 4_096);
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(requests.length, 1, "the stalled second window must not enqueue another prompt");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /two output windows made no visible progress/i);
    assert.match(errors[0]!.message, /max_output_tokens/);
  });

  test("a turn that produces reasoning but no answer without hitting the cap reports that distinctly", () => {
    const errors: Error[] = [];
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { reject: (error: Error) => void } }).active.reject = (
      error,
    ) => errors.push(error);
    attachTransport(fixture);
    const notify = notifier(fixture);

    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/chunk",
        data: { chunk: { type: "reasoning-delta", index: 0, text: "hmm" } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 2,
        type: "assistant/chunk",
        data: { chunk: { type: "finish", reason: { kind: "stop" } } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /reasoning .* no answer|produced reasoning only/i);
    assert.doesNotMatch(errors[0]!.message, /output budget/);
  });

  test("a failed compaction is reported as a failure and does not mark the context compacted", () => {
    const compacted: boolean[] = [];
    const fixture = activeProcess({
      onContextUsage: (event) => compacted.push(event.compacted === true),
    });
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/chunk",
        data: { chunk: { type: "usage", usage: { inputTokens: 50_000, outputTokens: 3_000 } } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 2, type: "compaction/start" },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 3,
        type: "compaction/end",
        data: { error: "pi-ai stream idle timeout after 300000ms" },
      },
    });

    assert.deepEqual(compacted, [false]);
    assert.equal(fixture.progressIds.at(-1), "local-harness-compaction");
    assert.match(
      fixture.progress.at(-1)!,
      /could not compact.*pi-ai stream idle timeout after 300000ms.*continuing with the full context/i,
    );
  });

  test("a successful compaction marks the context compacted", () => {
    const compacted: boolean[] = [];
    const fixture = activeProcess({
      onContextUsage: (event) => compacted.push(event.compacted === true),
    });
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/chunk",
        data: { chunk: { type: "usage", usage: { inputTokens: 50_000, outputTokens: 3_000 } } },
      },
    });
    notify("session.event", { sessionId: "session-1", event: { seq: 2, type: "compaction/end" } });

    assert.deepEqual(compacted, [false, true]);
    assert.equal(fixture.progress.at(-1), "Local Harness compacted the conversation context.");
  });

  test("Harness model retries are visible as progress", () => {
    const fixture = activeProcess();
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "llm/retry",
        data: {
          retry: 2,
          maxRetries: 5,
          delayMs: 989,
          failure: { message: "503 Service Unavailable", code: "SERVER" },
        },
      },
    });

    assert.deepEqual(fixture.progressIds, ["local-harness-retry"]);
    assert.match(fixture.progress[0]!, /503 Service Unavailable.*retrying 2\/5/i);
  });

  test("a stream idle timeout explains a stalled Local server instead of blaming tool support", () => {
    const errors: Error[] = [];
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { reject: (error: Error) => void } }).active.reject = (
      error,
    ) => errors.push(error);
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "turn/end",
        data: {
          turn: 1,
          reason: {
            kind: "error",
            error: { message: "pi-ai stream idle timeout after 300000ms", code: "TIMEOUT" },
          },
        },
      },
    });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(errors.length, 1);
    assert.match(
      errors[0]!.message,
      /^Local agent request failed: pi-ai stream idle timeout after 300000ms/,
    );
    assert.match(errors[0]!.message, /Model: Qwen/);
    assert.match(errors[0]!.message, /no output for 5 minutes/i);
    assert.match(errors[0]!.message, /RAM/);
    assert.match(errors[0]!.message, /--cache-ram/);
    assert.doesNotMatch(errors[0]!.message, /chat template/i);
  });

  test("non-timeout model errors keep the streaming and tool-calling hint", () => {
    const errors: Error[] = [];
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { reject: (error: Error) => void } }).active.reject = (
      error,
    ) => errors.push(error);
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "turn/end",
        data: {
          turn: 1,
          reason: { kind: "error", error: { message: "400: bad request", code: "BAD_REQUEST" } },
        },
      },
    });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /chat template/i);
    assert.doesNotMatch(errors[0]!.message, /--cache-ram/);
  });

  test("assistant/message output_text parts populate the final text", () => {
    const fixture = activeProcess();
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "thinking" },
              { type: "output_text", text: "the answer" },
            ],
          },
        },
      },
    });
    assert.deepEqual(fixture.deltas, ["the answer"]);
  });

  test("turn/end records non-error stop reasons", () => {
    const fixture = activeProcess();
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 1, type: "turn/end", data: { turn: 1, reason: { kind: "aborted" } } },
    });
    assert.equal(
      (fixture.process as unknown as { active: { stopReason?: string } }).active.stopReason,
      "aborted",
    );
  });

  test("a truncated non-empty answer continues without completing the logical run", () => {
    const resolved: string[] = [];
    const fixture = activeProcess();
    (fixture.process as unknown as { active: { resolve: (text: string) => void } }).active.resolve =
      (text) => resolved.push(text);
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/chunk",
        data: { chunk: { type: "text-delta", text: "partial answer" } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 2,
        type: "assistant/chunk",
        data: { chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 4_096 } } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } },
    });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.deepEqual(resolved, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "session/prompt");
    assert.match(
      JSON.stringify(requests[0]?.params.contentBlocks),
      /exactly where the previous response stopped/i,
    );
    assert.ok(fixture.progressIds.includes("local-harness-output-recovery"));
    assert.ok(fixture.progress.some((text) => /window 2/i.test(text)));
    assert.ok(fixture.progress.every((text) => !/response truncated/i.test(text)));
  });

  test("tool activity is productive rollover progress and stays in the same run", () => {
    const fixture = activeProcess();
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);

    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "tool/call",
        data: { callId: "call-1", name: "bash", arguments: '{"command":"git status"}' },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 2,
        type: "tool/result",
        data: {
          message: { source: { callId: "call-1" }, content: [{ type: "text", text: "clean" }] },
        },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 3, type: "turn/end", data: { reason: { kind: "max-tokens" } } },
    });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.params.sessionId, "session-1");
    assert.deepEqual(
      fixture.tools.map((event) => event.status),
      ["running", "completed"],
    );
    assert.equal(
      (fixture.process as unknown as { active: { consecutiveNoProgressWindows: number } }).active
        .consecutiveNoProgressWindows,
      0,
    );
  });

  test("a cancelled rollover cannot enqueue another prompt or finalize", () => {
    const resolved: string[] = [];
    const observedFinalAnswers: string[] = [];
    const fixture = activeProcess({
      onFinalAnswerObserved: (text) => observedFinalAnswers.push(text),
    });
    const active = (
      fixture.process as unknown as {
        active: { cancelled: boolean; resolve: (text: string) => void };
      }
    ).active;
    active.cancelled = true;
    active.resolve = (text) => resolved.push(text);
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);

    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/chunk",
        data: { chunk: { type: "text-delta", text: "partial" } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 2, type: "turn/end", data: { reason: { kind: "max-tokens" } } },
    });
    (fixture.process as unknown as { failActive(error: Error): void }).failActive(
      new DOMException("Local request cancelled.", "AbortError"),
    );
    notify("session.status", { sessionId: "session-1", status: "idle" });

    assert.equal(requests.length, 0);
    assert.deepEqual(resolved, []);
    assert.deepEqual(observedFinalAnswers, []);
  });

  test("completion waits for durable persistence before publishing a continuation watermark", async () => {
    const answers: string[] = [];
    const watermarks: number[] = [];
    const fixture = activeProcess({
      onLocalHarnessSession: (metadata) => {
        if (metadata) watermarks.push(metadata.throughMessageCount);
      },
    });
    (fixture.process as unknown as { active: { resolve: (text: string) => void } }).active.resolve =
      (text) => answers.push(text);
    let flush!: (value: { durable: boolean }) => void;
    (fixture.process as unknown as { transport: unknown }).transport = {
      request: async (method: string) => {
        assert.equal(method, "session/flush");
        return await new Promise((resolve) => {
          flush = resolve;
        });
      },
      close: () => undefined,
    };
    const notify = notifier(fixture);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/chunk",
        data: { chunk: { type: "text-delta", text: "saved reply" } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 2, type: "turn/end", data: { reason: { kind: "completed" } } },
    });
    notify("session.status", { sessionId: "session-1", status: "idle" });
    assert.deepEqual(answers, []);
    assert.deepEqual(watermarks, []);
    flush({ durable: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(answers, ["saved reply"]);
    assert.deepEqual(watermarks, [2]);
  });

  test("multiple productive output windows accumulate into one final response", async () => {
    const resolved: string[] = [];
    const observedFinalAnswers: string[] = [];
    const finalMetadata: Array<{ throughMessageCount: number; transcriptHash: string }> = [];
    const fixture = activeProcess({
      onFinalAnswerObserved: (text) => observedFinalAnswers.push(text),
      onLocalHarnessSession: (metadata) => {
        if (metadata) finalMetadata.push(metadata);
      },
    });
    const active = (fixture.process as unknown as { active: { resolve: (text: string) => void } })
      .active;
    active.resolve = (text) => resolved.push(text);
    const requests = attachTransport(fixture);
    const notify = notifier(fixture);

    for (const [index, text] of ["part one ", "part two "].entries()) {
      notify("session.status", { sessionId: "session-1", status: "running" });
      notify("session.event", {
        sessionId: "session-1",
        event: {
          seq: index * 3 + 1,
          type: "assistant/chunk",
          data: { chunk: { type: "text-delta", text } },
        },
      });
      notify("session.event", {
        sessionId: "session-1",
        event: {
          seq: index * 3 + 2,
          type: "assistant/chunk",
          data: { chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 4_096 } } },
        },
      });
      notify("session.event", {
        sessionId: "session-1",
        event: { seq: index * 3 + 3, type: "turn/end", data: { reason: { kind: "max-tokens" } } },
      });
      notify("session.status", { sessionId: "session-1", status: "idle" });
    }

    notify("session.status", { sessionId: "session-1", status: "running" });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 7,
        type: "assistant/message",
        data: { message: { role: "assistant", content: [{ type: "output_text", text: "done" }] } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: { seq: 8, type: "turn/end", data: { reason: { kind: "completed" } } },
    });
    notify("session.status", { sessionId: "session-1", status: "idle" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests.filter((entry) => entry.method === "session/prompt").length, 2);
    assert.equal(requests.filter((entry) => entry.method === "session/flush").length, 1);
    assert.deepEqual(fixture.deltas, ["part one ", "part two ", "done"]);
    assert.deepEqual(resolved, ["part one part two done"]);
    assert.deepEqual(observedFinalAnswers, ["part one part two done"]);
    assert.equal(finalMetadata.length, 1);
    assert.equal(finalMetadata[0]?.throughMessageCount, 2);
    assert.match(finalMetadata[0]?.transcriptHash ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(
      fixture.progress.filter((text) => /continuing automatically/i.test(text)),
      [
        "Output window reached; continuing automatically (window 2).",
        "Output window reached; continuing automatically (window 3).",
      ],
    );
  });

  test("reasoning effort reaches the Harness profile only when the model opts in", () => {
    const plain = localHarnessTestUtils.profilePatch(false, false);
    assert.doesNotMatch(plain, /reasoningEfforts/);
    assert.doesNotMatch(plain, /thinkingFormat/);

    const effort = localHarnessTestUtils.profilePatch(false, true);
    assert.match(effort, /reasoningEfforts:\n\s+low: low\n\s+medium: medium\n\s+high: high/);
    assert.match(effort, /thinkingFormat: openai/);
    assert.match(effort, /reasoning: !!js process\.env\.UBUME_DSH_REASONING_EFFORT/);

    const req = request("gpt-oss-20b");
    req.localConfig!.models!["gpt-oss-20b"]!.supportsReasoningEffort = true;
    (req.runtime as unknown as { reasoningLevel: string }).reasoningLevel = "low";
    const low = localHarnessTestUtils.resolveHarnessConfig(req);
    assert.equal(low.reasoningEffort, "low");
    (req.runtime as unknown as { reasoningLevel: string }).reasoningLevel = "high";
    const high = localHarnessTestUtils.resolveHarnessConfig(req);
    assert.equal(high.reasoningEffort, "high");
    assert.notEqual(
      localHarnessTestUtils.routeFingerprint(low, req),
      localHarnessTestUtils.routeFingerprint(high, req),
    );

    const optedOut = request("qwen");
    (optedOut.runtime as unknown as { reasoningLevel: string }).reasoningLevel = "high";
    assert.equal(localHarnessTestUtils.resolveHarnessConfig(optedOut).reasoningEffort, null);
  });

  test("the default output budget follows the context window when no cap is configured", () => {
    const req = request("big-context");
    delete req.localConfig!.models!["big-context"]!.maxOutputTokens;
    req.localConfig!.models!["big-context"]!.contextLength = 131_072;
    assert.equal(localHarnessTestUtils.resolveHarnessConfig(req).maxTokens, 32_768);
  });

  test("streams assistant, reasoning, usage, and tool events without replaying final text", () => {
    const fixture = activeProcess();
    const notify = (
      fixture.process as unknown as { onNotification(method: string, params: unknown): void }
    ).onNotification.bind(fixture.process);
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 1,
        type: "assistant/chunk",
        data: { step: 1, chunk: { type: "reasoning-delta", index: 0, text: "think" } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 2,
        type: "assistant/chunk",
        data: { step: 1, chunk: { type: "reasoning-delta", index: 0, text: "ing" } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 3,
        type: "assistant/chunk",
        data: { chunk: { type: "text-delta", text: "hello" } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 4,
        type: "assistant/chunk",
        data: { chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 5,
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text: "hello" }] } },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 5,
        type: "tool/call",
        data: { callId: "call-1", name: "bash", arguments: '{"command":"git status"}' },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 6,
        type: "tool/result",
        data: {
          message: { source: { callId: "call-1" }, content: [{ type: "text", text: "clean" }] },
        },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 7,
        type: "tool/call",
        data: { callId: "call-2", name: "edit", arguments: '{"path":"src/app.tsx"}' },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        seq: 8,
        type: "tool/result",
        data: {
          message: { source: { callId: "call-2" }, content: [{ type: "text", text: "edited" }] },
        },
      },
    });
    assert.deepEqual(fixture.deltas, ["hello"]);
    assert.deepEqual(fixture.progress, ["think", "thinking"]);
    assert.deepEqual(fixture.progressIds, [
      "local-reasoning-session-1-1-0",
      "local-reasoning-session-1-1-0",
    ]);
    assert.deepEqual(fixture.usage, [12]);
    assert.deepEqual(
      fixture.tools.map((item) => item.status),
      ["running", "completed", "running", "completed"],
    );
    assert.equal(fixture.tools[0]?.command, "git status");
  });

  test("long reasoning display and completed tool arguments stay bounded", () => {
    const fixture = activeProcess();
    const notify = notifier(fixture);
    for (let index = 0; index < 12; index += 1) {
      notify("session.event", {
        sessionId: "session-1",
        event: {
          type: "assistant/chunk",
          data: { step: 1, chunk: { type: "reasoning-delta", index: 0, text: "x".repeat(8_000) } },
        },
      });
    }
    const display = fixture.progress.at(-1)!;
    assert.match(display, /Earlier reasoning omitted/);
    assert.ok(display.length < 33_000);
    assert.equal((display.match(/Earlier reasoning omitted/g) ?? []).length, 1);

    notify("session.event", {
      sessionId: "session-1",
      event: {
        type: "tool/call",
        data: { callId: "call-1", name: "bash", arguments: '{"command":"git status"}' },
      },
    });
    notify("session.event", {
      sessionId: "session-1",
      event: {
        type: "tool/result",
        data: {
          message: { source: { callId: "call-1" }, content: [{ type: "text", text: "clean" }] },
        },
      },
    });
    const active = (
      fixture.process as unknown as { active: { toolArguments: Map<string, unknown> } }
    ).active;
    assert.equal(active.toolArguments.has("call-1"), false);
  });

  test("browser permissions bind one action to its approved target and reject altered calls", async () => {
    let decision: "allow-once" | "deny" = "deny";
    let identity = "original-target";
    let executions = 0;
    const fixture = activeProcess({
      onToolApproval: async (approval) => {
        assert.equal(approval.allowForRun, false);
        assert.doesNotMatch(approval.description ?? "", /secret-value/);
        return decision;
      },
    });
    const internals = fixture.process as unknown as {
      browser: unknown;
      active: { request: ProviderChatRequest };
      onBridgeRequest(method: string, params: Record<string, unknown>): Promise<any>;
    };
    internals.browser = {
      approvalState: async () => ({ identity, description: "Email field" }),
      execute: async () => {
        executions++;
        return { ok: true, value: { summary: "done" } };
      },
    };
    const bridge = internals.onBridgeRequest.bind(fixture.process);
    const call = {
      sessionId: "session-1",
      callId: "browser-1",
      tool: "browser_type",
      arguments: { element: "e1", text: "secret-value" },
    };
    assert.equal((await bridge("tool/policy", call)).kind, "ask");
    assert.equal((await bridge("approval/request", call)).outcome, "rejected");
    assert.equal((await bridge("browser/execute", call)).error.code, "BROWSER_PERMISSION_DENIED");
    decision = "allow-once";
    await bridge("tool/policy", call);
    await bridge("approval/request", call);
    assert.equal(
      (await bridge("browser/execute", { ...call, arguments: { element: "e1", text: "altered" } }))
        .error.code,
      "BROWSER_PERMISSION_DENIED",
    );
    await bridge("tool/policy", call);
    await bridge("approval/request", call);
    identity = "replaced-target";
    assert.equal((await bridge("browser/execute", call)).error.code, "BROWSER_PERMISSION_DENIED");
    await bridge("tool/policy", call);
    await bridge("approval/request", call);
    assert.equal((await bridge("browser/execute", call)).ok, true);
    assert.equal((await bridge("browser/execute", call)).error.code, "BROWSER_PERMISSION_DENIED");
    assert.equal(executions, 1);
    internals.active.request.runtime.policy.sandboxMode = "read-only";
    assert.equal((await bridge("tool/policy", call)).kind, "deny");
    assert.equal(
      (await bridge("tool/policy", { ...call, tool: "browser_inspect", arguments: {} })).kind,
      "allow",
    );
    internals.active.request.runtime.policy.sandboxMode = "workspace-write";
    internals.active.request.runtime.policy.approvalPolicy = "never";
    assert.equal((await bridge("tool/policy", call)).kind, "allow");
    assert.equal((await bridge("browser/execute", call)).ok, true);
    assert.equal(executions, 2);
    assert.equal((await bridge("tool/policy", { ...call, arguments: { text: 42 } })).kind, "deny");
  });

  test("approved plan execution asks for mutating tools instead of denying them", async () => {
    const fixture = activeProcess();
    (
      fixture.process as unknown as { active: { request: { runIntent: string } } }
    ).active.request.runIntent = "approved-execution";
    const bridge = (
      fixture.process as unknown as {
        onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
      }
    ).onBridgeRequest.bind(fixture.process);
    assert.deepEqual(
      await bridge("tool/policy", {
        sessionId: "session-1",
        callId: "1",
        tool: "edit",
        arguments: { path: "src/app.tsx" },
      }),
      { kind: "ask", reason: "Allow edit src/app.tsx?" },
    );
  });

  test("mutating tools use Ubume approval and dangerous commands fail closed", async () => {
    const fixture = activeProcess({ onToolApproval: async () => "allow-once" });
    const bridge = (
      fixture.process as unknown as {
        onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
      }
    ).onBridgeRequest.bind(fixture.process);
    assert.deepEqual(
      await bridge("tool/policy", {
        sessionId: "session-1",
        callId: "1",
        tool: "bash",
        arguments: { command: "git status" },
      }),
      { kind: "ask", reason: "Allow git status?" },
    );
    assert.deepEqual(
      await bridge("approval/request", { sessionId: "session-1", callId: "1", tool: "bash" }),
      { outcome: "allowed-once" },
    );
    assert.deepEqual(
      await bridge("tool/policy", {
        sessionId: "session-1",
        callId: "2",
        tool: "bash",
        arguments: { command: "rm -rf ." },
      }),
      { kind: "deny", reason: "Shell command blocked as dangerous." },
    );
    assert.deepEqual(
      await bridge("tool/policy", {
        sessionId: "session-1",
        callId: "3",
        tool: "bash",
        arguments: { command: "gh pr create --fill" },
      }),
      { kind: "ask", reason: "Allow gh pr create --fill?" },
    );
  });

  test("unknown or mismatched Local call IDs cannot request approval", async () => {
    let asked = 0;
    const fixture = activeProcess({
      onToolApproval: async () => {
        asked++;
        return "allow-once";
      },
    });
    const bridge = (
      fixture.process as unknown as {
        onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
      }
    ).onBridgeRequest.bind(fixture.process);
    assert.deepEqual(
      await bridge("approval/request", { sessionId: "session-1", callId: "missing", tool: "bash" }),
      { outcome: "rejected" },
    );
    await bridge("tool/policy", {
      sessionId: "session-1",
      callId: "known",
      tool: "bash",
      arguments: { command: "printf test" },
    });
    assert.deepEqual(
      await bridge("approval/request", { sessionId: "session-1", callId: "known", tool: "write" }),
      { outcome: "rejected" },
    );
    assert.equal(asked, 0);
  });

  test("a cancelled Local tool request cannot later receive an approval", async () => {
    let approve!: (value: "allow-once") => void;
    const fixture = activeProcess({
      onToolApproval: () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    });
    const internals = fixture.process as unknown as {
      active: { settled: boolean };
      onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    await internals.onBridgeRequest("tool/policy", {
      sessionId: "session-1",
      callId: "known",
      tool: "bash",
      arguments: { command: "printf test" },
    });
    const pending = internals.onBridgeRequest("approval/request", {
      sessionId: "session-1",
      callId: "known",
      tool: "bash",
    });
    internals.active.settled = true;
    approve("allow-once");
    assert.deepEqual(await pending, { outcome: "cancelled" });
  });

  test("session scratch paths pass the workspace guard", async () => {
    const fixture = activeProcess();
    const bridge = (
      fixture.process as unknown as {
        onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
      }
    ).onBridgeRequest.bind(fixture.process);
    assert.deepEqual(
      await bridge("tool/policy", {
        sessionId: "session-1",
        callId: "1",
        tool: "write",
        arguments: { path: ".ubume/scratch/session-1/_probe.html" },
      }),
      { kind: "ask", reason: "Allow write .ubume/scratch/session-1/_probe.html?" },
    );
    assert.deepEqual(
      await bridge("tool/policy", {
        sessionId: "session-1",
        callId: "2",
        tool: "bash",
        arguments: { command: "node .ubume/scratch/session-1/_cdp.js" },
      }),
      { kind: "ask", reason: "Allow node .ubume/scratch/session-1/_cdp.js?" },
    );
  });

  test("the scratch folder is created only when a tool targets it", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ubume-harness-scratch-policy-"));
    try {
      const fixture = activeProcess();
      const active = (fixture.process as unknown as { active: { request: ProviderChatRequest } })
        .active;
      active.request = { ...active.request, workspaceRoot };
      const bridge = (
        fixture.process as unknown as {
          onBridgeRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
        }
      ).onBridgeRequest.bind(fixture.process);

      await bridge("tool/policy", {
        sessionId: "session-1",
        callId: "1",
        tool: "write",
        arguments: { path: "index.html" },
      });
      assert.equal(existsSync(join(workspaceRoot, ".ubume")), false);

      await bridge("tool/policy", {
        sessionId: "session-1",
        callId: "2",
        tool: "write",
        arguments: { path: ".ubume/scratch/session-1/_probe.html" },
      });
      assert.ok(existsSync(join(workspaceRoot, ".ubume", "scratch", "session-1")));
      assert.ok(existsSync(join(workspaceRoot, ".ubume", "scratch", ".gitignore")));
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
