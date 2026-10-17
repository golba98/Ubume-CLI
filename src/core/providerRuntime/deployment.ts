import type { ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import { resolveLocalProviderConfig } from "./local.js";
import type { ActiveProviderRoute } from "./types.js";

/** Loopback is local automatically; LAN connections require an explicit deployment setting. */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Classifies the effective route using explicit deployment configuration before endpoint
 * locality.
 */
export function isLocalRuntime(
  route: ActiveProviderRoute,
  config?: ProviderWorkspaceOverride,
): boolean {
  if (route.providerId === "codexa-native" || route.providerId === "codexa-cupy") return true;
  if (route.providerId !== "local") return false;
  if (config?.deployment) return config.deployment === "local";
  const endpoint =
    route.localBackend === "unsloth"
      ? process.env.UNSLOTH_STUDIO_URL || "http://127.0.0.1:8888"
      : resolveLocalProviderConfig(config).baseUrl;
  return isLocalEndpoint(endpoint);
}
