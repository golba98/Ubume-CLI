/**
 * Builds the element shown in the composer slot: the plan action picker
 * while a plan awaits review, the plan feedback entry while collecting a
 * revision note, and the normal prompt composer otherwise.
 *
 * The element is memoized so that streaming updates, which re-render App
 * constantly, do not rebuild the composer.
 */

import { useMemo } from "react";
import { estimateTokens } from "../../config/settings.js";
import type { ModelSpec } from "../../core/providerRuntime/contextMetadata.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { SessionState } from "../../session/appSession.js";
import { cancelPlanFeedback, type PlanFlowState } from "../../session/planFlow.js";
import type { UIState } from "../../session/types.js";
import type { FileAttachment, PromptQueue } from "../../session/workbench.js";
import { MemoizedBottomComposer } from "../../ui/chrome/BottomComposer.js";
import type { InterruptHint } from "../../ui/chrome/composer/composerModel.js";
import { FOCUS_IDS } from "../../ui/input/focus.js";
import type { TerminalViewport } from "../../ui/layout.js";
import type { PlanActionValue } from "../../ui/panels/PlanActionPicker.js";
import { PlanActionPicker } from "../../ui/panels/PlanActionPicker.js";
import { TextEntryPanel } from "../../ui/panels/TextEntryPanel.js";
import type { WorkbenchView } from "../../ui/panels/WorkbenchPanel.js";
import type { buildActiveRuntimeDisplay } from "../../ui/render/runtimeDisplay.js";

interface UseAppComposerContext {
  // Plan review and revision flow
  planFlow: PlanFlowState;
  handlePlanAction: (action: PlanActionValue) => void;
  handleCancel: () => void;
  initialRevisionText: string;
  setInitialRevisionText: React.Dispatch<React.SetStateAction<string>>;
  handlePlanFeedbackSubmit: (value: string) => void;
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;

  // Layout, mode and runtime display
  terminalLayout: TerminalViewport;
  composerInstanceKey: number;
  composerWidth: number;
  uiState: UIState;
  mode: "suggest" | "auto-edit" | "full-auto";
  modelDisplayName: string;
  activeRuntimeDisplay: ReturnType<typeof buildActiveRuntimeDisplay>;
  activeThemeName: string;
  planMode: boolean;
  showBusyLoader: boolean;
  interruptHint: InterruptHint | null;
  conversationChars: number;
  currentModelSpec: ModelSpec;

  // Composer text and actions
  inputValue: string;
  cursor: number;
  handleChangeInput: (value: string, nextCursor: number) => void;
  handleRegisterPaste: (label: string, content: string) => void;
  handlePasteImage: (replaceCommand?: boolean) => Promise<void>;
  handleSubmit: () => Promise<void>;
  handleRedraw: () => void;
  openWorkbench: (view: WorkbenchView) => void;
  handleExternalEditor: () => Promise<void>;
  handleSendNow: () => Promise<void>;

  // Attachments, workspace and session state
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  workspaceRoot: string;
  sessionState: SessionState;
  promptQueue: PromptQueue;

  // History, pickers and quit
  handleHistoryUp: () => void;
  handleHistoryDown: () => void;
  openProviderPicker: () => void;
  openModelPicker: () => void;
  cycleModeWithNotice: () => void;
  handleQuit: () => void;

  // Active route and workbench version (re-render triggers)
  activeProviderRoute: ProviderRoute;
  workbenchVersion: number;
}

export function useAppComposer(context: UseAppComposerContext) {
  const {
    planFlow,
    terminalLayout,
    handlePlanAction,
    handleCancel,
    initialRevisionText,
    setInitialRevisionText,
    handlePlanFeedbackSubmit,
    setPlanFlow,
    composerInstanceKey,
    composerWidth,
    uiState,
    mode,
    modelDisplayName,
    activeRuntimeDisplay,
    activeThemeName,
    planMode,
    showBusyLoader,
    interruptHint,
    conversationChars,
    currentModelSpec,
    inputValue,
    cursor,
    handleChangeInput,
    handleRegisterPaste,
    handlePasteImage,
    handleSubmit,
    handleRedraw,
    openWorkbench,
    handleExternalEditor,
    handleSendNow,
    fileAttachmentRegistryRef,
    workspaceRoot,
    sessionState,
    promptQueue,
    handleHistoryUp,
    handleHistoryDown,
    openProviderPicker,
    openModelPicker,
    cycleModeWithNotice,
    handleQuit,
    activeProviderRoute,
    workbenchVersion,
  } = context;

  // Memoize the composer element so AppShell's memo check (prev.composer ===
  // next.composer) passes during streaming. Without this, a new JSX element is
  // created on every App render, forcing the entire AppShell tree (header +
  // timeline + footer) to re-render on every 25ms streaming flush.
  const composerElement = useMemo(() => {
    if (planFlow.kind === "awaiting_action") {
      return (
        <PlanActionPicker
          cols={terminalLayout.cols}
          onSelect={handlePlanAction}
          onCancel={handleCancel}
        />
      );
    }
    if (planFlow.kind === "collecting_feedback") {
      return (
        <TextEntryPanel
          focusId={FOCUS_IDS.composer}
          title="Update plan"
          subtitle="Describe what should change. Enter regenerates the plan."
          inputLabel="Update"
          placeholder={
            planFlow.mode === "revise"
              ? "e.g. keep it to one file and add tests"
              : "e.g. keep it minimal and avoid touching other files"
          }
          footerHint="Esc to close · Enter to confirm"
          initialValue={initialRevisionText}
          onSubmit={(value) => {
            setInitialRevisionText("");
            handlePlanFeedbackSubmit(value);
          }}
          onCancel={() => setPlanFlow((current) => cancelPlanFeedback(current))}
        />
      );
    }
    return (
      <MemoizedBottomComposer
        key={composerInstanceKey}
        layout={terminalLayout}
        width={composerWidth}
        uiState={uiState}
        mode={mode}
        model={modelDisplayName}
        footerModelDisplay={activeRuntimeDisplay.footerModelDisplay}
        themeName={activeThemeName}
        // The footer shows reasoning through the runtime display.
        reasoningLevel=""
        contextDisplay={activeRuntimeDisplay.contextDisplay}
        showContext={activeRuntimeDisplay.showContext}
        planMode={planMode}
        showBusyLoader={showBusyLoader}
        interruptHint={interruptHint}
        tokensUsed={estimateTokens(conversationChars)}
        modelSpec={currentModelSpec}
        value={inputValue}
        cursor={cursor}
        onChangeInput={handleChangeInput}
        onRegisterPaste={handleRegisterPaste}
        onPasteImage={() => {
          void handlePasteImage();
        }}
        onSubmit={() => {
          void handleSubmit();
        }}
        onRedraw={handleRedraw}
        onTranscript={() => openWorkbench("transcript")}
        onExternalEditor={() => {
          void handleExternalEditor();
        }}
        onSendNow={() => {
          void handleSendNow();
        }}
        onRegisterFile={(token, filePath) => {
          fileAttachmentRegistryRef.current.set(token, { path: filePath });
        }}
        workspaceRoot={workspaceRoot}
        history={sessionState.history}
        queueCount={promptQueue.items.length}
        queuePaused={promptQueue.paused}
        onCancel={handleCancel}
        onHistoryUp={handleHistoryUp}
        onHistoryDown={handleHistoryDown}
        onOpenProviderPicker={openProviderPicker}
        onOpenModelPicker={openModelPicker}
        onCycleMode={cycleModeWithNotice}
        onQuit={handleQuit}
        activeProviderId={activeProviderRoute.providerId}
        externalCliStatus={sessionState.externalCliStatus}
      />
    );
  }, [
    planFlow,
    initialRevisionText,
    handlePlanAction,
    handleCancel,
    handlePlanFeedbackSubmit,
    composerInstanceKey,
    composerWidth,
    terminalLayout,
    uiState,
    mode,
    modelDisplayName,
    activeRuntimeDisplay.footerModelDisplay,
    activeRuntimeDisplay.contextDisplay,
    activeRuntimeDisplay.showContext,
    activeThemeName,
    planMode,
    showBusyLoader,
    conversationChars,
    currentModelSpec,
    inputValue,
    interruptHint,
    cursor,
    handleChangeInput,
    handleRegisterPaste,
    handlePasteImage,
    handleSubmit,
    handleRedraw,
    openWorkbench,
    handleExternalEditor,
    handleSendNow,
    workbenchVersion,
    sessionState.history,
    workspaceRoot,
    handleHistoryUp,
    handleHistoryDown,
    openProviderPicker,
    openModelPicker,
    cycleModeWithNotice,
    handleQuit,
    activeProviderRoute.providerId,
    sessionState.externalCliStatus,
  ]);
  return { composerElement };
}
