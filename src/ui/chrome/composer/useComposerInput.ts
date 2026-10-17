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
  deleteInputBackward,
  deleteInputForward,
  getComposerRowLayout,
  InputUndo,
  insertInputText,
  lineBoundary,
  moveCursorLeft,
  moveCursorRight,
  normalizeCursorOffset,
  normalizeInputText,
  searchHistory,
  verticalCursor,
  wordBoundary,
} from "../../input/inputBuffer.js";
import {
  createAtomicContentToken,
  createPastedContentToken,
  deleteAdjacentPastedContent,
  isLargePaste,
  moveAcrossPastedContent,
} from "../../input/pastedContent.js";
import { getSlashCommandSuggestions } from "../../input/slashCommands.js";
import { THEMES, useTheme } from "../../theme.js";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CTRL_ALT_P_ESCAPE_SEQUENCE,
  CTRL_M_ESCAPE_SEQUENCE,
  composerKeymap,
  type DeleteIntent,
  isBacktabSequence,
  PASTE_CHUNK_CANDIDATE_MIN,
  PASTE_CHUNK_SETTLE_MS,
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
  const pasteBufferRef = useRef<string | null>(null);
  const pasteChunkBufferRef = useRef<string | null>(null);
  const pasteChunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteIntentRef = useRef<DeleteIntent | null>(null);
  const backtabEventTickRef = useRef(false);
  const ctrlMEventTickRef = useRef(false);
  const ctrlAltPEventTickRef = useRef(false);
  const mouseEventTickRef = useRef(false);
  const backtabEventTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrlMEventTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrlAltPEventTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseEventTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleRawInput = (chunk: Buffer | string) => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString();
      const intent = resolveDeleteIntentFromRawInput(raw);
      if (intent) {
        deleteIntentRef.current = intent;
      }

      if (isBacktabSequence(raw)) {
        backtabEventTickRef.current = true;
        if (backtabEventTimeoutRef.current) clearTimeout(backtabEventTimeoutRef.current);
        backtabEventTimeoutRef.current = setTimeout(() => {
          backtabEventTickRef.current = false;
        }, 64);
      }

      // Ctrl+M is not consistently surfaced as input="m" with key.ctrl.
      // Terminals using CSI-u style modified key reporting often emit
      // ESC[109;5u or ESC[13;5u instead. We also support Ctrl+O as a
      // reliable cross-terminal alternative for opening the model picker.
      if (CTRL_M_ESCAPE_SEQUENCE.test(raw)) {
        ctrlMEventTickRef.current = true;
        if (ctrlMEventTimeoutRef.current) clearTimeout(ctrlMEventTimeoutRef.current);
        ctrlMEventTimeoutRef.current = setTimeout(() => {
          ctrlMEventTickRef.current = false;
        }, 64);
      }

      // ESC ^P or CSI u style modified key reporting for Ctrl+Alt+P.
      if (CTRL_ALT_P_ESCAPE_SEQUENCE.test(raw)) {
        ctrlAltPEventTickRef.current = true;
        if (ctrlAltPEventTimeoutRef.current) clearTimeout(ctrlAltPEventTimeoutRef.current);
        ctrlAltPEventTimeoutRef.current = setTimeout(() => {
          ctrlAltPEventTickRef.current = false;
        }, 64);
      }

      // Explicitly detect terminal mouse reporting escape sequences to swallow
      // the fragments (e.g. "[<0;26;24M") that Ink's readline parser sequentially
      // emits after stripping the ESC prefix.
      if (/\u001b\[<(\d+);(\d+);(\d+)([Mm])/.test(raw) || /\u001b\[M/.test(raw)) {
        mouseEventTickRef.current = true;
        if (mouseEventTimeoutRef.current) clearTimeout(mouseEventTimeoutRef.current);
        mouseEventTimeoutRef.current = setTimeout(() => {
          mouseEventTickRef.current = false;
        }, 32);
      }
    };

    stdin.on("data", handleRawInput);
    return () => {
      stdin.off("data", handleRawInput);
      if (backtabEventTimeoutRef.current) clearTimeout(backtabEventTimeoutRef.current);
      if (ctrlMEventTimeoutRef.current) clearTimeout(ctrlMEventTimeoutRef.current);
      if (ctrlAltPEventTimeoutRef.current) clearTimeout(ctrlAltPEventTimeoutRef.current);
      if (mouseEventTimeoutRef.current) clearTimeout(mouseEventTimeoutRef.current);
      if (pasteChunkTimerRef.current) clearTimeout(pasteChunkTimerRef.current);
    };
  }, [stdin]);

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

  const flushPasteChunks = () => {
    const buffered = pasteChunkBufferRef.current;
    pasteChunkBufferRef.current = null;
    pasteChunkTimerRef.current = null;
    if (buffered) insertPaste(buffered);
  };

  const bufferPasteChunk = (text: string) => {
    pasteChunkBufferRef.current = `${pasteChunkBufferRef.current ?? ""}${text}`;
    if (pasteChunkTimerRef.current) clearTimeout(pasteChunkTimerRef.current);
    pasteChunkTimerRef.current = setTimeout(flushPasteChunks, PASTE_CHUNK_SETTLE_MS);
  };

  const handlePastedInput = (chunk: string) => {
    let remaining = chunk;

    while (remaining.length > 0) {
      if (pasteBufferRef.current !== null) {
        const endMatch = BRACKETED_PASTE_END.exec(remaining);
        if (!endMatch) {
          pasteBufferRef.current += remaining;
          return;
        }

        pasteBufferRef.current += remaining.slice(0, endMatch.index);
        const pastedText = normalizeInputText(pasteBufferRef.current);
        pasteBufferRef.current = null;
        insertPaste(pastedText);
        remaining = remaining.slice(endMatch.index + endMatch[0].length);
        continue;
      }

      const startMatch = BRACKETED_PASTE_START.exec(remaining);
      if (!startMatch) {
        // Ink/readline may consume bracketed-paste delimiters and deliver the
        // payload as one or more input events. Coalesce burst chunks before
        // applying the large-paste threshold so multi-kilobyte pastes cannot
        // leak into the composer as several smaller raw fragments.
        if (pasteChunkBufferRef.current !== null || remaining.length >= PASTE_CHUNK_CANDIDATE_MIN) {
          bufferPasteChunk(remaining);
        } else {
          insertText(normalizeInputText(remaining));
        }
        return;
      }

      const prefix = remaining.slice(0, startMatch.index);
      if (prefix) {
        insertText(normalizeInputText(prefix));
      }

      pasteBufferRef.current = "";
      remaining = remaining.slice(startMatch.index + startMatch[0].length);
    }
  };

  useInput(
    (input, key) => {
      const action = composerKeymap(input, key, {
        mouseEvent: mouseEventTickRef.current,
        backtabEvent: backtabEventTickRef.current,
        ctrlMEvent: ctrlMEventTickRef.current,
        ctrlAltPEvent: ctrlAltPEventTickRef.current,
        searchQuery,
        fileSuggestionCount: fileSuggestions.length,
        fileQuery,
        showSuggestions,
        suggestionCount: suggestions.length,
        chord: chord.current,
      });

      if (action === "ignore") {
        return;
      }

      if (action === "raw-cycle-mode") {
        backtabEventTickRef.current = false;
        if (backtabEventTimeoutRef.current) {
          clearTimeout(backtabEventTimeoutRef.current);
          backtabEventTimeoutRef.current = null;
        }
        onCycleMode();
        return;
      }

      // Ink exposes Shift+Tab directly on terminals whose parser understands the
      // active keyboard protocol. Keep this path in addition to raw-sequence
      // detection so the shortcut works in VTE, Kitty, and Windows terminals.
      if (action === "cycle-mode") {
        onCycleMode();
        return;
      }

      if (action === "raw-model-picker") {
        ctrlMEventTickRef.current = false;
        if (ctrlMEventTimeoutRef.current) {
          clearTimeout(ctrlMEventTimeoutRef.current);
          ctrlMEventTimeoutRef.current = null;
        }
        traceInputDebug("model_picker_shortcut_received", {
          handler: "BottomComposer.useInput",
          source: "ctrl-m-csi-u",
          allowCommands,
          isFocused,
          stdin: getStdinDebugState(stdin),
        });
        onOpenModelPicker();
        return;
      }

      if (action === "raw-provider-picker") {
        ctrlAltPEventTickRef.current = false;
        if (ctrlAltPEventTimeoutRef.current) {
          clearTimeout(ctrlAltPEventTimeoutRef.current);
          ctrlAltPEventTimeoutRef.current = null;
        }
        if (allowCommands) {
          onOpenProviderPicker();
        }
        return;
      }

      if (action === "quit") {
        onQuit();
        return;
      }
      if (action === "interrupt") {
        onInterrupt?.();
        return;
      }
      if (action === "redraw") {
        onRedraw?.();
        return;
      }
      if (action === "history-search" && searchQuery !== null) {
        if (key.escape) {
          commitInputChange(searchOriginal.current.value, searchOriginal.current.cursor);
          setSearchQuery(null);
          return;
        }
        if (key.return) {
          setSearchQuery(null);
          return;
        }
        let query = searchQuery;
        let offset = 0;
        if (key.ctrl && input === "r") offset = searchOffset + 1;
        else if (key.backspace) query = Array.from(query).slice(0, -1).join("");
        else if (!key.ctrl && !key.meta && input) query += input;
        else return;
        const match = searchHistory(history, query, offset);
        setSearchQuery(query);
        setSearchOffset(offset);
        if (match !== undefined) commitInputChange(match, match.length);
        return;
      }
      if (action === "dismiss-files") {
        setDismissedFile(`${value}:${cursor}`);
        return;
      }
      if (action === "cancel") {
        onCancel();
        return;
      }
      if (chord.current) {
        chord.current = false;
        if (key.ctrl && input === "s") {
          onSendNow?.();
          return;
        }
      }
      if (action === "start-chord") {
        chord.current = true;
        return;
      }
      if (action === "transcript") {
        onTranscript?.();
        return;
      }
      if (action === "external-editor") {
        onExternalEditor?.();
        return;
      }
      if (action === "start-history-search") {
        searchOriginal.current = { value: valueRef.current, cursor: cursorRef.current };
        setSearchQuery("");
        setSearchOffset(0);
        const match = searchHistory(history, "");
        if (match !== undefined) commitInputChange(match, match.length);
        return;
      }
      if (action === "model-picker") {
        onOpenModelPicker();
        return;
      }
      const text = valueRef.current;
      const position = cursorRef.current;
      if (action === "line-boundary") {
        desiredColumn.current = undefined;
        commitInputChange(text, lineBoundary(text, position, key.end));
        return;
      }
      if (action === "line-shortcut") {
        desiredColumn.current = undefined;
        commitInputChange(text, lineBoundary(text, position, input === "e"));
        return;
      }
      if (action === "character-shortcut") {
        desiredColumn.current = undefined;
        commitInputChange(
          text,
          input === "b"
            ? (moveAcrossPastedContent(text, position, "left") ?? moveCursorLeft(text, position))
            : (moveAcrossPastedContent(text, position, "right") ?? moveCursorRight(text, position)),
        );
        return;
      }
      if (action === "word-boundary") {
        desiredColumn.current = undefined;
        commitInputChange(text, wordBoundary(text, position, input === "b" ? -1 : 1));
        return;
      }
      if (action === "kill-text") {
        const edge =
          input === "w"
            ? wordBoundary(text, position, -1, true)
            : lineBoundary(text, position, input === "k");
        const from = Math.min(edge, position),
          to = Math.max(edge, position);
        killText.current = text.slice(from, to);
        commitInputChange(text.slice(0, from) + text.slice(to), from);
        return;
      }
      if (action === "yank") {
        insertText(killText.current);
        return;
      }
      if (action === "undo") {
        const previous = undo.current.undo();
        if (previous) {
          valueRef.current = previous.value;
          cursorRef.current = previous.cursor;
          onChangeInput(previous.value, previous.cursor);
        }
        return;
      }
      if (action === "paste-image") {
        onPasteImage?.();
        return;
      }
      if (action === "send-now") {
        onSendNow?.();
        return;
      }
      if (action === "newline") {
        insertText("\n");
        return;
      }
      if (action === "vertical") {
        const direction = key.upArrow || input === "p" ? -1 : 1;
        const list = fileSuggestions.length ? fileSuggestions : showSuggestions ? suggestions : [];
        if (list.length) {
          setSelectedIndex((index) => Math.max(0, Math.min(list.length - 1, index + direction)));
          return;
        }
        const next = verticalCursor(text, position, promptWidth, direction, desiredColumn.current);
        desiredColumn.current = next.column;
        if (!next.boundary) commitInputChange(text, next.cursor);
        else if (allowHistory) {
          direction < 0 ? onHistoryUp() : onHistoryDown();
          desiredColumn.current = undefined;
        }
        return;
      }
      desiredColumn.current = undefined;
      if (action === "accept-file" && fileQuery !== undefined) {
        const path = fileSuggestions[Math.min(selectedIndex, fileSuggestions.length - 1)]!;
        const token = createAtomicContentToken(`[File: ${path}]`);
        onRegisterFile?.(token, path);
        const start = position - fileQuery.length - 1;
        commitInputChange(
          text.slice(0, start) + token + " " + text.slice(position),
          start + token.length + 1,
        );
        return;
      }
      if (action === "accept-command") {
        const selected = suggestions[selectedIndex]?.cmd;
        if (selected) commitInputChange(`${selected} `, selected.length + 1);
        return;
      }
      if (action === "submit") {
        if (text.slice(0, position).endsWith("\\")) {
          commitInputChange(text.slice(0, position - 1) + "\n" + text.slice(position), position);
          return;
        }
        const exactCommand = getSlashCommandSuggestions(text.trim()).some(
          (command) =>
            command.cmd === text.trim().toLowerCase() ||
            ("aliases" in command &&
              command.aliases?.some((alias) => alias === text.trim().toLowerCase())),
        );
        if (!exactCommand && showSuggestions && suggestions.length > 0) {
          const selected = suggestions[selectedIndex];
          if (
            selected &&
            text.trim().toLowerCase() !== selected.cmd &&
            !(
              "aliases" in selected &&
              selected.aliases?.some((alias) => alias === text.trim().toLowerCase())
            )
          ) {
            commitInputChange(`${selected.cmd} `, selected.cmd.length + 1);
            return;
          }
        }
        if (text.trim()) onSubmit();
        return;
      }

      if (action === "left") {
        const nextCursor =
          moveAcrossPastedContent(valueRef.current, cursorRef.current, "left") ??
          moveCursorLeft(valueRef.current, cursorRef.current);
        commitInputChange(valueRef.current, nextCursor);
        return;
      }

      if (action === "right") {
        const nextCursor =
          moveAcrossPastedContent(valueRef.current, cursorRef.current, "right") ??
          moveCursorRight(valueRef.current, cursorRef.current);
        commitInputChange(valueRef.current, nextCursor);
        return;
      }

      if (action === "backspace") {
        deleteIntentRef.current = null;
        const next =
          deleteAdjacentPastedContent(valueRef.current, cursorRef.current, "backward") ??
          deleteInputBackward({
            value: valueRef.current,
            cursorOffset: cursorRef.current,
          });
        commitInputChange(next.value, next.cursorOffset);
        return;
      }

      if (action === "delete") {
        const deleteIntent = deleteIntentRef.current;
        deleteIntentRef.current = null;

        if (deleteIntent === "backspace") {
          const next = deleteInputBackward({
            value: valueRef.current,
            cursorOffset: cursorRef.current,
          });
          commitInputChange(next.value, next.cursorOffset);
          return;
        }

        const next =
          deleteAdjacentPastedContent(valueRef.current, cursorRef.current, "forward") ??
          deleteInputForward({
            value: valueRef.current,
            cursorOffset: cursorRef.current,
          });
        commitInputChange(next.value, next.cursorOffset);
        return;
      }

      if (action === "text") {
        handlePastedInput(input);
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
