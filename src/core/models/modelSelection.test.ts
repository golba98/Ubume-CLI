import { expect, test } from "bun:test";
import type { ProviderModelDiscoveryResult } from "../providerRuntime/types.js";
import { isCatalogModelUnavailable } from "./modelSelection.js";

const catalog: ProviderModelDiscoveryResult = {
  providerId: "google",
  backendKind: "antigravity-cli-auth",
  status: "ready",
  models: [],
};
test("only complete verified discovery can establish rejection through absence", () => {
  expect(isCatalogModelUnavailable(catalog, "new-model")).toBe(false);
  expect(
    isCatalogModelUnavailable({ ...catalog, freshness: "verified", complete: false }, "new-model"),
  ).toBe(false);
  expect(
    isCatalogModelUnavailable({ ...catalog, freshness: "unverified", complete: true }, "new-model"),
  ).toBe(false);
  expect(
    isCatalogModelUnavailable({ ...catalog, freshness: "verified", complete: true }, "retired"),
  ).toBe(true);
});
test("authoritative per-model availability can reject a listed model without rejecting its provider", () => {
  const denied = {
    ...catalog,
    freshness: "verified" as const,
    complete: false,
    models: [
      {
        id: "denied",
        modelId: "denied",
        label: "Denied",
        available: false,
        description: null,
        defaultReasoningLevel: null,
        supportedReasoningLevels: null,
      },
    ],
  };
  expect(isCatalogModelUnavailable(denied, "denied")).toBe(true);
  expect(denied.status).toBe("ready");
  expect(isCatalogModelUnavailable({ ...denied, freshness: "unverified" }, "denied")).toBe(false);
});
