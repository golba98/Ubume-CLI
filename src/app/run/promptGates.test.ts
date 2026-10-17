import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import {
  checkCodexAuth,
  checkImageSupport,
  checkRouteReady,
  checkWorkspaceBoundary,
  sanitizePrompts,
} from "./promptGates.js";

const ready = {
  routeChoiceRequired: null,
  pendingProviderId: null,
  activeProviderId: "google" as const,
  modelId: "gemini-x",
  retryDelayMs: 0,
  modelUnavailable: false,
};

test("a ready route passes", () => {
  assert.equal(checkRouteReady(ready), null);
});

test("route gates report in priority order", () => {
  assert.equal(
    checkRouteReady({ ...ready, routeChoiceRequired: "Pick one", modelUnavailable: true })?.title,
    "Select a route first",
  );
  assert.equal(
    checkRouteReady({ ...ready, pendingProviderId: "anthropic", retryDelayMs: 5 })?.title,
    "Choose a model",
  );
  assert.equal(
    checkRouteReady({ ...ready, pendingProviderId: "google" }),
    null,
    "a pending provider that is already active does not block",
  );
  assert.match(
    checkRouteReady({ ...ready, retryDelayMs: 1500, modelUnavailable: true })?.message ?? "",
    /Retry in 2 seconds/,
  );
  const unavailable = checkRouteReady({ ...ready, modelUnavailable: true });
  assert.equal(unavailable?.title, "Model unavailable");
  assert.match(unavailable?.message ?? "", /gemini-x/);
});

test("prompts that are only control characters are blocked", () => {
  assert.deepEqual(sanitizePrompts("  hi ", "hi there "), {
    safeDisplayPrompt: "hi",
    safeProviderPrompt: "hi there",
  });
  const blocked = sanitizePrompts("\u0007", "hello");
  assert.ok("title" in blocked);
  assert.equal(blocked.title, "Prompt blocked");
});

test("Codexa is exempt from the workspace boundary", () => {
  const prompt = "Write a file to /etc/ubume-test.conf";
  const rejection = checkWorkspaceBoundary(prompt, "/tmp/ws", [], "openai");
  if (rejection) {
    assert.equal(rejection.title, "Workspace boundary");
  }
  assert.equal(checkWorkspaceBoundary(prompt, "/tmp/ws", [], "codexa-native"), null);
});

test("images are accepted only by OpenAI and vision-enabled Local models", () => {
  const route = (providerId: ProviderRoute["providerId"]) =>
    ({ providerId, modelId: "m", backendKind: "codex-cli-auth" }) as ProviderRoute;
  const vision = { capabilityProfile: { supportsVision: true } } as unknown as ProviderConfig;
  assert.equal(checkImageSupport(route("google"), null, 0), null, "no images, no check");
  assert.equal(checkImageSupport(route("openai"), null, 1), null);
  assert.equal(checkImageSupport(route("local"), vision, 1), null);
  assert.match(checkImageSupport(route("local"), null, 1)?.message ?? "", /supports_vision/);
  assert.equal(checkImageSupport(route("anthropic"), null, 2)?.title, "Image not supported");
});

test("only the real Codex subprocess route is gated on login", () => {
  const signedOut = { state: "unauthenticated", checkedAt: 1 } as never;
  assert.equal(
    checkCodexAuth({
      hasProviderOverride: false,
      providerId: "openai",
      backend: "codex-subprocess",
      authStatus: signedOut,
    }).rejection?.title,
    "Authentication required",
  );
  for (const input of [
    { hasProviderOverride: true, providerId: "openai" as const },
    { hasProviderOverride: false, providerId: "google" as const },
  ]) {
    assert.deepEqual(
      checkCodexAuth({ ...input, backend: "codex-subprocess", authStatus: signedOut }),
      { rejection: null, warning: null },
    );
  }
});

test("an unknown login state after a probe warns but still runs", () => {
  const result = checkCodexAuth({
    hasProviderOverride: false,
    providerId: "openai",
    backend: "codex-subprocess",
    authStatus: { state: "unknown", checkedAt: 1 } as never,
  });
  assert.equal(result.rejection, null);
  assert.match(result.warning ?? "", /codex login/);
});
