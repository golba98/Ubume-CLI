/**
 * Workbench actions: the prompt queue, `/send-now`, external-editor drafts,
 * rewinding to a checkpoint, confirming outside-workspace file imports, and
 * the interrupt/redraw keys (`useInterruptKeys`).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { useApp } from "ink";
import { useCallback } from "react";
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
import { useInterruptKeys } from "./useInterruptKeys.js";

interface UseWorkbenchActionsContext {
  // Navigation and workbench view
  setWorkbenchView: React.Dispatch<React.SetStateAction<WorkbenchView>>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  screen: Screen;
  screenRef: React.RefObject<Screen>;

  // Session, transcript and composer
  promptQueue: PromptQueue;
  getSessionState: () => SessionState;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  dispatchSession: (action: SessionAction) => void;
  resetComposer: () => void;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;

  // Terminal control
  terminalControl: ReturnType<typeof createTerminalModeController>;
  inkInstance: InkRenderInstance | null;
  stdout: NodeJS.WriteStream;
  bumpStaticRepaintGeneration: React.Dispatch<React.SetStateAction<number>>;
  suspendTerminal: ReturnType<typeof useApp>["suspendTerminal"];

  // Run lifecycle and guards
  handleQuit: () => void;
  handleCancel: () => void;
  activeRunIdRef: React.RefObject<number | null>;
  stoppingRef: React.RefObject<Promise<void>>;
  isMountedRef: React.RefObject<boolean>;
  submissionRef: React.RefObject<boolean>;
  recoveryRef: React.RefObject<boolean>;
  pipelineGenerationRef: React.RefObject<number>;
  runControlRef: React.RefObject<ProviderRunControl | null>;
  cancelActiveRun: (retainHistory?: boolean) => boolean;
  setInterruptHint: React.Dispatch<React.SetStateAction<InterruptHint | null>>;

  // Plan flow
  planFlow: PlanFlowState;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  pendingQuitRef: React.RefObject<(() => void) | null>;

  // Attachments and workspace
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  workspaceRoot: string;

  // Runs, conversation and rewind
  startPromptRun: (
    displayPrompt: string,
    providerPrompt: string,
    lifecycle?: PromptRunLifecycle,
  ) => boolean;
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  conversationStore: ConversationStore;
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  checkpointsRef: React.RefObject<FileCheckpoint[]>;
  snapshotRef: React.RefObject<(() => WorkbenchSnapshot) | null>;
  armTranscriptReplacement: (source: string) => {
    clearGeneration: number;
    clearBoundaryArmed: boolean;
    finish: () => void;
  };

  // Outside-workspace import confirmation
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

  /** Opens the workbench panel on a view (`/queue`, `/transcript`, `/diff`, `/rewind`). */
  const openWorkbench = useCallback((view: WorkbenchView) => {
    setWorkbenchView(view);
    setScreen("workbench-panel");
  }, []);

  // ---------------------------------------------------------------------------
  // Prompt queue
  // ---------------------------------------------------------------------------

  /**
   * Moves a queued prompt back into an empty composer for editing. Editing
   * uses the immutable expanded file context; image chips are re-attached so
   * a later submission cannot silently lose the queued images.
   * Returns false when the composer already holds a draft.
   */
  const editQueuedPrompt = useCallback(
    (id: string): boolean => {
      if (getSessionState().inputValue.trim()) {
        appendEvent(
          "system",
          "Draft retained",
          "Clear or submit the current draft before editing a queued instruction.",
        );
        return false;
      }
      const item = promptQueue.items.find((queued) => queued.id === id);
      if (!item) {
        return true;
      }
      let draft = item.submitted;
      for (const [token, image] of imageAttachmentRegistryRef.current) {
        if (item.images.some((attachment) => attachment.path === image.path)) {
          draft = draft.split(token).join("");
        }
      }
      const tokens = item.images.map((image) => {
        const token = createImageAttachmentToken(image);
        imageAttachmentRegistryRef.current.set(token, image);
        return token;
      });
      dispatchSession({ type: "SET_INPUT", value: [draft, ...tokens].join("\n") });
      promptQueue.remove(id);
      setScreen("main");
      return true;
    },
    [appendEvent, dispatchSession, getSessionState, promptQueue],
  );

  const handleQueueAction = useCallback(
    (action: QueueAction, id?: string) => {
      switch (action) {
        case "pause":
          promptQueue.paused = !promptQueue.paused;
          break;
        case "continue":
          promptQueue.paused = false;
          break;
        case "remove":
          if (id) {
            promptQueue.remove(id);
          }
          break;
        case "up":
        case "down":
          if (id) {
            promptQueue.move(id, action === "up" ? -1 : 1);
          }
          break;
        case "edit":
          if (id && !editQueuedPrompt(id)) {
            return;
          }
          break;
      }
      saveWorkbenchRef.current?.();
      bumpWorkbench((value) => value + 1);
    },
    [editQueuedPrompt, promptQueue],
  );

  /**
   * Ctrl+L: clears the visible screen and forces Ink to write a complete
   * fresh frame, with static transcript content re-flushed.
   */
  const handleRedraw = useCallback(() => {
    terminalControl.write("\x1b[2J\x1b[H", "user:redraw");
    resetInkOutputForFreshFrame({ instance: inkInstance, columns: stdout.columns });
    bumpStaticRepaintGeneration((value) => value + 1);
  }, [terminalControl, inkInstance, stdout]);

  // Global interrupt keys (Ctrl+C/Ctrl+Q/Ctrl+L) — shares the queue, quit and
  // cancel handlers above.
  useInterruptKeys({
    promptQueue,
    handleQuit,
    handleCancel,
    handleRedraw,
    activeRunIdRef,
    stoppingRef,
    isMountedRef,
    submissionRef,
    pipelineGenerationRef,
    getSessionState,
    resetComposer,
    setInterruptHint,
    screen,
    planFlow,
  });

  // ---------------------------------------------------------------------------
  // External editor
  // ---------------------------------------------------------------------------

  /** Edits the draft (with attachments expanded) in $EDITOR, suspending the TUI. */
  const handleExternalEditor = useCallback(async () => {
    if (submissionRef.current) {
      return;
    }
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

  // ---------------------------------------------------------------------------
  // /send-now
  // ---------------------------------------------------------------------------

  /** Queues the composer draft (unless it is a command) with its attachments expanded. */
  const queueDraftForSendNow = useCallback(async () => {
    const draft = getSessionState().inputValue.trim();
    if (!draft || draft.startsWith("/")) {
      return;
    }
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
    for (const image of images) {
      if (!existsSync(image.path)) {
        throw new Error(`Image attachment is missing: ${image.name}`);
      }
    }
    promptQueue.push(queuedPrompt(draft, submitted, images));
    resetComposer();
  }, [getSessionState, promptQueue, resetComposer, workspaceRoot]);

  /**
   * `/send-now`: delivers the draft and every queued prompt to the model now.
   *
   * Providers that support steering receive them mid-run. Otherwise the
   * active run is canceled and the batch starts as one merged prompt. Queued
   * items are removed only once they were actually delivered.
   */
  const handleSendNow = useCallback(async () => {
    const blocked =
      submissionRef.current ||
      recoveryRef.current ||
      planFlow.kind !== "idle" ||
      screenRef.current === "tool-approval";
    if (blocked) {
      return;
    }

    submissionRef.current = true;
    const generation = pipelineGenerationRef.current;

    try {
      await queueDraftForSendNow();

      if (!promptQueue.items.length) {
        return;
      }

      // Providers that support steering receive the batch mid-run.
      const control = runControlRef.current;
      const batch = [...promptQueue.items];
      const steered =
        control?.steer && (await control.steer(batch.map((item) => item.submitted).join("\n\n")));

      if (steered) {
        for (const item of batch) {
          promptQueue.remove(item.id);
        }
      } else {
        // Otherwise cancel the active run and restart with one merged prompt.
        promptQueue.paused = true;
        cancelActiveRun(true);
        await stoppingRef.current;

        if (generation !== pipelineGenerationRef.current) {
          return;
        }

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

        if (started) {
          for (const item of batch) {
            promptQueue.remove(item.id);
          }
        }
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
    planFlow.kind,
    promptQueue,
    queueDraftForSendNow,
    startPromptRun,
  ]);
  // ---------------------------------------------------------------------------
  // Rewind
  // ---------------------------------------------------------------------------

  /**
   * Rewinds to `checkpoint`. Depending on `recoveryMode` it restores the
   * selected file edits, branches the conversation at that turn (the original
   * conversation is kept as the branch's parent), or both.
   *
   * Throws when an operation is running or there is no conversation; the
   * workbench panel shows the error.
   */
  const handleRewind = useCallback(
    async (
      checkpoint: FileCheckpoint,
      recoveryMode: RecoveryMode,
      operations: RestoreOperation[],
    ) => {
      if (activeRunIdRef.current !== null || submissionRef.current) {
        throw new Error("Stop the current operation before rewinding.");
      }
      const current = activeConversationRef.current;
      if (!current) {
        throw new Error("No conversation to rewind.");
      }
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
          // The rewound prompt returns to the composer for editing.
          const rewoundPrompt =
            current.messages[checkpoint.messageCount]?.submittedContent ?? checkpoint.prompt;
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
            value: rewoundPrompt,
            cursor: rewoundPrompt.length,
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

  // ---------------------------------------------------------------------------
  // Outside-workspace imports
  // ---------------------------------------------------------------------------

  /**
   * Copies the outside-workspace files the prompt mentions into the
   * attachments folder, rewrites the prompt to point at the copies, and runs
   * it. Files that fail to import are reported and left as written.
   */
  const handleImportConfirm = useCallback(async () => {
    if (!pendingImport) {
      return;
    }
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

  /** Returns the prompt to the composer without importing anything. */
  const handleImportCancel = useCallback(() => {
    if (!pendingImport) {
      return;
    }
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
