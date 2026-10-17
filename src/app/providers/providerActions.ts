/**
 * Pure decisions behind the provider picker (`useProviderRoute`).
 *
 * Everything here is deterministic: it reads configuration, catalog snapshots
 * and validation results and returns a decision or a message. The hook owns
 * the side effects (screen changes, persistence, probes and launches).
 */

import { resolveCatalogModel } from "../../core/models/modelSelection.js";
import type { ProviderConfig, ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import type {
  ProviderModel,
  ProviderModelDiscoveryResult,
  ProviderRouteValidationResult,
} from "../../core/providerRuntime/types.js";
import type { LocalBackendStatus } from "../../ui/panels/ProviderPicker.js";

const LOCAL_AUTH_FAILURE = /api key|authentication|authenticate|identity/i;
const LOCAL_NO_MODEL = /no model is loaded|no models were returned/i;
const LOCAL_TIMEOUT = /timed out/i;

/**
 * Whether a provider's saved model can be used directly when the provider is
 * selected. Registry placeholders ("Google default", "Claude Code default") are
 * not choices, but a "… default" entry the provider's own catalog lists is —
 * Mistral's "Vibe default" runs whatever model Vibe itself has active.
 *
 * When `catalogVerified` is true the catalog is a complete, authoritative
 * inventory, so a model must be listed and not marked unavailable.
 */
export function isUsableSavedModel(
  model: string | undefined,
  catalog: readonly ProviderModel[],
  catalogVerified = false,
): boolean {
  if (!model) {
    return false;
  }
  if (catalogVerified) {
    const descriptor = resolveCatalogModel(catalog, model);
    return descriptor !== undefined && descriptor.available !== false;
  }
  if (!model.endsWith("default")) {
    return true;
  }
  return resolveCatalogModel(catalog, model) !== undefined;
}

/** What selecting a provider with "Use in Ubume" should do. */
export type ProviderActivation =
  | { kind: "activate"; model: string; reasoning: string }
  | { kind: "pick-model" };

/**
 * Decides whether selecting a (non-Local) provider can activate its saved
 * model straight away or must open that provider's model picker.
 *
 * The saved model is only reused when nothing says it is unusable: it has no
 * session rejection (`rejected`), the catalog does not mark it unavailable,
 * and {@link isUsableSavedModel} accepts it. This is what stops a rejected
 * Google model from being retried every time the user returns to Google.
 *
 * Reasoning falls back from the provider's saved reasoning, to the active
 * route's reasoning when this provider is already active, to the catalog
 * default for Google, and finally to the session's reasoning level.
 */
export function resolveProviderActivation(input: {
  provider: ProviderConfig;
  config: ProviderWorkspaceConfig;
  discovery: ProviderModelDiscoveryResult;
  rejected: boolean;
  catalogMarksUnavailable: boolean;
  sessionReasoningLevel: string;
}): ProviderActivation {
  const { provider, config, discovery, rejected, catalogMarksUnavailable } = input;
  const providerConfig = config.providers?.[provider.id];
  const savedModel = providerConfig?.currentModel ?? provider.currentModel;
  const catalogIsAuthoritative = discovery.freshness === "verified" && discovery.complete === true;

  const usable =
    !rejected &&
    !catalogMarksUnavailable &&
    isUsableSavedModel(savedModel, discovery.models, catalogIsAuthoritative);
  if (!usable) {
    return { kind: "pick-model" };
  }

  const activeRoute = config.activeRoute;
  const activeReasoning =
    activeRoute?.providerId === provider.id ? activeRoute.reasoning : undefined;
  const fallbackReasoning =
    provider.id === "google"
      ? (resolveCatalogModel(discovery.models, savedModel)?.defaultReasoningLevel ?? "")
      : input.sessionReasoningLevel;

  return {
    kind: "activate",
    model: savedModel,
    reasoning: providerConfig?.currentReasoning ?? activeReasoning ?? fallbackReasoning,
  };
}

/** Notice shown when a provider cannot be routed inside Ubume yet. */
export function routeUnavailableMessage(provider: ProviderConfig): string {
  return provider.isDefault
    ? `${provider.displayName} is set as the workspace default, but in-Ubume routing is not configured yet.`
    : `${provider.displayName} in-Ubume routing is not configured yet.`;
}

/** Notice shown after a provider becomes the workspace default. */
export function workspaceDefaultNotice(
  provider: ProviderConfig,
  routeConfigured: boolean,
  activeRouteLabel: string,
): string {
  const activeRouteNote = `Active chat route remains ${activeRouteLabel}.`;
  if (provider.routeMode === "launch-only") {
    return `${provider.displayName} is now the workspace default external CLI. ${activeRouteNote}`;
  }
  if (provider.routeMode === "in-ubume" && routeConfigured) {
    return `${provider.displayName} is now the workspace default provider. ${activeRouteNote}`;
  }
  return `${provider.displayName} is set as the workspace default, but in-Ubume routing is not configured yet. ${activeRouteNote}`;
}

/** The model a Local backend reports as loaded, or `fallback` when it reports none. */
export function selectedLocalModel(
  validation: Pick<ProviderRouteValidationResult, "diagnostics">,
  fallback: string,
): string {
  const reported = validation.diagnostics?.selectedModel;
  const trimmed = typeof reported === "string" ? reported.trim() : "";
  return trimmed || fallback;
}

/** Maps a Local backend validation result to the picker's status badge. */
export function localBackendStatusFromValidation(
  validation: Pick<ProviderRouteValidationResult, "status" | "message" | "diagnostics">,
): LocalBackendStatus {
  if (validation.status === "ready") {
    return { state: "ready", label: selectedLocalModel(validation, "") || "Model loaded" };
  }
  const message = validation.message ?? "";
  if (validation.diagnostics?.endpointCheckResult === "no-models" || LOCAL_NO_MODEL.test(message)) {
    return { state: "no-model", label: "No model loaded" };
  }
  if (LOCAL_TIMEOUT.test(message)) {
    return { state: "timeout", label: "Check timed out" };
  }
  return localBackendStatusFromError(message);
}

/** Maps a Local backend probe that threw to the picker's status badge. */
export function localBackendStatusFromError(message: string): LocalBackendStatus {
  return LOCAL_AUTH_FAILURE.test(message)
    ? { state: "auth-required", label: "Authentication required" }
    : { state: "not-running", label: "Not running" };
}

/** A shell invocation that installs and then sets up a provider CLI. */
export interface SetupSpawn {
  command: string;
  args: string[];
}

/**
 * Builds the shell invocation for a provider's install and setup commands.
 *
 * On POSIX the steps are chained with `&&` so setup is skipped when install
 * fails. PowerShell gets `$ErrorActionPreference='Stop'` for the same effect.
 */
export function buildSetupSpawn(
  plan: { installCommand: string; setupCommand?: string },
  windows: boolean,
): SetupSpawn {
  const steps = plan.setupCommand
    ? [plan.installCommand, plan.setupCommand]
    : [plan.installCommand];
  if (windows) {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$ErrorActionPreference='Stop'; ${steps.join("; ")}`,
      ],
    };
  }
  return { command: "sh", args: ["-lc", steps.join(" && ")] };
}
