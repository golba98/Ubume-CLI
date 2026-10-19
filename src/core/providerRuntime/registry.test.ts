import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import { withEnvironment } from "../../test/environment.js";
import { saveCachedProviderModels } from "../models/modelCache.js";
import { ModelCatalog, providerCatalog } from "../models/modelCatalog.js";
import type { CommandResult, runCommand } from "../process/commandRunner.js";
import type { BackendProvider } from "../providers/types.js";
import { resetAnthropicRouteValidationCacheForTests, validateAnthropicRoute } from "./anthropic.js";
import {
  parseAgyModelsOutput,
  resetAntigravityRouteValidationCacheForTests,
} from "./antigravity.js";
import { checkLocalProvider, resetLocalProviderStateForTests } from "./local.js";
import {
  createRoutedProvider,
  discoverProviderModels,
  getDefaultRouteModel,
  getProviderRouteSetupMessage,
  getProviderRuntime,
  isProviderRouteConfigured,
  resolveActiveProviderRoute,
} from "./registry.js";
import type { ProviderChatRequest, ProviderModel, ProviderRuntime } from "./types.js";

test("Mistral failed refresh permits configured routes but blocks API routes and API aliases", async () => {
  const models: ProviderModel[] = [
    {
      id: "native",
      modelId: "native",
      label: "Native",
      source: "config",
      mistralExecutionClass: "native-vibe",
      description: null,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
      raw: { aliases: ["native-api-version"] },
    },
    {
      id: "local",
      modelId: "local",
      label: "Local",
      source: "config",
      mistralExecutionClass: "local-vibe",
      description: null,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
    },
    {
      id: "third-party",
      modelId: "third-party",
      label: "Third party",
      source: "config",
      mistralExecutionClass: "custom-vibe",
      description: null,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
    },
    {
      id: "api",
      modelId: "api",
      label: "API",
      source: "discovered",
      mistralExecutionClass: "custom-vibe",
      description: null,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
    },
  ];
  const runtime = getProviderRuntime("mistral");
  const originalDiscover = runtime.discoverModels;
  const originalRun = runtime.run;
  const catalog = new ModelCatalog();
  const fixtureRuntime: ProviderRuntime = {
    ...runtime,
    discoverModels: () => ({
      status: "ready",
      providerId: "mistral",
      backendKind: "mistral-vibe-cli-auth",
      models,
    }),
    refreshModels: async () => ({
      status: "ready",
      providerId: "mistral",
      backendKind: "mistral-vibe-cli-auth",
      models,
      freshness: "unverified",
      refreshState: "failed",
    }),
  };
  const snapshot = await catalog.refresh(fixtureRuntime, { cwd: "/tmp/no-vibe-project" });
  assert.equal(snapshot.freshness, "unverified");
  const backend: BackendProvider = {
    id: "codex-subprocess",
    label: "Fixture",
    description: "Fixture",
    authState: "delegated",
    authLabel: "Fixture",
    statusMessage: "Fixture",
    supportsModels: () => true,
  };
  const dispatched: ProviderChatRequest[] = [];
  try {
    providerCatalog.invalidate("mistral");
    runtime.discoverModels = () => snapshot;
    runtime.run = (request) => {
      dispatched.push(request);
      return () => {};
    };
    for (const modelId of ["native", "local", "third-party", "api", "native-api-version"]) {
      dispatched.length = 0;
      let error = "";
      const provider = createRoutedProvider(
        { providerId: "mistral", modelId, backendKind: "mistral-vibe-cli-auth" },
        backend,
        {},
      );
      provider.run!(
        "fixture",
        { runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})), workspaceRoot: "/tmp" },
        {
          onResponse: () => {},
          onError: (message) => {
            error = message;
          },
        },
      );
      if (modelId === "api" || modelId === "native-api-version") {
        assert.match(error, /unverified.*Refresh models/i);
        assert.equal(dispatched.length, 0);
      } else {
        assert.equal(error, "");
        assert.equal(dispatched.at(-1)?.route.modelId, modelId);
      }
    }
    runtime.discoverModels = () => ({ ...snapshot, freshness: "verified" });
    for (const modelId of ["api", "native-api-version"]) {
      const provider = createRoutedProvider(
        { providerId: "mistral", modelId, backendKind: "mistral-vibe-cli-auth" },
        backend,
        {},
      );
      provider.run!(
        "fixture",
        { runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})), workspaceRoot: "/tmp" },
        {
          onResponse: () => {},
          onError: (message) => {
            throw new Error(message);
          },
        },
      );
      assert.equal(dispatched.at(-1)?.route.modelId, modelId);
    }
  } finally {
    runtime.discoverModels = originalDiscover;
    runtime.run = originalRun;
    providerCatalog.invalidate("mistral");
    catalog.dispose();
  }
});

test("every supported external provider exposes the shared planning run path", () => {
  for (const providerId of ["openai", "anthropic", "mistral", "local", "google"] as const) {
    const runtime = getProviderRuntime(providerId);
    assert.equal(runtime.routeAvailable, true, `${providerId} must remain routable for plan mode`);
    assert.equal(typeof runtime.run, "function", `${providerId} must accept shared plan requests`);
  }
});

test("google runtime exposes configured Antigravity models for in-Ubume routing", async () => {
  const home = mkdtempSync(join(tmpdir(), "ubume-google-inventory-"));
  try {
    await withEnvironment({ HOME: home, USERPROFILE: home }, () => {
      resetAntigravityRouteValidationCacheForTests();
      saveCachedProviderModels("google", {
        discoveredAt: Date.now(),
        models: parseAgyModelsOutput("Gemini 3.5 Flash (Medium)"),
      });
      const runtime = getProviderRuntime("google");
      const discovery = discoverProviderModels("google");
      assert.equal(runtime.routeAvailable, true);
      assert.equal(runtime.backendKind, "antigravity-cli-auth");
      assert.equal(discovery.status, "ready");
      assert.ok(discovery.models.length > 0);
    });
  } finally {
    resetAntigravityRouteValidationCacheForTests();
    rmSync(home, { recursive: true, force: true });
  }
});

test("anthropic runtime exposes configured Claude models for in-Ubume routing", () => {
  const runtime = getProviderRuntime("anthropic");
  const discovery = discoverProviderModels("anthropic");

  assert.equal(runtime.routeAvailable, true);
  assert.equal(runtime.backendKind, "claude-code-auth");
  assert.equal(discovery.status, "ready");
  assert.ok(discovery.models.length > 0);
});

test("Google route restores its saved model ID gemini-3.5-flash", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "google",
      modelId: "gemini-3.5-flash",
      backendKind: "antigravity-cli-auth",
      reasoning: "medium",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });
  assert.equal(route.providerId, "google");
  assert.equal(route.modelId, "gemini-3.5-flash");
  assert.equal(route.reasoning, "medium");
});

test("Google route preserves an exact native ID until discovery resolves it", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "google",
      modelId: "gemini-3.5-flash-high",
      backendKind: "antigravity-cli-auth",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });
  assert.equal(route.providerId, "google");
  assert.equal(route.modelId, "gemini-3.5-flash-high");
  assert.equal(route.reasoning, undefined);
});

test("active route resolution preserves routable anthropic routes", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      backendKind: "anthropic-api-key",
      reasoning: "high",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "medium",
  });

  assert.deepEqual(route, {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    backendKind: "anthropic-api-key",
    reasoning: "high",
  });
});

test("active route resolution preserves routable local routes", async () => {
  resetLocalProviderStateForTests();
  await checkLocalProvider({
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "llama-local" }],
        }),
        { status: 200 },
      )) as typeof fetch,
  });
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "local",
      modelId: "llama-local",
      backendKind: "local-openai-compatible",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });

  assert.deepEqual(route, {
    providerId: "local",
    modelId: "llama-local",
    backendKind: "local-openai-compatible",
    localBackend: "lm-studio",
  });
  resetLocalProviderStateForTests();
});

test("active route resolution preserves an explicit Unsloth backend", () => {
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "local",
      modelId: "Qwen3.8-27B-UD-Q3_K_XL",
      backendKind: "local-openai-compatible",
      localBackend: "unsloth",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "low",
  });

  assert.deepEqual(route, {
    providerId: "local",
    modelId: "Qwen3.8-27B-UD-Q3_K_XL",
    backendKind: "local-openai-compatible",
    localBackend: "unsloth",
  });
});

// ─── CLI --model override precedence ─────────────────────────────────────────
// These tests mirror the app-level logic: when --model is given on the CLI,
// the caller constructs effectiveRoute = { ...savedRoute, modelId: cliModel }
// before passing it to resolveActiveProviderRoute. The tests verify the resolver
// honours that override correctly.

test("CLI model override wins over persisted OpenAI activeRoute model", () => {
  // Simulate: providers.json has gpt-5.4-mini, but user ran --model gpt-5.5
  const cliModel = "gpt-5.5";
  const savedRoute = {
    providerId: "openai" as const,
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth" as const,
    reasoning: "low",
  };
  const effectiveRoute = { ...savedRoute, modelId: cliModel };

  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: effectiveRoute,
    currentModel: "gpt-5.5",
    currentReasoning: "low",
  });

  assert.equal(
    route.modelId,
    "gpt-5.5",
    "CLI model must be used for the run, not providers.json model",
  );
  assert.equal(route.providerId, "openai");
});

test("without CLI model override the persisted providers.json activeRoute model is used", () => {
  const savedRoute = {
    providerId: "openai" as const,
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth" as const,
    reasoning: "low",
  };

  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: savedRoute,
    currentModel: "gpt-5.4",
    currentReasoning: "high",
  });

  assert.equal(
    route.modelId,
    "gpt-5.4-mini",
    "Without CLI override, persisted model must win over layered-config default",
  );
});

test("CLI model override preserves provider from providers.json activeRoute", () => {
  // --model on the CLI should not change the provider, only the modelId
  const cliModel = "gpt-5.5";
  const savedRoute = {
    providerId: "openai" as const,
    modelId: "gpt-5.4-mini",
    backendKind: "codex-cli-auth" as const,
    reasoning: "low",
  };
  const effectiveRoute = { ...savedRoute, modelId: cliModel };

  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: effectiveRoute,
    currentModel: cliModel,
    currentReasoning: "low",
  });

  assert.equal(route.providerId, "openai", "Provider from providers.json must be preserved");
  assert.equal(route.modelId, cliModel);
  assert.equal(route.reasoning, "low", "Reasoning from providers.json must be preserved");
});

test("Mistral Vibe runtime is routable in Ubume and exposes the configured model", () => {
  const runtime = getProviderRuntime("mistral");
  const discovery = discoverProviderModels("mistral");

  assert.equal(runtime.label, "Mistral Vibe CLI");
  assert.equal(runtime.backendKind, "mistral-vibe-cli-auth");
  assert.equal(runtime.routeAvailable, true);
  assert.equal(runtime.launchAvailable, true);
  assert.equal(typeof runtime.run, "function");
  assert.equal(typeof runtime.refreshModels, "function");
  assert.equal(typeof runtime.validateRoute, "function");
  assert.equal(discovery.providerId, "mistral");
  assert.equal(discovery.backendKind, "mistral-vibe-cli-auth");
  assert.ok(discovery.models[0]?.modelId);
});

// ─── Authentication and setup gates ──────────────────────────────────────────

test("anthropic route configuration is gated by ANTHROPIC_API_KEY or Claude Code", () => {
  const original = process.env.ANTHROPIC_API_KEY;

  try {
    delete process.env.ANTHROPIC_API_KEY;
    resetAnthropicRouteValidationCacheForTests();
    assert.equal(isProviderRouteConfigured("anthropic"), false);
    assert.match(getProviderRouteSetupMessage("anthropic"), /set ANTHROPIC_API_KEY/);
  } finally {
    if (original) process.env.ANTHROPIC_API_KEY = original;
  }
});

test("google route setup message instructs installing Antigravity CLI", () => {
  assert.match(getProviderRouteSetupMessage("google"), /agy/);
});

test("local route configuration is gated by endpoint model discovery", async () => {
  resetLocalProviderStateForTests();
  assert.equal(isProviderRouteConfigured("local"), false);

  await checkLocalProvider({
    fetchImpl: (async (input) => {
      if (String(input).includes("/api/v0/")) {
        return new Response(null, { status: 404 });
      }
      return new Response(
        JSON.stringify({
          data: [{ id: "google/gemma-4-26b-a4b" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });

  assert.equal(isProviderRouteConfigured("local"), true);
  resetLocalProviderStateForTests();
});

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    userMessage: "Command completed.",
    ...overrides,
  };
}

function mockRunCommand(
  resultOrMap: CommandResult | ((executable: string, args: string[]) => CommandResult),
): typeof runCommand {
  return ((spec) => {
    const result =
      typeof resultOrMap === "function" ? resultOrMap(spec.executable, spec.args) : resultOrMap;
    return {
      child: null as unknown as ChildProcess,
      result: Promise.resolve(result),
      cancel: () => undefined,
    };
  }) as typeof runCommand;
}

async function withEmptyClaudeSettingsHome(run: () => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-claude-empty-"));

  try {
    process.env.HOME = tempHome;
    delete process.env.USERPROFILE;
    await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;

    rmSync(tempHome, { recursive: true, force: true });
  }
}

test("Provider isolation: discoverProviderModels('openai') returns empty models array regardless of anthropic discovery state", async () => {
  await withEmptyClaudeSettingsHome(async () => {
    resetAnthropicRouteValidationCacheForTests();

    // Initially openai is empty
    const initialOpenai = discoverProviderModels("openai");
    assert.deepEqual(initialOpenai.models, []);

    // Mock-validate anthropic to populate cache
    const mockImpl = mockRunCommand((executable, args) => {
      if (executable === "where.exe")
        return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
      if (args[0] === "auth")
        return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "--help")
        return commandResult({ exitCode: 0, stdout: "Commands:\n  model list --json\n" });
      if (args[0] === "model" && args[1] === "--help")
        return commandResult({ exitCode: 0, stdout: "model list --json\n" });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({
          exitCode: 0,
          stdout: JSON.stringify({
            models: [
              {
                value: "claude-sonnet-4-98",
                label: "Claude Sonnet 4.98",
                family: "sonnet",
                canonicalId: "claude-sonnet-4-98",
                effortLevels: ["low"],
                defaultEffort: "low",
              },
            ],
          }),
        });
      }
      return commandResult({ exitCode: 0 });
    });

    await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockImpl,
    });

    // Verify anthropic has discovered model
    const anthropicDiscovery = discoverProviderModels("anthropic");
    assert.equal(anthropicDiscovery.status, "ready");
    assert.ok(anthropicDiscovery.models.length > 0);
    assert.equal(anthropicDiscovery.models[0].modelId, "claude-sonnet-4-98");

    // Verify openai is still empty (isolated!)
    const postOpenai = discoverProviderModels("openai");
    assert.deepEqual(postOpenai.models, []);

    resetAnthropicRouteValidationCacheForTests();
  });
});

test("getDefaultRouteModel with discovered models: prefers discovered anthropic models when cache is populated", async () => {
  await withEmptyClaudeSettingsHome(async () => {
    resetAnthropicRouteValidationCacheForTests();

    // Cold cache: should return hardcoded default
    const coldDefault = getDefaultRouteModel("anthropic", "gpt-5.4");
    assert.equal(coldDefault, "fable"); // ANTHROPIC_FALLBACK_MODELS[0]?.modelId is "fable"

    // Mock-validate anthropic to populate cache
    const mockImpl = mockRunCommand((executable, args) => {
      if (executable === "where.exe")
        return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
      if (args[0] === "auth")
        return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "--help")
        return commandResult({ exitCode: 0, stdout: "Commands:\n  model list --json\n" });
      if (args[0] === "model" && args[1] === "--help")
        return commandResult({ exitCode: 0, stdout: "model list --json\n" });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({
          exitCode: 0,
          stdout: JSON.stringify({
            models: [
              {
                value: "claude-sonnet-4-99",
                label: "Claude Sonnet 4.99",
                family: "sonnet",
                canonicalId: "claude-sonnet-4-99",
                effortLevels: ["low"],
                defaultEffort: "low",
              },
            ],
          }),
        });
      }
      return commandResult({ exitCode: 0 });
    });

    await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockImpl,
    });

    // Warm cache: should return the first discovered model
    const warmDefault = getDefaultRouteModel("anthropic", "gpt-5.4");
    assert.equal(warmDefault, "claude-sonnet-4-99");

    resetAnthropicRouteValidationCacheForTests();
  });
});

test("resolveActiveProviderRoute preserves stale Anthropic selection for explicit reconciliation", async () => {
  await withEmptyClaudeSettingsHome(async () => {
    resetAnthropicRouteValidationCacheForTests();

    const mockImpl = mockRunCommand((executable, args) => {
      if (executable === "where.exe")
        return commandResult({ exitCode: 0, stdout: "C:\\bin\\claude.exe\n" });
      if (args[0] === "auth")
        return commandResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) });
      if (args[0] === "model" && args[1] === "list" && args[2] === "--json") {
        return commandResult({
          exitCode: 0,
          stdout: JSON.stringify([
            {
              value: "claude-opus-4-8",
              label: "Claude Opus 4.8",
              family: "opus",
              effortLevels: ["low"],
              defaultEffort: "low",
            },
            {
              value: "claude-sonnet-4-6",
              label: "Claude Sonnet 4.6",
              family: "sonnet",
              effortLevels: ["low"],
              defaultEffort: "low",
            },
          ]),
        });
      }
      return commandResult({ exitCode: 1 });
    });

    await validateAnthropicRoute({
      cwd: process.cwd(),
      runCommandImpl: mockImpl,
    });

    const route = resolveActiveProviderRoute({
      workspaceConfigActiveRoute: {
        providerId: "anthropic",
        modelId: "opus",
        backendKind: "claude-code-auth",
        reasoning: "high",
      },
      currentModel: "gpt-5.4",
      currentReasoning: "medium",
    });

    assert.equal(route.modelId, "opus");

    resetAnthropicRouteValidationCacheForTests();
  });
});

test("Anthropic routing preserves selected effort and rejects stale unsupported preferences", () => {
  const runtime = getProviderRuntime("anthropic");
  const originalDiscover = runtime.discoverModels;
  const originalRun = runtime.run;
  const levels = ["high", "xhigh", "max"].map((id) => ({ id, label: id, description: null }));
  const model: ProviderModel = {
    id: "claude-test",
    modelId: "claude-test",
    label: "Claude Test",
    source: "discovered",
    description: null,
    defaultReasoningLevel: "high",
    supportedReasoningLevels: levels,
    reasoningControl: { kind: "levels", levels, default: "high", transport: "parameter" },
  };
  const sent: ProviderChatRequest[] = [];
  const errors: string[] = [];
  providerCatalog.invalidate("anthropic");
  runtime.discoverModels = () => ({
    status: "ready",
    providerId: "anthropic",
    backendKind: "claude-code-auth",
    models: [model],
  });
  runtime.run = (request) => {
    sent.push(request);
    return () => {};
  };
  const backend: BackendProvider = {
    id: "codex-subprocess",
    label: "Fixture",
    description: "Fixture",
    authState: "delegated",
    authLabel: "Fixture",
    statusMessage: "Fixture",
    supportsModels: () => true,
  };
  const send = (reasoning: string) =>
    createRoutedProvider(
      {
        providerId: "anthropic",
        modelId: model.modelId,
        reasoning,
        backendKind: "claude-code-auth",
      },
      backend,
      {},
    ).run!(
      "Task",
      { runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})), workspaceRoot: "/tmp" },
      { onResponse: () => {}, onError: (message) => errors.push(message) },
    );
  try {
    send("max");
    send("xhigh");
    assert.deepEqual(
      sent.map((request) => request.route.reasoning),
      ["max", "xhigh"],
    );
    send("ultra");
    assert.equal(sent.length, 2);
    assert.match(errors[0]!, /does not advertise effort/);
    for (const kind of ["fixed", "unsupported", "unknown"] as const) {
      model.reasoningControl = kind === "fixed" ? { kind, label: "Provider managed" } : { kind };
      send("max");
      assert.equal(sent.length, 2);
    }
    send("");
    assert.equal(sent.length, 3);
    assert.equal(sent[2]?.route.reasoning, undefined);
  } finally {
    runtime.discoverModels = originalDiscover;
    runtime.run = originalRun;
    providerCatalog.invalidate("anthropic");
  }
});
