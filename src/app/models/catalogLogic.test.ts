import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderModel } from "../../core/providerRuntime/types.js";
import { openAiCapabilitiesFromDiscovery } from "./catalogLogic.js";

const models: ProviderModel[] = [
  {
    id: "gpt-a",
    modelId: "gpt-a",
    label: "GPT A",
    description: null,
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
  },
];

test("a verified OpenAI catalog is ready with no error", () => {
  const capabilities = openAiCapabilitiesFromDiscovery({ models, freshness: "verified" }, "gpt-a");
  assert.equal(capabilities.status, "ready");
  assert.equal(capabilities.error, null);
  assert.ok(capabilities.models.some((model) => model.id === "gpt-a"));
});

test("an unverified OpenAI catalog is a fallback that explains why", () => {
  assert.equal(
    openAiCapabilitiesFromDiscovery({ models, freshness: "unverified" }, "gpt-a").error,
    "Cached Codex inventory is unverified.",
  );
  const failed = openAiCapabilitiesFromDiscovery(
    { models, freshness: "unverified", message: "codex not found" },
    "gpt-a",
  );
  assert.equal(failed.status, "fallback");
  assert.equal(failed.error, "codex not found");
});
