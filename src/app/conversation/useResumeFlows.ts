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

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { closeLocalHarnessSession } from "../../core/providerRuntime/localHarness/lazyRuntime.js";
import { discoverProviderModels } from "../../core/providerRuntime/registry.js";
import type { BackendProvider } from "../../core/providers/types.js";
import { errorMessage } from "../../core/shared/values.js";
import { CheckpointStore } from "../../core/workspace/checkpoints.js";
import {
  type ConversationMetadata,
  ConversationStore,
} from "../../core/workspace/conversationStore.js";
import { acquireOwnership } from "../../core/workspace/ownership.js";
import { normalizeWorkspaceRoot, sameFolder } from "../../core/workspace/workspaceRoot.js";
import { advanceIdsPast } from "../../session/eventIds.js";
import { createInitialPlanFlowState } from "../../session/planFlow.js";
import { relocateConversation } from "../../session/relocateConversation.js";
import { hydrateConversationEvents } from "../../session/restoreConversation.js";
import { ResumeTransition } from "../../session/resumeTransition.js";
import {
  assessSavedRoute,
  createSessionWorkspaceRelaunch,
  importNativeConversation,
  listSessionCatalog,
  readOwnedConversation,
  type SessionRef,
  type SessionSummary,
  sessionIsInWorkspace,
} from "../../session/sessionCatalog.js";
import { describeContinuation } from "../../session/sessionContinuation.js";
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

function isDirectory(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

export function useResumeFlows(context: ResumeFlowsContext) {
  const {
    // Transcript swap and the active conversation record
    armTranscriptReplacement,
    activeConversationRef,
    preserveSavedRouteRef,
    conversationStore,
    lastSaveErrorRef,
    appendEvent,
    saveWorkbenchRef,

    // Run guards and workspace lease
    busy,
    stoppingRef,
    workspaceLeaseRef,
    submissionRef,
    recoveryRef,
    pipelineGenerationRef,

    // Active-run bookkeeping (checkpoints, captures, lifecycle, control)
    activeRunIdRef,
    activeTurnIdRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    runControlRef,
    activeRunCaptureRef,

    // Tool approval
    toolApprovalResolverRef,
    setToolApproval,

    // Attachment and checkpoint registries
    pastedContentRegistryRef,
    imageAttachmentRegistryRef,
    fileAttachmentRegistryRef,
    checkpointsRef,
    restoredFileBoundaryRef,
    promptQueue,

    // Session dispatch and plan flow
    dispatchSession,
    setPlanFlow,
    bumpWorkbench,

    // Resume picker, viewers and conversation switches
    setResumeConversations,
    catalogListsRef,
    resumePickerPositionRef,
    setScreen,
    workspaceRoot,
    launchContext,
    exit,
    setExternalViewerSession,
    externalViewerSession,
    setSavedViewerSession,
    savedViewerSession,
    startupResumeHandledRef,
    launchArgs,

    // Provider config and route override
    providerWorkspaceConfig,
    providerOverride,
    providerRegistry,
    routeChoiceRequiredRef,
    setConversationRouteOverride,

    // Focus routing and lifecycle
    busyRef,
    isMountedRef,
    externalCliLaunchHooks,
    intendedFocusTargetRef,
    focusManager,
    pendingQuitRef,

    // Usage totals
    setConversationChars,

    // Conversation saving
    saveActiveConversation,
    selectionCoordinator,
    modelSelectionInFlightRef,
    modelPickerOpenRef,
    setRouteSwitchBusy,
    waitUntilRenderFlush,
    suspendTerminal,
  } = context;

  const [transition] = useState(() => new ResumeTransition());
  const [resumeLoading, setResumeLoading] = useState(false);
  const [relocationTarget, setRelocationTarget] = useState<string | null>(null);
  const [relocationError, setRelocationError] = useState<string | null>(null);
  const relocationRef = useRef<{ folder: string; session: SessionSummary } | null>(null);
  useEffect(
    () => () => {
      transition.cancel();
    },
    [transition],
  );
  const cancelResume = useCallback(() => {
    transition.cancel();
    setScreen("main");
  }, [transition]);

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
    if (busy || operationActive()) {
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
        pending.catch(() => {
          if (catalogListsRef.current.get(scope) === pending) catalogListsRef.current.delete(scope);
        });
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
    transition.cancel();
    relocationRef.current = null;
    setRelocationTarget(null);
    setRelocationError(null);
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
      resume?: { conversationId: string } | { source: string; sessionId: string },
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
        setScreen("main");
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
        await waitUntilRenderFlush();
        exit({
          kind: "workspace-relaunch",
          plan: prepared.plan,
          returnResumeId: activeConversationRef.current?.metadata.id,
        });
      } catch (error) {
        recoveryRef.current = false;
        appendEvent("error", "Workspace resume failed", errorMessage(error));
        setScreen("main");
      }
    },
    [appendEvent, conversationStore, exit, launchContext],
  );

  /** Suspends Ubume and resumes an external session in its own CLI. */
  const resumeExternalSessionNative = useCallback(
    async (summary: ExternalSessionSummary) => {
      if (busyRef.current || operationActive()) {
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
      recoveryRef.current = true;

      const label = externalSourceLabel(summary.source);
      try {
        await waitUntilRenderFlush();
        saveCurrentChatOrThrow();
        const providers = providerWorkspaceConfig.providers;
        const prepared = await buildExternalResumeLaunch(summary, {
          fallbackCwd: workspaceRoot,
          configuredPaths: {
            claude: providers?.anthropic?.claudeCommandPath,
            codex: providers?.openai?.codexCommandPath,
            antigravity: providers?.google?.antigravityCommandPath,
          },
        });
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
        const result = await suspendTerminal(() =>
          launchCliCommand(launch.displayName, launch, externalCliLaunchHooks),
        );
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
      } finally {
        finishRecovery({ recoveryRef, bumpWorkbench, pendingQuitRef });
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
    async (id: string, ref?: Extract<SessionRef, { kind: "ubume" }>) => {
      if (operationActive()) {
        appendEvent(
          "system",
          "Resume unavailable",
          "Stop the active operation before switching sessions.",
        );
        return;
      }

      const operation = transition.begin();
      recoveryRef.current = true;
      setResumeLoading(true);
      setScreen("resume-picker");
      let lease: ReturnType<ConversationStore["prepareLease"]> | undefined;
      try {
        await stoppingRef.current;
        if (!operation.current() || !isMountedRef.current) return;
        saveCurrentChatOrThrow();
        lease = conversationStore.prepareLease(id);
        let loaded = ref ? readOwnedConversation(ref) : conversationStore.load(id);
        if (!loaded && !ref) {
          const catalog = await listSessionCatalog(workspaceRoot, "workspace", { sources: [] });
          const alias = catalog.sessions.find(
            (entry) => entry.ref.kind === "ubume" && entry.ref.conversationId === id,
          );
          if (alias?.ref.kind === "ubume") loaded = readOwnedConversation(alias.ref);
        }
        if (!operation.current() || !isMountedRef.current) return;
        if (!loaded) throw new Error("That conversation could not be loaded.");
        const saved = loaded.session;
        const interrupted = saved ? interruptedRunMessage(saved.events, loaded.messages) : null;
        const resumed = interrupted
          ? { ...loaded, messages: [...loaded.messages, interrupted] }
          : loaded;
        const events = hydrateConversationEvents(resumed);
        advanceIdsPast(events);
        const assessment = assessResumedRoute(
          resumed.metadata,
          providerOverride,
          providerWorkspaceConfig,
        );

        // Recovery may fail or yield. Do not replace the active chat until it succeeds.
        const executionLease = acquireOwnership(workspaceRoot, "execution");
        let recovered = false;
        try {
          recovered = await new CheckpointStore(workspaceRoot, id).recover();
        } finally {
          executionLease.release();
        }
        if (!operation.current() || !isMountedRef.current) return;
        operation.commit();
        const previousHarnessSessionId =
          activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
        lease.commit();
        selectionCoordinator.cancel();
        selectionCoordinator.navigate(assessment.route?.providerId);
        modelSelectionInFlightRef.current = false;
        modelPickerOpenRef.current = false;
        setRouteSwitchBusy(false);
        const replacement = armTranscriptReplacement(
          "src/app/conversation/useResumeFlows.ts:resumeConversation",
        );
        preserveSavedRouteRef.current = true;
        activeConversationRef.current = resumed;
        setConversationChars(conversationCharCount(loaded.messages));
        resetTimelineMeasureCaches();
        resetRunStateForResume();
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
        routeChoiceRequiredRef.current =
          assessment.status === "unavailable" ? assessment.message : null;
        setConversationRouteOverride(assessment.route ?? null);
        dispatchSession({
          type: "RESTORE_SESSION",
          events,
          value: saved?.draft ?? "",
          cursor: saved?.cursor ?? 0,
          history: saved?.history ?? promptHistoryFromMessages(resumed.messages),
          uiState: saved?.uiState,
        });
        bumpWorkbench((value) => value + 1);
        replacement.finish();
        if (
          previousHarnessSessionId &&
          previousHarnessSessionId !== resumed.metadata.localHarnessSession?.sessionId
        )
          stoppingRef.current = stoppingRef.current.then(() =>
            closeLocalHarnessSession(previousHarnessSessionId),
          );
        if (recovered)
          appendEvent("system", "File recovery", "Rolled back an interrupted restoration.");
        if (assessment.status === "unavailable")
          appendEvent(
            "system",
            "Original route unavailable",
            `${assessment.message} History has been restored for viewing.`,
          );
        else
          appendEvent(
            "system",
            "Conversation resumed",
            `${resumed.metadata.title}\n${describeContinuation(resumed)}`,
          );
        setScreen("main");
        intendedFocusTargetRef.current = FOCUS_IDS.composer;
        focusManager.focus(FOCUS_IDS.composer);
      } catch (error) {
        if (operation.current() && isMountedRef.current) {
          appendEvent("error", "Resume failed", errorMessage(error));
          setScreen("main");
        }
      } finally {
        lease?.release();
        operation.finish();
        if (isMountedRef.current) setResumeLoading(false);
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
      if (!summary.cwd || !isAbsolute(summary.cwd)) {
        appendEvent(
          "error",
          "Original workspace unknown",
          "This session does not record an absolute original folder. Open its transcript for viewing.",
        );
        return;
      }
      if (!sameFolder(summary.cwd, workspaceRoot)) {
        await relaunchSavedSession(summary.cwd, { source: summary.source, sessionId: summary.id });
        return;
      }

      const operation = transition.begin();
      recoveryRef.current = true;
      setResumeLoading(true);
      let recordId: string | undefined;
      let notice = "";
      try {
        saveCurrentChatOrThrow();
        const providerId = externalProviderId(summary.source);
        const transcript = await readExternalTranscript(summary);
        if (!operation.current() || !isMountedRef.current) return;
        // The import owns its target lease; it must not replace the active store's lease.
        const importStore = new ConversationStore(workspaceRoot, { ownership: true });
        try {
          const record = importNativeConversation(
            importStore,
            transcript,
            findProvider(providerRegistry, providerId)?.currentModel ?? "unknown",
          );
          recordId = record.metadata.id;
        } finally {
          importStore.release();
        }
        notice = transcript.notice ?? "";
      } catch (error) {
        if (operation.current() && isMountedRef.current)
          appendEvent("error", "Continue failed", errorMessage(error));
      } finally {
        operation.finish();
        setResumeLoading(false);
        finishRecovery({ recoveryRef, bumpWorkbench, pendingQuitRef });
      }
      if (recordId && !operation.signal.aborted && isMountedRef.current) {
        setExternalViewerSession(null);
        await resumeConversation(recordId);
        if (activeConversationRef.current?.metadata.id === recordId)
          appendEvent(
            "system",
            "Continuing in Ubume",
            `Imported “${summary.title}” from ${externalSourceLabel(summary.source)}. Context is reconstructed from its transcript. ${notice}`,
          );
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
      if (
        !session.workspaceRoot ||
        !isAbsolute(session.workspaceRoot) ||
        !isDirectory(session.workspaceRoot)
      ) {
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
      await resumeConversation(session.ref.conversationId, session.ref);
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
      try {
        setRelocationError(null);
        const pending = relocationRef.current;
        if (pending) {
          if (value.trim() !== "RELOCATE")
            throw new Error("Type RELOCATE to confirm, or Escape to cancel.");
          if (operationActive()) throw new Error("Finish the active operation before relocating.");
          saveCurrentChatOrThrow();
          const relocated = relocateConversation(session.ref, pending.folder);
          relocationRef.current = null;
          setRelocationTarget(null);
          if (sameFolder(relocated.folder, workspaceRoot)) await resumeConversation(relocated.id);
          else await relaunchSavedSession(relocated.folder, { conversationId: relocated.id });
          return;
        }
        const folder = realpathSync(normalizeWorkspaceRoot(value));
        if (!statSync(folder).isDirectory()) throw new Error("Select an existing directory.");
        if (session.workspaceRoot && sameFolder(folder, session.workspaceRoot)) {
          await selectResumeSession({
            ...session,
            workspaceRoot: folder,
            ref: { ...session.ref, workspaceRoot: folder },
          });
          return;
        }
        relocationRef.current = { folder, session };
        setRelocationTarget(folder);
      } catch (error) {
        setRelocationError(errorMessage(error));
      }
    },
    [
      appendEvent,
      savedViewerSession,
      selectResumeSession,
      resumeConversation,
      relaunchSavedSession,
      workspaceRoot,
    ],
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
    resumeLoading,
    relocationTarget,
    relocationError,
    cancelRelocation: () => {
      relocationRef.current = null;
      setRelocationTarget(null);
      setRelocationError(null);
      setScreen("saved-session-viewer");
    },
    cancelResume,
    handleWorkspaceRelaunch: (target: string) => relaunchSavedSession(target),
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
