import assert from "node:assert/strict";
import test from "node:test";
import { providerSecrets, redact } from "./redact.js";

test("redacts secret-looking field names at any depth without mutating the input", () => {
  const input = {
    nested: [{ authorization: "Bearer abc", refresh_token: "r", token: "t", name: "kept" }],
    tokens: 5,
  };
  const output = redact(input) as typeof input;
  assert.deepEqual(output, {
    nested: [
      {
        authorization: "[redacted]",
        refresh_token: "[redacted]",
        token: "[redacted]",
        name: "kept",
      },
    ],
    tokens: 5,
  });
  assert.equal(input.nested[0]?.authorization, "Bearer abc");
});

test("redacts values of secret-named environment variables, ignoring very short ones", () => {
  const previous = { long: process.env.UBUME_TEST_API_KEY, short: process.env.UBUME_TEST_TOKEN };
  process.env.UBUME_TEST_API_KEY = "sk-live-value";
  process.env.UBUME_TEST_TOKEN = "abc";
  try {
    assert.equal(redact("key sk-live-value and abc"), "key [redacted] and abc");
  } finally {
    for (const [name, value] of [
      ["UBUME_TEST_API_KEY", previous.long],
      ["UBUME_TEST_TOKEN", previous.short],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("masks URL credentials and secret query parameters and strips terminal escapes", () => {
  assert.equal(
    redact("\x1b[31mhttp://u:p@host/x?api_key=1&other=2\x1b[0m"),
    "http://[redacted]@host/x?api_key=[redacted]&other=2",
  );
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
});

test("providerSecrets collects configured API keys only", () => {
  assert.deepEqual(
    providerSecrets({
      providers: { local: { apiKey: "local-key" }, mistral: {}, anthropic: { apiKey: "" } },
    } as never),
    ["local-key"],
  );
  assert.deepEqual(providerSecrets({} as never), []);
});
