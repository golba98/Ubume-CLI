import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withEnvironment } from "../../test/environment.js";
import type { ProviderModel } from "../providerRuntime/types.js";
import { loadCachedProviderModels, saveCachedProviderModels } from "./modelCache.js";

function tempCacheFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ubume-model-cache-"));
  return {
    file: join(dir, "model-cache.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const SAMPLE_MODELS: readonly ProviderModel[] = [
  {
    id: "gpt-5.6-sol",
    modelId: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: [
      { id: "low", label: "Low", description: null },
      { id: "high", label: "High", description: null },
    ],
    source: "discovered",
  },
];

test("Google caches require Antigravity provenance and preserve the old Gemini inventory on save", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    const legacy = { discoveredAt: 1, models: SAMPLE_MODELS };
    writeFileSync(
      file,
      JSON.stringify({ version: 1, providers: { google: legacy, antigravity: legacy } }),
    );
    assert.equal(loadCachedProviderModels("google", file), null);
    assert.deepEqual(loadCachedProviderModels("antigravity", file), legacy);
    saveCachedProviderModels("google", { discoveredAt: 2, models: [] }, file);
    assert.equal(loadCachedProviderModels("google", file)?.backendKind, "antigravity-cli-auth");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(saved.legacyGoogleCli, legacy);
    assert.deepEqual(saved.providers.antigravity, legacy);
  } finally {
    cleanup();
  }
});

test("round-trips a provider entry", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    saveCachedProviderModels("openai", { discoveredAt: 123, models: SAMPLE_MODELS }, file);
    const loaded = loadCachedProviderModels("openai", file);
    assert.ok(loaded);
    assert.equal(loaded.discoveredAt, 123);
    assert.equal(loaded.models.length, 1);
    assert.equal(loaded.models[0]!.modelId, "gpt-5.6-sol");
    assert.equal(loaded.models[0]!.supportedReasoningLevels?.length, 2);
  } finally {
    cleanup();
  }
});

test("providers are isolated from each other", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    saveCachedProviderModels("openai", { discoveredAt: 1, models: SAMPLE_MODELS }, file);
    saveCachedProviderModels(
      "anthropic",
      {
        discoveredAt: 2,
        models: [{ ...SAMPLE_MODELS[0]!, id: "opus", modelId: "opus", label: "Claude Opus" }],
      },
      file,
    );
    assert.equal(loadCachedProviderModels("openai", file)?.models[0]?.modelId, "gpt-5.6-sol");
    assert.equal(loadCachedProviderModels("anthropic", file)?.models[0]?.modelId, "opus");
    assert.equal(loadCachedProviderModels("google", file), null);
  } finally {
    cleanup();
  }
});

test("missing file loads as null", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    assert.equal(loadCachedProviderModels("openai", file), null);
  } finally {
    cleanup();
  }
});

test("corrupt JSON loads as null and is overwritten by the next save", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    writeFileSync(file, "{ not json", "utf8");
    assert.equal(loadCachedProviderModels("openai", file), null);
    saveCachedProviderModels("openai", { discoveredAt: 5, models: SAMPLE_MODELS }, file);
    assert.equal(loadCachedProviderModels("openai", file)?.discoveredAt, 5);
  } finally {
    cleanup();
  }
});

test("unknown cache version loads as null", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 99,
        providers: { openai: { discoveredAt: 1, models: SAMPLE_MODELS } },
      }),
      "utf8",
    );
    assert.equal(loadCachedProviderModels("openai", file), null);
  } finally {
    cleanup();
  }
});

test("entries with malformed models load as null", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        providers: { openai: { discoveredAt: 1, models: [{ bogus: true }] } },
      }),
      "utf8",
    );
    assert.equal(loadCachedProviderModels("openai", file), null);
  } finally {
    cleanup();
  }
});

test("verified empty model inventories replace withdrawn cached models", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    saveCachedProviderModels("openai", { discoveredAt: 9, models: SAMPLE_MODELS }, file);
    saveCachedProviderModels("openai", { discoveredAt: 10, models: [] }, file);
    assert.equal(loadCachedProviderModels("openai", file)?.discoveredAt, 10);
    assert.deepEqual(loadCachedProviderModels("openai", file)?.models, []);
  } finally {
    cleanup();
  }
});

test("Mistral legacy API-only cache rows cannot re-enter the native Vibe picker", () => {
  const { file, cleanup } = tempCacheFile();
  try {
    const native = {
      ...SAMPLE_MODELS[0],
      modelId: "glm-5-3",
      mistralExecutionClass: "native-vibe" as const,
    };
    const custom = {
      ...SAMPLE_MODELS[0],
      modelId: "codestral-2508",
      mistralExecutionClass: "custom-vibe" as const,
    };
    saveCachedProviderModels("mistral", { discoveredAt: 1, models: [native, custom] }, file);
    assert.deepEqual(
      loadCachedProviderModels("mistral", file)?.models.map((m) => m.modelId),
      ["glm-5-3"],
    );
    assert.match(readFileSync(file, "utf8"), /codestral-2508/);
  } finally {
    cleanup();
  }
});

test("model-cache migration preserves legacy contents and writes only Ubume", async () => {
  const home = mkdtempSync(join(tmpdir(), "ubume-model-import-"));
  try {
    await withEnvironment({ HOME: home, USERPROFILE: home }, () => {
      const legacy = join(home, ".codexa-model-cache.json");
      const initial = JSON.stringify({
        version: 1,
        providers: {
          "codexa-native": {
            discoveredAt: 1,
            models: [{ ...SAMPLE_MODELS[0], id: "codexa-934m-end3", modelId: "codexa-934m-end3" }],
          },
        },
      });
      writeFileSync(legacy, initial);
      assert.equal(
        loadCachedProviderModels("codexa-native")?.models[0]?.modelId,
        "codexa-934m-end3",
      );
      saveCachedProviderModels("openai", { discoveredAt: 2, models: SAMPLE_MODELS });
      assert.equal(readFileSync(legacy, "utf8"), initial);
      const current = JSON.parse(readFileSync(join(home, ".ubume-model-cache.json"), "utf8"));
      assert.equal(current.providers["codexa-native"].models[0].modelId, "codexa-934m-end3");
      assert.equal(
        loadCachedProviderModels("openai")?.models[0]?.modelId,
        SAMPLE_MODELS[0]?.modelId,
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
