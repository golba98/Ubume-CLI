import path from "node:path";
import { useCallback } from "react";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import type { ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import { closeLocalHarnessSession } from "../../core/providerRuntime/localHarness/runtime.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import { readClipboardImage } from "../../core/shared/clipboard.js";
import { errorMessage } from "../../core/shared/values.js";
import { sanitizeTerminalInput } from "../../core/terminal/terminalSanitize.js";
import { resolveUbumeAttachmentDir } from "../../core/workspace/appData.js";
import { saveClipboardImage } from "../../core/workspace/attachments.js";
import type { FileBoundary, FileCheckpoint } from "../../core/workspace/checkpoints.js";
import type {
  ConversationRecord,
  ConversationStore,
} from "../../core/workspace/conversationStore.js";
import type { LaunchContext } from "../../core/workspace/launchContext.js";
import type { SessionAction } from "../../session/appSession.js";
import type { PromptRunTiming } from "../../session/eventIds.js";
import { createStartupStaticEvents } from "../../session/eventIds.js";
import { type PlanFlowState, resetPlanFlow } from "../../session/planFlow.js";
import type { TimelineEvent } from "../../session/types.js";
import type { FileAttachment, PromptQueue } from "../../session/workbench.js";
import {
  createImageAttachmentToken,
  type ImageAttachmentRegistry,
  type PastedContentRegistry,
} from "../../ui/input/pastedContent.js";
import { resetTimelineMeasureCaches } from "../../ui/timeline/timelineMeasure.js";
import { resetConversationScratchState } from "../conversation/conversationPersistence.js";
import type { PromptRunLifecycle } from "../run/promptRunPrep.js";

interface UseComposerEditingContext {
  dispatchSession: (action: SessionAction) => void;
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  busyRef: React.RefObject<boolean>;
  workspaceRoot: string;
  runtimeConfig: RuntimeConfig;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  inputValueRef: React.RefObject<string>;
  cursorRef: React.RefObject<number>;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  submissionRef: React.RefObject<boolean>;
  recoveryRef: React.RefObject<boolean>;
  pipelineGenerationRef: React.RefObject<number>;
  armTranscriptReplacement: (source: string) => {
    clearGeneration: number;
    clearBoundaryArmed: boolean;
    finish: () => void;
  };
  cancelActiveRun: (retainHistory?: boolean) => boolean;
  stoppingRef: React.RefObject<Promise<void>>;
  saveActiveConversation: () => void;
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  preserveSavedRouteRef: React.RefObject<boolean>;
  routeChoiceRequiredRef: React.RefObject<string | null>;
  conversationStore: ConversationStore;
  promptQueue: PromptQueue;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  checkpointsRef: React.RefObject<FileCheckpoint[]>;
  restoredFileBoundaryRef: React.RefObject<FileBoundary | undefined>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  setConversationRouteOverride: React.Dispatch<React.SetStateAction<ProviderRoute | null>>;
  activeTurnIdRef: React.RefObject<number | null>;
  activeRunLifecycleRef: React.RefObject<PromptRunLifecycle | null>;
  activeRunTimingRef: React.RefObject<(PromptRunTiming & { runId: number; turnId: number }) | null>;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  resetToHomeScreen: (seedEvents?: TimelineEvent[]) => void;
  providerWorkspaceConfig: ProviderWorkspaceConfig;
  pendingQuitRef: React.RefObject<(() => void) | null>;
  launchContext: LaunchContext;
}

export function useComposerEditing(context: UseComposerEditingContext) {
  const {
    dispatchSession,
    pastedContentRegistryRef,
    busyRef,
    workspaceRoot,
    runtimeConfig,
    imageAttachmentRegistryRef,
    inputValueRef,
    cursorRef,
    appendEvent,
    submissionRef,
    recoveryRef,
    pipelineGenerationRef,
    armTranscriptReplacement,
    cancelActiveRun,
    stoppingRef,
    saveActiveConversation,
    activeConversationRef,
    preserveSavedRouteRef,
    routeChoiceRequiredRef,
    conversationStore,
    promptQueue,
    fileAttachmentRegistryRef,
    checkpointsRef,
    restoredFileBoundaryRef,
    bumpWorkbench,
    setConversationRouteOverride,
    activeTurnIdRef,
    activeRunLifecycleRef,
    activeRunTimingRef,
    setPlanFlow,
    resetToHomeScreen,
    providerWorkspaceConfig,
    pendingQuitRef,
    launchContext,
  } = context;

  // ─── Stable composer-input callbacks ──────────────────────────────────────────
  // These use refs so the function identity never changes, avoiding
  // unnecessary downstream work even though the memo comparator on
  // MemoizedBottomComposer already skips callback checks.
  const handleChangeInput = useCallback(
    (value: string, nextCursor: number) => {
      const safeValue = sanitizeTerminalInput(value);
      dispatchSession({
        type: "SET_INPUT",
        value: safeValue,
        cursor: Math.min(nextCursor, safeValue.length),
      });
    },
    [dispatchSession],
  );

  const handleRegisterPaste = useCallback((label: string, content: string) => {
    const current = pastedContentRegistryRef.current.get(label) ?? [];
    pastedContentRegistryRef.current.set(label, [...current, content]);
  }, []);

  const handlePasteImage = useCallback(
    async (replaceCommand = false) => {
      if (busyRef.current) return;
      try {
        const clipboardImage = await readClipboardImage();
        const attachmentsDir = resolveUbumeAttachmentDir(
          workspaceRoot,
          runtimeConfig.policy.attachmentDir,
        );
        const imagePath = await saveClipboardImage(clipboardImage.data, attachmentsDir);
        const attachment = {
          path: imagePath,
          mediaType: clipboardImage.mediaType,
          name: path.basename(imagePath),
          bytes: clipboardImage.data.length,
        } as const;
        const token = createImageAttachmentToken(attachment);
        imageAttachmentRegistryRef.current.set(token, attachment);
        const currentValue = replaceCommand ? "" : inputValueRef.current;
        const currentCursor = replaceCommand ? 0 : cursorRef.current;
        const separator =
          currentValue && currentCursor > 0 && !/\s$/.test(currentValue.slice(0, currentCursor))
            ? " "
            : "";
        const inserted = `${separator}${token}`;
        const nextValue =
          currentValue.slice(0, currentCursor) + inserted + currentValue.slice(currentCursor);
        const nextCursor = currentCursor + inserted.length;
        dispatchSession({ type: "SET_INPUT", value: nextValue, cursor: nextCursor });
      } catch (error) {
        appendEvent(
          "error",
          "Clipboard image unavailable",
          errorMessage(error, "Could not read an image from the clipboard."),
        );
      }
    },
    [appendEvent, dispatchSession, runtimeConfig.policy.attachmentDir, workspaceRoot],
  );

  const handleClear = useCallback(async () => {
    if (submissionRef.current || recoveryRef.current) return;
    pipelineGenerationRef.current++;
    recoveryRef.current = true;
    const replacement = armTranscriptReplacement("src/app/input/useComposerEditing.ts:handleClear");
    try {
      cancelActiveRun(true);
      await stoppingRef.current;
      saveActiveConversation();
      const harnessSessionId =
        activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
      stoppingRef.current = stoppingRef.current
        .then(() => closeLocalHarnessSession(harnessSessionId))
        .then(() => undefined);
      activeConversationRef.current = null;
      preserveSavedRouteRef.current = false;
      routeChoiceRequiredRef.current = null;
      conversationStore.release();
      resetConversationScratchState({ promptQueue, checkpointsRef, restoredFileBoundaryRef });
      pastedContentRegistryRef.current.clear();
      imageAttachmentRegistryRef.current.clear();
      fileAttachmentRegistryRef.current.clear();
      bumpWorkbench((value) => value + 1);
      setConversationRouteOverride(null);
      activeTurnIdRef.current = null;
      activeRunLifecycleRef.current = null;
      activeRunTimingRef.current = null;
      setPlanFlow(resetPlanFlow());
      // Row caches are keyed by transcript item keys; drop them with the transcript.
      resetTimelineMeasureCaches();
      renderDebug.traceEvent("terminal", "clearReactStateRequested", {
        clearGeneration: replacement.clearGeneration,
        clearPending: replacement.clearBoundaryArmed,
      });
      resetToHomeScreen(
        createStartupStaticEvents({
          providerWorkspaceConfig,
        }),
      );
      replacement.finish();
    } finally {
      recoveryRef.current = false;
      bumpWorkbench((value) => value + 1);
      const quit = pendingQuitRef.current;
      pendingQuitRef.current = null;
      quit?.();
    }
  }, [
    armTranscriptReplacement,
    cancelActiveRun,
    launchContext,
    providerWorkspaceConfig,
    resetToHomeScreen,
    saveActiveConversation,
    workspaceRoot,
  ]);
  const handleHistoryUp = useCallback(() => {
    dispatchSession({ type: "HISTORY_UP" });
  }, [dispatchSession]);

  const handleHistoryDown = useCallback(() => {
    dispatchSession({ type: "HISTORY_DOWN" });
  }, [dispatchSession]);

  return {
    handleChangeInput,
    handleRegisterPaste,
    handlePasteImage,
    handleClear,
    handleHistoryUp,
    handleHistoryDown,
  };
}
