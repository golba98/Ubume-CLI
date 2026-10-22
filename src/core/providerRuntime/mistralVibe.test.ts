import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import { resolveVibeExecutable } from "../executables/executableResolver.js";
import type { CommandResult, CommandSpec } from "../process/commandRunner.js";
import type { ProviderConfig } from "../providerLauncher/types.js";
import { parseMistralModels } from "./mistralDiscovery.js";
import {
  createVibeStreamParser,
  detectVibeActiveModel,
  discoverMistralVibeModels,
  findLatestVibeSession,
  launchMistralVibeCli,
  listVibeConfiguredModels,
  MISTRAL_VIBE_AUTH_MESSAGE,
  MISTRAL_VIBE_MISSING_MESSAGE,
  mergeMistralVibeModels,
  runMistralVibe,
  validateMistralVibeRoute,
  vibeAgentFor,
} from "./mistralVibe.js";
import type { ProviderChatRequest } from "./types.js";

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    userMessage: "Command completed.",
    ...overrides,
  };
}

function buildRequest(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  const modelId = "mistral-medium-3.5";
  return {
    prompt: "Reply with hello.",
    route: {
      providerId: "mistral",
      modelId: "mistral-medium-3.5",
      backendKind: "mistral-vibe-cli-auth",
    },
    runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})),
    workspaceRoot: "/workspace/project",
    modelDescriptor: {
      id: modelId,
      modelId,
      label: "Mistral Medium 3.5",
      description: "Vibe test fixture",
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
      source: "config",
      mistralExecutionClass: "native-vibe",
      executionVerified: false,
      raw: { name: "mistral-vibe-cli-latest", alias: modelId, provider: "mistral" },
    },
    ...overrides,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeProvider(): ProviderConfig {
  return {
    id: "mistral",
    displayName: "Mistral Vibe CLI",
    currentModel: "mistral-medium-3.5",
    backendType: "mistral-vibe-cli-auth",
    routeMode: "launch-only",
    enabled: true,
    statusLabel: "Launch only",
    launchCommand: { executable: "vibe", args: [] },
    isDefault: false,
    isActiveRoute: false,
    routeUnavailableReason: "Native interactive session.",
  };
}

test("resolveVibeExecutable uses the exact command -v vibe probe", async () => {
  let observedCommand = "";
  const executable = await resolveVibeExecutable({
    cwd: "/workspace",
    platform: "linux",
    runShellCommandImpl: ((command: string) => {
      observedCommand = command;
      return {
        result: Promise.resolve({
          status: "completed" as const,
          exitCode: 0,
          stdout: "/home/test/.local/bin/vibe\n",
        }),
      };
    }) as any,
  });

  assert.equal(observedCommand, "command -v vibe");
  assert.equal(executable, "/home/test/.local/bin/vibe");
});

test("resolveVibeExecutable returns null when command -v cannot find vibe", async () => {
  const executable = await resolveVibeExecutable({
    platform: "linux",
    runShellCommandImpl: (() => ({
      result: Promise.resolve({ status: "failed" as const, exitCode: 1, stdout: "" }),
    })) as any,
  });

  assert.equal(executable, null);
});

test("detectVibeActiveModel follows environment, project, and user config precedence", () => {
  const root = join(tmpdir(), `ubume-vibe-model-${Date.now()}`);
  const workspace = join(root, "workspace", "nested");
  const home = join(root, "home");
  mkdirSync(join(root, "workspace", ".vibe"), { recursive: true });
  mkdirSync(join(home, ".vibe"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, ".vibe", "config.toml"), 'active_model = "user-model"\n');
  writeFileSync(
    join(root, "workspace", ".vibe", "config.toml"),
    'active_model = "project-model"\n',
  );

  try {
    assert.deepEqual(detectVibeActiveModel({ cwd: workspace, homeDirectory: home, env: {} }), {
      modelId: "project-model",
      source: "project-config",
      configPath: join(root, "workspace", ".vibe", "config.toml"),
    });
    assert.equal(
      detectVibeActiveModel({
        cwd: workspace,
        homeDirectory: home,
        env: { VIBE_ACTIVE_MODEL: "env-model" },
      }).modelId,
      "env-model",
    );
    rmSync(join(root, "workspace", ".vibe"), { recursive: true, force: true });
    assert.equal(
      detectVibeActiveModel({ cwd: workspace, homeDirectory: home, env: {} }).modelId,
      "user-model",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectVibeActiveModel falls back safely when configuration is malformed", () => {
  const root = join(tmpdir(), `ubume-vibe-invalid-${Date.now()}`);
  const home = join(root, "home");
  mkdirSync(join(home, ".vibe"), { recursive: true });
  writeFileSync(join(home, ".vibe", "config.toml"), "active_model = [\n");

  try {
    assert.deepEqual(detectVibeActiveModel({ cwd: root, homeDirectory: home, env: {} }), {
      modelId: "Vibe default",
      source: "default",
      configPath: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured Vibe models prefer the project config, deduplicate aliases, and keep the active model first", () => {
  const root = join(tmpdir(), `ubume-vibe-models-${Date.now()}`);
  const workspace = join(root, "workspace", "nested");
  const home = join(root, "home");
  mkdirSync(join(root, "workspace", ".vibe"), { recursive: true });
  mkdirSync(join(home, ".vibe"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(root, "workspace", ".vibe", "config.toml"),
    [
      'active_model = "project-model"',
      "[[models]]",
      'name = "project/model"',
      'alias = "project-model"',
      'provider = "mistral"',
      "[[models]]",
      'name = "shared/project"',
      'alias = "shared"',
    ].join("\n"),
  );
  writeFileSync(
    join(home, ".vibe", "config.toml"),
    [
      "[[models]]",
      'name = "shared/user"',
      'alias = "shared"',
      "[[models]]",
      'name = "user/model"',
      'alias = "user-model"',
    ].join("\n"),
  );

  try {
    const listed = listVibeConfiguredModels({ cwd: workspace, homeDirectory: home, env: {} });
    assert.deepEqual(
      listed.models.map((model) => model.modelId),
      ["project-model", "shared", "user-model"],
    );
    assert.equal(listed.models[0]?.description, "project/model via mistral");

    const previousHome = process.env.HOME;
    const previousVibeHome = process.env.VIBE_HOME;
    try {
      process.env.HOME = home;
      process.env.VIBE_HOME = join(home, ".vibe");
      const discovery = discoverMistralVibeModels(workspace);
      assert.deepEqual(
        discovery.models.map((model) => model.modelId),
        ["project-model", "Vibe default", "shared", "user-model"],
      );
      assert.equal(discovery.diagnostics?.selectedModel, "project-model");
      assert.equal(discovery.models[1]?.label, "Vibe current/default");
      assert.equal(discovery.models[0]?.mistralExecutionClass, "native-vibe");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousVibeHome === undefined) delete process.env.VIBE_HOME;
      else process.env.VIBE_HOME = previousVibeHome;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Vibe environment model config is parsed as a list and local providers stay classified", () => {
  const listed = listVibeConfiguredModels({
    cwd: "/tmp/no-vibe-project",
    homeDirectory: "/tmp/no-vibe-home",
    env: {
      VIBE_HOME: "/tmp/no-vibe-home/.vibe",
      VIBE_MODELS: JSON.stringify([
        { name: "custom-endpoint-model", alias: "custom", provider: "mistral" },
        { name: "devstral", alias: "local", provider: "llamacpp" },
      ]),
    },
  });
  assert.deepEqual(
    listed.models.map((model) => model.modelId),
    ["custom", "local"],
  );
  assert.equal(listed.models[0]?.mistralExecutionClass, "native-vibe");
  assert.equal(listed.models[1]?.mistralExecutionClass, "local-vibe");
});

test("Mistral aliases collapse to one route while preserving configured aliases", () => {
  const apiModels = parseMistralModels({
    data: [
      {
        id: "mistral-large-4",
        aliases: ["mistral-large-4-0"],
        capabilities: { completion_chat: true, reasoning: true },
      },
      {
        id: "mistral-large-4-0",
        aliases: ["mistral-large-4"],
        capabilities: { completion_chat: true, reasoning: true },
      },
    ],
  });
  const custom = mergeMistralVibeModels([], apiModels);
  assert.equal(custom.length, 1);
  assert.equal(custom[0]?.modelId, "mistral-large-4");
  assert.equal(custom[0]?.mistralExecutionClass, "custom-vibe");
  assert.ok((custom[0]?.raw as { aliases?: string[] }).aliases?.includes("mistral-large-4-0"));

  const configured = mergeMistralVibeModels(
    [
      {
        id: "mistral-large-4-0",
        modelId: "mistral-large-4-0",
        label: "Mistral Large 4 hosted alias",
        description: null,
        defaultReasoningLevel: null,
        supportedReasoningLevels: null,
        source: "config",
        mistralExecutionClass: "native-vibe",
        executionVerified: false,
        raw: {
          name: "mistral-large-4",
          alias: "mistral-large-4-0",
          provider: "mistral",
          displayName: "Mistral Large 4 hosted alias",
        },
      },
    ],
    apiModels,
  );
  assert.equal(configured.length, 1);
  assert.equal(configured[0]?.modelId, "mistral-large-4-0");
  assert.equal(configured[0]?.mistralExecutionClass, "native-vibe");
  assert.ok(
    (configured[0]?.raw as { variantIds?: string[] }).variantIds?.includes("mistral-large-4"),
  );
});

test("native Vibe models survive absent API metadata and match request names rather than colliding selectors", () => {
  const configured = listVibeConfiguredModels({
    cwd: "/tmp/no-vibe-project",
    homeDirectory: "/tmp/no-vibe-home",
    env: {
      VIBE_HOME: "/tmp/no-vibe-home/.vibe",
      VIBE_MODELS: JSON.stringify([
        {
          name: "native-request",
          alias: "friendly-selector",
          provider: "mistral",
          temperature: 0.7,
        },
      ]),
    },
  }).models;
  assert.equal(mergeMistralVibeModels(configured, [])[0]?.mistralExecutionClass, "native-vibe");
  const merged = mergeMistralVibeModels(
    configured,
    parseMistralModels({
      data: [
        {
          id: "native-request",
          aliases: ["native-version"],
          capabilities: { completion_chat: true, reasoning: true },
        },
        { id: "friendly-selector", capabilities: { completion_chat: true, reasoning: false } },
      ],
    }),
  );
  assert.equal(merged[0]?.modelId, "friendly-selector");
  assert.equal(merged[0]?.canonicalId, "native-request");
  assert.equal(merged[0]?.capabilities?.reasoning, true);
  assert.equal(merged[0]?.source, "config");
  assert.deepEqual(
    (merged[0]?.raw as { vibeConfig: { configuration: unknown } }).vibeConfig.configuration,
    { name: "native-request", alias: "friendly-selector", provider: "mistral", temperature: 0.7 },
  );
});

test("stream parser emits reasoning, assistant text, and tool lifecycle without duplicating trailing text", () => {
  const deltas: string[] = [];
  const progress: string[] = [];
  const tools: Array<{ id: string; status: string; summary?: string | null }> = [];
  const parser = createVibeStreamParser({
    onResponse: () => undefined,
    onError: () => undefined,
    onAssistantDelta: (chunk) => deltas.push(chunk),
    onProgress: (update) => progress.push(update.text),
    onToolActivity: (activity) =>
      tools.push({ id: activity.id, status: activity.status, summary: activity.summary }),
  });

  const assistant = JSON.stringify({
    role: "assistant",
    reasoning_content: "Check the workspace",
    content: [{ text: "First answer" }],
    tool_calls: [
      { id: "tool-1", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
    ],
  });
  const tool = JSON.stringify({ role: "tool", tool_call_id: "tool-1", content: "Read complete" });
  parser.push(`${assistant.slice(0, 20)}`);
  parser.push(`${assistant.slice(20)}\n${tool}\nFirst answer`);
  parser.flush();

  assert.deepEqual(deltas, ["First answer"]);
  assert.deepEqual(progress, ["Check the workspace"]);
  assert.deepEqual(
    tools.map(({ id, status }) => ({ id, status })),
    [
      { id: "tool-1", status: "running" },
      { id: "tool-1", status: "completed" },
    ],
  );
  assert.equal(tools[1]?.summary, "Read complete");
  assert.equal(parser.finalText(), "First answer");
});

test("stream parser falls back to plain text when no assistant JSON is present", () => {
  const parser = createVibeStreamParser({ onResponse: () => undefined, onError: () => undefined });
  parser.push("plain response without newline");
  parser.flush();
  assert.equal(parser.assistantText(), "");
  assert.equal(parser.finalText(), "plain response without newline");
});

test("stream parser suppresses replayed history until the resumed turn's user prompt", () => {
  const deltas: string[] = [];
  const progress: string[] = [];
  const parser = createVibeStreamParser(
    {
      onResponse: () => undefined,
      onError: () => undefined,
      onAssistantDelta: (chunk) => deltas.push(chunk),
      onProgress: (update) => progress.push(update.text),
    },
    { startAfterUserPrompt: "current prompt" },
  );

  for (const message of [
    { role: "user", content: "prior prompt" },
    { role: "assistant", reasoning_content: "prior reasoning", content: "prior answer" },
    { role: "user", content: "current prompt" },
    { role: "assistant", reasoning_content: "current reasoning", content: "current answer" },
  ]) {
    parser.push(`${JSON.stringify(message)}\n`);
  }
  parser.push("current answer\n");

  assert.deepEqual(deltas, ["current answer"]);
  assert.deepEqual(progress, ["current reasoning"]);
  assert.equal(parser.finalText(), "current answer");
});

test("launchMistralVibeCli launches the resolved executable with no arguments", async () => {
  const child = new EventEmitter();
  let observedExecutable = "";
  let observedArgs: string[] = [];
  let observedCwd = "";
  let observedStdio: unknown;
  const spawnImpl = ((
    executable: string,
    args: string[],
    options: { cwd?: string; stdio?: unknown },
  ) => {
    observedExecutable = executable;
    observedArgs = args;
    observedCwd = options.cwd ?? "";
    observedStdio = options.stdio;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof import("child_process").spawn;

  const result = await launchMistralVibeCli(makeProvider(), {
    cwd: "/workspace/project",
    resolveExecutable: async () => "/home/test/.local/bin/vibe",
    commandExists: () => true,
    spawnImpl,
  });

  assert.equal(result.status, "completed");
  assert.equal(observedExecutable, "/home/test/.local/bin/vibe");
  assert.deepEqual(observedArgs, []);
  assert.equal(observedCwd, "/workspace/project");
  assert.equal(observedStdio, "inherit");
});

test("launchMistralVibeCli reports the install and authentication requirement", async () => {
  let didSpawn = false;
  const result = await launchMistralVibeCli(makeProvider(), {
    cwd: "/workspace",
    resolveExecutable: async () => null,
    spawnImpl: (() => {
      didSpawn = true;
      return new EventEmitter();
    }) as unknown as typeof import("child_process").spawn,
  });

  assert.equal(result.status, "missing-command");
  assert.equal(result.message, MISTRAL_VIBE_MISSING_MESSAGE);
  assert.equal(didSpawn, false);
});

test("launchMistralVibeCli restores terminal state after SIGINT termination", async () => {
  const child = new EventEmitter();
  const events: string[] = [];
  const result = await launchMistralVibeCli(makeProvider(), {
    cwd: "/workspace",
    resolveExecutable: async () => "/home/test/.local/bin/vibe",
    commandExists: () => true,
    stdin: {
      isRaw: true,
      setRawMode(enabled) {
        events.push(enabled ? "raw-on" : "raw-off");
      },
    },
    beforeLaunch: () => events.push("before"),
    afterLaunch: () => events.push("after"),
    spawnImpl: (() => {
      events.push("spawn");
      queueMicrotask(() => child.emit("close", null, "SIGINT"));
      return child;
    }) as unknown as typeof import("child_process").spawn,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.signal, "SIGINT");
  assert.deepEqual(events, ["before", "raw-off", "spawn", "raw-on", "after"]);
});

test("findLatestVibeSession refuses ambiguous concurrent workspace sessions", async () => {
  const root = join(tmpdir(), `ubume-vibe-sessions-${Date.now()}`);
  const sessionRoot = join(root, ".vibe", "logs", "session");
  const workspaceRoot = join(root, "workspace");
  const startedAt = Date.now();
  const writeSession = (directory: string, sessionId: string, startTime: number, cwd: string) => {
    mkdirSync(join(sessionRoot, directory), { recursive: true });
    writeFileSync(
      join(sessionRoot, directory, "meta.json"),
      JSON.stringify({
        session_id: sessionId,
        start_time: new Date(startTime).toISOString(),
        environment: { working_directory: cwd },
      }),
    );
  };
  writeSession("session_old", "old", startedAt - 20_000, workspaceRoot);
  writeSession("session_other", "other", startedAt + 1_000, join(root, "other"));
  writeSession("session_first", "first", startedAt + 1_000, workspaceRoot);
  writeSession("session_latest", "latest", startedAt + 2_000, workspaceRoot);

  try {
    assert.equal(
      await findLatestVibeSession({
        workspaceRoot,
        sinceMs: startedAt,
        homeDirectory: root,
        env: {},
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Vibe resumes only the reference attached to this conversation, including after restart", async () => {
  const specs: CommandSpec[] = [];
  let reference: import("../workspace/conversationStore.js").NativeSessionReference | undefined;
  const run = (request: ProviderChatRequest) =>
    new Promise<string>((resolve, reject) => {
      runMistralVibe(
        request,
        {
          onResponse: resolve,
          onError: (message) => reject(new Error(message)),
          onNativeSession: (value) => {
            reference = value;
          },
        },
        {
          resolveExecutable: async () => "/bin/vibe",
          runCommandImpl: (spec, handlers) => {
            specs.push(spec);
            handlers.onStdout?.(
              `${JSON.stringify({ role: "user", content: request.prompt })}\n${JSON.stringify({ role: "assistant", content: "reply" })}\n`,
            );
            return {
              result: Promise.resolve(commandResult({ stdout: "reply" })),
              cancel: () => undefined,
            };
          },
          findSessionImpl: async () => (specs.length === 1 ? "chat-a-native" : null),
        },
      );
    });
  await run(buildRequest({ prompt: "first" }));
  assert.equal(reference?.sessionId, "chat-a-native");
  const saved = JSON.parse(JSON.stringify(reference));
  await run(
    buildRequest({
      prompt: "second",
      conversationHistory: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
      nativeSessions: [saved],
    }),
  );
  assert.ok(specs[1]?.args.includes("chat-a-native"));
  assert.equal(reference?.sessionId, "chat-a-native");
  await run(buildRequest({ prompt: "other chat" }));
  assert.equal(specs[2]?.args.includes("--resume"), false);
  assert.equal(specs[0]?.stdinData, "first");
  assert.equal(specs[1]?.stdinData, "second");
});

test("Vibe retries a missing native session once using the saved dialogue", async () => {
  let calls = 0;
  const history = [
    { role: "user" as const, content: "first" },
    { role: "assistant" as const, content: "seed" },
  ];
  const { createHash } = await import("node:crypto");
  const response = await new Promise<string>((resolve, reject) => {
    runMistralVibe(
      buildRequest({
        prompt: "retry",
        conversationHistory: history,
        nativeSessions: [
          {
            source: "vibe",
            sessionId: "stale-session",
            modelId: "mistral-medium-3.5",
            throughMessageCount: 2,
            transcriptHash: createHash("sha256").update(JSON.stringify(history)).digest("hex"),
          },
        ],
      }),
      {
        onResponse: resolve,
        onError: (message) => reject(new Error(message)),
      },
      {
        resolveExecutable: async () => "vibe",
        runCommandImpl: (spec, handlers) => {
          calls += 1;
          if (calls === 1) {
            assert.ok(spec.args.includes("stale-session"));
            return {
              result: Promise.resolve(
                commandResult({ status: "failed", exitCode: 1, stderr: "session not found" }),
              ),
              cancel: () => undefined,
            };
          }
          assert.equal(spec.args.includes("--resume"), false);
          assert.match(spec.stdinData ?? "", /seed/);
          handlers.onStdout?.(`${JSON.stringify({ role: "assistant", content: "fresh" })}\n`);
          return {
            result: Promise.resolve(commandResult({ stdout: "fresh" })),
            cancel: () => undefined,
          };
        },
        findSessionImpl: async () => null,
      },
    );
  });
  assert.equal(response, "fresh");
  assert.equal(calls, 2);
});

test("runMistralVibe maps missing executable and authentication failures to setup guidance", async () => {
  const missing = await new Promise<string>((resolve) => {
    runMistralVibe(
      buildRequest(),
      { onResponse: () => undefined, onError: resolve },
      {
        resolveExecutable: async () => null,
      },
    );
  });
  assert.equal(missing, MISTRAL_VIBE_MISSING_MESSAGE);

  const auth = await new Promise<string>((resolve) => {
    runMistralVibe(
      buildRequest(),
      { onResponse: () => undefined, onError: resolve },
      {
        resolveExecutable: async () => "vibe",
        runCommandImpl: () => ({
          result: Promise.resolve(
            commandResult({ status: "failed", exitCode: 1, stderr: "401 unauthorized" }),
          ),
          cancel: () => undefined,
        }),
      },
    );
  });
  assert.equal(auth, MISTRAL_VIBE_AUTH_MESSAGE);
});

test("runMistralVibe cancellation before executable resolution prevents process launch", async () => {
  let resolveExecutable!: (value: string | null) => void;
  let didRun = false;
  const cancel = runMistralVibe(
    buildRequest(),
    { onResponse: () => undefined, onError: () => undefined },
    {
      resolveExecutable: () =>
        new Promise((resolve) => {
          resolveExecutable = resolve;
        }),
      runCommandImpl: () => {
        didRun = true;
        return { result: Promise.resolve(commandResult()), cancel: () => undefined };
      },
    },
  );
  cancel();
  resolveExecutable("vibe");
  await tick();
  assert.equal(didRun, false);
});

test("validateMistralVibeRoute reports missing and ready executable states", async () => {
  const missing = await validateMistralVibeRoute({
    cwd: "/workspace",
    resolveExecutable: async () => null,
  });
  assert.equal(missing.status, "not-configured");
  assert.equal(missing.backendKind, "unavailable");
  assert.equal(missing.message, MISTRAL_VIBE_MISSING_MESSAGE);

  const ready = await validateMistralVibeRoute({
    cwd: process.cwd(),
    resolveExecutable: async () => "/home/test/.local/bin/vibe",
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.backendKind, "mistral-vibe-cli-auth");
  assert.equal(ready.diagnostics?.resolvedCommand, "/home/test/.local/bin/vibe");
});

test("vibeAgentFor maps Ubume modes to built-in Vibe agents and never auto-approve", () => {
  const runtime = (mode: "suggest" | "auto-edit" | "full-auto") => ({
    ...buildRequest().runtime,
    mode,
  });
  assert.equal(vibeAgentFor(buildRequest({ runtime: runtime("suggest") })), "plan");
  assert.equal(vibeAgentFor(buildRequest({ runtime: runtime("auto-edit") })), "accept-edits");
  assert.equal(vibeAgentFor(buildRequest({ runtime: runtime("full-auto") })), "smart-approve");
  assert.equal(vibeAgentFor(buildRequest({ runIntent: "plan" })), "plan");
});

test("Vibe passes the mapped --agent and retries once without it on an older CLI", async () => {
  const specs: CommandSpec[] = [];
  const progress: string[] = [];
  const request = buildRequest({ runtime: { ...buildRequest().runtime, mode: "auto-edit" } });
  await new Promise<string>((resolve, reject) => {
    runMistralVibe(
      request,
      {
        onResponse: resolve,
        onError: (message) => reject(new Error(message)),
        onProgress: (update) => progress.push(update.text),
      },
      {
        resolveExecutable: async () => "/bin/vibe",
        runCommandImpl: (spec, handlers) => {
          specs.push(spec);
          if (spec.args.includes("--agent"))
            return {
              result: Promise.resolve(
                commandResult({
                  status: "failed",
                  exitCode: 2,
                  stderr: "vibe: error: unrecognized arguments: --agent accept-edits",
                }),
              ),
              cancel: () => undefined,
            };
          handlers.onStdout?.(
            `${JSON.stringify({ role: "user", content: request.prompt })}\n${JSON.stringify({ role: "assistant", content: "reply" })}\n`,
          );
          return {
            result: Promise.resolve(commandResult({ stdout: "reply" })),
            cancel: () => undefined,
          };
        },
        findSessionImpl: async () => null,
      },
    );
  });
  assert.equal(specs.length, 2);
  const agentIndex = specs[0]!.args.indexOf("--agent");
  assert.equal(specs[0]!.args[agentIndex + 1], "accept-edits");
  assert.equal(specs[1]!.args.includes("--agent"), false);
  assert.ok(progress.some((text) => /agent accept-edits/.test(text)));
  assert.equal(
    specs.some((spec) => spec.args.includes("--auto-approve") || spec.args.includes("--yolo")),
    false,
  );
});
