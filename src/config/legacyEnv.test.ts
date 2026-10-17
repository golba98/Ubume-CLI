import assert from "node:assert/strict";
import test from "node:test";
import { applyLegacyEnvAliases } from "./legacyEnv.js";

test("applyLegacyEnvAliases copies CODEXA_* variables into unset UBUME_* names", () => {
  const env: NodeJS.ProcessEnv = { CODEXA_RENDER_DEBUG: "1", CODEXA_DATA_DIR: "/data/codexa" };
  applyLegacyEnvAliases(env);
  assert.equal(env.UBUME_RENDER_DEBUG, "1");
  assert.equal(env.UBUME_DATA_DIR, "/data/codexa");
});

test("applyLegacyEnvAliases never overrides an explicit UBUME_* value", () => {
  const env: NodeJS.ProcessEnv = { CODEXA_CHANNEL: "local-dev", UBUME_CHANNEL: "published" };
  applyLegacyEnvAliases(env);
  assert.equal(env.UBUME_CHANNEL, "published");
});

test("applyLegacyEnvAliases leaves Codexa model-family variables unaliased", () => {
  const env: NodeJS.ProcessEnv = {
    CODEXA_NATIVE_MODEL_ROOT: "/models/pytorch",
    CODEXA_CUPY_DEVICE: "cuda",
    CODEXA_NUMPY_PYTHON: "/python",
  };
  applyLegacyEnvAliases(env);
  assert.equal(env.UBUME_NATIVE_MODEL_ROOT, undefined);
  assert.equal(env.UBUME_CUPY_DEVICE, undefined);
  assert.equal(env.UBUME_NUMPY_PYTHON, undefined);
});

test("applyLegacyEnvAliases handles empty, undefined, and non-prefixed variables gracefully", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    CODEXA_: "empty-suffix",
    CODEXA_EMPTY: "",
    CODEXA_UNDEFINED: undefined,
  };
  applyLegacyEnvAliases(env);
  assert.equal(env.UBUME_, "empty-suffix");
  assert.equal(env.UBUME_EMPTY, "");
  assert.equal(env.UBUME_UNDEFINED, undefined);
  assert.equal(env.PATH, "/usr/bin");
});
