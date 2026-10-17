/**
 * The active conversation record and its persistence.
 *
 * - A conversation is created by its first sent prompt
 *   (`appendConversationMessage`). Autosave never creates one, so a draft
 *   alone does not become a /resume entry.
 * - Autosave runs 300 ms after composer or workbench changes, every second
 *   while a run is busy, once when a run ends, and on process exit.
 * - `captureFinalRef` finishes a run's file checkpoint once the provider
 *   process has stopped, and closes a Local harness session whose close was
 *   deferred while the run used it.
 *
 * Effects are declared in the order they ran in the original
 * `useConversation`; `useConversation` calls this hook first.
 */

import { useCallback, useEffect } from "react";
import { closeLocalHarnessSession } from "../../core/providerRuntime/localHarness/runtime.js";
import type {
  ConversationMessage,
  ConversationRecord,
} from "../../core/workspace/conversationStore.js";
import type { PersistedRunStatus } from "../../session/persistedResponse.js";
import type { UseConversationContext } from "./conversationContext.js";
import { buildRunAssistantMessage, withRouteMetadata } from "./conversationMetadata.js";
import { saveConversationRecord } from "./conversationPersistence.js";

type ActiveConversationContext = Pick<
  UseConversationContext,
  | "activeConversationRef"
  | "snapshotRef"
  | "preserveSavedRouteRef"
  | "activeProviderRoute"
  | "conversationStore"
  | "lastSaveErrorRef"
  | "appendEvent"
  | "saveWorkbenchRef"
  | "inputValue"
  | "cursor"
  | "workbenchVersion"
  | "planFlow"
  | "busy"
  | "stoppingRef"
  | "workspaceLeaseRef"
  | "captureFinalRef"
  | "activeCheckpointRef"
  | "processStoppedRef"
  | "pendingCaptureRef"
  | "deferredRouteCloseRef"
  | "activeRunCaptureRef"
>;

const AUTOSAVE_DEBOUNCE_MS = 300;
const BUSY_AUTOSAVE_INTERVAL_MS = 1000;

/** Options shared by every save of the active conversation. */
const ACTIVE_SAVE_OPTIONS = {
  title: "Session save failed",
  deduplicate: true,
  rememberError: true,
  clearOnSuccess: true,
} as const;

export function useActiveConversation(context: ActiveConversationContext) {
  const {
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
  } = context;

  const persist = (record: ConversationRecord) => {
    activeConversationRef.current = record;
    saveConversationRecord(
      record,
      { conversationStore, snapshotRef, lastSaveErrorRef, appendEvent },
      ACTIVE_SAVE_OPTIONS,
    );
  };

  /**
   * Saves the active conversation with the current workbench snapshot. The
   * route is updated to the active one unless the conversation was resumed
   * and its saved route must be kept (`preserveSavedRouteRef`).
   */
  const saveActiveConversation = useCallback(() => {
    const current = activeConversationRef.current;
    if (!current) {
      return;
    }
    persist({
      ...current,
      session: snapshotRef.current?.(),
      metadata: preserveSavedRouteRef.current
        ? current.metadata
        : withRouteMetadata(current.metadata, activeProviderRoute),
    });
  }, [activeProviderRoute, conversationStore]);

  const saveWorkbench = useCallback(() => {
    saveActiveConversation();
  }, [saveActiveConversation]);
  saveWorkbenchRef.current = saveWorkbench;

  useEffect(() => {
    const timer = setTimeout(saveWorkbench, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputValue, cursor, workbenchVersion, planFlow, saveWorkbench]);

  useEffect(() => {
    if (!busy) {
      saveWorkbench();
      return;
    }
    const interval = setInterval(saveWorkbench, BUSY_AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [busy, saveWorkbench]);

  // Flush on exit, then release the workspace lease and conversation lock
  // once any in-flight provider has stopped.
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

  // Assigned during render so finalizePromptRun always calls the latest version.
  captureFinalRef.current = (runId) => {
    const capture = activeCheckpointRef.current;
    if (!capture || capture.runId !== runId) {
      return;
    }
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
        // If the user switched conversations meanwhile, save the run's own
        // conversation directly instead of overwriting the new one.
        if (original && activeConversationRef.current?.metadata.id !== original.metadata.id) {
          conversationStore.save({ ...original, session: originalSnapshot });
        } else {
          saveWorkbenchRef.current?.();
        }
      })
      .catch((error) => {
        appendEvent("error", "Checkpoint unavailable", (error as Error).message);
      })
      .finally(() => lease?.release());
    stoppingRef.current = work;
  };

  /** Appends a message, creating the conversation on the first one. */
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
      persist({ ...current, messages: [...current.messages, message] });
    },
    [activeProviderRoute, conversationStore],
  );

  /** Saves the assistant message for a finished run and releases its capture. */
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
      if (capture) {
        activeRunCaptureRef.current = null;
      }
      const message = buildRunAssistantMessage(capture, status, response);
      if (message) {
        appendConversationMessage(message);
      }
    },
    [appendConversationMessage],
  );

  return { saveActiveConversation, appendConversationMessage, persistRunConversationMessage };
}
