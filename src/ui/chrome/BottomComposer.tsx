/**
 * The bottom composer: prompt box, command/file suggestion row, transient status
 * row (thinking timer, interrupt hints) and the runtime footer (mode, provider,
 * model, reasoning, context meter).
 *
 * Rendering only. Input handling, editing and paste assembly live in
 * `composer/useComposerInput.ts`; row measurement and status text in
 * `composer/composerModel.ts`. The draft text and cursor are owned by `src/app`
 * and passed in as `value`/`cursor`; edits are reported through `onChangeInput`.
 *
 * `MemoizedBottomComposer` skips re-renders during streaming with a hand-written
 * comparator (`areBottomComposerPropsEqual`). A new prop that changes what the
 * composer shows must be added to that comparator, or the composer will keep
 * showing the old value until something else re-renders it.
 */
import { Box, Text } from "ink";
import { memo } from "react";
import type { Theme } from "../../config/settings.js";
import type { UIState } from "../../session/types.js";
import { COMPOSER_ROW_CHROME, createInputRowWindow } from "../input/inputBuffer.js";
import { getModeDisplaySpec } from "../render/runtimeDisplay.js";
import {
  type BottomComposerProps,
  FALLBACK_MODEL_SPEC,
  getExternalCliLabel,
} from "./composer/composerModel.js";
import { useComposerInput } from "./composer/useComposerInput.js";
import { AnimatedStatusText, isAnimatedBusyState, Spinner } from "./statusIndicators.js";

// ─── Component ────────────────────────────────────────────────────────────────

function renderFooterRuntime(displayStr: string, theme: Theme) {
  // e.g. "Claude Code CLI / Sonnet 4.6 (Low)"
  const slashIndex = displayStr.indexOf("/");
  if (slashIndex === -1) {
    return (
      <Text color={theme.model} wrap="truncate">
        {displayStr}
      </Text>
    );
  }
  const providerPart = displayStr.substring(0, slashIndex).trim();
  let remaining = displayStr.substring(slashIndex + 1).trim();

  const parenIndex = remaining.indexOf("(");
  if (parenIndex === -1) {
    return (
      <Box flexDirection="row" overflow="hidden">
        <Text color={theme.provider}>{providerPart}</Text>
        <Text color={theme.textMuted}>{" / "}</Text>
        <Text color={theme.model}>{remaining}</Text>
      </Box>
    );
  }

  const modelPart = remaining.substring(0, parenIndex).trim();
  let reasoningPart = remaining.substring(parenIndex + 1).trim();
  if (reasoningPart.endsWith(")")) {
    reasoningPart = reasoningPart.substring(0, reasoningPart.length - 1).trim();
  }

  return (
    <Box flexDirection="row" overflow="hidden">
      <Text color={theme.provider}>{providerPart}</Text>
      <Text color={theme.textMuted}>{" / "}</Text>
      <Text color={theme.model}>{modelPart}</Text>
      <Text color={theme.textMuted}>{" ("}</Text>
      <Text color={theme.accentMuted}>{reasoningPart}</Text>
      <Text color={theme.textMuted}>{")"}</Text>
    </Box>
  );
}

export function BottomComposer({
  layout,
  width = layout.cols,
  uiState,
  themeName = "purple",
  mode = "",
  model = "",
  footerModelDisplay,
  reasoningLevel = "",
  contextDisplay,
  showContext = false,
  planMode = false,
  showBusyLoader = true,
  interruptHint = null,
  tokensUsed = 0,
  modelSpec = FALLBACK_MODEL_SPEC,
  value,
  cursor,
  onChangeInput,
  onRegisterPaste,
  onPasteImage,
  onSubmit,
  onInterrupt,
  onRedraw,
  onTranscript,
  onExternalEditor,
  onSendNow,
  onRegisterFile,
  workspaceRoot,
  history = [],
  queueCount = 0,
  queuePaused = false,
  onCancel,
  onHistoryUp,
  onHistoryDown,
  onOpenProviderPicker = () => undefined,
  onOpenModelPicker,
  onCycleMode,
  onQuit,
  activeProviderId = "",
  externalCliStatus,
}: BottomComposerProps) {
  const {
    theme,
    persona,
    fileQuery,
    commandSuggestionState,
    layoutMode,
    isFocused,
    searchQuery,
    fileSuggestions,
    selectedIndex,
    promptPrefix,
    promptWidth,
    rowLayout,
    rawStatusLine,
    showTransientStatusRow,
    promptViewport,
    placeholderText,
    suggestionText,
    tokenDisplay,
    footerRuntimeDisplay,
    isAnswerMode,
  } = useComposerInput({
    layout,
    width,
    uiState,
    themeName,
    mode,
    model,
    footerModelDisplay,
    reasoningLevel,
    contextDisplay,
    planMode,
    showBusyLoader,
    interruptHint,
    tokensUsed,
    modelSpec,
    value,
    cursor,
    onChangeInput,
    onRegisterPaste,
    onPasteImage,
    onSubmit,
    onInterrupt,
    onRedraw,
    onTranscript,
    onExternalEditor,
    onSendNow,
    onRegisterFile,
    workspaceRoot,
    history,
    queueCount,
    queuePaused,
    onCancel,
    onHistoryUp,
    onHistoryDown,
    onOpenProviderPicker,
    onOpenModelPicker,
    onCycleMode,
    onQuit,
    activeProviderId,
    externalCliStatus,
  });

  // The prompt line is shared between bordered and non-bordered layouts.
  const promptLine = (
    <Box flexDirection="row" width={rowLayout.bodyWidth}>
      <Box width={rowLayout.promptWidth} flexShrink={0}>
        <Text color={theme.text} bold>
          {promptPrefix}
        </Text>
      </Box>
      <Box flexDirection="column" width={promptWidth} flexShrink={0} overflow="hidden">
        {value.length === 0 ? (
          <Box width="100%" overflow="hidden">
            <Text
              backgroundColor={isFocused ? theme.text : undefined}
              color={isFocused ? theme.surface : undefined}
            >
              {" "}
            </Text>
            <Text color={theme.textDim}>{placeholderText}</Text>
          </Box>
        ) : (
          promptViewport.visibleRows.map((row, index) => {
            const visibleCursorRow = promptViewport.cursorRow - promptViewport.scrollRow;
            const isCursorRow = index === visibleCursorRow;
            const segments = createInputRowWindow(
              row.text,
              promptWidth,
              isCursorRow ? promptViewport.cursorColumn : undefined,
            );

            return (
              <Box key={`${row.start}-${row.end}-${index}`} width="100%" overflow="hidden">
                {isCursorRow ? (
                  <>
                    <Text color={theme.text}>{segments.before}</Text>
                    <Text
                      backgroundColor={isFocused ? theme.text : undefined}
                      color={isFocused ? theme.surface : undefined}
                    >
                      {segments.current}
                    </Text>
                    <Text color={theme.text}>{segments.after}</Text>
                  </>
                ) : (
                  <Text color={theme.text}>{segments.before || " "}</Text>
                )}
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column" paddingBottom={layoutMode === "compact" ? 0 : 1} width={width}>
      {isAnswerMode ? (
        // Answer mode: Highlighted prompt
        <Box
          flexDirection="column"
          width="100%"
          paddingLeft={COMPOSER_ROW_CHROME.paddingLeft}
          paddingRight={COMPOSER_ROW_CHROME.paddingRight}
          paddingY={0}
          borderStyle="round"
          borderColor={theme.warning}
        >
          {promptLine}
        </Box>
      ) : (
        // Normal mode: clean prompt in rounded border
        <Box
          flexDirection="column"
          width="100%"
          paddingLeft={COMPOSER_ROW_CHROME.paddingLeft}
          paddingRight={COMPOSER_ROW_CHROME.paddingRight}
          paddingY={0}
          borderStyle="round"
          borderColor={theme.border}
        >
          {promptLine}
        </Box>
      )}

      {(fileQuery !== undefined || queueCount > 0) && (
        <Box paddingX={1} height={1} overflow="hidden">
          <Text color={theme.textDim} wrap="truncate">
            {searchQuery !== null
              ? `History search: ${searchQuery} · Ctrl+R next · Enter accept · Esc cancel`
              : fileQuery !== undefined
                ? fileSuggestions[selectedIndex]
                  ? `@ ${fileSuggestions[selectedIndex]} · ↑↓ choose · Tab attach`
                  : "No matching files"
                : `${queueCount} queued${queuePaused ? " (paused)" : ""} · /queue · Ctrl+X Ctrl+S send now`}
          </Text>
        </Box>
      )}
      {commandSuggestionState.reserveSuggestionRow && (
        <Box paddingLeft={1} marginTop={0} width="100%" overflow="hidden">
          <Text color={theme.textDim} wrap="truncate">
            {suggestionText || " "}
          </Text>
        </Box>
      )}

      {showTransientStatusRow && (
        <Box
          paddingX={1}
          marginTop={0}
          height={1}
          width="100%"
          justifyContent="space-between"
          overflow="hidden"
        >
          <>
            <Box flexShrink={1} flexGrow={1} overflow="hidden" flexDirection="row">
              {!!getExternalCliLabel(activeProviderId ?? "") && uiState.kind === "THINKING" && (
                <>
                  <Spinner color={theme.accent} />
                  <Text> </Text>
                </>
              )}
              <AnimatedStatusText
                baseText={rawStatusLine}
                isActive={!interruptHint && persona === "busy" && showBusyLoader}
                animationStyle="flow"
                isError={persona === "error"}
              />
            </Box>
            {persona === "busy" && (
              <Box flexShrink={0}>
                <Text color={theme.textDim}>Enter queue · Ctrl+C stop</Text>
              </Box>
            )}
          </>
        </Box>
      )}

      <Box
        paddingLeft={1}
        paddingRight={1}
        marginTop={0}
        width="100%"
        justifyContent="space-between"
      >
        <Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="row">
          {searchQuery !== null && fileQuery === undefined && queueCount === 0 ? (
            <Text
              color={theme.textDim}
              wrap="truncate"
            >{`History search: ${searchQuery} · Ctrl+R next · Enter accept · Esc cancel`}</Text>
          ) : (
            renderFooterRuntime(footerRuntimeDisplay, theme)
          )}
          {searchQuery !== null ? null : planMode ? (
            <Text color={theme.accent}>{"  · PLAN"}</Text>
          ) : mode ? (
            <Text color={getModeDisplaySpec(mode, theme).ringColor}>
              {`  · ${getModeDisplaySpec(mode, theme).label}`}
            </Text>
          ) : null}
        </Box>
        {showContext && (
          <Box flexShrink={0}>
            {contextDisplay ? (
              <Box flexDirection="row">
                <Text color={theme.textMuted}>Context: </Text>
                <Text color={theme.context}>{contextDisplay}</Text>
              </Box>
            ) : tokenDisplay.hasKnownLimit ? (
              <Box flexDirection="row">
                <Text color={theme.textMuted}>Context: </Text>
                <Text color={theme.context}>{tokenDisplay.usedText}</Text>
                <Text color={theme.textDim}>
                  {" / "}
                  {tokenDisplay.limitText}
                  {tokenDisplay.percentage !== null
                    ? ` · ${tokenDisplay.isEstimatedLimit ? "~" : ""}${tokenDisplay.percentage}%`
                    : ""}
                </Text>
              </Box>
            ) : (
              <Box flexDirection="row">
                <Text color={theme.textMuted}>Context: </Text>
                <Text color={theme.textDim}>Unknown</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

// Helper to extract the relevant uiState kind for comparison
function getUiStateKey(uiState: UIState): string {
  // Only re-render when the kind changes to a different persona-relevant state
  // THINKING/RESPONDING/AWAITING_USER_ACTION are all "busy" states
  // We don't need to re-render for every streaming update within RESPONDING
  if (isAnimatedBusyState(uiState.kind)) {
    return "busy";
  }
  if (uiState.kind === "AWAITING_USER_ACTION") {
    return "answer";
  }
  if (uiState.kind === "ERROR") {
    return "error";
  }
  return "idle";
}

// ─── Memoized export ─────────────────────────────────────────────────────────

// Skips re-renders during streaming when props haven't meaningfully changed.
export function areBottomComposerPropsEqual(
  prev: BottomComposerProps,
  next: BottomComposerProps,
): boolean {
  // Always re-render if the uiState kind changes to a different persona
  const prevKey = getUiStateKey(prev.uiState);
  const nextKey = getUiStateKey(next.uiState);
  if (prevKey !== nextKey) return false;

  // Busy kinds share a persona but drive different status lines
  // (e.g. THINKING "Still waiting…" vs RESPONDING "ready"). Kind changes
  // happen a few times per run, not per delta, so this stays cheap.
  if (prev.uiState.kind !== next.uiState.kind) return false;
  if (prev.externalCliStatus !== next.externalCliStatus) return false;

  // Re-render if input-related props change
  if (
    prev.queueCount !== next.queueCount ||
    prev.queuePaused !== next.queuePaused ||
    prev.history !== next.history
  )
    return false;
  if (
    prev.onSubmit !== next.onSubmit ||
    prev.onCancel !== next.onCancel ||
    prev.onSendNow !== next.onSendNow ||
    prev.onInterrupt !== next.onInterrupt
  )
    return false;
  if (prev.value !== next.value) return false;
  if (prev.cursor !== next.cursor) return false;

  // Re-render if display props change
  if (prev.mode !== next.mode) return false;
  if (prev.model !== next.model) return false;
  if (prev.footerModelDisplay !== next.footerModelDisplay) return false;
  if (prev.reasoningLevel !== next.reasoningLevel) return false;
  if (prev.showContext !== next.showContext) return false;
  if (prev.contextDisplay !== next.contextDisplay) return false;
  if (prev.planMode !== next.planMode) return false;
  if (prev.showBusyLoader !== next.showBusyLoader || prev.interruptHint !== next.interruptHint)
    return false;
  if (prev.tokensUsed !== next.tokensUsed) return false;

  // Re-render if layout changes
  if (prev.width !== next.width) return false;
  if (prev.layout.cols !== next.layout.cols) return false;
  if (prev.layout.rows !== next.layout.rows) return false;
  if (prev.layout.mode !== next.layout.mode) return false;
  if (prev.themeName !== next.themeName) return false;

  if (prev.modelSpec?.status !== next.modelSpec?.status) return false;
  if (prev.modelSpec?.contextWindow !== next.modelSpec?.contextWindow) return false;

  // Re-render if active provider changes (affects status line text)
  if (prev.activeProviderId !== next.activeProviderId) return false;

  // Skip re-render - streaming updates within the same uiState kind don't affect composer
  return true;
}

export const MemoizedBottomComposer = memo(BottomComposer, areBottomComposerPropsEqual);
