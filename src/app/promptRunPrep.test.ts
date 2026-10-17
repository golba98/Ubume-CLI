import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RUNTIME_CONFIG } from "../config/runtimeConfig.js";
import { preparePromptRun } from "./promptRunPrep.js";

test("Codexa stays conversational even with editing mode and a cleanup-looking prompt", () => {
  const result = preparePromptRun(
    { ...DEFAULT_RUNTIME_CONFIG, mode: "auto-edit" },
    {},
    "Delete generated temporary files and implement the plan",
    {
      providerId: "codexa-native",
      modelId: "codexa-934m-balanced",
      backendKind: "codexa-native-pytorch",
    },
    {},
  );
  assert.equal(result.effectiveMode, "suggest");
  assert.equal(result.executionModeDecision.autoUpgraded, false);
  assert.equal(result.fastCleanupRun, false);
});
