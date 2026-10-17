/**
 * Input controller for the bottom composer. Returns everything `BottomComposer.tsx`
 * needs to render (viewport, suggestions, status line, footer) and handles keys
 * while the composer has focus.
 *
 * Responsibilities, in order of a key press:
 * 1. Raw stdin signals (`rawStdinSignals.ts`) recover shortcuts and mouse reports
 *    Ink mis-parses, and the raw delete byte (Backspace vs Delete).
 * 2. `composerKeymap` turns the key into one action.
 * 3. The handler performs it: global shortcuts and modal states first, then a
 *    pending Ctrl+X chord, then commands and edits. Text edits are pure functions
 *    in `composerEditing.ts`, Ctrl+R in `historySearch.ts`, and typed or pasted
 *    text goes through `PasteAssembler`.
 *
 * State ownership: the draft (`value`/`cursor`) belongs to `src/app`. The hook keeps
 * `valueRef`/`cursorRef` in sync so that several key events arriving in one stdin
 * chunk build on each other before React re-renders, plus local view state (undo
 * stack, kill ring, suggestion index, history search, chord, desired column).
 *
 * Cleanup: stdin listeners, raw-signal timers, the file-list debounce, the elapsed
 * timer and any pending paste burst are released on unmount.
 */
import { useFocus, useInput, useStdin } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { getStdinDebugState, traceInputDebug } from "../../../core/perf/debugLog.js";
import * as renderDebug from "../../../core/perf/renderDebug.js";
import { clampVisualText } from "../../../core/shared/text.js";
import { fuzzyFiles, listWorkspaceFiles } from "../../../core/workspace/workspaceFiles.js";
import { FOCUS_IDS } from "../../input/focus.js";
import {
  COMPOSER_ROW_CHROME,
  createInputViewport,
  getComposerRowLayout,
  InputUndo,
  insertInputText,
  lineBoundary,
  normalizeCursorOffset,
  normalizeInputText,
  searchHistory,
  verticalCursor,
  wordBoundary,
} from "../../input/inputBuffer.js";
import {
  createAtomicContentToken,
  createPastedContentToken,
  isLargePaste,
} from "../../input/pastedContent.js";
import { isMouseReportSequence, useRawStdinSignals } from "../../input/rawStdinSignals.js";
import { THEMES, useTheme } from "../../theme.js";
import {
  completeSlashCommand,
  type DraftState,
  deleteDraftBackward,
  deleteDraftForward,
  insertFileToken,
  killDraftText,
  moveDraftLeft,
  moveDraftRight,
  resolveSubmit,
} from "./composerEditing.js";
import {
  CTRL_ALT_P_ESCAPE_SEQUENCE,
  CTRL_M_ESCAPE_SEQUENCE,
  composerKeymap,
  type DeleteIntent,
  isBacktabSequence,
  resolveDeleteIntentFromRawInput,
} from "./composerKeymap.js";
import {
  type BottomComposerProps,
  FALLBACK_MODEL_SPEC,
  getCommandSuggestionState,
  getComposerPersona,
  getPlaceholder,
  getTokenBarDisplay,
  getVisibleComposerStatusLine,
  MAX_VISIBLE_INPUT_ROWS,
} from "./composerModel.js";
import { stepHistorySearch } from "./historySearch.js";
import { PasteAssembler, type PasteAssemblerSink } from "./pasteAssembler.js";

/**
 * Raw stdin sequences the composer watches, because Ink does not report them reliably
 * on every terminal (see `rawStdinSignals.ts`):
 * - `mouse`: swallow the printable fragments of a mouse report.
 * - `backtab`: Shift+Tab variants → cycle mode.
 * - `ctrlM`: Ctrl+M sent as CSI-u (`ESC[109;5u`) → model picker. Ctrl+O is the
 *   portable alternative.
 * - `ctrlAltP`: Ctrl+Alt+P (`ESC ^P` or CSI-u) → provider picker.
 */
const COMPOSER_RAW_SIGNALS = {
  mouse: { matches: isMouseReportSequence, holdMs: 32 },
  backtab: { matches: isBacktabSequence, holdMs: 64 },
  ctrlM: { matches: (raw: string) => CTRL_M_ESCAPE_SEQUENCE.test(raw), holdMs: 64 },
  ctrlAltP: { matches: (raw: string) => CTRL_ALT_P_ESCAPE_SEQUENCE.test(raw), holdMs: 64 },
} as const;

export function useComposerInput({
  layout,
  width = layout.cols,
  uiState,
  themeName = "purple",
  mode = "",
  model = "",
  footerModelDisplay,
  reasoningLevel = "",
  planMode = false,
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
  renderDebug.useRenderDebug("Composer", {
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
    uiStateKind: uiState.kind,
    themeName,
    runtimeMode: mode,
    model,
    reasoningLevel,
    planMode,
    tokensUsed,
    modelSpecStatus: modelSpec.status,
    value,
    cursor,
  });
  renderDebug.useLifecycleDebug("Composer", {
    uiStateKind: uiState.kind,
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
  });
  renderDebug.traceLayoutValidity("Composer", {
    cols: layout.cols,
    rows: layout.rows,
  });

  const { stdin } = useStdin();
  const inheritedTheme = useTheme();
  // The composer is memoized and also rendered across the main/overlay shell
  // boundary. Resolve the explicit active theme name here so the runtime row
  // (provider, model, reasoning and context) cannot retain a stale inherited
  // token set during a theme transition. Custom themes remain sourced from the
  // provider because their merged tokens are supplied there.
  const theme = themeName === "custom" ? inheritedTheme : (THEMES[themeName] ?? inheritedTheme);
  const { mode: layoutMode } = layout;
  const { isFocused } = useFocus({ id: FOCUS_IDS.composer, autoFocus: true });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollRow, setScrollRow] = useState(0);
  const persona = getComposerPersona(uiState);
  const undo = useRef(new InputUndo());
  const killText = useRef("");
  const desiredColumn = useRef<number | undefined>(undefined);
  const chord = useRef(false);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const searchOriginal = useRef({ value: "", cursor: 0 });
  const [searchOffset, setSearchOffset] = useState(0);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const fileMatch = value.slice(0, cursor).match(/(?:^|\s)@([^\s]*)$/);
  const fileQuery = fileMatch?.[1];
  const [dismissedFile, setDismissedFile] = useState<string | null>(null);
  const fileSuggestions =
    fileQuery !== undefined && dismissedFile !== `${value}:${cursor}`
      ? fuzzyFiles(filePaths, fileQuery)
      : [];
  useEffect(() => {
    if (fileQuery === undefined || !workspaceRoot) return;
    let stale = false;
    const timer = setTimeout(() => {
      void listWorkspaceFiles(workspaceRoot)
        .then((paths) => {
          if (!stale) setFilePaths(paths);
        })
        .catch(() => {
          if (!stale) setFilePaths([]);
        });
    }, 100);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [fileQuery, workspaceRoot]);
  const [runElapsedSeconds, setRunElapsedSeconds] = useState(0);

  useEffect(() => {
    if (uiState.kind !== "THINKING") {
      setRunElapsedSeconds(0);
      return;
    }
    setRunElapsedSeconds(0);
    const interval = setInterval(() => {
      setRunElapsedSeconds((s) => s + 1);
    }, 1_000);
    return () => clearInterval(interval);
  }, [uiState.kind]);

  const allowCommands = persona !== "answer";
  const allowHistory = persona !== "answer";
  const promptPrefix = COMPOSER_ROW_CHROME.prompt;
  const rowLayout = getComposerRowLayout(width);
  const promptWidth = rowLayout.editorWidth;
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  const lastPropsValueRef = useRef(value);
  const lastPropsCursorRef = useRef(cursor);
  // Last raw delete byte seen on stdin, consumed by the next delete/backspace action.
  const deleteIntentRef = useRef<DeleteIntent | null>(null);
  const rawSignals = useRawStdinSignals(stdin, COMPOSER_RAW_SIGNALS, (raw) => {
    const intent = resolveDeleteIntentFromRawInput(raw);
    if (intent) deleteIntentRef.current = intent;
  });

  // Sync from props only when props actually change from an external source
  // or after a render cycle has confirmed our local change.
  useEffect(() => {
    if (value !== lastPropsValueRef.current || cursor !== lastPropsCursorRef.current) {
      valueRef.current = value;
      cursorRef.current = cursor;
      lastPropsValueRef.current = value;
      lastPropsCursorRef.current = cursor;
    }
  }, [cursor, value]);

  const commandSuggestionState = getCommandSuggestionState({
    value,
    allowCommands,
  });
  const { showSuggestions, suggestions } = commandSuggestionState;
  const suggestionText = suggestions
    .map((suggestion, index) => `${index === selectedIndex ? "›" : "·"} ${suggestion.cmd}`)
    .join("   ");

  const rawStatusLine = getVisibleComposerStatusLine({
    uiState,
    value,
    allowCommands,
    activeProviderId,
    runElapsedSeconds,
    externalCliStatus,
    interruptHint,
  });
  const showStatusLine = rawStatusLine.length > 0;
  const showTransientStatusRow = showStatusLine;

  const promptViewport = useMemo(
    () =>
      createInputViewport({
        text: value,
        cursorOffset: normalizeCursorOffset(value, cursor),
        width: promptWidth,
        maxVisibleRows: MAX_VISIBLE_INPUT_ROWS,
        scrollRow,
      }),
    [cursor, promptWidth, scrollRow, value],
  );
  const placeholderText = clampVisualText(getPlaceholder(persona), Math.max(1, promptWidth - 1));

  useEffect(() => {
    setSelectedIndex(0);
  }, [value]);

  useEffect(() => {
    if (promptViewport.scrollRow !== scrollRow) {
      setScrollRow(promptViewport.scrollRow);
    }
  }, [promptViewport.scrollRow, scrollRow]);

  const commitInputChange = (nextValue: string, nextCursor: number) => {
    const normalizedValue = normalizeInputText(nextValue);
    const normalizedCursor = normalizeCursorOffset(normalizedValue, nextCursor);

    undo.current.record(
      { value: valueRef.current, cursor: cursorRef.current },
      { value: normalizedValue, cursor: normalizedCursor },
    );
    // Update refs immediately to avoid race conditions with fast input events
    valueRef.current = normalizedValue;
    cursorRef.current = normalizedCursor;
    lastPropsValueRef.current = normalizedValue;
    lastPropsCursorRef.current = normalizedCursor;

    onChangeInput(normalizedValue, normalizedCursor);
  };

  const insertText = (text: string) => {
    if (!text) return;
    const next = insertInputText({
      value: valueRef.current,
      cursorOffset: cursorRef.current,
      text,
    });
    commitInputChange(next.value, next.cursorOffset);
  };

  const insertPaste = (text: string) => {
    const pastedText = normalizeInputText(text);
    if (isLargePaste(pastedText)) {
      const label = createPastedContentToken(pastedText);
      onRegisterPaste?.(label, pastedText);
      insertText(label);
      return;
    }
    insertText(pastedText);
  };

  // The assembler outlives renders, so it reaches the current insert functions
  // through a ref. A burst flushed by its settle timer therefore uses the latest
  // props, not the ones from the render that buffered the first chunk.
  const pasteSinkRef = useRef<PasteAssemblerSink>({ text: insertText, paste: insertPaste });
  pasteSinkRef.current = { text: insertText, paste: insertPaste };
  const pasteAssemblerRef = useRef<PasteAssembler | null>(null);
  pasteAssemblerRef.current ??= new PasteAssembler({
    text: (text) => pasteSinkRef.current.text(text),
    paste: (text) => pasteSinkRef.current.paste(text),
  });
  useEffect(() => () => pasteAssemblerRef.current?.dispose(), []);

  const commitDraft = (draft: DraftState) => commitInputChange(draft.value, draft.cursor);

  useInput(
    (input, key) => {
      const action = composerKeymap(input, key, {
        mouseEvent: rawSignals.isActive("mouse"),
        backtabEvent: rawSignals.isActive("backtab"),
        ctrlMEvent: rawSignals.isActive("ctrlM"),
        ctrlAltPEvent: rawSignals.isActive("ctrlAltP"),
        searchQuery,
        fileSuggestionCount: fileSuggestions.length,
        fileQuery,
        showSuggestions,
        suggestionCount: suggestions.length,
        chord: chord.current,
      });

      // ── Phase 1: global shortcuts and modal states. These never consume a pending
      // Ctrl+X chord.
      switch (action) {
        case "ignore":
          return;
        case "raw-cycle-mode":
          rawSignals.consume("backtab");
          onCycleMode();
          return;
        // Ink exposes Shift+Tab directly on terminals whose parser understands the
        // active keyboard protocol. Keep this path in addition to raw-sequence
        // detection so the shortcut works in VTE, Kitty, and Windows terminals.
        case "cycle-mode":
          onCycleMode();
          return;
        case "raw-model-picker":
          rawSignals.consume("ctrlM");
          traceInputDebug("model_picker_shortcut_received", {
            handler: "BottomComposer.useInput",
            source: "ctrl-m-csi-u",
            allowCommands,
            isFocused,
            stdin: getStdinDebugState(stdin),
          });
          onOpenModelPicker();
          return;
        case "raw-provider-picker":
          rawSignals.consume("ctrlAltP");
          if (allowCommands) onOpenProviderPicker();
          return;
        case "quit":
          onQuit();
          return;
        case "interrupt":
          onInterrupt?.();
          return;
        case "redraw":
          onRedraw?.();
          return;
        case "history-search": {
          if (searchQuery === null) break;
          const step = stepHistorySearch(
            { query: searchQuery, offset: searchOffset },
            input,
            key,
            history,
          );
          if (step.kind === "cancel") {
            commitInputChange(searchOriginal.current.value, searchOriginal.current.cursor);
            setSearchQuery(null);
          } else if (step.kind === "accept") {
            setSearchQuery(null);
          } else if (step.kind === "update") {
            setSearchQuery(step.state.query);
            setSearchOffset(step.state.offset);
            if (step.match !== undefined) commitInputChange(step.match, step.match.length);
          }
          return;
        }
        case "dismiss-files":
          setDismissedFile(`${value}:${cursor}`);
          return;
        case "cancel":
          onCancel();
          return;
      }

      // ── Phase 2: Ctrl+X arms a chord that the very next key consumes. Ctrl+X Ctrl+S
      // sends now; any other key disarms the chord and is then handled normally.
      if (chord.current) {
        chord.current = false;
        if (key.ctrl && input === "s") {
          onSendNow?.();
          return;
        }
      }

      const draft: DraftState = { value: valueRef.current, cursor: cursorRef.current };
      // Vertical movement remembers the column it started from. Explicit
      // horizontal moves and the edits below forget it, so the next Up/Down
      // starts from the new cursor column.
      const forgetColumn = () => {
        desiredColumn.current = undefined;
      };

      // ── Phase 3: commands and edits.
      switch (action) {
        case "start-chord":
          chord.current = true;
          return;
        case "transcript":
          onTranscript?.();
          return;
        case "external-editor":
          onExternalEditor?.();
          return;
        case "start-history-search": {
          searchOriginal.current = { ...draft };
          setSearchQuery("");
          setSearchOffset(0);
          const match = searchHistory(history, "");
          if (match !== undefined) commitInputChange(match, match.length);
          return;
        }
        case "model-picker":
          onOpenModelPicker();
          return;
        case "line-boundary":
          forgetColumn();
          commitInputChange(draft.value, lineBoundary(draft.value, draft.cursor, key.end));
          return;
        case "line-shortcut":
          forgetColumn();
          commitInputChange(draft.value, lineBoundary(draft.value, draft.cursor, input === "e"));
          return;
        case "character-shortcut":
          forgetColumn();
          commitInputChange(
            draft.value,
            input === "b"
              ? moveDraftLeft(draft.value, draft.cursor)
              : moveDraftRight(draft.value, draft.cursor),
          );
          return;
        case "word-boundary":
          forgetColumn();
          commitInputChange(
            draft.value,
            wordBoundary(draft.value, draft.cursor, input === "b" ? -1 : 1),
          );
          return;
        case "kill-text": {
          const next = killDraftText(draft, input);
          killText.current = next.killed;
          commitDraft(next);
          return;
        }
        case "yank":
          insertText(killText.current);
          return;
        case "undo": {
          // Undo bypasses commitInputChange so that it is not itself recorded as an edit.
          const previous = undo.current.undo();
          if (previous) {
            valueRef.current = previous.value;
            cursorRef.current = previous.cursor;
            onChangeInput(previous.value, previous.cursor);
          }
          return;
        }
        case "paste-image":
          onPasteImage?.();
          return;
        case "send-now":
          onSendNow?.();
          return;
        case "newline":
          insertText("\n");
          return;
        case "vertical": {
          const direction = key.upArrow || input === "p" ? -1 : 1;
          // An open suggestion list takes Up/Down; otherwise move between lines,
          // then fall through to history at the first or last line.
          const list = fileSuggestions.length
            ? fileSuggestions
            : showSuggestions
              ? suggestions
              : [];
          if (list.length) {
            setSelectedIndex((index) => Math.max(0, Math.min(list.length - 1, index + direction)));
            return;
          }
          const next = verticalCursor(
            draft.value,
            draft.cursor,
            promptWidth,
            direction,
            desiredColumn.current,
          );
          desiredColumn.current = next.column;
          if (!next.boundary) {
            commitInputChange(draft.value, next.cursor);
          } else if (allowHistory) {
            if (direction < 0) onHistoryUp();
            else onHistoryDown();
            forgetColumn();
          }
          return;
        }
      }

      forgetColumn();
      switch (action) {
        case "accept-file": {
          if (fileQuery === undefined) return;
          const path = fileSuggestions[Math.min(selectedIndex, fileSuggestions.length - 1)];
          if (path === undefined) return;
          const token = createAtomicContentToken(`[File: ${path}]`);
          onRegisterFile?.(token, path);
          commitDraft(insertFileToken(draft, fileQuery, token));
          return;
        }
        case "accept-command": {
          const selected = suggestions[selectedIndex]?.cmd;
          if (selected) commitDraft(completeSlashCommand(selected));
          return;
        }
        case "submit": {
          const resolution = resolveSubmit({ draft, showSuggestions, suggestions, selectedIndex });
          if (resolution.kind === "continue-line" || resolution.kind === "complete-command") {
            commitDraft(resolution.draft);
          } else if (resolution.kind === "submit") {
            onSubmit();
          }
          return;
        }
        case "left":
          commitInputChange(draft.value, moveDraftLeft(draft.value, draft.cursor));
          return;
        case "right":
          commitInputChange(draft.value, moveDraftRight(draft.value, draft.cursor));
          return;
        case "backspace":
          deleteIntentRef.current = null;
          commitDraft(deleteDraftBackward(draft));
          return;
        case "delete": {
          const rawIntent = deleteIntentRef.current;
          deleteIntentRef.current = null;
          commitDraft(deleteDraftForward(draft, rawIntent));
          return;
        }
        case "text":
          pasteAssemblerRef.current?.feed(input);
          return;
      }
    },
    { isActive: isFocused },
  );

  const tokenDisplay = getTokenBarDisplay(tokensUsed, modelSpec);
  const reasoningSuffix = reasoningLevel ? ` (${reasoningLevel})` : "";
  const footerRuntimeDisplay = footerModelDisplay ?? `${model}${reasoningSuffix}`;
  const isAnswerMode = persona === "answer";

  return {
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
    showStatusLine,
    showTransientStatusRow,
    promptViewport,
    placeholderText,
    showSuggestions,
    suggestionText,
    tokenDisplay,
    footerRuntimeDisplay,
    isAnswerMode,
  };
}
