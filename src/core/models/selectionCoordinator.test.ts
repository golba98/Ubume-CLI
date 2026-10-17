import { expect, test } from "bun:test";
import type { ProviderId } from "../providerLauncher/types.js";
import { classifyProviderFailure } from "../providerRuntime/failures.js";
import { getProviderRuntime } from "../providerRuntime/registry.js";
import { SelectionCoordinator } from "./selectionCoordinator.js";

for (const providerId of ["openai", "anthropic", "google", "mistral", "local"] as ProviderId[]) {
  test(`${providerId}: model failures are scoped and transient failures never reject the model`, () => {
    const state = new SelectionCoordinator();
    const route = {
      providerId,
      modelId: "withdrawn",
      backendKind: getProviderRuntime(providerId).backendKind,
    };
    const transition = state.begin(route, "account-a");
    state.commit(transition);
    for (const message of [
      "Authentication expired",
      "HTTP 429",
      "Quota exhausted",
      "ECONNRESET",
      "HTTP 503",
    ])
      state.reject("account-a", route.modelId, classifyProviderFailure(message));
    expect(state.state("account-a", route.modelId)?.status).toBe("provisional");
    state.reject(
      "account-a",
      route.modelId,
      classifyProviderFailure("Model withdrawn is unavailable"),
    );
    expect(state.state("account-a", route.modelId)?.status).toBe("unavailable");
    expect(state.state("account-b", route.modelId)).toBeUndefined();
    expect(state.state("account-a", "working")).toBeUndefined();
    const valid = { ...route, modelId: "working" };
    state.commit(state.begin(valid, "account-a"));
    state.validate("account-a", valid);
    expect(state.lastValidatedRoute).toEqual(valid);
    expect(state.state("account-a", valid.modelId)?.status).toBe("validated");
    expect(state.state("account-a", route.modelId)?.status).toBe("unavailable");
  });
}

test("old request failures cannot invalidate a reselected model", () => {
  const state = new SelectionCoordinator();
  const route = {
    providerId: "google" as const,
    modelId: "x",
    backendKind: "antigravity-cli-auth" as const,
  };
  const old = state.begin(route, "connection");
  state.commit(old);
  const revision = state.revision("connection", "x");
  const next = state.begin(route, "connection");
  state.commit(next);
  state.validate("connection", route);
  state.reject("connection", "x", classifyProviderFailure("Model x is unavailable"), revision);
  expect(old.signal.aborted).toBe(true);
  expect(state.commit(old)).toBe(false);
  expect(state.state("connection", "x")?.status).toBe("validated");
});

test("navigation and cancellation prevent stale focus and route commits", () => {
  const state = new SelectionCoordinator();
  const transition = state.begin(
    { providerId: "google", modelId: "x", backendKind: "antigravity-cli-auth" },
    "connection",
  );
  state.navigate("openai");
  expect(state.ownsNavigation(transition)).toBe(false);
  state.cancel();
  expect(state.isCurrent(transition)).toBe(false);
  expect(state.commit(transition)).toBe(false);
  expect(state.selectedProviderId).toBe("openai");
});
