import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalBackend } from "./localBackend.js";

test("the route's backend wins, then the saved Local preference, then LM Studio", () => {
  const savedUnsloth = { providers: { local: { localBackend: "unsloth" as const } } };
  assert.equal(resolveLocalBackend(savedUnsloth, "lm-studio"), "lm-studio");
  assert.equal(resolveLocalBackend(savedUnsloth), "unsloth");
  assert.equal(resolveLocalBackend({}), "lm-studio");
});
