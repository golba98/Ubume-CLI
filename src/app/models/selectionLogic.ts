/**
 * Pure decisions behind model and reasoning selection (`useModelSelection`).
 *
 * These functions never touch React state, the filesystem or the network, so
 * the rules for "which route are we trying", "is this reasoning allowed" and
 * "what went wrong" can be tested without rendering the app.
 */

import type { CodexModelCapability } from "../../core/models/codexModelCapabilities.js";
import { isSupportedReasoning } from "../../core/models/reasoningControl.js";
import { resolveLocalBackend } from "../../core/providerLauncher/localBackend.js";
import type {
  LocalBackendId,
  ProviderId,
  ProviderWorkspaceConfig,
} from "../../core/providerLauncher/types.js";
import { getAgyModelSelector } from "../../core/providerRuntime/antigravity.js";
import {
  classifyProviderFailure,
  isModelFailure,
  modelRecoveryMessage,
  type ProviderFailure,
} from "../../core/providerRuntime/failures.js";
import type {
  ProviderBackendKind,
  ProviderModel,
  ProviderRoute,
  ProviderRouteValidationResult,
} from "../../core/providerRuntime/types.js";

/** Shown when the provider's connection settings changed while a model was being validated. */
export const CONNECTION_CHANGED_MESSAGE =
  "The provider connection changed during validation. Choose a model again using the current connection.";

/** Shown when a validated route could not be written to `providers.json`. */
export const SELECTION_SAVE_FAILED_MESSAGE =
  "Unable to save the selection. The previous active route and preferences were preserved.";

/** The route a model selection is trying to activate, before validation. */
export function buildCandidateRoute(input: {
  providerId: ProviderId;
  modelId: string;
  reasoning: string;
  backendKind: ProviderBackendKind;
  config: ProviderWorkspaceConfig;
  localBackend?: LocalBackendId;
}): ProviderRoute {
  const { providerId, modelId, reasoning, backendKind, config, localBackend } = input;
  return {
    providerId,
    modelId,
    reasoning,
    backendKind,
    ...(providerId === "local" ? { localBackend: resolveLocalBackend(config, localBackend) } : {}),
  };
}

/**
 * Activation-time reasoning check: rejects a reasoning setting only when the
 * model explicitly declares level- or budget-style reasoning that excludes it.
 *
 * This is deliberately lenient. A model with no declared reasoning control may
 * still be selected with the session's reasoning, which is then normalized.
 */
export function reasoningExcludedByModel(
  capability: CodexModelCapability | null | undefined,
  reasoning: string,
): boolean {
  const control = capability?.reasoningControl;
  if (!reasoning || !control) {
    return false;
  }
  if (control.kind !== "levels" && control.kind !== "budget") {
    return false;
  }
  return !isSupportedReasoning(control, reasoning);
}

/**
 * `/reasoning` check for the active model: the level must be supported by the
 * model's reasoning control, or (for models without one) appear in the levels
 * the model advertises. Stricter than {@link reasoningExcludedByModel}
 * because the user is explicitly asking for a level on the current model.
 */
export function reasoningNotAdvertised(
  capability: CodexModelCapability | null | undefined,
  reasoning: string,
): boolean {
  if (capability?.reasoningControl) {
    return !isSupportedReasoning(capability.reasoningControl, reasoning);
  }
  const supported = capability?.supportedReasoningLevels;
  return !supported || !supported.some((level) => level.id === reasoning);
}

/** What a failed route validation means for the selection. */
export interface ValidationFailure {
  failure: ProviderFailure;
  /** The model itself was rejected (as opposed to auth, network, setup, …). */
  isModelFailure: boolean;
  /** Message for the recovery notice. */
  userMessage: string;
  /** Message to remember as the provider's route error, when not a model problem. */
  routeError: string | null;
}

/**
 * Classifies a non-ready validation result.
 *
 * Only an explicit model rejection is reported as "this model is unavailable";
 * authentication, quota, network and setup problems keep the provider's own
 * message and are remembered as a provider-level route error instead.
 */
export function classifyValidationFailure(
  validation: Pick<ProviderRouteValidationResult, "failure" | "message">,
  modelId: string,
  setupMessage: string,
): ValidationFailure {
  const message = validation.message ?? setupMessage;
  const failure = validation.failure ?? classifyProviderFailure(message);
  const modelProblem = isModelFailure(failure);
  return {
    failure,
    isModelFailure: modelProblem,
    userMessage: modelProblem ? modelRecoveryMessage(modelId) : message,
    routeError: modelProblem ? null : message,
  };
}

/**
 * Google exposes reasoning as distinct model selectors (for example a
 * "-thinking" variant). When the reasoning level changes, the model to
 * persist and the model to run may both move to the selector for that level.
 *
 * Returns the model id to persist, and the runtime model to switch to when the
 * active model has a selector for the new level.
 */
export function googleReasoningModels(
  persistedModelId: string,
  activeModelId: string,
  reasoning: string,
  catalog: readonly ProviderModel[],
): { modelToPersist: string; runtimeModel: string | null } {
  const persistedSelector = getAgyModelSelector(persistedModelId, reasoning, catalog);
  const nativePersisted = catalog.find((model) => model.modelId === persistedSelector);
  const activeSelector = getAgyModelSelector(activeModelId, reasoning, catalog);
  const activeListed = catalog.some((model) => model.modelId === activeSelector);
  return {
    modelToPersist: nativePersisted ? nativePersisted.modelId : persistedModelId,
    runtimeModel: activeListed && activeSelector ? activeSelector : null,
  };
}
