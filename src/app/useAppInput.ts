import { existsSync } from "node:fs";
import path from "node:path";
import type { useFocusManager } from "ink";
import { useCallback } from "react";
import { handleCommand } from "../commands/handler.js";
import type { LayeredConfigResult } from "../config/layeredConfig.js";
import type {
  ResolvedRuntimeConfig,
  RuntimeApprovalPolicy,
  RuntimeConfig,
  RuntimeNetworkAccess,
  RuntimePersonality,
  RuntimeSandboxMode,
  RuntimeServiceTier,
} from "../config/runtimeConfig.js";
import type { AvailableMode, AvailableModel, ReasoningLevel } from "../config/settings.js";
import {
  type AuthPreference,
  estimateTokens,
  type TerminalTitleMode,
  type WorkspaceDisplayMode,
} from "../config/settings.js";
import type { CodexModelCapabilities } from "../core/models/codexModelCapabilities.js";
import * as perf from "../core/perf/profiler.js";
import type { ProviderConfig } from "../core/providerLauncher/types.js";
import { unloadCodexaNative } from "../core/providerRuntime/codexaNative.js";
import type { ProviderImageAttachment } from "../core/providerRuntime/types.js";
import { sanitizeTerminalInput } from "../core/terminal/terminalSanitize.js";
import type { GlobalPackageManager } from "../core/version/packageManager.js";
import type { UpdateCheckResult } from "../core/version/updateCheck.js";
import { resolveUbumeAttachmentDir } from "../core/workspace/appData.js";
import { isImageFile } from "../core/workspace/attachments.js";
import type { ConversationRecord } from "../core/workspace/conversationStore.js";
import type { WorkspaceCommandContext } from "../core/workspace/launchContext.js";
import type { ProjectInstructionsLoadResult } from "../core/workspace/projectInstructions.js";
import { expandFileAttachments } from "../core/workspace/workspaceFiles.js";
import {
  findOutsideWorkspacePaths,
  formatSkippedDependencyPath,
  getPromptWorkspaceGuardMessage,
} from "../core/workspace/workspaceGuard.js";
import type { SessionAction, SessionState } from "../session/appSession.js";
import { buildFollowUpPrompt } from "../session/chatLifecycle.js";
import type { PromptRunTiming } from "../session/eventIds.js";
import { createPromptRunTiming } from "../session/eventIds.js";
import { type PlanFlowState, startPlanGeneration } from "../session/planFlow.js";
import type { Screen, UIState, UserPromptEvent } from "../session/types.js";
import { type FileAttachment, type PromptQueue, queuedPrompt } from "../session/workbench.js";
import type { InterruptHint } from "../ui/chrome/composer/composerModel.js";
import {
  assertAttachedContent,
  expandPastedContent,
  type ImageAttachmentRegistry,
  type PastedContentRegistry,
  selectImageAttachments,
} from "../ui/input/pastedContent.js";
import type { PendingImportFile } from "../ui/panels/AttachmentImportPanel.js";
import type { WorkbenchView } from "../ui/panels/WorkbenchPanel.js";
import type { ThemeSelectionState } from "../ui/theme.js";
import { dispatchCommand } from "./commandDispatch.js";
import type { PromptRunLifecycle } from "./promptRunPrep.js";

interface UseAppInputContext {
  activeConversationRef: React.RefObject<ConversationRecord | null>;
  submissionRef: React.RefObject<boolean>;
  recoveryRef: React.RefObject<boolean>;
  getSessionState: () => SessionState;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  dispatchSession: (action: SessionAction) => void;
  resetComposer: () => void;
  openWorkbench: (view: WorkbenchView) => void;
  handleSendNow: () => Promise<void>;
  busy: boolean;
  resumeConversation: (id: string) => Promise<void>;
  pipelineGenerationRef: React.RefObject<number>;
  stoppingRef: React.RefObject<Promise<void>>;
  activeRunIdRef: React.RefObject<number | null>;
  handleShellExecute: (command: string) => Promise<void>;
  layeredRuntimeConfig: LayeredConfigResult;
  runtimeConfig: RuntimeConfig;
  resolvedRuntimeConfig: ResolvedRuntimeConfig;
  workspaceDisplayMode: "dir" | "name" | "simple";
  terminalTitleMode: "dir" | "name" | "simple";
  showBusyLoader: boolean;
  workspaceCommandContext: WorkspaceCommandContext;
  conversationChars: number;
  activeRouteModelCapabilities: CodexModelCapabilities | null;
  routeStatusMessage: string;
  activeRouteProvider: ProviderConfig;
  projectInstructionsLoad: ProjectInstructionsLoadResult;
  handleQuit: () => void;
  handleClear: () => Promise<void>;
  openResumePicker: () => void;
  setModelWithNotice: (nextModel: AvailableModel) => Promise<void>;
  setModeWithNotice: (nextMode: AvailableMode) => void;
  setReasoningWithNotice: (nextReasoningLevel: ReasoningLevel) => void;
  setPlanModeWithNotice: (nextEnabled: boolean) => void;
  setProjectTrustWithNotice: (trusted: boolean) => void;
  setApprovalPolicyWithNotice: (nextValue: RuntimeApprovalPolicy) => void;
  setSandboxModeWithNotice: (nextValue: RuntimeSandboxMode) => void;
  setNetworkAccessWithNotice: (nextValue: RuntimeNetworkAccess) => void;
  addWritableRootWithNotice: (pathValue: string) => void;
  removeWritableRootWithNotice: (pathValue: string) => void;
  clearWritableRootsWithNotice: () => void;
  setServiceTierWithNotice: (nextValue: RuntimeServiceTier) => void;
  setPersonalityWithNotice: (nextValue: RuntimePersonality) => void;
  setAuthPreferenceWithNotice: (nextPreference: AuthPreference) => void;
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
  setWorkspaceDisplayModeWithNotice: (nextMode: WorkspaceDisplayMode) => void;
  setTerminalTitleModeWithNotice: (nextMode: TerminalTitleMode) => void;
  setShowBusyLoader: React.Dispatch<React.SetStateAction<boolean>>;
  repaintCommittedTheme: (themeName: string) => void;
  refreshAuthStatus: (announce: boolean) => Promise<void>;
  openProviderPicker: () => void;
  openModelPicker: () => void;
  openModePicker: () => void;
  openReasoningPicker: () => void;
  openSettingsPanel: () => void;
  openThemePicker: () => void;
  openPermissionsPanel: () => void;
  openAuthPanel: () => void;
  openUsagePanel: () => void;
  setVerboseMode: React.Dispatch<React.SetStateAction<boolean>>;
  verboseMode: boolean;
  handleCopy: () => Promise<void>;
  handlePasteImage: (replaceCommand?: boolean) => Promise<void>;
  handleWorkspaceRelaunch: (targetPath: string) => void;
  modelCapabilities: CodexModelCapabilities | null;
  refreshModelCapabilities: (
    forceRefresh?: boolean,
    announce?: boolean,
  ) => Promise<CodexModelCapabilities>;
  updateCheckResult: UpdateCheckResult | null;
  requestUpdateCheck: () => Promise<UpdateCheckResult>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  globalPackageManager: GlobalPackageManager;
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;
  fileAttachmentRegistryRef: React.RefObject<Map<string, FileAttachment>>;
  workspaceRoot: string;
  uiState: UIState;
  findUserPromptForTurn: (turnId: number) => UserPromptEvent | null;
  startPromptRun: (
    displayPrompt: string,
    providerPrompt: string,
    lifecycle?: PromptRunLifecycle,
  ) => boolean;
  promptQueue: PromptQueue;
  saveWorkbenchRef: React.RefObject<(() => void) | null>;
  bumpWorkbench: React.Dispatch<React.SetStateAction<number>>;
  allowedWritableRoots: string[];
  setPendingImport: React.Dispatch<
    React.SetStateAction<{
      prompt: string;
      providerPrompt: string;
      files: PendingImportFile[];
      attachmentsDir: string;
    } | null>
  >;
  planMode: boolean;
  mode: "suggest" | "auto-edit" | "full-auto";
  setPlanFlow: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  runPlanGeneration: (
    state: Extract<PlanFlowState, { kind: "generating" }>,
    displayPrompt: string,
    submitTiming?: PromptRunTiming,
    commitPrompt?: boolean,
    imageAttachments?: readonly ProviderImageAttachment[],
    preserveInput?: boolean,
    queuedPromptIds?: readonly string[],
  ) => boolean;
  focusManager: ReturnType<typeof useFocusManager>;
  handlePlanFeedbackSubmit: (value: string) => void;
  inputValue: string;
  interruptHint: InterruptHint | null;
  togglePlanModeWithNotice: () => void;
  themeSelection: ThemeSelectionState;
}

export function useAppInput(context: UseAppInputContext) {
  const {
    submissionRef,
    recoveryRef,
    getSessionState,
    appendEvent,
    dispatchSession,
    resetComposer,
    openWorkbench,
    handleSendNow,
    busy,
    resumeConversation,
    pipelineGenerationRef,
    stoppingRef,
    activeRunIdRef,
    handleShellExecute,
    layeredRuntimeConfig,
    runtimeConfig,
    resolvedRuntimeConfig,
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader,
    workspaceCommandContext,
    conversationChars,
    activeRouteModelCapabilities,
    routeStatusMessage,
    activeRouteProvider,
    projectInstructionsLoad,
    handleQuit,
    handleClear,
    openResumePicker,
    setModelWithNotice,
    setModeWithNotice,
    setReasoningWithNotice,
    setPlanModeWithNotice,
    setProjectTrustWithNotice,
    setApprovalPolicyWithNotice,
    setSandboxModeWithNotice,
    setNetworkAccessWithNotice,
    addWritableRootWithNotice,
    removeWritableRootWithNotice,
    clearWritableRootsWithNotice,
    setServiceTierWithNotice,
    setPersonalityWithNotice,
    setAuthPreferenceWithNotice,
    providerDiagnosticsRef,
    setWorkspaceDisplayModeWithNotice,
    setTerminalTitleModeWithNotice,
    setShowBusyLoader,
    repaintCommittedTheme,
    refreshAuthStatus,
    openProviderPicker,
    openModelPicker,
    openModePicker,
    openReasoningPicker,
    openSettingsPanel,
    openThemePicker,
    openPermissionsPanel,
    openAuthPanel,
    openUsagePanel,
    setVerboseMode,
    verboseMode,
    handleCopy,
    handlePasteImage,
    handleWorkspaceRelaunch,
    modelCapabilities,
    refreshModelCapabilities,
    updateCheckResult,
    requestUpdateCheck,
    setScreen,
    globalPackageManager,
    pastedContentRegistryRef,
    imageAttachmentRegistryRef,
    fileAttachmentRegistryRef,
    workspaceRoot,
    uiState,
    findUserPromptForTurn,
    startPromptRun,
    promptQueue,
    saveWorkbenchRef,
    bumpWorkbench,
    allowedWritableRoots,
    setPendingImport,
    planMode,
    mode,
    setPlanFlow,
    runPlanGeneration,
    focusManager,
    handlePlanFeedbackSubmit,
    inputValue,
    interruptHint,
    togglePlanModeWithNotice,
    themeSelection,
  } = context;

  const handleSubmit = useCallback(async () => {
    const submitTiming = createPromptRunTiming();
    perf.mark("submit");
    if (submissionRef.current || recoveryRef.current) return;
    const value = sanitizeTerminalInput(getSessionState().inputValue).trim();
    if (!value) return;

    // Special perf debug command (not routed through handleCommand)
    if (value === "/codexa" || value.startsWith("/codexa ")) {
      resetComposer();
      if (activeRouteProvider?.id !== "codexa-native") {
        appendEvent("error", "Codexa", "Select Codexa Native first using /providers and /model.");
        return;
      }
      if (busy) {
        appendEvent("system", "Codexa", "Cancel or finish the current response first.");
        return;
      }
      const action = value.slice(7).trim();
      if (action === "settings") {
        openSettingsPanel();
        return;
      }
      if (action === "unload") {
        await unloadCodexaNative();
        appendEvent(
          "system",
          "Codexa",
          "Model unloaded; the next message reloads the selected checkpoint.",
        );
        return;
      }
      if (action === "replay") {
        const messages = context.activeConversationRef.current?.messages ?? [];
        const index = messages.findLastIndex((message) => message.role === "user");
        if (index < 0) {
          appendEvent("error", "Codexa", "There is no previous user prompt to replay.");
          return;
        }
        const prompt = messages[index]!.submittedContent ?? messages[index]!.content;
        startPromptRun(prompt, prompt, {
          submitTiming,
          commitPrompt: true,
          parseActionRequired: false,
          historyOverride: messages.slice(0, index).map((message) => ({
            ...message,
            content: message.generationMetadata?.rawOutput ?? message.content,
          })),
        });
        return;
      }
      appendEvent(
        "system",
        "Codexa",
        "/codexa settings · /codexa unload · /codexa replay. Experimental native model; no tools. Interactive exploration is not the frozen benchmark.",
      );
      return;
    }
    if (value === "/perf") {
      const session = perf.getSession();
      const summary = session
        ? perf.buildSummary(session)
        : "No perf data recorded yet. Set UBUME_PERF=1 and send a prompt first.";
      appendEvent("system", "Perf report", summary);
      dispatchSession({ type: "PUSH_HISTORY", value });
      resetComposer();
      return;
    }

    if (["/queue", "/transcript", "/diff", "/rewind"].includes(value)) {
      resetComposer();
      openWorkbench(value.slice(1) as WorkbenchView);
      return;
    }
    if (value === "/send-now") {
      resetComposer();
      await handleSendNow();
      return;
    }
    if (value.startsWith("/resume ")) {
      if (!busy) resumeConversation(value.slice(8).trim());
      return;
    }

    // ========== COMMAND ROUTING (before AWAITING_USER_ACTION) ==========
    // Shell execution: ! prefix routes directly to the terminal
    if (value.startsWith("!")) {
      if (busy) return;
      const shellCmd = value.slice(1).trim();
      if (!shellCmd) return;
      submissionRef.current = true;
      const generation = pipelineGenerationRef.current;
      try {
        await stoppingRef.current;
        if (generation !== pipelineGenerationRef.current || activeRunIdRef.current !== null) return;
        dispatchSession({ type: "PUSH_HISTORY", value });
        resetComposer();
        await handleShellExecute(shellCmd);
      } finally {
        submissionRef.current = false;
      }
      return;
    }

    // Parse slash commands (/ prefix) and question-prefix invalid commands (? prefix)
    const commandResult = handleCommand(value, {
      config: layeredRuntimeConfig,
      runtime: runtimeConfig,
      resolvedRuntime: resolvedRuntimeConfig,
      settings: {
        workspaceDisplayMode,
        terminalTitleMode,
        showBusyLoader,
      },
      workspace: workspaceCommandContext,
      tokensUsed: estimateTokens(conversationChars),
      modelCapabilities: activeRouteModelCapabilities,
      routeStatusMessage,
      activeRouteProviderLabel: activeRouteProvider?.displayName ?? "OpenAI",
      projectInstructions: projectInstructionsLoad,
    });
    const isCommand = commandResult !== null;

    if (isCommand) {
      // Internal commands should NOT be added to PUSH_HISTORY or sent to provider
      resetComposer();

      return dispatchCommand({
        commandResult,
        handleQuit,
        handleClear,
        openResumePicker,
        setModelWithNotice,
        setModeWithNotice,
        appendEvent,
        setReasoningWithNotice,
        setPlanModeWithNotice,
        setProjectTrustWithNotice,
        setApprovalPolicyWithNotice,
        setSandboxModeWithNotice,
        setNetworkAccessWithNotice,
        addWritableRootWithNotice,
        removeWritableRootWithNotice,
        clearWritableRootsWithNotice,
        setServiceTierWithNotice,
        setPersonalityWithNotice,
        setAuthPreferenceWithNotice,
        providerDiagnosticsRef,
        setWorkspaceDisplayModeWithNotice,
        setTerminalTitleModeWithNotice,
        setShowBusyLoader,
        repaintCommittedTheme,
        refreshAuthStatus,
        openProviderPicker,
        openModelPicker,
        openModePicker,
        openReasoningPicker,
        openSettingsPanel,
        openThemePicker,
        openPermissionsPanel,
        openAuthPanel,
        openUsagePanel,
        setVerboseMode,
        verboseMode,
        handleCopy,
        handlePasteImage,
        handleWorkspaceRelaunch,
        modelCapabilities,
        refreshModelCapabilities,
        updateCheckResult,
        requestUpdateCheck,
        setScreen,
        globalPackageManager,
      });
    }

    // ========== NORMAL PROMPT SUBMISSION (after command routing) ==========
    submissionRef.current = true;
    const generation = pipelineGenerationRef.current;
    let providerValue: string;
    try {
      assertAttachedContent(
        value,
        pastedContentRegistryRef.current,
        imageAttachmentRegistryRef.current,
        fileAttachmentRegistryRef.current,
      );
      providerValue = await expandFileAttachments(
        expandPastedContent(value, pastedContentRegistryRef.current),
        fileAttachmentRegistryRef.current,
        workspaceRoot,
      );
      for (const attachment of selectImageAttachments(value, imageAttachmentRegistryRef.current)) {
        if (!existsSync(attachment.path))
          throw new Error(`Image attachment is missing: ${attachment.name}`);
      }
      if (generation !== pipelineGenerationRef.current) return;
      await stoppingRef.current;
    } catch (error) {
      appendEvent("error", "Prompt unavailable", (error as Error).message);
      return;
    } finally {
      submissionRef.current = false;
    }
    const imageAttachments = selectImageAttachments(value, imageAttachmentRegistryRef.current);
    // Check for follow-up answer submission
    if (uiState.kind === "AWAITING_USER_ACTION") {
      const originalUserEvent = findUserPromptForTurn(uiState.turnId);
      if (!originalUserEvent) {
        appendEvent(
          "error",
          "Follow-up unavailable",
          "The original turn could not be found, so the answer could not be resumed.",
        );
        dispatchSession({ type: "UI_ACTION", action: { type: "DISMISS_TRANSIENT" } });
        return;
      }

      if (busy) return;
      startPromptRun(
        value,
        buildFollowUpPrompt({
          originalPrompt: originalUserEvent.prompt,
          assistantQuestion: uiState.question,
          userAnswer: providerValue,
        }),
        { submitTiming, commitPrompt: true, imageAttachments },
      );
      return;
    }

    if (generation !== pipelineGenerationRef.current) return;
    // Check if app is busy for normal prompts
    if (!isCommand && activeRunIdRef.current !== null) {
      promptQueue.push(queuedPrompt(value, providerValue, imageAttachments));
      dispatchSession({ type: "PUSH_HISTORY", value });
      resetComposer();
      saveWorkbenchRef.current?.();
      bumpWorkbench((value) => value + 1);
      return;
    }

    if (activeRouteProvider?.id === "codexa-native") {
      startPromptRun(value, providerValue, {
        submitTiming,
        commitPrompt: true,
        parseActionRequired: false,
        imageAttachments,
      });
      return;
    }

    // Validate workspace access for normal prompts
    const { violations: outsideViolations, skippedExternalPaths } = findOutsideWorkspacePaths(
      providerValue,
      workspaceRoot,
      allowedWritableRoots,
    );

    if (skippedExternalPaths.length > 0) {
      for (const skipped of skippedExternalPaths) {
        appendEvent(
          "system",
          "Dependency skipped",
          `Skipped external dependency source: ${formatSkippedDependencyPath(skipped)}`,
        );
      }
    }

    if (outsideViolations.length > 0) {
      if (runtimeConfig.policy.allowExternalFileImport) {
        const attachmentsDir = resolveUbumeAttachmentDir(
          workspaceRoot,
          runtimeConfig.policy.attachmentDir,
        );
        const importFiles: PendingImportFile[] = outsideViolations.map((v) => ({
          srcPath: v.normalizedPath,
          rawPath: v.rawPath,
          destFilename: path.basename(v.normalizedPath),
          isImage: isImageFile(v.normalizedPath),
        }));
        setPendingImport({
          prompt: value,
          providerPrompt: providerValue,
          files: importFiles,
          attachmentsDir,
        });
        setScreen("import-confirmation");
        return;
      }
      const workspaceGuardMessage = getPromptWorkspaceGuardMessage(
        providerValue,
        workspaceRoot,
        allowedWritableRoots,
      );
      if (workspaceGuardMessage) {
        appendEvent("error", "Workspace boundary", workspaceGuardMessage);
        return;
      }
    }

    // Submit to provider or plan mode
    if (planMode) {
      const nextPlanState = startPlanGeneration(providerValue, mode);
      setPlanFlow(nextPlanState);
      runPlanGeneration(nextPlanState, value, submitTiming, true, imageAttachments);
      return;
    }
    startPromptRun(value, providerValue, { submitTiming, commitPrompt: true, imageAttachments });
  }, [
    context.activeConversationRef,
    allowedWritableRoots,
    appendEvent,
    appendEvent,
    busy,
    buildFollowUpPrompt,
    conversationChars,
    dispatchSession,
    findUserPromptForTurn,
    focusManager,
    globalPackageManager,
    handleCopy,
    handlePasteImage,
    handleClear,
    handleQuit,
    handleShellExecute,
    handlePlanFeedbackSubmit,
    handleWorkspaceRelaunch,
    inputValue,
    interruptHint,
    layeredRuntimeConfig,
    modelCapabilities,
    mode,
    openAuthPanel,
    openUsagePanel,
    openProviderPicker,
    openModePicker,
    openModelPicker,
    openPermissionsPanel,
    openResumePicker,
    openReasoningPicker,
    openSettingsPanel,
    planMode,
    refreshAuthStatus,
    repaintCommittedTheme,
    resetComposer,
    getSessionState,
    openWorkbench,
    handleSendNow,
    resumeConversation,
    resolvedRuntimeConfig,
    runPlanGeneration,
    runtimeConfig,
    addWritableRootWithNotice,
    clearWritableRootsWithNotice,
    removeWritableRootWithNotice,
    setApprovalPolicyWithNotice,
    setAuthPreferenceWithNotice,
    setNetworkAccessWithNotice,
    setModeWithNotice,
    setModelWithNotice,
    setPlanModeWithNotice,
    togglePlanModeWithNotice,
    setPersonalityWithNotice,
    setProjectTrustWithNotice,
    setReasoningWithNotice,
    setSandboxModeWithNotice,
    setServiceTierWithNotice,
    showBusyLoader,
    startPromptRun,
    themeSelection.committedTheme,
    uiState,
    workspaceCommandContext,
    workspaceDisplayMode,
    workspaceRoot,
  ]);
  return { handleSubmit };
}
