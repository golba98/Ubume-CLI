import type { ProviderModel, ProviderModelDiscoveryResult } from "../providerRuntime/types.js";
import { isRecord } from "../shared/values.js";

/** Aliases are provider-advertised or Vibe configuration mappings, never inferred from labels. */
export function resolveCatalogModel(
  models: readonly ProviderModel[],
  id: string,
): ProviderModel | undefined {
  const exact = models.find((model) => model.modelId === id || model.id === id);
  if (exact) return exact;
  return models.find(
    (model) =>
      model.canonicalId === id ||
      (isRecord(model.raw) &&
        [model.raw.aliases, model.raw.vibeAliases].some(
          (aliases) => Array.isArray(aliases) && aliases.includes(id),
        )),
  );
}

/** Failed discovery and partial alias lists cannot establish that a model disappeared. */
export function isCatalogModelUnavailable(
  catalog: ProviderModelDiscoveryResult,
  id: string,
): boolean {
  if (catalog.freshness !== "verified") return false;
  const model = resolveCatalogModel(catalog.models, id);
  return model?.available === false || (catalog.complete === true && !model);
}
