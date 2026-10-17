import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderModel } from "../core/providerRuntime/types.js";
import { isUsableSavedModel } from "./useProviderRoute.js";

function model(modelId: string): ProviderModel {
  return {
    id: modelId,
    modelId,
    label: modelId,
    description: null,
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
  };
}

test("Vibe's own default entry is a real Mistral choice, so selecting Mistral needs no picker", () => {
  const vibeCatalog = [model("devstral-small"), model("Vibe default"), model("mistral-medium-3.5")];
  assert.equal(isUsableSavedModel("Vibe default", vibeCatalog), true);
});

test("registry placeholders that no catalog lists still require a model choice", () => {
  assert.equal(isUsableSavedModel("Google default", [model("gemini-3.8-flash")]), false);
  assert.equal(isUsableSavedModel("Claude Code default", []), false);
  assert.equal(isUsableSavedModel("Vibe default", []), false);
  assert.equal(isUsableSavedModel("", [model("x")]), false);
  assert.equal(isUsableSavedModel(undefined, [model("x")]), false);
});

test("concrete saved models stay usable even before discovery has loaded", () => {
  assert.equal(isUsableSavedModel("mistral-medium-3.5", []), true);
  assert.equal(isUsableSavedModel("gemini-3.8-flash", []), true);
});

test("a verified catalog is authoritative: only listed, available models are usable", () => {
  const unavailable = { ...model("gemini-old"), available: false };
  const catalog = [model("gemini-3.8-flash"), unavailable];
  assert.equal(isUsableSavedModel("gemini-3.8-flash", catalog, true), true);
  assert.equal(isUsableSavedModel("gemini-old", catalog, true), false);
  assert.equal(isUsableSavedModel("gemini-removed", catalog, true), false);
  assert.equal(isUsableSavedModel(undefined, catalog, true), false);
});
