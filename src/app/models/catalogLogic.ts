/**
 * Pure helpers for the model-catalog hook (`useModelCatalog`).
 *
 * Kept free of React and I/O so catalog-to-UI conversions can be unit tested
 * and shared between the catalog subscription and explicit refreshes.
 */

import type { CodexModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import { providerModelsToCodexCapabilities } from "../../core/providerRuntime/models.js";
import type { ProviderModelDiscoveryResult } from "../../core/providerRuntime/types.js";

/**
 * Converts an OpenAI catalog snapshot into the Codex capability shape the
 * model picker and `/models` use.
 *
 * A verified snapshot is `ready`. Anything else (cached or failed discovery)
 * is a `fallback` that carries the catalog's explanation, so the UI can still
 * offer the listed models while saying they are unconfirmed.
 */
export function openAiCapabilitiesFromDiscovery(
  discovery: Pick<ProviderModelDiscoveryResult, "models" | "freshness" | "message">,
  activeModelId: string,
): CodexModelCapabilities {
  const verified = discovery.freshness === "verified";
  return {
    ...providerModelsToCodexCapabilities(discovery.models, activeModelId),
    status: verified ? "ready" : "fallback",
    error: verified ? null : (discovery.message ?? "Cached Codex inventory is unverified."),
  };
}
