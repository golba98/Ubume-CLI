import type { LocalBackendId, ProviderWorkspaceConfig } from "./types.js";

/**
 * The Local backend a route targets: the route's own backend, then the saved
 * Local preference, then LM Studio. This is the single precedence rule shared
 * by route persistence, catalog discovery and model-evidence connection keys,
 * so every consumer agrees on which Local server a model belongs to.
 */
export function resolveLocalBackend(
  config: ProviderWorkspaceConfig,
  routeLocalBackend?: LocalBackendId,
): LocalBackendId {
  return routeLocalBackend ?? config.providers?.local?.localBackend ?? "lm-studio";
}
