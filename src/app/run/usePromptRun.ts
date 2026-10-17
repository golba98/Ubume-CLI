/**
 * Starts provider runs for prompts.
 *
 * `startPromptRun` has three phases:
 *
 * 1. **Gate** — refuse to run (returning `false`) when another run or a
 *    recovery is active, the route is not ready, the prompt is empty after
 *    sanitizing, it writes outside the workspace, it carries images the route
 *    cannot accept, the backend cannot run, or Codex login is required.
 *    See `promptGates.ts`. Nothing is created before every gate passes.
 * 2. **Bootstrap the turn** — record the user message, initialize the
 *    run-lifecycle refs and dispatch `SUBMIT_PROMPT_RUN`, which renders the
 *    prompt and a "starting" run event.
 * 3. **Run** — hand off to `startProviderRunSession`, which starts the
 *    provider after the next visible frame and owns streaming and cleanup.
 *
 * The connection and selection revision captured in phase 1 travel with the
 * run, so its success or failure is recorded as evidence for exactly the
 * model selection that was active when the prompt was submitted.
 */

import { useCallback } from "react";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import type { CodexAuthProbeResult } from "../../core/codex/codexAuth.js";
import { providerConnectionKey } from "../../core/models/modelCatalog.js";
import type { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import * as perf from "../../core/perf/profiler.js";
import type { ProviderConfig, ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import type { ModelContextMetadata } from "../../core/providerRuntime/contextMetadata.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { BackendProvider } from "../../core/providers/types.js";
import type {
  ConversationMessage,
  ConversationRecord,
} from "../../core/workspace/conversationStore.js";
import { createRunEvent } from "../../session/chatLifecycle.js";
import {
  createEventId,
  createPromptRunTiming,
  createTurnId,
  type PromptRunTiming,
} from "../../session/eventIds.js";
import type { UserPromptEvent } from "../../session/types.js";
import type { GateRejection } from "./promptGates.js";
import {
  checkCodexAuth,
  checkImageSupport,
  checkRouteReady,
  checkWorkspaceBoundary,
  sanitizePrompts,
} from "./promptGates.js";
import {
  type PromptRunLifecycle,
  preparePromptRun,
  selectProviderHistory,
} from "./promptRunPrep.js";
import { type ProviderRunDeps, startProviderRunSession } from "./providerRunSession.js";

interface UsePromptRunContext extends ProviderRunDeps {
  // Route and selection
  pendingRouteProviderId: ProviderRoute["providerId"] | null;
  activeProviderRoute: ProviderRoute;
  activeRouteProvider: ProviderConfig;
  selectionCoordinator: SelectionCoordinator;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  recoveryRef: React.RefObject<boolean>;

  // Workspace guard
  allowedWritableRoots: string[];

  // Runtime config and provider backend
  runtimeConfig: RuntimeConfig;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  provider: BackendProvider;
  providerOverride: BackendProvider | undefined;
  authStatus: CodexAuthProbeResult;

  // Context and conversation
  activeContextMetadata: ModelContextMetadata | null;
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  appendConversationMessage: (message: ConversationMessage) => void;

  // Active-run refs
  activeTurnIdRef: React.RefObject<number | null>;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
}

export function usePromptRun(context: UsePromptRunContext) {
  const {
    selectionCoordinator,
    pendingRouteProviderId,
    activeRunIdRef,
    recoveryRef,
    routeChoiceRequiredRef,
    appendEvent,
    workspaceRoot,
    allowedWritableRoots,
    activeProviderRoute,
    activeRouteProvider,
    runtimeConfig,
    providerWorkspaceConfig,
    provider,
    providerOverride,
    backend,
    authStatus,
    activeConversationRef,
    activeContextMetadata,
    promptQueue,
    appendConversationMessage,
    setConversationChars,
    activeRunCaptureRef,
    rolloverResponseCharsRef,
    activeTurnIdRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    externalCliStatusRef,
    dispatchSession,
    finalizePromptRun,
    projectInstructions,
    refreshAuthStatus,
  } = context;

  const startPromptRun = useCallback(
    (displayPrompt: string, providerPrompt: string, lifecycle: PromptRunLifecycle = {}) => {
      if (activeRunIdRef.current !== null || recoveryRef.current) {
        return false;
      }
      const reject = (rejection: GateRejection) => {
        appendEvent("error", rejection.title, rejection.message);
        return false;
      };

      // --- Phase 1: gates -----------------------------------------------------

      const route = activeProviderRoute;
      const modelConnection = providerConnectionKey(route.providerId, {
        cwd: workspaceRoot,
        config: providerWorkspaceConfig,
        routeLocalBackend: route.localBackend,
      });
      const modelRevision = selectionCoordinator.revision(modelConnection, route.modelId);
      const routeRejection = checkRouteReady({
        routeChoiceRequired: routeChoiceRequiredRef.current,
        pendingProviderId: pendingRouteProviderId,
        activeProviderId: route.providerId,
        modelId: route.modelId,
        retryDelayMs: selectionCoordinator.retryDelay(modelConnection, route.modelId),
        modelUnavailable:
          selectionCoordinator.state(modelConnection, route.modelId)?.status === "unavailable",
      });
      if (routeRejection) {
        return reject(routeRejection);
      }

      const submitTiming = lifecycle.submitTiming ?? createPromptRunTiming();
      const prompts = sanitizePrompts(displayPrompt, providerPrompt);
      if ("title" in prompts) {
        return reject(prompts);
      }
      const { safeDisplayPrompt, safeProviderPrompt } = prompts;

      const imageAttachments = lifecycle.imageAttachments ?? [];
      const contentRejection =
        checkWorkspaceBoundary(
          safeProviderPrompt,
          workspaceRoot,
          allowedWritableRoots,
          route.providerId,
        ) ?? checkImageSupport(route, activeRouteProvider, imageAttachments.length);
      if (contentRejection) {
        return reject(contentRejection);
      }

      const { runtimeForTurn, fastCleanupRun, executionModeDecision, effectiveMode } =
        preparePromptRun(
          runtimeConfig,
          lifecycle,
          safeProviderPrompt,
          route,
          providerWorkspaceConfig,
        );
      if (executionModeDecision.autoUpgraded) {
        appendEvent(
          "system",
          "Mode auto-upgraded",
          "This prompt looks like a file-editing request, so the run is using Auto instead of Read-only.",
        );
      }
      if (fastCleanupRun) {
        appendEvent(
          "system",
          "Fast cleanup path",
          "Using a low-latency cleanup profile: shallow inspection, generated artifacts only, no branch/bootstrap setup.",
        );
      }

      const runProvider = provider.run;
      if (!runProvider) {
        return reject({
          title: "Backend unavailable",
          message: `${provider.label} is a planned provider placeholder. Use Ubume Core for runnable execution in v1.`,
        });
      }

      const auth = checkCodexAuth({
        hasProviderOverride: Boolean(providerOverride),
        providerId: route.providerId,
        backend,
        authStatus,
      });
      if (auth.rejection) {
        return reject(auth.rejection);
      }
      if (auth.warning) {
        appendEvent("system", "Auth warning", auth.warning);
      }

      // --- Phase 2: bootstrap the turn ---------------------------------------

      const turnId = createTurnId();
      // Local Harness session reuse hashes the history, so local requests get the
      // exact saved reply text; other providers also see what earlier runs did.
      const conversationHistory =
        lifecycle.historyOverride ??
        selectProviderHistory(activeConversationRef.current, route, activeContextMetadata);
      const userEvent: UserPromptEvent = {
        id: createEventId(),
        type: "user",
        createdAt: submitTiming.submitEpochMs,
        prompt: safeDisplayPrompt,
        turnId,
      };
      for (const id of lifecycle.queuedPromptIds ?? []) {
        promptQueue.remove(id);
      }
      appendConversationMessage({
        role: "user",
        content: safeDisplayPrompt,
        submittedContent: safeProviderPrompt,
        turnId,
        createdAt: submitTiming.submitEpochMs,
      });
      setConversationChars((count) => count + safeProviderPrompt.length);

      const runId = createEventId();
      activeRunCaptureRef.current = { runId, text: "", tools: new Map(), files: new Map() };
      // A failed or canceled rollover must not reduce the next response's
      // accounting. Each provider run starts with no response text covered.
      rolloverResponseCharsRef.current = 0;
      perf.startSession(String(runId));
      perf.mark("dispatch_start");
      perf.setMeta("fast_cleanup", fastCleanupRun);
      perf.setMeta("reasoning", runtimeForTurn.reasoningLevel);
      activeRunIdRef.current = runId;
      activeTurnIdRef.current = turnId;
      // Codexa answers conversationally; it never asks for structured actions.
      activeRunLifecycleRef.current =
        route.providerId === "codexa-native"
          ? { ...lifecycle, parseActionRequired: false }
          : lifecycle;
      activeRunTimingRef.current = { ...submitTiming, runId, turnId };
      if (externalCliStatusRef.current === "idle") {
        dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "starting" });
      }
      dispatchSession({
        type: "SUBMIT_PROMPT_RUN",
        historyValue: lifecycle.commitPrompt ? safeDisplayPrompt : undefined,
        preserveInput: lifecycle.preserveInput,
        turnId,
        runId,
        events: [
          userEvent,
          {
            ...createRunEvent({
              id: runId,
              backendId: backend,
              backendLabel: provider.label,
              runtime: runtimeForTurn,
              prompt: safeProviderPrompt,
              turnId,
              startedAtMs: submitTiming.submitEpochMs,
              responsePresentation: lifecycle.responsePresentation,
              approvedPlan: lifecycle.approvedPlan,
            }),
            summary: "Ubume is starting...",
          },
        ],
      });

      // --- Phase 3: run --------------------------------------------------------

      startProviderRunSession(context, {
        // Identity
        runId,
        turnId,

        // Route, lifecycle and timing
        route,
        lifecycle,
        submitTiming,

        // Prompts
        safeDisplayPrompt,
        safeProviderPrompt,

        // Runtime
        runtimeForTurn,
        fastCleanupRun,
        effectiveMode,

        // Provider content
        conversationHistory,
        imageAttachments,

        // Model evidence and provider entry point
        modelConnection,
        modelRevision,
        runProvider,
      });
      return true;
    },
    [
      activeContextMetadata,
      activeProviderRoute,
      activeRouteProvider,
      allowedWritableRoots,
      appendConversationMessage,
      appendEvent,
      authStatus.checkedAt,
      authStatus.state,
      dispatchSession,
      finalizePromptRun,
      pendingRouteProviderId,
      projectInstructions,
      provider,
      providerOverride,
      providerWorkspaceConfig,
      refreshAuthStatus,
      runtimeConfig,
      selectionCoordinator,
      workspaceRoot,
    ],
  );

  return { startPromptRun };
}
