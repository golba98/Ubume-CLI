/**
 * Small persistence helpers shared by conversation, run and workbench hooks:
 * saving a conversation record, ending a conversation switch, and resetting
 * or restoring the per-conversation scratch state.
 */

import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ProviderImageAttachment } from "../../core/providerRuntime/types.js";
import { errorMessage } from "../../core/shared/values.js";
import type { FileBoundary, FileCheckpoint } from "../../core/workspace/checkpoints.js";
import type {
  ConversationRecord,
  ConversationStore,
} from "../../core/workspace/conversationStore.js";
import type { FileAttachment, PromptQueue, WorkbenchSnapshot } from "../../session/workbench.js";
import type { PastedContentRegistry } from "../../ui/input/pastedContent.js";

interface SaveContext {
  conversationStore: ConversationStore;
  snapshotRef: RefObject<(() => WorkbenchSnapshot) | null>;
  lastSaveErrorRef: RefObject<string | null>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
}

/**
 * Saves a conversation with the current workbench snapshot. Save errors are
 * reported under `options.title`; `deduplicate` suppresses repeating the same
 * error, `rememberError` records it in `lastSaveErrorRef` (which blocks
 * conversation switches), and `clearOnSuccess` clears it again.
 */
export function saveConversationRecord(
  next: ConversationRecord,
  context: SaveContext,
  options: {
    title: string;
    deduplicate?: boolean;
    rememberError?: boolean;
    clearOnSuccess?: boolean;
  },
): void {
  const { conversationStore, snapshotRef, lastSaveErrorRef, appendEvent } = context;
  try {
    conversationStore.save({ ...next, session: snapshotRef.current?.() });
    if (options.clearOnSuccess) {
      lastSaveErrorRef.current = null;
    }
  } catch (error) {
    const message = errorMessage(error, "Filesystem error");
    if (!options.deduplicate || lastSaveErrorRef.current !== message) {
      appendEvent("error", options.title, message);
    }
    if (options.rememberError) {
      lastSaveErrorRef.current = message;
    }
  }
}

interface RecoveryContext {
  recoveryRef: RefObject<boolean>;
  bumpWorkbench: Dispatch<SetStateAction<number>>;
  pendingQuitRef: RefObject<(() => void) | null>;
}

/**
 * Ends a conversation switch, /clear or rewind: releases `recoveryRef`,
 * refreshes the workbench, and runs a quit requested while it was active.
 */
export function finishRecovery(context: RecoveryContext): void {
  context.recoveryRef.current = false;
  context.bumpWorkbench((value) => value + 1);
  const quit = context.pendingQuitRef.current;
  context.pendingQuitRef.current = null;
  quit?.();
}

interface ScratchContext {
  promptQueue: PromptQueue;
  checkpointsRef: RefObject<FileCheckpoint[]>;
  restoredFileBoundaryRef: RefObject<FileBoundary | undefined>;
}

/** Reset transient queue and recovery state when selecting a new conversation branch. */
export function resetConversationScratchState(context: ScratchContext): void {
  context.promptQueue.restore([]);
  context.checkpointsRef.current = [];
  context.restoredFileBoundaryRef.current = undefined;
}

interface RegistryContext extends ScratchContext {
  pastedContentRegistryRef: RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: RefObject<Map<string, ProviderImageAttachment>>;
  fileAttachmentRegistryRef: RefObject<Map<string, FileAttachment>>;
}

/** Restores pastes, attachments, checkpoints and the queue saved with a conversation. */
export function restoreConversationScratchState(
  context: RegistryContext,
  saved: WorkbenchSnapshot | undefined,
): void {
  context.pastedContentRegistryRef.current = new Map(saved?.pastes ?? []);
  context.imageAttachmentRegistryRef.current = new Map(saved?.images ?? []);
  context.fileAttachmentRegistryRef.current = new Map(saved?.files ?? []);
  context.checkpointsRef.current = saved?.checkpoints ?? [];
  context.restoredFileBoundaryRef.current = saved?.restoredFileBoundary;
  context.promptQueue.restore(saved?.queue ?? []);
}
