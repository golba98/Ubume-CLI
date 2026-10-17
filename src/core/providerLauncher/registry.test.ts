import assert from "node:assert/strict";
import test from "node:test";
import { checkLocalProvider, resetLocalProviderStateForTests } from "../providerRuntime/local.js";
import { resolveActiveProviderRoute } from "../providerRuntime/registry.js";
import { buildProviderRegistry, getDefaultProviderId, isKnownProviderId } from "./registry.js";
import { parseProviderWorkspaceConfig, setProviderActiveRoute } from "./workspaceConfig.js";

test("provider registry includes Google and preserves native development-channel gating", () => {
  const dev = buildProviderRegistry({
    activeModel: "gpt-5.4",
    env: { UBUME_CHANNEL: "local-dev" },
  });
  const prod = buildProviderRegistry({
    activeModel: "gpt-5.4",
    env: { UBUME_CHANNEL: "published" },
  });
  assert.ok(dev.find((provider) => provider.id === "codexa-native"));
  assert.ok(dev.find((provider) => provider.id === "codexa-cupy"));
  assert.equal(
    prod.find((provider) => provider.id === "codexa-native"),
    undefined,
  );
  assert.equal(
    prod.find((provider) => provider.id === "codexa-cupy"),
    undefined,
  );
  for (const providers of [dev, prod]) {
    assert.equal(providers.filter((provider) => provider.displayName === "Google").length, 1);
    assert.equal(
      providers.find((provider) => provider.id === "google")?.backendType,
      "antigravity-cli-auth",
    );
    assert.equal(
      providers.some((provider) => provider.launchCommand?.executable === "gemini"),
      false,
    );
    assert.deepEqual(providers.find((provider) => provider.id === "google")?.launchCommand, {
      executable: "agy",
      args: [],
    });
    assert.deepEqual(providers.find((provider) => provider.id === "mistral")?.launchCommand, {
      executable: "vibe",
      args: [],
    });
  }
});

test("Codexa Native remains a known provider ID so workspace config preserves overrides when saved", () => {
  assert.equal(isKnownProviderId("codexa-native"), true);
  const parsed = parseProviderWorkspaceConfig({
    providers: {
      "codexa-native": { current_model: "codexa-1b-sft-v2-native" },
      openai: { current_model: "gpt-5.4" },
    },
  });
  assert.ok(parsed.providers?.["codexa-native"]);
  assert.equal(parsed.providers["codexa-native"].currentModel, "codexa-1b-sft-v2-native");
});

test("Mistral Vibe can be the workspace default without becoming the active chat route", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      workspaceDefaultProviderId: "mistral",
      activeRoute: { providerId: "openai", modelId: "gpt-5.4", backendKind: "codex-cli-auth" },
    },
  });

  const mistral = providers.find((provider) => provider.id === "mistral");
  assert.equal(mistral?.isDefault, true);
  assert.equal(mistral?.isActiveRoute, false);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isActiveRoute, true);
});

test("Antigravity is no longer a known or listed provider", () => {
  assert.equal(isKnownProviderId("antigravity"), false);
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    env: { UBUME_CHANNEL: "local-dev" },
  });
  assert.equal(
    providers.some((provider) => (provider.id as string) === "antigravity"),
    false,
  );
});

test("workspace config can set the default provider", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: { workspaceDefaultProviderId: "anthropic" },
  });

  assert.equal(getDefaultProviderId({ workspaceDefaultProviderId: "anthropic" }), "anthropic");
  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isDefault, true);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isDefault, false);
});

test("provider registry keeps workspace default separate from active route", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      workspaceDefaultProviderId: "anthropic",
      activeRoute: {
        providerId: "openai",
        modelId: "gpt-5.4",
      },
    },
  });

  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isDefault, true);
  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isActiveRoute, false);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isDefault, false);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isActiveRoute, true);
});

test("unvalidated local provider remains disabled until endpoint discovery succeeds", () => {
  resetLocalProviderStateForTests();
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      workspaceDefaultProviderId: "anthropic",
      activeRoute: {
        providerId: "local",
        modelId: "llama-local",
      },
    },
  });

  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isDefault, true);
  assert.equal(providers.find((provider) => provider.id === "local")?.isActiveRoute, true);
  assert.equal(providers.find((provider) => provider.id === "local")?.routeMode, "in-ubume");
  assert.equal(providers.find((provider) => provider.id === "local")?.enabled, false);
});

test("registry retains Google active route independently of OpenAI", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      activeRoute: {
        providerId: "google",
        modelId: "gemini-99.8-flash",
        backendKind: "antigravity-cli-auth",
      },
    },
  });
  assert.equal(providers.find((provider) => provider.id === "google")?.isActiveRoute, true);
  assert.equal(providers.find((provider) => provider.id === "openai")?.isActiveRoute, false);
});

test("anthropic can be selected as an active in-Ubume route", () => {
  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      activeRoute: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        backendKind: "anthropic-api-key",
      },
    },
  });

  assert.equal(providers.find((provider) => provider.id === "anthropic")?.isActiveRoute, true);
  assert.equal(providers.find((provider) => provider.id === "anthropic")?.routeMode, "in-ubume");
  assert.equal(
    providers.find((provider) => provider.id === "anthropic")?.currentModel,
    "claude-sonnet-4-20250514",
  );
  assert.equal(providers.find((provider) => provider.id === "openai")?.isActiveRoute, false);
});

test("discovered local models enable local provider and display selected model", async () => {
  resetLocalProviderStateForTests();
  const localOverride = {
    currentModel: "google/gemma-4-26b-a4b",
  };
  await checkLocalProvider({
    override: localOverride,
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

  const providers = buildProviderRegistry({
    activeModel: "gpt-5.4",
    workspaceConfig: {
      activeRoute: {
        providerId: "local",
        modelId: "google/gemma-4-26b-a4b",
        backendKind: "local-openai-compatible",
      },
      providers: {
        local: localOverride,
      },
    },
  });

  const local = providers.find((provider) => provider.id === "local");
  assert.equal(local?.enabled, true);
  assert.equal(local?.currentModel, "google/gemma-4-26b-a4b");
  assert.equal(local?.backendType, "local-openai-compatible");
  assert.equal(local?.statusLabel, "Enabled");
  assert.deepEqual(local?.launchCommand, null);
  resetLocalProviderStateForTests();
});

test("LM Studio loaded Local model replaces stale active route in provider registry", async () => {
  resetLocalProviderStateForTests();
  try {
    await checkLocalProvider({
      override: {
        currentModel: "google/gemma-4-26b-a4b",
        defaultModel: "google/gemma-4-26b-a4b",
        baseUrl: "http://localhost:1234/v1",
      },
      fetchImpl: (async (input) => {
        if (String(input).includes("/api/v0/")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "qwen/qwen3.6-27b",
                  state: "loaded",
                  loaded_context_length: 32000,
                  max_context_length: 262144,
                  capabilities: ["tool_use"],
                },
              ],
              object: "list",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            data: [{ id: "google/gemma-4-26b-a4b" }, { id: "qwen/qwen3.6-27b" }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const providers = buildProviderRegistry({
      activeModel: "gpt-5.4",
      workspaceConfig: {
        activeRoute: {
          providerId: "local",
          modelId: "google/gemma-4-26b-a4b",
          backendKind: "local-openai-compatible",
        },
        providers: {
          local: {
            currentModel: "google/gemma-4-26b-a4b",
            defaultModel: "google/gemma-4-26b-a4b",
            baseUrl: "http://localhost:1234/v1",
          },
        },
      },
    });

    const local = providers.find((provider) => provider.id === "local");
    assert.equal(local?.currentModel, "qwen/qwen3.6-27b");
    assert.equal(local?.contextLengthLabel, "32,000");
    assert.equal(local?.contextLengthSource, "lmstudio-api");
    assert.equal(local?.capabilityProfile?.supportsToolCalls, true);
    assert.equal(local?.capabilityProfile?.supportsVision, null);
  } finally {
    resetLocalProviderStateForTests();
  }
});

test("runtime resolver preserves Google selection even while access is unavailable", () => {
  const original: import("./types.js").ProviderWorkspaceConfig = {
    activeRoute: { providerId: "openai", modelId: "gpt-5.4", backendKind: "codex-cli-auth" },
  };
  const result = setProviderActiveRoute(original, {
    providerId: "google",
    modelId: "gemini-99.8-pro",
    backendKind: "antigravity-cli-auth",
  });
  assert.equal(
    result.activeRoute?.providerId,
    "google",
    "Provider preferences do not depend on runtime readiness",
  );
  const route = resolveActiveProviderRoute({
    workspaceConfigActiveRoute: {
      providerId: "google",
      modelId: "gemini-99.8-pro",
      backendKind: "antigravity-cli-auth",
    },
    currentModel: "gpt-5.4",
    currentReasoning: "medium",
  });
  assert.equal(route.providerId, "google");
  assert.equal(route.modelId, "gemini-99.8-pro");
});
