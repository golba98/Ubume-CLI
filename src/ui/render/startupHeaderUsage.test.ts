import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSpec } from "../../core/providerRuntime/contextMetadata.js";
import type { UsageViewState } from "../../core/usage/usageService.js";
import { startupHeaderUsage } from "./startupHeaderUsage.js";

const unknown: ModelSpec = {
  status: "unknown",
  contextWindow: null,
  maxOutputTokens: null,
  sourceUrl: "",
  verifiedAt: null,
  error: null,
};
const known: ModelSpec = {
  status: "verified",
  contextWindow: 10000,
  maxOutputTokens: 1000,
  sourceUrl: "",
  verifiedAt: 0,
};
const empty: UsageViewState = {
  scopeKey: "a",
  snapshot: null,
  origin: "cached",
  inFlight: false,
  nextRefreshAt: 0,
  lastError: undefined,
};
test("usage labels estimated context explicitly, updates from current data and needs no adapter", () => {
  assert.equal(
    startupHeaderUsage(2400, known, empty, "a", "google"),
    "Context: ~24% used (estimate)",
  );
  assert.equal(
    startupHeaderUsage(5000, known, empty, "a", "google"),
    "Context: ~50% used (estimate)",
  );
  assert.equal(startupHeaderUsage(2400, unknown, empty, "a", "google"), "Usage unavailable");
});
test("cached provider allowance is scoped, truthful and never substitutes stale data", () => {
  const view: UsageViewState = {
    ...empty,
    snapshot: {
      scopeKey: "a",
      providerId: "google",
      providerLabel: "Google",
      billingMode: "subscription",
      status: "available",
      freshness: "observed",
      source: "cached fixture",
      limits: [{ id: "window", label: "5-hour allowance", unit: "percent", remainingPercent: 75 }],
      facts: [],
    },
  };
  assert.equal(
    startupHeaderUsage(0, unknown, view, "a", "google"),
    "5-hour allowance: 25% used (cached)",
  );
  assert.equal(startupHeaderUsage(0, unknown, view, "b", "google"), "Usage unavailable");
  assert.equal(startupHeaderUsage(0, unknown, view, "a", "openai"), "Usage unavailable");
  assert.equal(
    startupHeaderUsage(0, unknown, { ...view, origin: "stale" }, "a", "google"),
    "Usage unavailable",
  );
  assert.equal(startupHeaderUsage(100, known, view, "a", "google"), "Context: ~1% used (estimate)");
});
