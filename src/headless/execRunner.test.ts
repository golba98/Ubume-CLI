import assert from "node:assert/strict";
import test from "node:test";
import type { LaunchArgs } from "../config/launchArgs.js";
import type { LayeredConfigResult } from "../config/layeredConfig.js";
import {
  normalizeRuntimeConfig,
  type ResolvedRuntimeConfig,
  resolveRuntimeConfig,
} from "../config/runtimeConfig.js";
import type { BackendProvider } from "../core/providers/types.js";
import {
  HEADLESS_EXEC_PROVIDER_UNAVAILABLE,
  HEADLESS_EXEC_RUN_FAILED,
  type HeadlessExecIo,
  runHeadlessExec,
} from "./execRunner.js";
import { createHeadlessExecTiming } from "./execTiming.js";

function createLaunchArgs(): LaunchArgs {
  return {
    help: false,
    version: false,
    initialPrompt: "Prompt",
    profile: null,
    configOverrides: [],
    passthroughArgs: [],
    modelOverride: null,
    noClear: false,
  };
}

function createIo(): HeadlessExecIo & { stdoutText: () => string; stderrText: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function createLayeredConfig(): LayeredConfigResult {
  return {
    runtime: normalizeRuntimeConfig({
      provider: "codex-subprocess",
      model: "gpt-5.4-mini",
      reasoningLevel: "medium",
      mode: "full-auto",
      planMode: true,
      policy: {
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
        writableRoots: ["C:/Repo/extra"],
        serviceTier: "fast",
        personality: "pragmatic",
      },
    }),
    diagnostics: {
      projectRoot: "C:\\Repo",
      projectTrusted: true,
      selectedProfile: null,
      selectedProfileSource: null,
      cliOverrides: [],
      layers: [{ label: "test", status: "loaded" }],
      ignoredEntries: [],
      fieldSources: {
        provider: "test",
        model: "test",
        reasoningLevel: "test",
        mode: "test",
        planMode: "test",
        antigravityCommandPath: "test",
        codexCommandPath: "test",
        "policy.approvalPolicy": "test",
        "policy.sandboxMode": "test",
        "policy.networkAccess": "test",
        "policy.writableRoots": "test",
        "policy.serviceTier": "test",
        "policy.personality": "test",
      },
    },
  };
}

function createProvider(run: BackendProvider["run"]): BackendProvider {
  return {
    id: "codex-subprocess",
    label: "Mock Codex",
    description: "Mock provider",
    authState: "delegated",
    authLabel: "Mock",
    statusMessage: "Mock",
    supportsModels: () => true,
    run,
  };
}

test("streams assistant deltas to stdout and progress/tool/error diagnostics to stderr", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onProgress?.({ id: "p1", source: "reasoning", text: "thinking" });
    handlers.onToolActivity?.({
      id: "tool-1",
      command: "pwd",
      status: "running",
      startedAt: Date.now(),
    });
    handlers.onAssistantDelta?.("Hello ");
    handlers.onAssistantDelta?.("world");
    handlers.onResponse("Hello world");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(io.stdoutText(), "Hello world");
  assert.doesNotMatch(
    `${io.stdoutText()}\n${io.stderrText()}`,
    /██████|Ubume v|Workspace:|Provider:|Context:/,
  );
  assert.match(io.stderrText(), /startup:/);
  assert.match(io.stderrText(), /reasoning: thinking/);
  assert.match(io.stderrText(), /tool: running: pwd/);
});

test("emits final_answer_observed timing before provider response settles", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onAssistantDelta?.("READY");
    handlers.onFinalAnswerObserved?.("READY");
    handlers.onResponse("READY");
    return () => {};
  });

  const result = await runHeadlessExec(
    {
      prompt: "Prompt",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
      benchmarkDiagnostics: createHeadlessExecTiming({
        enabled: true,
        stderr: io.stderr,
        startTimeMs: Date.now(),
      }),
    },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(io.stderrText(), /final_answer_observed/);
  assert.match(io.stderrText(), /\[ubume exec timing\]/);
  assert.match(io.stderrText(), /final_answer_character_count=5/);
});

test("timing is silent when disabled", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(io.stderrText(), /\[ubume exec timing\]/);
});

test("raw prompt policy sends the exact prompt and skips project instructions", async () => {
  const io = createIo();
  const captured: Array<{
    prompt: string;
    promptPolicy: string | undefined;
    projectInstructions: unknown;
  }> = [];
  let projectInstructionLoadCount = 0;
  const provider = createProvider((prompt, options, handlers) => {
    captured.push({
      prompt,
      promptPolicy: options.promptPolicy,
      projectInstructions: options.projectInstructions,
    });
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    {
      prompt: "Reply with exactly: UBUME_READY",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
    },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => {
        projectInstructionLoadCount += 1;
        return {
          status: "loaded",
          instructions: { path: "C:\\Repo\\AGENTS.md", content: "extra instructions" },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(projectInstructionLoadCount, 0);
  assert.equal(captured[0]?.prompt, "Reply with exactly: UBUME_READY");
  assert.equal(captured[0]?.promptPolicy, "raw");
  assert.equal(captured[0]?.projectInstructions, null);
});

test("wrapped prompt policy loads project instructions for compatibility", async () => {
  const io = createIo();
  let capturedProjectInstructions: unknown = null;
  const provider = createProvider((_prompt, options, handlers) => {
    capturedProjectInstructions = options.projectInstructions;
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    {
      prompt: "Prompt",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
      promptPolicy: "wrapped",
    },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({
        status: "loaded",
        instructions: { path: "C:\\Repo\\AGENTS.md", content: "extra instructions" },
      }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(capturedProjectInstructions, {
    path: "C:\\Repo\\AGENTS.md",
    content: "extra instructions",
  });
});

test("does not duplicate equivalent tool activity as progress", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onToolActivity?.({
      id: "tool-1",
      command: "Get-ChildItem",
      status: "running",
      startedAt: Date.now(),
    });
    handlers.onProgress?.({ id: "tool-1", source: "tool", text: "Running Get-ChildItem" });
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(io.stderrText(), /tool: running: Get-ChildItem/);
  assert.doesNotMatch(io.stderrText(), /tool: Running Get-ChildItem/);
});

test("returns exit code 0 on provider success without deltas", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onResponse("Final answer");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(io.stdoutText(), "Final answer");
});

test("keeps structured fallback events out of stdout", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onAssistantDelta?.(
      '{"type":"item.completed","item":{"type":"agent_message","text":"raw"}}\n',
    );
    handlers.onAssistantDelta?.("Actual answer");
    handlers.onResponse("Actual answer");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(io.stdoutText(), "Actual answer");
});

test("returns non-zero when provider is unavailable", async () => {
  const io = createIo();
  const provider = createProvider(undefined);

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, HEADLESS_EXEC_PROVIDER_UNAVAILABLE);
  assert.match(io.stderrText(), /unavailable/i);
});

test("returns non-zero on provider error", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onError("Provider exploded");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, HEADLESS_EXEC_RUN_FAILED);
  assert.match(io.stderrText(), /Provider exploded/);
});

test("missing-file failure remains non-zero and visible", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onError(
      "Process exited with code 1",
      "Get-Content: Cannot find path 'missing.txt' because it does not exist.",
    );
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Read missing.txt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, HEADLESS_EXEC_RUN_FAILED);
  assert.match(io.stderrText(), /missing\.txt/);
  assert.match(io.stderrText(), /does not exist/);
});

test("forces planMode off while preserving other runtime settings", async () => {
  const io = createIo();
  const capturedRuntimes: ResolvedRuntimeConfig[] = [];
  const provider = createProvider((_prompt, options, handlers) => {
    capturedRuntimes.push(options.runtime);
    handlers.onResponse("ok");
    return () => {};
  });

  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    {
      resolveLayeredConfig: () => createLayeredConfig(),
      resolveRuntimeConfig,
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "missing" }),
    },
  );

  assert.equal(result.exitCode, 0);
  const capturedRuntime = capturedRuntimes[0];
  assert.ok(capturedRuntime);
  assert.equal(capturedRuntime.planMode, false);
  assert.equal(capturedRuntime.model, "gpt-5.4-mini");
  assert.equal(capturedRuntime.reasoningLevel, "medium");
  assert.equal(capturedRuntime.mode, "full-auto");
  assert.equal(capturedRuntime.policy.approvalPolicy, "never");
  assert.equal(capturedRuntime.policy.sandboxMode, "danger-full-access");
  assert.equal(capturedRuntime.policy.networkAccess, true);
  assert.deepEqual(capturedRuntime.policy.writableRoots, ["C:\\Repo\\extra"]);
  assert.equal(capturedRuntime.policy.serviceTier, "fast");
  assert.equal(capturedRuntime.policy.personality, "pragmatic");
});

test("final response supplies an unstreamed suffix and waits for provider teardown", async () => {
  const io = createIo();
  let stopped = false;
  let cleaned = false;
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onRunControl?.({
      stopped: new Promise<void>((resolve) =>
        setTimeout(() => {
          stopped = true;
          resolve();
        }, 30),
      ),
    });
    handlers.onAssistantDelta?.("Hello");
    handlers.onResponse("Hello world");
    return () => {
      cleaned = true;
    };
  });
  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    { resolveLayeredConfig: () => createLayeredConfig(), getBackendProvider: () => provider },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(io.stdoutText(), "Hello world");
  assert(stopped);
  assert(cleaned);
});

test("abort saves partial result and ignores late provider callbacks", async () => {
  const io = createIo();
  const controller = new AbortController();
  let stopped = false;
  const provider = createProvider((_prompt, _options, handlers) => {
    let end!: () => void;
    handlers.onRunControl?.({
      stopped: new Promise<void>((resolve) => {
        end = resolve;
      }),
    });
    handlers.onAssistantDelta?.("partial");
    setTimeout(() => controller.abort(), 10);
    return () => {
      setTimeout(() => {
        handlers.onResponse("late answer");
        stopped = true;
        end();
      }, 20);
    };
  });
  const result = await runHeadlessExec(
    {
      prompt: "Prompt",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
      signal: controller.signal,
    },
    io,
    { resolveLayeredConfig: () => createLayeredConfig(), getBackendProvider: () => provider },
  );
  assert.equal(result.exitCode, 130);
  assert.equal(result.text, "partial");
  assert.equal(io.stdoutText(), "partial");
  assert(stopped);
});

const mockDependencies = (provider: BackendProvider) => ({
  resolveLayeredConfig: () => createLayeredConfig(),
  getBackendProvider: () => provider,
  loadProjectInstructions: () => ({ status: "missing" as const }),
});

test("an already-aborted signal never starts the provider", async () => {
  const io = createIo();
  const controller = new AbortController();
  controller.abort();
  let started = false;
  const provider = createProvider(() => {
    started = true;
    return () => {};
  });
  const result = await runHeadlessExec(
    {
      prompt: "Prompt",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
      signal: controller.signal,
    },
    io,
    mockDependencies(provider),
  );
  assert.deepEqual(result, { exitCode: 130, text: "", error: "Run interrupted." });
  assert.equal(started, false);
  assert.equal(io.stdoutText(), "");
});

test("denied tool approval fails with exit 3 and cancels the provider", async () => {
  const io = createIo();
  let canceled = 0;
  const provider = createProvider((_prompt, _options, handlers) => {
    queueMicrotask(async () => {
      assert.equal(await handlers.onToolApproval?.({ id: "t1" } as never), "deny");
      handlers.onResponse("too late");
    });
    return () => {
      canceled += 1;
    };
  });
  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    mockDependencies(provider),
  );
  assert.equal(result.exitCode, 3);
  assert.match(result.error ?? "", /requires interactive approval/);
  assert.match(io.stderrText(), /\[ubume exec\] approval: This tool requires interactive approval/);
  assert.equal(io.stdoutText(), "", "callbacks after settle are ignored");
  assert.equal(canceled, 1, "cleanup runs exactly once");
});

test("a provider that throws while starting fails with exit 1", async () => {
  const io = createIo();
  const provider = createProvider(() => {
    throw new Error("spawn failed");
  });
  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    mockDependencies(provider),
  );
  assert.deepEqual(result, { exitCode: HEADLESS_EXEC_RUN_FAILED, text: "", error: "spawn failed" });
  assert.match(io.stderrText(), /\[ubume exec\] error: spawn failed/);
});

test("provider errors combine message and raw output, defaulting when both are blank", async () => {
  for (const [message, raw, expected] of [
    ["Exited 1", "stderr tail", "Exited 1\nstderr tail"],
    ["  ", undefined, "Provider run failed."],
  ] as const) {
    const io = createIo();
    const provider = createProvider((_prompt, _options, handlers) => {
      handlers.onError(message, raw);
      return () => {};
    });
    const result = await runHeadlessExec(
      { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
      io,
      mockDependencies(provider),
    );
    assert.equal(result.exitCode, HEADLESS_EXEC_RUN_FAILED);
    assert.equal(result.error, expected);
  }
});

test("a final response that diverges from the stream is printed on a new line", async () => {
  const io = createIo();
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onAssistantDelta?.("Draft");
    handlers.onResponse("Final answer");
    return () => {};
  });
  const result = await runHeadlessExec(
    { prompt: "Prompt", launchArgs: createLaunchArgs(), workspaceRoot: "C:\\Repo" },
    io,
    mockDependencies(provider),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.text, "Final answer");
  assert.equal(io.stdoutText(), "Draft\nFinal answer");
});

test("ignored config entries and failed instruction loads are reported on stderr", async () => {
  const io = createIo();
  const layered = createLayeredConfig();
  layered.diagnostics.ignoredEntries = ["foo (unknown key)"];
  const provider = createProvider((_prompt, _options, handlers) => {
    handlers.onResponse("ok");
    return () => {};
  });
  await runHeadlessExec(
    {
      prompt: "Prompt",
      launchArgs: createLaunchArgs(),
      workspaceRoot: "C:\\Repo",
      promptPolicy: "wrapped",
    },
    io,
    {
      resolveLayeredConfig: () => layered,
      getBackendProvider: () => provider,
      loadProjectInstructions: () => ({ status: "error", path: "AGENTS.md", message: "EACCES" }),
    },
  );
  assert.match(io.stderrText(), /\[ubume exec\] config: ignored foo \(unknown key\)/);
  assert.match(io.stderrText(), /could not load project instructions at AGENTS\.md: EACCES/);
  assert.equal(io.stdoutText(), "ok");
});
