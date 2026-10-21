import { expect, test } from "bun:test";
import {
  apiRequestError,
  classifyProviderFailure,
  isModelFailure,
  isUnknownCliOption,
} from "./failures.js";

for (const [message, kind] of [
  ["MODEL_NOT_FOUND: gemini-nonexistent", "model-unavailable"],
  ["models/retired is not found for API version v1beta", "model-unavailable"],
  ["Google model withdrawn is unavailable.", "model-unavailable"],
  ["Model x was retired", "model-unavailable"],
  ["You do not have access to model x", "model-unavailable"],
  ["Unsupported model identifier: x", "model-configuration"],
  ["Antigravity has no verified selector for x", "model-configuration"],
  ["Authentication expired; sign in", "authentication"],
  ["Provider request failed (HTTP 401).", "authentication"],
  ["Provider request failed (HTTP 403).", "authentication"],
  ["Model x unavailable: rate limit exceeded", "rate-limit"],
  ["Provider request failed (HTTP 429).", "rate-limit"],
  ["Model x unavailable: quota exhausted", "quota"],
  ["Model x unavailable: network outage", "network"],
  ["ECONNRESET", "network"],
  ["Command timed out before it could finish.", "network"],
  ["Model x unavailable: temporary service failure", "temporary"],
  ["Provider request failed (HTTP 503).", "temporary"],
  ["Provider request failed (HTTP 404).", "unknown"],
  ["Endpoint not found", "unknown"],
] as const) {
  test(`classifies ${message}`, () => {
    const failure = classifyProviderFailure(message);
    expect(failure.kind).toBe(kind);
    expect(isModelFailure(failure)).toBe(
      kind === "model-unavailable" || kind === "model-configuration",
    );
  });
}

test("structured model access denial differs from a generic forbidden response", () => {
  expect(
    apiRequestError(
      403,
      JSON.stringify({ error: { code: "model_access_denied", message: "Model x unavailable" } }),
    ).failure.kind,
  ).toBe("model-unavailable");
  expect(apiRequestError(403, "Forbidden").failure.kind).toBe("authentication");
  expect(apiRequestError(404, "<html>Not found</html>").failure.kind).toBe("unknown");
  expect(
    apiRequestError(429, JSON.stringify({ error: { code: "insufficient_quota" } })).failure.kind,
  ).toBe("quota");
});

test("unknown-option detection recognizes common CLI parsers and only the named flag", () => {
  expect(isUnknownCliOption("Error: unknown flag: --mode", "--mode")).toBe(true);
  expect(isUnknownCliOption("flag provided but not defined: -mode", "--mode")).toBe(true);
  expect(isUnknownCliOption("error: unknown option '--agent'", "--agent")).toBe(true);
  expect(isUnknownCliOption("vibe: error: unrecognized arguments: --agent plan", "--agent")).toBe(
    true,
  );
  expect(isUnknownCliOption("error: unexpected argument '--agent' found", "--agent")).toBe(true);
  expect(isUnknownCliOption("Error: unknown flag: --model", "--mode")).toBe(false);
  expect(isUnknownCliOption("tool output mentioned --mode", "--mode")).toBe(false);
});
