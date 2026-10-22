import { expect, test } from "bun:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import type { CommandSpec, runCommand } from "../process/commandRunner.js";
import { parseAgyModelsOutput, runAntigravityWithRunner } from "./antigravity.js";
import { parseMistralModels } from "./mistralDiscovery.js";
import {
  listVibeConfiguredModels,
  mergeMistralVibeModels,
  parseVibeEffectiveModels,
  runMistralVibe,
} from "./mistralVibe.js";
import type { ProviderChatRequest } from "./types.js";

const result = {
  status: "completed" as const,
  exitCode: 0,
  signal: null,
  stdout: "OK",
  stderr: "",
  startedAt: 0,
  endedAt: 0,
  durationMs: 0,
  userMessage: "done",
};
const runtime = resolveRuntimeConfig(normalizeRuntimeConfig({}));

async function captureVibeRequest(
  request: Pick<ProviderChatRequest, "route" | "modelDescriptor" | "providerConfig">,
  env: NodeJS.ProcessEnv = {},
): Promise<CommandSpec> {
  let captured: CommandSpec | undefined;
  await new Promise<void>((resolve, reject) =>
    runMistralVibe(
      { prompt: "fixture", workspaceRoot: "/tmp", runtime, ...request },
      { onResponse: () => resolve(), onError: reject },
      {
        env,
        resolveExecutable: async () => "/fixture/vibe",
        findSessionImpl: async () => null,
        runCommandImpl: (spec, handlers) => {
          captured = spec;
          handlers.onStdout?.("OK\n");
          return { result: Promise.resolve(result), cancel: () => {} };
        },
      },
    ),
  );
  return captured!;
}

test("merged Vibe selectors execute configured names while API aliases execute the exact selected ID", async () => {
  const configured = listVibeConfiguredModels({
    cwd: "/tmp/no-vibe-project",
    homeDirectory: "/tmp/no-vibe-home",
    env: {
      VIBE_HOME: "/tmp/no-vibe-home/.vibe",
      VIBE_MODELS: JSON.stringify([
        { name: "native-request", alias: "friendly-selector", provider: "mistral" },
      ]),
    },
  }).models;
  const model = mergeMistralVibeModels(
    configured,
    parseMistralModels({
      data: [
        { id: "native-request", aliases: ["api-version"], capabilities: { completion_chat: true } },
      ],
    }),
  )[0]!;
  for (const modelId of ["friendly-selector", "native-request", "api-version"]) {
    const spec = await captureVibeRequest({
      route: { providerId: "mistral", modelId, backendKind: "mistral-vibe-cli-auth" },
      modelDescriptor: model,
    });
    const payload = JSON.parse(spec.env!.VIBE_MODELS!)[0];
    expect(payload.name).toBe(modelId === "friendly-selector" ? "native-request" : modelId);
    expect(payload.alias).toBe(modelId);
    expect(spec.env!.VIBE_ACTIVE_MODEL).toBe(modelId);
  }
});

for (const provider of ["mistral", "llamacpp", "custom-backend"]) {
  test(`configured ${provider} Vibe routes preserve complete model and provider settings`, async () => {
    const configuration = {
      name: "configured-name",
      alias: "selector",
      provider,
      temperature: 0.73,
      thinking: "off",
      thinking_levels: ["off"],
      supports_images: true,
      max_context_length: 16000,
      auto_compact_threshold: 12000,
      input_price: 0.5,
      output_price: 1.2,
      cached_input_price: 0.1,
      display_name: "Configured model",
    };
    const env = {
      VIBE_HOME: "/tmp/no-vibe-home/.vibe",
      VIBE_MODELS: JSON.stringify([configuration]),
      VIBE_PROVIDERS: JSON.stringify([{ name: provider, api_base: "http://localhost:8080/v1" }]),
    };
    const configured = listVibeConfiguredModels({
      cwd: "/tmp/no-vibe-project",
      homeDirectory: "/tmp/no-vibe-home",
      env,
    }).models;
    const spec = await captureVibeRequest(
      {
        route: { providerId: "mistral", modelId: "selector", backendKind: "mistral-vibe-cli-auth" },
        modelDescriptor: mergeMistralVibeModels(configured, [])[0],
      },
      env,
    );
    expect(JSON.parse(spec.env!.VIBE_MODELS!)[0]).toEqual(configuration);
    expect(spec.env!.VIBE_PROVIDERS).toBe(env.VIBE_PROVIDERS);
  });
}

test("Vibe current/default preserves inherited model and provider overrides", async () => {
  const env = { VIBE_ACTIVE_MODEL: "saved-selector", VIBE_MODELS: "[]", VIBE_PROVIDERS: "[]" };
  const spec = await captureVibeRequest(
    {
      route: {
        providerId: "mistral",
        modelId: "Vibe default",
        backendKind: "mistral-vibe-cli-auth",
      },
    },
    env,
  );
  expect(spec.env).toEqual(env);
});

for (const effort of ["none", "high"])
  test(`Mistral Vibe sends selectable API-native ID and exact ${effort} effort mapping`, async () => {
    const model = parseMistralModels({
      data: [
        {
          id: "mistral-large-4",
          capabilities: {
            completion_chat: true,
            reasoning: true,
            function_calling: true,
            vision: false,
          },
          max_context_length: 32768,
        },
      ],
    })[0]!;
    let captured: CommandSpec | undefined;
    await new Promise<void>((resolve, reject) =>
      runMistralVibe(
        {
          prompt: "hello",
          route: {
            providerId: "mistral",
            modelId: model.modelId,
            reasoning: effort,
            backendKind: "mistral-vibe-cli-auth",
          },
          modelDescriptor: model,
          workspaceRoot: "/tmp",
          runtime,
          providerConfig: { apiKey: "fixture-key", baseUrl: "https://fixture.test/v1" },
        },
        { onResponse: () => resolve(), onError: reject },
        {
          env: {},
          resolveExecutable: async () => "/fixture/vibe",
          findSessionImpl: async () => null,
          runCommandImpl: (spec, handlers) => {
            captured = spec;
            handlers.onStdout?.("OK\n");
            return { result: Promise.resolve(result), cancel: () => {} };
          },
        },
      ),
    );
    const configuredModels = JSON.parse(captured!.env!.VIBE_MODELS!);
    expect(Array.isArray(configuredModels)).toBe(true);
    expect(configuredModels).toHaveLength(1);
    const configured = configuredModels[0];
    expect(configured.alias).toBe(model.modelId);
    expect(captured?.env?.VIBE_ACTIVE_MODEL).toBe(model.modelId);
    expect(configured.name).toBe(model.modelId);
    expect(configured.thinking).toBe(effort === "none" ? "low" : "high");
    expect(configured.max_context_length).toBe(32768);
    expect(JSON.parse(captured!.env!.VIBE_PROVIDERS!)[0].api_base).toBe("https://fixture.test/v1");
  });
test("unsupported Mistral settings stop before spawning", async () => {
  const model = parseMistralModels({
    data: [{ id: "mistral-medium-3-5", capabilities: { completion_chat: true, reasoning: true } }],
  })[0]!;
  let spawned = false;
  const error = await new Promise<string>((resolve) =>
    runMistralVibe(
      {
        prompt: "hi",
        route: {
          providerId: "mistral",
          modelId: model.modelId,
          reasoning: "max",
          backendKind: "mistral-vibe-cli-auth",
        },
        modelDescriptor: model,
        workspaceRoot: "/tmp",
        runtime,
      },
      { onResponse: () => {}, onError: resolve },
      {
        env: {},
        resolveExecutable: async () => "/fixture/vibe",
        runCommandImpl: () => {
          spawned = true;
          return { result: Promise.resolve(result), cancel: () => {} };
        },
      },
    ),
  );
  expect(error).toContain("Unsupported");
  expect(spawned).toBe(false);
});

test("Mistral Vibe refuses a model without a current descriptor before spawning", async () => {
  let spawned = false;
  const error = await new Promise<string>((resolve) =>
    runMistralVibe(
      {
        prompt: "hi",
        route: {
          providerId: "mistral",
          modelId: "mistral-large-4",
          backendKind: "mistral-vibe-cli-auth",
        },
        workspaceRoot: "/tmp",
        runtime,
      },
      { onResponse: () => {}, onError: resolve },
      {
        env: {},
        resolveExecutable: async () => "/fixture/vibe",
        runCommandImpl: () => {
          spawned = true;
          return { result: Promise.resolve(result), cancel: () => {} };
        },
      },
    ),
  );
  expect(error).toContain("not present");
  expect(spawned).toBe(false);
});

test("Mistral Vibe detects a descriptor and selected-ID mismatch before spawning", async () => {
  const descriptor = parseMistralModels({
    data: [{ id: "mistral-small-latest", capabilities: { completion_chat: true } }],
  })[0]!;
  let spawned = false;
  const error = await new Promise<string>((resolve) =>
    runMistralVibe(
      {
        prompt: "hi",
        route: {
          providerId: "mistral",
          modelId: "mistral-large-4",
          backendKind: "mistral-vibe-cli-auth",
        },
        modelDescriptor: descriptor,
        workspaceRoot: "/tmp",
        runtime,
      },
      { onResponse: () => {}, onError: resolve },
      {
        env: {},
        resolveExecutable: async () => "/fixture/vibe",
        runCommandImpl: () => {
          spawned = true;
          return { result: Promise.resolve(result), cancel: () => {} };
        },
      },
    ),
  );
  expect(error).toContain("not present");
  expect(spawned).toBe(false);
});

test("configured local Vibe models keep their provider and do not inherit Mistral credentials", async () => {
  const model = {
    id: "local-devstral",
    modelId: "local-devstral",
    label: "Devstral local",
    description: "devstral via llamacpp",
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    source: "config" as const,
    mistralExecutionClass: "local-vibe" as const,
    executionVerified: false,
    raw: { name: "devstral", alias: "local-devstral", provider: "llamacpp" },
  };
  let captured: CommandSpec | undefined;
  await new Promise<void>((resolve, reject) =>
    runMistralVibe(
      {
        prompt: "hello",
        route: {
          providerId: "mistral",
          modelId: model.modelId,
          backendKind: "mistral-vibe-cli-auth",
        },
        modelDescriptor: model,
        workspaceRoot: "/tmp",
        runtime,
        providerConfig: { apiKey: "must-not-leak", baseUrl: "https://fixture.test/v1" },
      },
      { onResponse: () => resolve(), onError: reject },
      {
        env: {},
        resolveExecutable: async () => "/fixture/vibe",
        findSessionImpl: async () => null,
        runCommandImpl: (spec, handlers) => {
          captured = spec;
          handlers.onStdout?.("OK\n");
          return { result: Promise.resolve(result), cancel: () => {} };
        },
      },
    ),
  );
  const configured = JSON.parse(captured!.env!.VIBE_MODELS!)[0];
  expect(configured.name).toBe("devstral");
  expect(configured.provider).toBe("llamacpp");
  expect(captured?.env?.MISTRAL_API_KEY).toBeUndefined();
  expect(captured?.env?.VIBE_PROVIDERS).toBeUndefined();
});

test("Google request executes agy with exact model and prompt arguments", async () => {
  const model = parseAgyModelsOutput("gemini-3.5-flash-high\tGemini 3.5 Flash (High)")[0]!;
  let captured: CommandSpec | undefined;
  const runner = ((spec: CommandSpec) => {
    captured = spec;
    return {
      child: null,
      result: Promise.resolve({
        status: "completed",
        exitCode: 0,
        signal: null,
        stdout: "Antigravity response",
        stderr: "",
        startedAt: 0,
        endedAt: 0,
        durationMs: 0,
        userMessage: "done",
      }),
      cancel: () => {},
    };
  }) as unknown as typeof runCommand;

  const resultText = await new Promise<string>((resolve, reject) => {
    runAntigravityWithRunner(
      {
        prompt: "hello from test",
        route: {
          providerId: "google",
          modelId: model.modelId,
          backendKind: "antigravity-cli-auth",
        },
        modelDescriptor: model,
        workspaceRoot: "/tmp",
        runtime,
      },
      {
        onResponse: resolve,
        onError: reject,
      },
      runner,
      "agy",
    );
  });

  expect(resultText).toBe("Antigravity response");
  expect(captured?.executable).toBe("agy");
  expect(captured?.args).toEqual([
    "--model",
    "gemini-3.5-flash-high",
    "--mode",
    "auto",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "0",
    "-p",
    "hello from test",
  ]);
});

test("Claude Messages API sends configured endpoint, native ID and only advertised effort", async () => {
  const { anthropicRuntime, resetAnthropicRouteValidationCacheForTests } = await import(
    "./anthropic.js"
  );
  const { parseAnthropicModels } = await import("./anthropicDiscovery.js");
  const model = parseAnthropicModels({
    data: [
      {
        id: "claude-future-99",
        capabilities: { effort: { supported: true, high: { supported: true } } },
      },
    ],
  })[0]!;
  const original = globalThis.fetch;
  let url = "";
  let payload: Record<string, unknown> = {};
  resetAnthropicRouteValidationCacheForTests();
  try {
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      payload = JSON.parse(String(init?.body));
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("fixture");
      return Response.json({ content: [{ type: "text", text: "OK" }] });
    }) as typeof fetch;
    await new Promise<void>((resolve, reject) =>
      anthropicRuntime.run!(
        {
          prompt: "hello",
          route: {
            providerId: "anthropic",
            modelId: model.modelId,
            backendKind: "anthropic-api-key",
            reasoning: "high",
          },
          modelDescriptor: model,
          workspaceRoot: "/tmp",
          runtime,
          providerConfig: { apiKey: "fixture", baseUrl: "https://fixture.test" },
        },
        { onResponse: () => resolve(), onError: reject },
      ),
    );
    expect(url).toBe("https://fixture.test/v1/messages");
    expect(payload.model).toBe(model.modelId);
    expect(payload.output_config).toEqual({ effort: "high" });
  } finally {
    globalThis.fetch = original;
    resetAnthropicRouteValidationCacheForTests();
  }
});

test("Claude effort rejection corrects the catalog without retrying or displaying a lower effort", async () => {
  const { providerCatalog } = await import("../models/modelCatalog.js");
  const { getProviderRuntime } = await import("./registry.js");
  const { resetAnthropicRouteValidationCacheForTests, runClaudeCodeWithRunner } = await import(
    "./anthropic.js"
  );
  const { providerModelsToCodexCapabilities } = await import("./models.js");
  const { buildActiveRuntimeDisplay } = await import("../../ui/render/runtimeDisplay.js");
  const levels = [
    { id: "low", label: "Low", description: null },
    { id: "high", label: "High", description: null },
  ];
  const model = {
    id: "opus-test",
    modelId: "opus-test",
    label: "Opus Test",
    description: null,
    defaultReasoningLevel: "low",
    supportedReasoningLevels: levels,
    reasoningControl: {
      kind: "levels" as const,
      levels,
      default: "low",
      transport: "parameter" as const,
    },
    source: "discovered" as const,
  };
  resetAnthropicRouteValidationCacheForTests([model]);
  const native = getProviderRuntime("anthropic");
  const discovery = {
    status: "ready" as const,
    providerId: "anthropic" as const,
    backendKind: native.backendKind,
    models: [model],
  };
  try {
    await providerCatalog.refresh(
      { ...native, discoverModels: () => discovery, refreshModels: async () => discovery },
      { cwd: "/tmp/claude-effort-fixture", forceRefresh: true },
    );
    const descriptor = providerCatalog.get("anthropic")!.models[0]!;
    const efforts: string[] = [];
    const route = {
      providerId: "anthropic" as const,
      modelId: model.modelId,
      reasoning: "high",
      backendKind: native.backendKind,
    };
    const runner = ((spec: CommandSpec) => {
      const effort = spec.args[spec.args.indexOf("--effort") + 1]!;
      efforts.push(effort);
      return {
        child: null,
        result: Promise.resolve(
          effort === "high"
            ? {
                ...result,
                status: "failed",
                exitCode: 2,
                stdout: "",
                stderr: "Invalid effort high for selected model. Valid efforts: low.",
                userMessage: "Invalid effort high.",
              }
            : result,
        ),
        cancel: () => {},
      };
    }) as unknown as typeof runCommand;
    const failure = await new Promise<string>((resolve, reject) =>
      runClaudeCodeWithRunner(
        { prompt: "hi", route, modelDescriptor: descriptor, workspaceRoot: "/tmp", runtime },
        {
          onResponse: () => reject(new Error("unexpected lower-effort execution")),
          onError: resolve,
        },
        runner,
        "claude",
      ),
    );
    expect(failure).toContain("did not retry at a lower level");
    expect(efforts).toEqual(["high"]);
    expect(route.reasoning).toBe("high");
    const updated = providerCatalog.get("anthropic")!.models;
    expect(updated[0]!.supportedReasoningLevels?.map((l) => l.id)).toEqual(["low"]);
    const capability = providerModelsToCodexCapabilities(updated, model.modelId).models[0]!;
    const display = buildActiveRuntimeDisplay({
      route,
      reasoningLevel: "high",
      mode: "auto",
      tokensUsed: 0,
      modelCapability: capability,
    });
    expect(display.footerModelDisplay).toContain("(High unavailable)");
    expect(display.footerModelDisplay).not.toContain("(Low)");
  } finally {
    providerCatalog.dispose();
    resetAnthropicRouteValidationCacheForTests();
  }
});

test("effective Vibe GLM selection dispatches its configured request name and native thinking level", async () => {
  const model = parseVibeEffectiveModels({
    active_model: "",
    default_label: "GLM-5.3 (Mistral Hosted)",
    models: [
      {
        alias: "glm-5-3",
        name: "glm-5.3",
        provider: "mistral",
        display_name: "GLM-5.3 (Mistral Hosted)",
        thinking: "high",
        thinking_levels: ["off", "medium", "high"],
      },
    ],
  }).models[1];
  const spec = await captureVibeRequest({
    route: {
      providerId: "mistral",
      backendKind: "mistral-vibe-cli-auth",
      modelId: "glm-5-3",
      reasoning: "medium",
    },
    modelDescriptor: model,
  });
  expect(spec.env?.VIBE_ACTIVE_MODEL).toBe("glm-5-3");
  const payload = JSON.parse(spec.env!.VIBE_MODELS!)[0];
  expect(payload.name).toBe("glm-5.3");
  expect(payload.alias).toBe("glm-5-3");
  expect(payload.thinking).toBe("medium");
  expect(payload.thinking_levels).toEqual(["off", "medium", "high"]);
});
