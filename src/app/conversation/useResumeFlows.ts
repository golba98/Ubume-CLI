/**
 * Switching conversations: the /resume picker, resuming a saved Ubume chat,
 * importing or natively resuming another CLI's session, and relaunching Ubume
 * in a chat's original workspace.
 *
 * Every switch follows the same safety rules:
 * - It refuses to start while a run, submission or another switch is active.
 * - It sets `recoveryRef` for its duration, so queued prompts, quits and new
 *   runs wait until the switch has finished (`finishRecovery`).
 * - It saves the current chat first and aborts if that save failed, so a
 *   switch can never lose unsaved work.
 *
 * `resumeConversation` replaces the transcript atomically with the
 * clear-frame boundary (`armTranscriptReplacement`) so the logo and old
 * transcript are not printed twice.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { useCallback, useEffect } from "react";
import {
  buildExternalResumeLaunch,
  type ExternalSessionSummary,
  externalProviderId,
  externalSourceLabel,
  listExternalSessions,
  readExternalTranscript,
} from "../../core/externalSessions/index.js";
import { launchCliCommand } from "../../core/providerLauncher/launcher.js";
import { resolveProviderIdentity } from "../../core/providerLauncher/providerIdentity.js";
import { findProvider, isKnownProviderId } from "../../core/providerLauncher/registry.js";
import type { ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import { discoverLocalModels } from "../../core/providerRuntime/local.js";
import { closeLocalHarnessSession } from "../../core/providerRuntime/localHarness/runtime.js";
import { discoverProviderModels } from "../../core/providerRuntime/registry.js";
import type { BackendProvider } from "../../core/providers/types.js";
import { errorMessage } from "../../core/shared/values.js";
import { workspaceStorageKey } from "../../core/workspace/appData.js";
import { CheckpointStore } from "../../core/workspace/checkpoints.js";
import type { ConversationMetadata } from "../../core/workspace/conversationStore.js";
import { acquireOwnership } from "../../core/workspace/ownership.js";
import { normalizeWorkspaceRoot, sameFolder } from "../../core/workspace/workspaceRoot.js";
import { conversationMessagesToTimeline } from "../../session/conversation.js";
import { advanceIdsPast, createEventId, createTurnId } from "../../session/eventIds.js";
import { createInitialPlanFlowState } from "../../session/planFlow.js";
import {
  assessSavedRoute,
  createSessionWorkspaceRelaunch,
  importNativeConversation,
  listSessionCatalog,
  type SessionSummary,
  sessionIsInWorkspace,
} from "../../session/sessionCatalog.js";
import { restoredEvents } from "../../session/workbench.js";
import { FOCUS_IDS } from "../../ui/input/focus.js";
import type { ExternalListScope, ResumePickerPosition } from "../../ui/panels/resumePickerRows.js";
import { resetTimelineMeasureCaches } from "../../ui/timeline/timelineMeasure.js";
import type { UseConversationContext } from "./conversationContext.js";
import {
  conversationCharCount,
  interruptedRunMessage,
  promptHistoryFromMessages,
} from "./conversationMetadata.js";
import { finishRecovery, restoreConversationScratchState } from "./conversationPersistence.js";

type ResumeFlowsContext = Omit<
  UseConversationContext,
  "inputValue" | "cursor" | "workbenchVersion" | "planFlow"
> & {
  saveActiveConversation: () => void;
};

// Ink throttles frame writes (~34 ms at 30 fps). Leaving an overlay exits the
// alternate screen inside that write, so a child CLI waits this long before it
// takes the terminal.
const OVERLAY_EXIT_SETTLE_MS = 80;

const waitForOverlayExit = () =>
  new Promise((resolve) => setTimeout(resolve, OVERLAY_EXIT_SETTLE_MS));

/**
 * Decides whether a resumed chat can keep running on the route it was saved
 * with. An embedded test provider accepts any route.
 */
function assessResumedRoute(
  metadata: ConversationMetadata,
  providerOverride: BackendProvider | undefined,
  config: ProviderWorkspaceConfig,
) {
  const savedProvider = resolveProviderIdentity(metadata.providerId, metadata.backendKind);
  const routeProvider = savedProvider && isKnownProviderId(savedProvider) ? savedProvider : null;

  let discovery = null;
  if (routeProvider === "local") {
    discovery = discoverLocalModels(undefined, metadata.localBackend);
  } else if (routeProvider) {
    discovery = discoverProviderModels(routeProvider);
  }

  const providerEnabled = !routeProvider || config.providers?.[routeProvider]?.enabled !== false;
  return assessSavedRoute(
    metadata,
    providerOverride ? null : discovery,
    Boolean(providerOverride) || providerEnabled,
  );
}

export function useResumeFlows(context: ResumeFlowsContext) {
  const {
    armTranscriptReplacement,
    activeConversationRef,
    preserveSavedRouteRef,
    conversationStore,
    lastSaveErrorRef,
    appendEvent,
    saveWorkbenchRef,
    busy,
    stoppingRef,
    workspaceLeaseRef,
    activeRunCaptureRef,
    setResumeConversations,
    catalogListsRef,
    resumePickerPositionRef,
    setScreen,
    workspaceRoot,
    activeRunIdRef,
    submissionRef,
    recoveryRef,
    launchContext,
    exit,
    setExternalViewerSession,
    externalViewerSession,
    setSavedViewerSession,
    busyRef,
    providerWorkspaceConfig,
    isMountedRef,
    externalCliLaunchHooks,
    setConversationChars,
    pipelineGenerationRef,
    runControlRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    activeTurnIdRef,
    toolApprovalResolverRef,
    setToolApproval,
    pastedContentRegistryRef,
    imageAttachmentRegistryRef,
    fileAttachmentRegistryRef,
    checkpointsRef,
    restoredFileBoundaryRef,
    promptQueue,
    setPlanFlow,
    dispatchSession,
    bumpWorkbench,
    providerOverride,
    routeChoiceRequiredRef,
    setConversationRouteOverride,
    intendedFocusTargetRef,
    focusManager,
    pendingQuitRef,
    providerRegistry,
    savedViewerSession,
    startupResumeHandledRef,
    launchArgs,
    saveActiveConversation,
  } = context;

  // ---------------------------------------------------------------------------
  // Shared guards
  // ---------------------------------------------------------------------------

  /** A run, a prompt submission, or another conversation switch is in progress. */
  const operationActive = () =>
    activeRunIdRef.current !== null || submissionRef.current || recoveryRef.current;

  /** Saves the current chat; throws if it (or an earlier save) failed. */
  const saveCurrentChatOrThrow = () => {
    saveWorkbenchRef.current?.();
    if (lastSaveErrorRef.current) {
      throw new Error(`Current chat could not be saved: ${lastSaveErrorRef.current}`);
    }
  };

  // ---------------------------------------------------------------------------
  // Resume picker and viewers
  // ---------------------------------------------------------------------------

  const openResumePicker = useCallback(() => {
    if (busy) {
      appendEvent(
        "system",
        "Resume unavailable",
        "Finish the active run before switching conversations.",
      );
      return;
    }
    saveActiveConversation();
    setResumeConversations(conversationStore.list());
    catalogListsRef.current.clear();
    resumePickerPositionRef.current = undefined;
    setScreen("resume-picker");
  }, [appendEvent, busy, conversationStore, saveActiveConversation]);

  /** Lists sessions for a picker tab; concurrent requests share one listing. */
  const loadResumeSessions = useCallback(
    (scope: ExternalListScope) => {
      let pending = catalogListsRef.current.get(scope);
      if (!pending) {
        pending = listSessionCatalog(workspaceRoot, scope);
        catalogListsRef.current.set(scope, pending);
        pending.catch(() => catalogListsRef.current.delete(scope));
      }
      return pending;
    },
    [workspaceRoot],
  );

  const rememberResumePickerPosition = useCallback((position: ResumePickerPosition) => {
    resumePickerPositionRef.current = position;
  }, []);

  const openExternalSession = useCallback((summary: ExternalSessionSummary) => {
    setExternalViewerSession(summary);
    setScreen("external-session-viewer");
  }, []);

  const loadExternalTranscript = useCallback(
    () =>
      externalViewerSession
        ? readExternalTranscript(externalViewerSession)
        : Promise.reject(new Error("No session selected.")),
    [externalViewerSession],
  );

  const returnToResumePicker = useCallback(() => {
    setExternalViewerSession(null);
    setSavedViewerSession(null);
    setScreen("resume-picker");
  }, []);

  // ---------------------------------------------------------------------------
  // Leaving Ubume: another workspace, or another CLI
  // ---------------------------------------------------------------------------

  /**
   * Relaunches Ubume in `target` to resume a chat saved there, then exits
   * this instance once the child has spawned.
   */
  const relaunchSavedSession = useCallback(
    async (
      target: string,
      resume: { conversationId: string } | { source: string; sessionId: string },
    ) => {
      if (operationActive()) {
        appendEvent(
          "system",
          "Resume unavailable",
          "Stop the active operation before switching workspaces.",
        );
        return;
      }
      const prepared = createSessionWorkspaceRelaunch(target, launchContext, resume);
      if (!prepared.ok) {
        appendEvent("error", "Workspace unavailable", prepared.message);
        return;
      }

      recoveryRef.current = true;
      try {
        await stoppingRef.current;
        saveCurrentChatOrThrow();
        const harness = activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
        if (harness) {
          await closeLocalHarnessSession(harness);
        }
        conversationStore.release();
        workspaceLeaseRef.current?.release();
        workspaceLeaseRef.current = undefined;
        setScreen("main");
        appendEvent("system", "Opening saved workspace", prepared.plan.targetWorkspaceRoot);
        await waitForOverlayExit();

        const child = spawn(prepared.plan.executable, prepared.plan.args, {
          cwd: prepared.plan.cwd,
          env: prepared.plan.env,
          stdio: "inherit",
        });
        child.once("error", (error) => {
          recoveryRef.current = false;
          appendEvent("error", "Workspace resume failed", error.message);
        });
        child.once("spawn", () => exit());
      } catch (error) {
        recoveryRef.current = false;
        appendEvent("error", "Workspace resume failed", errorMessage(error));
      }
    },
    [appendEvent, conversationStore, exit, launchContext],
  );

  /** Suspends Ubume and resumes an external session in its own CLI. */
  const resumeExternalSessionNative = useCallback(
    async (summary: ExternalSessionSummary) => {
      if (busyRef.current || activeRunIdRef.current !== null) {
        appendEvent(
          "system",
          "Resume unavailable",
          "Finish the active run before opening another CLI.",
        );
        return;
      }
      // Leave the overlay first: its alternate screen is exited inside the next
      // (throttled) frame write, which must land before the child owns the terminal.
      setExternalViewerSession(null);
      setScreen("main");
      await waitForOverlayExit();

      const label = externalSourceLabel(summary.source);
      try {
        saveCurrentChatOrThrow();
        const prepared = await buildExternalResumeLaunch(summary, { fallbackCwd: workspaceRoot });
        if (!isMountedRef.current) {
          return;
        }
        if (!prepared.ok) {
          appendEvent("error", `${label} resume unavailable`, prepared.message);
          return;
        }
        const { launch } = prepared;
        appendEvent(
          "system",
          "Resume in native CLI",
          `Suspending Ubume and resuming "${summary.title}" in ${label} (${launch.cwd}). Ubume will resume when ${label} exits.`,
        );
        const result = await launchCliCommand(launch.displayName, launch, externalCliLaunchHooks);
        if (!isMountedRef.current) {
          return;
        }
        if (result.status === "completed") {
          appendEvent("system", "Resume in native CLI", result.message);
        } else {
          appendEvent("error", `${label} resume failed`, result.message);
        }
      } catch (error) {
        if (isMountedRef.current) {
          appendEvent("error", `${label} resume failed`, errorMessage(error, "Launch failed."));
        }
      }
    },
    [appendEvent, externalCliLaunchHooks, workspaceRoot],
  );

  // ---------------------------------------------------------------------------
  // Resuming a saved Ubume chat
  // ---------------------------------------------------------------------------

  /** Forgets everything about the previous chat's run so the resumed one starts clean. */
  const resetRunStateForResume = () => {
    pipelineGenerationRef.current++;
    runControlRef.current = null;
    activeRunCaptureRef.current = null;
    activeRunLifecycleRef.current = null;
    activeRunTimingRef.current = null;
    activeTurnIdRef.current = null;
    toolApprovalResolverRef.current?.("deny");
    toolApprovalResolverRef.current = null;
    setToolApproval(null);
  };

  /**
   * Resumes saved conversation `id` in this workspace: locks it, swaps the
   * transcript and composer state, recovers any interrupted file restore, and
   * decides whether its saved route can still be used.
   */
  const resumeConversation = useCallback(
    async (id: string) => {
      if (operationActive()) {
        appendEvent(
          "system",
          "Resume unavailable",
          "Stop the active operation before switching sessions.",
        );
        return;
      }

      recoveryRef.current = true;
      try {
        await stoppingRef.current;
        saveCurrentChatOrThrow();

        // Lock the conversation, then reload it so we see the locked version.
        let loaded = conversationStore.load(id);
        if (loaded) {
          try {
            conversationStore.acquire(id);
            loaded = conversationStore.load(id);
          } catch (error) {
            appendEvent("error", "Resume unavailable", (error as Error).message);
            return;
          }
        }
        if (!loaded) {
          appendEvent("error", "Resume failed", "That conversation could not be loaded.");
          setScreen("main");
          return;
        }

        const previousHarnessSessionId =
          activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
        if (
          previousHarnessSessionId &&
          previousHarnessSessionId !== loaded.metadata.localHarnessSession?.sessionId
        ) {
          stoppingRef.current = stoppingRef.current.then(() =>
            closeLocalHarnessSession(previousHarnessSessionId),
          );
        }

        const replacement = armTranscriptReplacement(
          "src/app/conversation/useResumeFlows.ts:resumeConversation",
        );
        const saved = loaded.session;
        const interrupted = saved ? interruptedRunMessage(saved.events, loaded.messages) : null;
        const resumed = interrupted
          ? { ...loaded, messages: [...loaded.messages, interrupted] }
          : loaded;

        preserveSavedRouteRef.current = true;
        activeConversationRef.current = resumed;
        // Counted before the interrupted-run note, which was never sent to a model.
        setConversationChars(conversationCharCount(loaded.messages));
        resetTimelineMeasureCaches();
        resetRunStateForResume();

        const events = saved
          ? restoredEvents(saved.events)
          : conversationMessagesToTimeline(resumed.messages, createEventId, createTurnId);
        advanceIdsPast(events);
        restoreConversationScratchState(
          {
            pastedContentRegistryRef,
            imageAttachmentRegistryRef,
            fileAttachmentRegistryRef,
            checkpointsRef,
            restoredFileBoundaryRef,
            promptQueue,
          },
          saved,
        );

        setPlanFlow(saved?.plan ?? createInitialPlanFlowState());
        dispatchSession({
          type: "RESTORE_SESSION",
          events,
          value: saved?.draft ?? "",
          cursor: saved?.cursor ?? 0,
          history: saved?.history ?? promptHistoryFromMessages(resumed.messages),
          uiState: saved?.uiState,
        });

        // Roll back a file restoration that was interrupted mid-way.
        const lease = acquireOwnership(workspaceRoot, "execution");
        try {
          if (await new CheckpointStore(workspaceRoot, id).recover()) {
            appendEvent("system", "File recovery", "Rolled back an interrupted restoration.");
          }
        } finally {
          lease.release();
        }
        bumpWorkbench((value) => value + 1);
        replacement.finish();

        const assessment = assessResumedRoute(
          resumed.metadata,
          providerOverride,
          providerWorkspaceConfig,
        );
        routeChoiceRequiredRef.current =
          assessment.status === "unavailable" ? assessment.message : null;
        setConversationRouteOverride(assessment.route ?? null);
        if (assessment.status === "unavailable") {
          appendEvent(
            "system",
            "Original route unavailable",
            `${assessment.message} History has been restored for viewing.`,
          );
        } else {
          appendEvent("system", "Conversation resumed", resumed.metadata.title);
        }

        setScreen("main");
        intendedFocusTargetRef.current = FOCUS_IDS.composer;
        focusManager.focus(FOCUS_IDS.composer);
      } catch (error) {
        appendEvent("error", "Resume failed", (error as Error).message);
      } finally {
        finishRecovery({ recoveryRef, bumpWorkbench, pendingQuitRef });
      }
    },
    [
      appendEvent,
      armTranscriptReplacement,
      conversationStore,
      dispatchSession,
      focusManager,
      providerOverride,
      providerWorkspaceConfig.providers,
    ],
  );

  /**
   * Imports another CLI's session as an Ubume conversation and resumes it.
   * Sessions from another folder relaunch Ubume there instead.
   */
  const continueExternalSession = useCallback(
    async (summary: ExternalSessionSummary) => {
      if (operationActive()) {
        appendEvent(
          "system",
          "Resume unavailable",
          "Stop the active operation before importing history.",
        );
        return;
      }
      if (!summary.cwd) {
        appendEvent(
          "error",
          "Original workspace unknown",
          "This session does not record its original folder. Open its transcript for viewing.",
        );
        return;
      }
      if (!sameFolder(summary.cwd, workspaceRoot)) {
        await relaunchSavedSession(summary.cwd, { source: summary.source, sessionId: summary.id });
        return;
      }

      recoveryRef.current = true;
      try {
        saveCurrentChatOrThrow();
        const providerId = externalProviderId(summary.source);
        const transcript = await readExternalTranscript(summary);
        const record = importNativeConversation(
          conversationStore,
          transcript,
          findProvider(providerRegistry, providerId)?.currentModel ?? "unknown",
        );
        conversationStore.release();
        setExternalViewerSession(null);
        // resumeConversation takes its own recovery guard.
        recoveryRef.current = false;
        await resumeConversation(record.metadata.id);
        if (activeConversationRef.current?.metadata.id === record.metadata.id) {
          const notice = transcript.notice ? ` ${transcript.notice}` : "";
          appendEvent(
            "system",
            "Continuing in Ubume",
            `Imported “${summary.title}” from ${externalSourceLabel(summary.source)}.${notice}`,
          );
        }
      } catch (error) {
        appendEvent("error", "Continue failed", errorMessage(error));
      } finally {
        recoveryRef.current = false;
      }
    },
    [
      appendEvent,
      conversationStore,
      providerRegistry,
      relaunchSavedSession,
      resumeConversation,
      workspaceRoot,
    ],
  );

  /**
   * Opens a picker entry: native sessions open in the viewer; Ubume chats
   * resume here, relaunch in their workspace, or (when that folder is gone)
   * open read-only in the saved-session viewer.
   */
  const selectResumeSession = useCallback(
    async (session: SessionSummary) => {
      if (session.native) {
        openExternalSession(session.native);
        return;
      }
      if (session.ref.kind !== "ubume") {
        return;
      }
      if (!session.workspaceRoot || !existsSync(session.workspaceRoot)) {
        setSavedViewerSession(session);
        setScreen("saved-session-viewer");
        return;
      }
      if (!sessionIsInWorkspace(session, workspaceRoot)) {
        await relaunchSavedSession(session.workspaceRoot, {
          conversationId: session.ref.conversationId,
        });
        return;
      }
      await resumeConversation(session.ref.conversationId);
    },
    [openExternalSession, relaunchSavedSession, resumeConversation, workspaceRoot],
  );

  /**
   * Lets the user point at a moved project folder for a saved chat. The
   * folder must have the same workspace identity as the one the chat saved.
   */
  const locateSavedWorkspace = useCallback(
    async (value: string) => {
      const session = savedViewerSession;
      if (!session || session.ref.kind !== "ubume") {
        return;
      }
      const folder = normalizeWorkspaceRoot(value);
      if (workspaceStorageKey(folder) !== session.ref.workspaceKey) {
        appendEvent(
          "error",
          "Workspace does not match",
          "Select the original project folder; its identity must match this saved chat.",
        );
        return;
      }
      await selectResumeSession({
        ...session,
        workspaceRoot: folder,
        ref: { ...session.ref, workspaceRoot: folder },
      });
    },
    [appendEvent, savedViewerSession, selectResumeSession],
  );

  // `--resume <id>` and `--import <source>:<session>` run once at startup.
  useEffect(() => {
    const requested = launchArgs.resumeId || launchArgs.importSession;
    if (startupResumeHandledRef.current || !requested) {
      return;
    }
    startupResumeHandledRef.current = true;
    void (async () => {
      if (launchArgs.resumeId) {
        await resumeConversation(launchArgs.resumeId);
        return;
      }
      const target = launchArgs.importSession!;
      const sessions = await listExternalSessions(target.source, {
        kind: "workspace",
        root: workspaceRoot,
      });
      const summary = sessions.find((entry) => entry.id === target.sessionId);
      if (!summary) {
        throw new Error("The selected native session was not found in its original workspace.");
      }
      await continueExternalSession(summary);
    })().catch((error) => appendEvent("error", "Startup resume failed", errorMessage(error)));
  }, [
    appendEvent,
    continueExternalSession,
    launchArgs.importSession,
    launchArgs.resumeId,
    resumeConversation,
    workspaceRoot,
  ]);

  return {
    openResumePicker,
    loadResumeSessions,
    rememberResumePickerPosition,
    openExternalSession,
    loadExternalTranscript,
    returnToResumePicker,
    resumeExternalSessionNative,
    resumeConversation,
    continueExternalSession,
    selectResumeSession,
    locateSavedWorkspace,
  };
}
