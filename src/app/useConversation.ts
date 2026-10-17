import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { useFocusManager } from "ink";
import { useCallback, useEffect } from "react";
import type { LaunchArgs } from "../config/launchArgs.js";
import {
  buildExternalResumeLaunch,
  type ExternalSessionSummary,
  externalProviderId,
  externalSourceLabel,
  listExternalSessions,
  readExternalTranscript,
} from "../core/externalSessions/index.js";
import { traceInputDebug } from "../core/perf/debugLog.js";
import { launchCliCommand } from "../core/providerLauncher/launcher.js";
import { resolveProviderIdentity } from "../core/providerLauncher/providerIdentity.js";
import { findProvider, isKnownProviderId } from "../core/providerLauncher/registry.js";
import type { ProviderConfig, ProviderWorkspaceConfig } from "../core/providerLauncher/types.js";
import { discoverLocalModels } from "../core/providerRuntime/local.js";
import { closeLocalHarnessSession } from "../core/providerRuntime/localHarness/runtime.js";
import { discoverProviderModels } from "../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../core/providerRuntime/types.js";
import type {
  BackendProvider,
  GenerationMetadata,
  ProviderRunControl,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../core/providers/types.js";
import { errorMessage } from "../core/shared/values.js";
import { workspaceStorageKey } from "../core/workspace/appData.js";
import {
  CheckpointStore,
  type FileBoundary,
  type FileCheckpoint,
} from "../core/workspace/checkpoints.js";
import type {
  ConversationListEntry,
  ConversationMessage,
  ConversationRecord,
  ConversationStore,
} from "../core/workspace/conversationStore.js";
import type { LaunchContext } from "../core/workspace/launchContext.js";
import { acquireOwnership, type OwnershipLease } from "../core/workspace/ownership.js";
import type { ProjectInstructionsLoadResult } from "../core/workspace/projectInstructions.js";
import { normalizeWorkspaceRoot, sameFolder } from "../core/workspace/workspaceRoot.js";
import type { SessionAction } from "../session/appSession.js";
import { conversationMessagesToTimeline } from "../session/conversation.js";
import {
  advanceIdsPast,
  createEventId,
  createProviderMigrationNoticeEvent,
  createTurnId,
  type PromptRunTiming,
} from "../session/eventIds.js";
import {
  buildPersistedAssistantMessage,
  type PersistedFileActivity,
  type PersistedRunStatus,
} from "../session/persistedResponse.js";
import { createInitialPlanFlowState, type PlanFlowState } from "../session/planFlow.js";
import {
  assessSavedRoute,
  createSessionWorkspaceRelaunch,
  importNativeConversation,
  listSessionCatalog,
  type SessionCatalogResult,
  type SessionSummary,
  sessionIsInWorkspace,
} from "../session/sessionCatalog.js";
import type { Screen, TimelineEvent } from "../session/types.js";
import {
  type FileAttachment,
  type PromptQueue,
  restoredEvents,
  type WorkbenchSnapshot,
} from "../session/workbench.js";
import { FOCUS_IDS } from "../ui/input/focus.js";
import type { ImageAttachmentRegistry, PastedContentRegistry } from "../ui/input/pastedContent.js";
import type { ExternalListScope, ResumePickerPosition } from "../ui/panels/resumePickerRows.js";
import { resetTimelineMeasureCaches } from "../ui/timeline/timelineMeasure.js";
import {
  finishRecovery,
  restoreConversationScratchState,
  saveConversationRecord,
} from "./conversationPersistence.js";
import type { PromptRunLifecycle } from "./promptRunPrep.js";

interface UseConversationContext {
  armTranscriptReplacement: (source: string) => {
    clearGeneration: number;
    clearBoundaryArmed: boolean;
    finish: () => void;
  };
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  snapshotRef: React.RefObject<(() => WorkbenchSnapshot) | null>;
  preserveSavedRouteRef: React.RefObject<boolean>;
  activeProviderRoute: ProviderRoute;
  conversationStore: ConversationStore;
  lastSaveErrorRef: React.RefObject<string | null>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;
  inputValue: string;
  cursor: number;
  workbenchVersion: number;
  planFlow: PlanFlowState;
  busy: boolean;
  stoppingRef: React.RefObject<Promise<void>>;
  workspaceLeaseRef: React.RefObject<OwnershipLease | undefined>;
  captureFinalRef: React.RefObject<((runId: number) => void) | null>;
  activeCheckpointRef: React.RefObject<{
    runId: number;
    checkpoint: FileCheckpoint;
    store: CheckpointStore;
  } | null>;
  processStoppedRef: React.RefObject<Promise<void>>;
  pendingCaptureRef: React.RefObject<Promise<void>>;
  deferredRouteCloseRef: React.RefObject<string | undefined>;
  activeRunCaptureRef: React.RefObject<{
    runId: number;
    text: string;
    tools: Map<string, string>;
    files: Map<string, PersistedFileActivity>;
    generationMetadata?: GenerationMetadata;
  } | null>;
  setResumeConversations: React.Dispatch<React.SetStateAction<ConversationListEntry[]>>;
  catalogListsRef: React.RefObject<Map<ExternalListScope, Promise<SessionCatalogResult>>>;
  resumePickerPositionRef: React.RefObject<ResumePickerPosition | undefined>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  workspaceRoot: string;
  activeRunIdRef: React.RefObject<number | null>;
  submissionRef: React.RefObject<boolean>;
  recoveryRef: React.RefObject<boolean>;
  launchContext: LaunchContext;
  exit: (errorOrResult?: Error | unknown) => void;
  setExternalViewerSession: React.Dispatch<React.SetStateAction<ExternalSessionSummary | null>>;
  externalViewerSession: ExternalSessionSummary | null;
  setSavedViewerSession: React.Dispatch<React.SetStateAction<SessionSummary | null>>;
  busyRef: React.RefObject<boolean>;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  isMountedRef: React.RefObject<boolean>;
  externalCliLaunchHooks: {
    stdin: NodeJS.ReadStream;
    beforeLaunch: () => void;
    afterLaunch: () => void;
  };
  setConversationChars: React.Dispatch<React.SetStateAction<number>>;
  pipelineGenerationRef: React.RefObject<number>;
  runControlRef: React.RefObject<ProviderRunControl | null>;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
  activeTurnIdRef: React.RefObject<number | null>;
  toolApprovalResolverRef: React.RefObject<((decision: ToolApprovalDecision) => void) | null>;
  setToolApproval: React.Dispatch<React.SetStateAction<ToolApprovalRequest | null>>;
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  checkpointsRef: React.RefObject<FileCheckpoint[]>;
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  promptQueue: PromptQueue;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  dispatchSession: (action: SessionAction) => void;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  providerOverride: BackendProvider | undefined;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  setConversationRouteOverride: React.Dispatch<React.SetStateAction<ProviderRoute | null>>;
  intendedFocusTargetRef: React.RefObject<string>;
  focusManager: ReturnType<typeof useFocusManager>;
  pendingQuitRef: React.RefObject<(() => void) | null>;
  providerRegistry: ProviderConfig[];
  savedViewerSession: SessionSummary | null;
  startupResumeHandledRef: React.RefObject<boolean>;
  launchArgs: LaunchArgs;
  providerMigrationNoticeShownRef: React.RefObject<boolean>;
  appendStaticEvent: (event: TimelineEvent) => void;
  projectInstructionsLoad: ProjectInstructionsLoadResult;
}

export function useConversation(context: UseConversationContext) {
  const {
    armTranscriptReplacement,
    activeConversationRef,
    snapshotRef,
    preserveSavedRouteRef,
    activeProviderRoute,
    conversationStore,
    lastSaveErrorRef,
    appendEvent,
    saveWorkbenchRef,
    inputValue,
    cursor,
    workbenchVersion,
    planFlow,
    busy,
    stoppingRef,
    workspaceLeaseRef,
    captureFinalRef,
    activeCheckpointRef,
    processStoppedRef,
    pendingCaptureRef,
    deferredRouteCloseRef,
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
    providerMigrationNoticeShownRef,
    appendStaticEvent,
    projectInstructionsLoad,
  } = context;

  const saveActiveConversation = useCallback(() => {
    const current = activeConversationRef.current;
    if (!current) return;
    const next: ConversationRecord = {
      ...current,
      session: snapshotRef.current?.(),
      metadata: preserveSavedRouteRef.current
        ? current.metadata
        : {
            ...current.metadata,
            providerId: activeProviderRoute.providerId,
            modelId: activeProviderRoute.modelId,
            backendKind: activeProviderRoute.backendKind,
            ...(activeProviderRoute.localBackend
              ? { localBackend: activeProviderRoute.localBackend }
              : {}),
            ...(activeProviderRoute.reasoning ? { reasoning: activeProviderRoute.reasoning } : {}),
          },
    };
    activeConversationRef.current = next;
    saveConversationRecord(
      next,
      { conversationStore, snapshotRef, lastSaveErrorRef, appendEvent },
      {
        title: "Session save failed",
        deduplicate: true,
        rememberError: true,
        clearOnSuccess: true,
      },
    );
  }, [activeProviderRoute, conversationStore]);

  // A conversation is created by its first sent prompt (appendConversationMessage);
  // autosave never creates one, so a draft alone does not become a /resume entry.
  const saveWorkbench = useCallback(() => {
    saveActiveConversation();
  }, [saveActiveConversation]);
  saveWorkbenchRef.current = saveWorkbench;
  useEffect(() => {
    const timer = setTimeout(saveWorkbench, 300);
    return () => clearTimeout(timer);
  }, [inputValue, cursor, workbenchVersion, planFlow, saveWorkbench]);
  useEffect(() => {
    if (!busy) {
      saveWorkbench();
      return;
    }
    const interval = setInterval(saveWorkbench, 1000);
    return () => clearInterval(interval);
  }, [busy, saveWorkbench]);
  useEffect(() => {
    const flush = () => saveWorkbenchRef.current?.();
    process.on("beforeExit", flush);
    return () => {
      flush();
      process.off("beforeExit", flush);
      void stoppingRef.current.finally(() => {
        workspaceLeaseRef.current?.release();
        workspaceLeaseRef.current = undefined;
        conversationStore.release();
      });
    };
  }, []);
  captureFinalRef.current = (runId) => {
    const capture = activeCheckpointRef.current;
    if (!capture || capture.runId !== runId) return;
    activeCheckpointRef.current = null;
    const stopped = processStoppedRef.current;
    const original = activeConversationRef.current;
    const originalSnapshot = snapshotRef.current?.();
    const lease = workspaceLeaseRef.current;
    workspaceLeaseRef.current = undefined;
    const work = pendingCaptureRef.current
      .then(async () => {
        await stopped;
        if (deferredRouteCloseRef.current) {
          const id = deferredRouteCloseRef.current;
          deferredRouteCloseRef.current = undefined;
          await closeLocalHarnessSession(id);
        }
        capture.checkpoint.after = await capture.store.capture();
        if (original && activeConversationRef.current?.metadata.id !== original.metadata.id)
          conversationStore.save({ ...original, session: originalSnapshot });
        else saveWorkbenchRef.current?.();
      })
      .catch((error) => {
        appendEvent("error", "Checkpoint unavailable", (error as Error).message);
      })
      .finally(() => lease?.release());
    stoppingRef.current = work;
  };

  const appendConversationMessage = useCallback(
    (message: ConversationMessage) => {
      const current =
        activeConversationRef.current ??
        conversationStore.createConversation({
          providerId: activeProviderRoute.providerId,
          modelId: activeProviderRoute.modelId,
          backendKind: activeProviderRoute.backendKind,
          localBackend: activeProviderRoute.localBackend,
          reasoning: activeProviderRoute.reasoning,
        });
      const next: ConversationRecord = { ...current, messages: [...current.messages, message] };
      activeConversationRef.current = next;
      saveConversationRecord(
        next,
        { conversationStore, snapshotRef, lastSaveErrorRef, appendEvent },
        {
          title: "Session save failed",
          deduplicate: true,
          rememberError: true,
          clearOnSuccess: true,
        },
      );
    },
    [activeProviderRoute, conversationStore],
  );

  const persistRunConversationMessage = useCallback(
    (
      runId: number,
      status: PersistedRunStatus,
      response: {
        renderedResponse?: string;
        completeResponse?: string;
        errorMessage?: string;
      } = {},
    ) => {
      const capture =
        activeRunCaptureRef.current?.runId === runId ? activeRunCaptureRef.current : null;
      if (capture) activeRunCaptureRef.current = null;
      const message = buildPersistedAssistantMessage({
        status,
        ...response,
        streamedText: capture?.text ?? "",
        toolCommands: capture ? [...capture.tools.values()] : [],
        fileActivity: capture ? [...capture.files.values()] : [],
      });
      if (message)
        appendConversationMessage({
          ...message,
          ...(capture?.generationMetadata
            ? { generationMetadata: capture.generationMetadata }
            : {}),
        });
      else if (capture?.generationMetadata?.providerId === "codexa-native")
        appendConversationMessage({
          role: "assistant",
          content: capture.generationMetadata.rawOutput,
          generationMetadata: capture.generationMetadata,
        });
    },
    [appendConversationMessage],
  );

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

  const relaunchSavedSession = useCallback(
    async (
      target: string,
      resume: { conversationId: string } | { source: string; sessionId: string },
    ) => {
      if (activeRunIdRef.current !== null || submissionRef.current || recoveryRef.current) {
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
        saveWorkbenchRef.current?.();
        if (lastSaveErrorRef.current)
          throw new Error(`Current chat could not be saved: ${lastSaveErrorRef.current}`);
        const harness = activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
        if (harness) await closeLocalHarnessSession(harness);
        conversationStore.release();
        workspaceLeaseRef.current?.release();
        workspaceLeaseRef.current = undefined;
        setScreen("main");
        appendEvent("system", "Opening saved workspace", prepared.plan.targetWorkspaceRoot);
        await new Promise((resolve) => setTimeout(resolve, OVERLAY_EXIT_SETTLE_MS));
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
    [appendEvent, appendEvent, conversationStore, exit, launchContext],
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
      await new Promise((resolve) => setTimeout(resolve, OVERLAY_EXIT_SETTLE_MS));
      const label = externalSourceLabel(summary.source);
      try {
        saveWorkbenchRef.current?.();
        if (lastSaveErrorRef.current)
          throw new Error(`Current chat could not be saved: ${lastSaveErrorRef.current}`);
        const prepared = await buildExternalResumeLaunch(summary, {
          fallbackCwd: workspaceRoot,
        });
        if (!isMountedRef.current) return;
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
        if (!isMountedRef.current) return;
        if (result.status === "completed")
          appendEvent("system", "Resume in native CLI", result.message);
        else appendEvent("error", `${label} resume failed`, result.message);
      } catch (error) {
        if (isMountedRef.current)
          appendEvent("error", `${label} resume failed`, errorMessage(error, "Launch failed."));
      }
    },
    [
      appendEvent,
      appendEvent,
      externalCliLaunchHooks,
      workspaceRoot,
      providerWorkspaceConfig.providers,
    ],
  );

  const resumeConversation = useCallback(
    async (id: string) => {
      if (activeRunIdRef.current !== null || submissionRef.current || recoveryRef.current) {
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
        saveWorkbenchRef.current?.();
        if (lastSaveErrorRef.current)
          throw new Error(`Current chat could not be saved: ${lastSaveErrorRef.current}`);
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
          "src/app/useConversation.ts:resumeConversation",
        );
        preserveSavedRouteRef.current = true;
        activeConversationRef.current = loaded;
        setConversationChars(
          loaded.messages.reduce((total, message) => total + message.content.length, 0),
        );
        resetTimelineMeasureCaches();
        pipelineGenerationRef.current++;
        runControlRef.current = null;
        activeRunCaptureRef.current = null;
        activeRunLifecycleRef.current = null;
        activeRunTimingRef.current = null;
        activeTurnIdRef.current = null;
        toolApprovalResolverRef.current?.("deny");
        toolApprovalResolverRef.current = null;
        setToolApproval(null);
        const saved = loaded.session;
        const events = saved
          ? restoredEvents(saved.events)
          : conversationMessagesToTimeline(loaded.messages, createEventId, createTurnId);
        advanceIdsPast(events);
        if (saved && loaded.messages.at(-1)?.role === "user") {
          const partial = [...saved.events].reverse().find((event) => event.type === "assistant");
          const lastRun = [...saved.events].reverse().find((event) => event.type === "run");
          if (
            lastRun?.type === "run" &&
            lastRun.status === "running" &&
            partial?.type === "assistant" &&
            partial.turnId === lastRun.turnId
          ) {
            loaded.messages.push({
              role: "assistant",
              content: `${partial.contentChunks.join("") || partial.content}\n\n[Run interrupted before session closed]`,
            });
          }
        }
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
          history:
            saved?.history ??
            loaded.messages
              .filter((item) => item.role === "user")
              .map((item) => item.content)
              .reverse()
              .slice(0, 50),
          uiState: saved?.uiState,
        });
        const lease = acquireOwnership(workspaceRoot, "execution");
        try {
          if (await new CheckpointStore(workspaceRoot, id).recover())
            appendEvent("system", "File recovery", "Rolled back an interrupted restoration.");
        } finally {
          lease.release();
        }
        bumpWorkbench((value) => value + 1);
        replacement.finish();
        const savedProvider = resolveProviderIdentity(
          loaded.metadata.providerId,
          loaded.metadata.backendKind,
        );
        const routeProvider =
          savedProvider && isKnownProviderId(savedProvider) ? savedProvider : null;
        const discovery =
          routeProvider === "local"
            ? discoverLocalModels(undefined, loaded.metadata.localBackend)
            : routeProvider
              ? discoverProviderModels(routeProvider)
              : null;
        const assessment = assessSavedRoute(
          loaded.metadata,
          providerOverride ? null : discovery,
          !!providerOverride ||
            !routeProvider ||
            providerWorkspaceConfig.providers?.[routeProvider]?.enabled !== false,
        );
        routeChoiceRequiredRef.current =
          assessment.status === "unavailable" ? assessment.message : null;
        setConversationRouteOverride(assessment.route ?? null);
        if (assessment.status === "unavailable")
          appendEvent(
            "system",
            "Original route unavailable",
            `${assessment.message} History has been restored for viewing.`,
          );
        else appendEvent("system", "Conversation resumed", loaded.metadata.title);
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
      appendEvent,
      armTranscriptReplacement,
      conversationStore,
      dispatchSession,
      focusManager,
      providerOverride,
      providerWorkspaceConfig.providers,
    ],
  );

  const continueExternalSession = useCallback(
    async (summary: ExternalSessionSummary) => {
      if (activeRunIdRef.current !== null || submissionRef.current || recoveryRef.current) {
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
        saveWorkbenchRef.current?.();
        if (lastSaveErrorRef.current)
          throw new Error(`Current chat could not be saved: ${lastSaveErrorRef.current}`);
        const providerId = externalProviderId(summary.source);
        const transcript = await readExternalTranscript(summary);
        const record = importNativeConversation(
          conversationStore,
          transcript,
          findProvider(providerRegistry, providerId)?.currentModel ?? "unknown",
        );
        conversationStore.release();
        setExternalViewerSession(null);
        recoveryRef.current = false;
        await resumeConversation(record.metadata.id);
        if (activeConversationRef.current?.metadata.id === record.metadata.id) {
          appendEvent(
            "system",
            "Continuing in Ubume",
            `Imported “${summary.title}” from ${externalSourceLabel(summary.source)}.${transcript.notice ? ` ${transcript.notice}` : ""}`,
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
      appendEvent,
      conversationStore,
      providerRegistry,
      relaunchSavedSession,
      resumeConversation,
      workspaceRoot,
    ],
  );

  const selectResumeSession = useCallback(
    async (session: SessionSummary) => {
      if (session.native) {
        openExternalSession(session.native);
        return;
      }
      if (session.ref.kind !== "ubume") return;
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

  const locateSavedWorkspace = useCallback(
    async (value: string) => {
      const session = savedViewerSession;
      if (!session || session.ref.kind !== "ubume") return;
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

  useEffect(() => {
    if (startupResumeHandledRef.current || (!launchArgs.resumeId && !launchArgs.importSession))
      return;
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
      if (!summary)
        throw new Error("The selected native session was not found in its original workspace.");
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

  useEffect(() => {
    const notice = providerWorkspaceConfig.migrationNotice;
    if (!notice || providerMigrationNoticeShownRef.current) return;
    const providerLabel =
      findProvider(providerRegistry, notice.revertedProviderId)?.displayName ?? "OpenAI";
    const event = createProviderMigrationNoticeEvent(notice, providerLabel);
    if (!event) return;
    providerMigrationNoticeShownRef.current = true;
    appendStaticEvent(event);
  }, [appendStaticEvent, providerRegistry, providerWorkspaceConfig.migrationNotice]);

  useEffect(() => {
    if (projectInstructionsLoad.status === "loaded") {
      traceInputDebug("project_instructions_loaded", {
        path: projectInstructionsLoad.instructions.path,
        content: projectInstructionsLoad.instructions.content,
      });
      return;
    }

    if (projectInstructionsLoad.status === "error") {
      appendEvent(
        "error",
        "Project instructions",
        `Could not read ${projectInstructionsLoad.path}: ${projectInstructionsLoad.message}`,
      );
    }
  }, [appendEvent, projectInstructionsLoad]);
  return {
    saveActiveConversation,
    appendConversationMessage,
    persistRunConversationMessage,
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

// Ink throttles frame writes (~34 ms at 30 fps). Leaving an overlay exits the
// alternate screen inside that write, so a child CLI waits this long before it
// takes the terminal.
export const OVERLAY_EXIT_SETTLE_MS = 80;
