import { existsSync } from "node:fs";
import path from "node:path";
import type { useApp } from "ink";
import { useInput } from "ink";
import { useCallback, useEffect, useRef } from "react";
import type { ProviderRunControl } from "../../core/providers/types.js";
import { errorMessage } from "../../core/shared/values.js";
import { editExternalPrompt } from "../../core/terminal/externalEditor.js";
import type { InkRenderInstance } from "../../core/terminal/inkRenderReset.js";
import { resetInkOutputForFreshFrame } from "../../core/terminal/inkRenderReset.js";
import type { createTerminalModeController } from "../../core/terminal/terminalControl.js";
import {
  importExternalFile,
  rewritePromptWithImportedPaths,
} from "../../core/workspace/attachments.js";
import type { FileBoundary, RestoreOperation } from "../../core/workspace/checkpoints.js";
import {
  assertFileRecoveryReady,
  CheckpointStore,
  type FileCheckpoint,
} from "../../core/workspace/checkpoints.js";
import type {
  ConversationRecord,
  ConversationStore,
} from "../../core/workspace/conversationStore.js";
import { acquireOwnership, type OwnershipLease } from "../../core/workspace/ownership.js";
import { expandFileAttachments } from "../../core/workspace/workspaceFiles.js";
import type { SessionAction, SessionState } from "../../session/appSession.js";
import { conversationMessagesToTimeline } from "../../session/conversation.js";
import { createEventId, createPromptRunTiming, createTurnId } from "../../session/eventIds.js";
import { createInitialPlanFlowState, type PlanFlowState } from "../../session/planFlow.js";
import type { Screen } from "../../session/types.js";
import {
  eventsBeforeTurn,
  type FileAttachment,
  type PromptQueue,
  queuedPrompt,
  restoredEvents,
  type WorkbenchSnapshot,
} from "../../session/workbench.js";
import type { InterruptHint } from "../../ui/chrome/composer/composerModel.js";
import {
  assertAttachedContent,
  createImageAttachmentToken,
  expandPastedContent,
  type ImageAttachmentRegistry,
  type PastedContentRegistry,
  selectImageAttachments,
} from "../../ui/input/pastedContent.js";
import type { PendingImportFile } from "../../ui/panels/AttachmentImportPanel.js";
import type { QueueAction, RecoveryMode, WorkbenchView } from "../../ui/panels/WorkbenchPanel.js";
import {
  finishRecovery,
  resetConversationScratchState,
} from "../conversation/conversationPersistence.js";

import type { PromptRunLifecycle } from "../run/promptRunPrep.js";

interface UseWorkbenchActionsContext {
  setWorkbenchView: React.Dispatch<React.SetStateAction<WorkbenchView>>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  promptQueue: PromptQueue;
  getSessionState: () => SessionState;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  dispatchSession: (action: SessionAction) => void;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  terminalControl: ReturnType<typeof createTerminalModeController>;
  inkInstance: InkRenderInstance | null;
  stdout: NodeJS.WriteStream;
  bumpStaticRepaintGeneration: React.Dispatch<React.SetStateAction<number>>;
  handleQuit: () => void;
  activeRunIdRef: React.RefObject<number | null>;
  setInterruptHint: React.Dispatch<React.SetStateAction<InterruptHint | null>>;
  handleCancel: () => void;
  stoppingRef: React.RefObject<Promise<void>>;
  isMountedRef: React.RefObject<boolean>;
  submissionRef: React.RefObject<boolean>;
  pipelineGenerationRef: React.RefObject<number>;
  resetComposer: () => void;
  screen: Screen;
  planFlow: PlanFlowState;
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  workspaceRoot: string;
  suspendTerminal: ReturnType<typeof useApp>["suspendTerminal"];
  recoveryRef: React.RefObject<boolean>;
  screenRef: React.RefObject<Screen>;
  runControlRef: React.RefObject<ProviderRunControl | null>;
  cancelActiveRun: (retainHistory?: boolean) => boolean;
  startPromptRun: (
    displayPrompt: string,
    providerPrompt: string,
    lifecycle?: PromptRunLifecycle,
  ) => boolean;
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  checkpointsRef: React.RefObject<FileCheckpoint[]>;
  snapshotRef: React.RefObject<(() => WorkbenchSnapshot) | null>;
  conversationStore: ConversationStore;
  armTranscriptReplacement: (source: string) => {
    clearGeneration: number;
    clearBoundaryArmed: boolean;
    finish: () => void;
  };
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  pendingQuitRef: React.RefObject<(() => void) | null>;
  pendingImport: {
    prompt: string;
    providerPrompt: string;
    files: PendingImportFile[];
    attachmentsDir: string;
  } | null;
  setPendingImport: React.Dispatch<
    React.SetStateAction<{
      prompt: string;
      providerPrompt: string;
      files: PendingImportFile[];
      attachmentsDir: string;
    } | null>
  >;
}

/** How long the composer offers "Press Ctrl+C again to exit" before disarming. */
export const EXIT_CONFIRM_WINDOW_MS = 2000;

export function useWorkbenchActions(context: UseWorkbenchActionsContext) {
  const {
    setWorkbenchView,
    setScreen,
    promptQueue,
    getSessionState,
    appendEvent,
    imageAttachmentRegistryRef,
    dispatchSession,
    saveWorkbenchRef,
    bumpWorkbench,
    terminalControl,
    inkInstance,
    stdout,
    bumpStaticRepaintGeneration,
    handleQuit,
    activeRunIdRef,
    setInterruptHint,
    handleCancel,
    stoppingRef,
    isMountedRef,
    submissionRef,
    pipelineGenerationRef,
    resetComposer,
    screen,
    planFlow,
    pastedContentRegistryRef,
    fileAttachmentRegistryRef,
    workspaceRoot,
    suspendTerminal,
    recoveryRef,
    screenRef,
    runControlRef,
    cancelActiveRun,
    startPromptRun,
    activeConversationRef,
    restoredFileBoundaryRef,
    checkpointsRef,
    snapshotRef,
    conversationStore,
    armTranscriptReplacement,
    setPlanFlow,
    pendingQuitRef,
    pendingImport,
    setPendingImport,
  } = context;

  const openWorkbench = useCallback((view: WorkbenchView) => {
    setWorkbenchView(view);
    setScreen("workbench-panel");
  }, []);
  const handleQueueAction = useCallback(
    (action: QueueAction, id?: string) => {
      if (action === "pause") promptQueue.paused = !promptQueue.paused;
      else if (action === "continue") promptQueue.paused = false;
      else if (id && action === "remove") promptQueue.remove(id);
      else if (id && (action === "up" || action === "down"))
        promptQueue.move(id, action === "up" ? -1 : 1);
      else if (id && action === "edit") {
        if (getSessionState().inputValue.trim()) {
          appendEvent(
            "system",
            "Draft retained",
            "Clear or submit the current draft before editing a queued instruction.",
          );
          return;
        }
        const item = promptQueue.items.find((item) => item.id === id);
        if (item) {
          // Editing uses the immutable expanded file context. Reattach image chips
          // so subsequent submission cannot silently lose queued images.
          let draft = item.submitted;
          for (const [token, image] of imageAttachmentRegistryRef.current) {
            if (item.images.some((attachment) => attachment.path === image.path))
              draft = draft.split(token).join("");
          }
          const tokens = item.images.map((image) => {
            const token = createImageAttachmentToken(image);
            imageAttachmentRegistryRef.current.set(token, image);
            return token;
          });
          dispatchSession({ type: "SET_INPUT", value: [draft, ...tokens].join("\n") });
          promptQueue.remove(id);
          setScreen("main");
        }
      }
      saveWorkbenchRef.current?.();
      bumpWorkbench((value) => value + 1);
    },
    [appendEvent, dispatchSession, getSessionState, promptQueue],
  );
  const handleRedraw = useCallback(() => {
    terminalControl.write("\x1b[2J\x1b[H", "user:redraw");
    resetInkOutputForFreshFrame({ instance: inkInstance, columns: stdout.columns });
    bumpStaticRepaintGeneration((value) => value + 1);
  }, [terminalControl, inkInstance, stdout]);
  // The composer shows the exit hint exactly while the next Ctrl+C would quit.
  const exitArmedRef = useRef(false);
  const exitArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (exitArmTimerRef.current) clearTimeout(exitArmTimerRef.current);
    },
    [],
  );
  const disarmExit = useCallback(() => {
    if (exitArmTimerRef.current) clearTimeout(exitArmTimerRef.current);
    exitArmTimerRef.current = null;
    if (!exitArmedRef.current) return;
    exitArmedRef.current = false;
    if (isMountedRef.current) setInterruptHint((hint) => (hint === "confirm-exit" ? null : hint));
  }, [isMountedRef, setInterruptHint]);
  const armExit = useCallback(() => {
    exitArmedRef.current = true;
    setInterruptHint("confirm-exit");
    exitArmTimerRef.current = setTimeout(disarmExit, EXIT_CONFIRM_WINDOW_MS);
  }, [disarmExit, setInterruptHint]);
  const interruptCleanupRef = useRef(false);
  const handleInterrupt = useCallback(() => {
    promptQueue.paused = true;
    if (interruptCleanupRef.current) {
      handleQuit();
      return;
    }
    const exitArmed = exitArmedRef.current;
    disarmExit();
    if (activeRunIdRef.current !== null) {
      interruptCleanupRef.current = true;
      setInterruptHint("stopping");
      handleCancel();
      void stoppingRef.current.finally(() => {
        interruptCleanupRef.current = false;
        if (isMountedRef.current) setInterruptHint(null);
      });
      return;
    }
    if (submissionRef.current) {
      pipelineGenerationRef.current++;
      return;
    }
    if (getSessionState().inputValue) {
      resetComposer();
      return;
    }
    if (exitArmed) handleQuit();
    else armExit();
  }, [armExit, disarmExit, getSessionState, handleCancel, handleQuit, promptQueue, resetComposer]);
  useInput((input, key) => {
    if (!key.ctrl) return;
    if (input === "c") handleInterrupt();
    else if (
      screen !== "main" ||
      planFlow.kind === "awaiting_action" ||
      planFlow.kind === "collecting_feedback"
    ) {
      if (input === "q") handleQuit();
      else if (input === "l") handleRedraw();
    }
  });

  const handleExternalEditor = useCallback(async () => {
    if (submissionRef.current) return;
    submissionRef.current = true;
    try {
      const state = getSessionState();
      const text = await expandFileAttachments(
        expandPastedContent(state.inputValue, pastedContentRegistryRef.current),
        fileAttachmentRegistryRef.current,
        workspaceRoot,
      );
      const edited = await editExternalPrompt(text, (action) => suspendTerminal(action));
      dispatchSession({ type: "SET_INPUT", value: edited });
    } catch (error) {
      appendEvent("error", "External editor", (error as Error).message);
    } finally {
      submissionRef.current = false;
      handleRedraw();
    }
  }, [appendEvent, dispatchSession, getSessionState, handleRedraw, suspendTerminal, workspaceRoot]);
  const handleSendNow = useCallback(async () => {
    if (
      submissionRef.current ||
      recoveryRef.current ||
      planFlow.kind !== "idle" ||
      screenRef.current === "tool-approval"
    )
      return;
    submissionRef.current = true;
    const generation = pipelineGenerationRef.current;
    try {
      const state = getSessionState();
      const draft = state.inputValue.trim();
      if (draft && !draft.startsWith("/")) {
        assertAttachedContent(
          draft,
          pastedContentRegistryRef.current,
          imageAttachmentRegistryRef.current,
          fileAttachmentRegistryRef.current,
        );
        const submitted = await expandFileAttachments(
          expandPastedContent(draft, pastedContentRegistryRef.current),
          fileAttachmentRegistryRef.current,
          workspaceRoot,
        );
        const images = selectImageAttachments(draft, imageAttachmentRegistryRef.current);
        for (const image of images)
          if (!existsSync(image.path))
            throw new Error(`Image attachment is missing: ${image.name}`);
        promptQueue.push(queuedPrompt(draft, submitted, images));
        resetComposer();
      }
      if (!promptQueue.items.length) return;
      const control = runControlRef.current;
      const batch = [...promptQueue.items];
      if (
        control?.steer &&
        (await control.steer(batch.map((item) => item.submitted).join("\n\n")))
      ) {
        batch.forEach((item) => promptQueue.remove(item.id));
      } else {
        promptQueue.paused = true;
        cancelActiveRun(true);
        await stoppingRef.current;
        if (generation !== pipelineGenerationRef.current) return;
        const merged = queuedPrompt(
          batch.map((item) => item.display).join("\n\n"),
          batch.map((item) => item.submitted).join("\n\n"),
          batch.flatMap((item) => item.images),
        );
        const started = startPromptRun(merged.display, merged.submitted, {
          commitPrompt: true,
          preserveInput: true,
          queuedPromptIds: batch.map((item) => item.id),
          imageAttachments: merged.images,
        });
        if (started) batch.forEach((item) => promptQueue.remove(item.id));
      }
    } catch (error) {
      appendEvent("error", "Send now failed", (error as Error).message);
    } finally {
      submissionRef.current = false;
      saveWorkbenchRef.current?.();
      bumpWorkbench((value) => value + 1);
    }
  }, [
    appendEvent,
    cancelActiveRun,
    getSessionState,
    planFlow.kind,
    promptQueue,
    resetComposer,
    startPromptRun,
    workspaceRoot,
  ]);
  const handleRewind = useCallback(
    async (
      checkpoint: FileCheckpoint,
      recoveryMode: RecoveryMode,
      operations: RestoreOperation[],
    ) => {
      if (activeRunIdRef.current !== null || submissionRef.current)
        throw new Error("Stop the current operation before rewinding.");
      const current = activeConversationRef.current;
      if (!current) throw new Error("No conversation to rewind.");
      recoveryRef.current = true;
      let lease: OwnershipLease | undefined;
      try {
        await stoppingRef.current;
        lease = acquireOwnership(workspaceRoot, "execution");
        await assertFileRecoveryReady(workspaceRoot);
        saveWorkbenchRef.current?.();
        if (recoveryMode !== "conversation") {
          const store = new CheckpointStore(workspaceRoot, current.metadata.id);
          await store.restore(operations);
          restoredFileBoundaryRef.current = await store.capture();
          // Old file chains describe a workspace that has now been superseded.
          checkpointsRef.current = checkpointsRef.current.map((point) => ({
            ...point,
            recoveryInvalidated: true,
          }));
          appendEvent(
            "system",
            "File recovery",
            "Restored supported file edits. Earlier checkpoints remain available for conversation rewind.",
          );
        }
        if (recoveryMode !== "files") {
          const branchEvents = snapshotRef.current?.()?.events;
          const branch = conversationStore.createConversation(current.metadata);
          branch.messages = current.messages.slice(0, checkpoint.messageCount);
          branch.metadata.parentConversationId = current.metadata.id;
          branch.metadata.parentCheckpointId = checkpoint.id;
          const replacement = armTranscriptReplacement("user:rewind");
          activeConversationRef.current = branch;
          pipelineGenerationRef.current++;
          resetConversationScratchState({ promptQueue, checkpointsRef, restoredFileBoundaryRef });
          setPlanFlow(createInitialPlanFlowState());
          dispatchSession({
            type: "RESTORE_SESSION",
            events: branchEvents
              ? restoredEvents(eventsBeforeTurn(branchEvents, checkpoint.turnId))
              : conversationMessagesToTimeline(branch.messages, createEventId, createTurnId),
            value: current.messages[checkpoint.messageCount]?.submittedContent ?? checkpoint.prompt,
            cursor: (
              current.messages[checkpoint.messageCount]?.submittedContent ?? checkpoint.prompt
            ).length,
            history: branch.messages
              .filter((message) => message.role === "user")
              .map((message) => message.content)
              .reverse(),
          });
          replacement.finish();
        }
        saveWorkbenchRef.current?.();
      } finally {
        lease?.release();
        finishRecovery({ recoveryRef, bumpWorkbench, pendingQuitRef });
      }
    },
    [armTranscriptReplacement, conversationStore, dispatchSession, promptQueue, workspaceRoot],
  );

  const handleImportConfirm = useCallback(async () => {
    if (!pendingImport) return;
    const replacements: Array<{ rawPath: string; replacementPath: string }> = [];
    for (const file of pendingImport.files) {
      try {
        const destPath = await importExternalFile(file.srcPath, pendingImport.attachmentsDir);
        if (destPath) {
          replacements.push({ rawPath: file.rawPath, replacementPath: destPath });
        }
      } catch (err) {
        appendEvent(
          "error",
          "Import failed",
          `Could not import ${path.basename(file.srcPath)}: ${errorMessage(err)}`,
        );
      }
    }
    const rewrittenPrompt = rewritePromptWithImportedPaths(
      pendingImport.providerPrompt,
      replacements,
    );
    setPendingImport(null);
    setScreen("main");
    startPromptRun(pendingImport.prompt, rewrittenPrompt, {
      submitTiming: createPromptRunTiming(),
      commitPrompt: true,
    });
  }, [pendingImport, workspaceRoot, startPromptRun, appendEvent]);

  const handleImportCancel = useCallback(() => {
    if (!pendingImport) return;
    dispatchSession({
      type: "SET_INPUT",
      value: pendingImport.prompt,
      cursor: pendingImport.prompt.length,
    });
    setPendingImport(null);
    setScreen("main");
  }, [pendingImport, dispatchSession]);
  return {
    openWorkbench,
    handleQueueAction,
    handleRedraw,
    handleExternalEditor,
    handleSendNow,
    handleRewind,
    handleImportConfirm,
    handleImportCancel,
  };
}
