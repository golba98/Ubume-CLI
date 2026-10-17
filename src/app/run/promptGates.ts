/**
 * Pre-flight checks that decide whether a prompt may start a provider run.
 *
 * Each check is pure: it returns `null` when the prompt may proceed, or a
 * {@link GateRejection} describing the error event to show. `usePromptRun`
 * runs them in order and stops at the first rejection, before any turn,
 * transcript event or provider process is created.
 */

import type { CodexAuthProbeResult } from "../../core/codex/codexAuth.js";
import { getRunGateDecision } from "../../core/codex/codexAuth.js";
import type { ProviderConfig, ProviderId } from "../../core/providerLauncher/types.js";
import { modelRecoveryMessage } from "../../core/providerRuntime/failures.js";
import { formatRuntimeProviderLabel } from "../../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import { sanitizeTerminalInput } from "../../core/terminal/terminalSanitize.js";
import { getPromptWorkspaceGuardMessage } from "../../core/workspace/workspaceGuard.js";

/** Why a prompt was not started, shown as an error event. */
export interface GateRejection {
  title: string;
  message: string;
}

/**
 * Checks that the active route is one a prompt can run on.
 *
 * - A resumed conversation may require the user to pick a route first.
 * - A provider chosen in the picker but without a selected model blocks runs,
 *   so a prompt never silently goes to the previously active provider.
 * - Model evidence from this session (a provider-requested retry delay, or an
 *   explicit "model unavailable" rejection) blocks the run until the user
 *   waits, or changes model or provider.
 */
export function checkRouteReady(input: {
  routeChoiceRequired: string | null;
  pendingProviderId: ProviderId | null;
  activeProviderId: ProviderId;
  modelId: string;
  retryDelayMs: number;
  modelUnavailable: boolean;
}): GateRejection | null {
  if (input.routeChoiceRequired) {
    return { title: "Select a route first", message: input.routeChoiceRequired };
  }
  if (input.pendingProviderId && input.pendingProviderId !== input.activeProviderId) {
    return {
      title: "Choose a model",
      message: `Choose a model for ${input.pendingProviderId} with /model, or change provider with /providers.`,
    };
  }
  if (input.retryDelayMs > 0) {
    return {
      title: "Retry later",
      message: `The provider requested a retry delay. Retry in ${Math.ceil(input.retryDelayMs / 1000)} seconds, or change model or provider.`,
    };
  }
  if (input.modelUnavailable) {
    return { title: "Model unavailable", message: modelRecoveryMessage(input.modelId) };
  }
  return null;
}

/** The display and provider prompts with terminal control characters removed. */
export interface SanitizedPrompts {
  safeDisplayPrompt: string;
  safeProviderPrompt: string;
}

/**
 * Strips terminal control sequences from both prompt forms. Returns a
 * rejection when either becomes empty, which means the input was only
 * non-printable characters.
 */
export function sanitizePrompts(
  displayPrompt: string,
  providerPrompt: string,
): SanitizedPrompts | GateRejection {
  const safeDisplayPrompt = sanitizeTerminalInput(displayPrompt).trim();
  const safeProviderPrompt = sanitizeTerminalInput(providerPrompt).trim();
  if (!safeDisplayPrompt || !safeProviderPrompt) {
    return {
      title: "Prompt blocked",
      message: "The prompt only contained non-printable/control characters after sanitization.",
    };
  }
  return { safeDisplayPrompt, safeProviderPrompt };
}

/**
 * Rejects prompts that ask to write outside the workspace and its allowed
 * roots. Codexa is a conversational-only route and is exempt.
 */
export function checkWorkspaceBoundary(
  prompt: string,
  workspaceRoot: string,
  allowedWritableRoots: string[],
  providerId: ProviderId,
): GateRejection | null {
  const guardMessage = getPromptWorkspaceGuardMessage(prompt, workspaceRoot, allowedWritableRoots);
  if (!guardMessage || providerId === "codexa-native") {
    return null;
  }
  return { title: "Workspace boundary", message: guardMessage };
}

/**
 * Rejects image attachments for routes without verified image transport.
 * Only OpenAI and Local models configured with `supports_vision` accept them.
 */
export function checkImageSupport(
  route: ProviderRoute,
  routeProvider: ProviderConfig | null | undefined,
  imageCount: number,
): GateRejection | null {
  if (imageCount === 0) {
    return null;
  }
  const supportsImages =
    route.providerId === "openai" ||
    (route.providerId === "local" && routeProvider?.capabilityProfile?.supportsVision === true);
  if (supportsImages) {
    return null;
  }
  const message =
    route.providerId === "local"
      ? "The active Local model is not configured with supports_vision: true. Switch to a vision model or remove the image."
      : `${formatRuntimeProviderLabel(route.providerId)} does not have verified image transport in Ubume yet. Switch to Ubume/OpenAI or a vision-enabled Local model.`;
  return { title: "Image not supported", message };
}

/**
 * Applies the Codex login gate. Only the real Codex subprocess route is gated;
 * an embedded test provider (`hasProviderOverride`) is never blocked.
 *
 * Returns a rejection when the run must not start, or a warning to show when
 * the run may start but the login state is uncertain.
 */
export function checkCodexAuth(input: {
  hasProviderOverride: boolean;
  providerId: ProviderId;
  backend: string;
  authStatus: CodexAuthProbeResult;
}): { rejection: GateRejection | null; warning: string | null } {
  const gated =
    !input.hasProviderOverride &&
    input.providerId === "openai" &&
    input.backend === "codex-subprocess";
  if (!gated) {
    return { rejection: null, warning: null };
  }
  const decision = getRunGateDecision(input.authStatus.state, {
    warnOnUnknown: input.authStatus.checkedAt > 0,
  });
  if (!decision.allowRun) {
    return {
      rejection: {
        title: "Authentication required",
        message: decision.blockMessage ?? "Please sign in with `codex login`.",
      },
      warning: null,
    };
  }
  return { rejection: null, warning: decision.warningMessage ?? null };
}
