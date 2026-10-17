/**
 * Provides the single controller for terminal writes, mouse, paste, cursor, alternate-screen,
 * and reset sequences.
 */

import { APP_NAME } from "../../config/settings.js";
import * as renderDebug from "../perf/renderDebug.js";
import {
  setTerminalTitleLifecycleState,
  traceTerminalTitleSequences,
  writeGuardedTerminalOutput,
} from "./terminalTitle.js";

export const TERMINAL_SEQUENCES = {
  // \x1b[2J clears the visible viewport; \x1b[3J clears scrollback.
  hardRepaint: "\x1b[2J\x1b[H",
  viewportClear: "\x1b[2J\x1b[H",
  transcriptClear: "\x1b[2J\x1b[3J\x1b[H",
  bracketedPasteEnable: "\x1b[?2004h",
  bracketedPasteDisable: "\x1b[?2004l",
  mouseEnable: "\x1b[?1000h\x1b[?1006h",
  mouseDisable: "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l",
  title: `\x1b]0;${APP_NAME}\x07\x1b]2;${APP_NAME}\x07`,
  alternateScreenEnable: "\x1b[?1049h",
  alternateScreenDisable: "\x1b[?1049l",
} as const;

type TerminalWrite = (chunk: string) => boolean | void;
type TerminalChannel = "stdout" | "stderr";

// Tracks whether the terminal is currently in a live resize debounce.
let terminalResizing = false;

/** Updates the shared resize diagnostic flag; does not trigger a repaint itself. */
export function setTerminalResizing(resizing: boolean): void {
  terminalResizing = resizing;
}

/** Reads the current resize diagnostic flag. */
export function isTerminalResizing(): boolean {
  return terminalResizing;
}

// Tracks current UI state kind for diagnostic assertions.
let currentUIStateKind: string = "IDLE";

/** Updates lifecycle diagnostics used by terminal write guards without writing a frame. */
export function setTerminalControlUIState(kind: string): void {
  if (currentUIStateKind !== kind) {
    renderDebug.traceEvent("terminal", "uiStateTransition", {
      from: currentUIStateKind,
      to: kind,
    });
    currentUIStateKind = kind;
    setTerminalTitleLifecycleState(kind);
  }
}

/**
 * Writes through terminal guards; disallowed post-startup clear/reset sequences are consumed
 * without reaching the terminal.
 */
export function writeTerminalControl(
  write: TerminalWrite,
  channel: TerminalChannel,
  source: string,
  sequence: string,
): boolean {
  traceTerminalTitleSequences(sequence, {
    source,
    stream: channel,
    origin: "ubume",
    action: "allowed",
    lifecycleState: currentUIStateKind,
  });
  renderDebug.traceTerminalWrite(channel, source, sequence);
  const containsClearOrReset =
    sequence.includes("\x1b[2J") ||
    sequence.includes("\x1b[3J") ||
    sequence.includes("\x1bc") ||
    sequence.includes("\x1b[H");
  const isExplicitRedraw = source === "user:redraw";
  const isStartupWrite = source.includes(":startup");
  const isTranscriptClear = source.includes(":transcriptClear");
  const isViewportClear = source.includes(":viewportClear");

  // Aggressively block any clearing or reset sequences after startup,
  // especially during active states, to prevent the UI from disappearing.
  if (
    containsClearOrReset &&
    !isExplicitRedraw &&
    !isStartupWrite &&
    !isTranscriptClear &&
    !isViewportClear
  ) {
    renderDebug.traceEvent("terminal", "blockedPostStartupClearOrReset", {
      source,
      uiStateKind: currentUIStateKind,
      sequenceLength: sequence.length,
      containsViewportClear: sequence.includes("\x1b[2J"),
      containsScrollbackClear: sequence.includes("\x1b[3J"),
      containsCursorHome: sequence.includes("\x1b[H"),
      containsTerminalReset: sequence.includes("\x1bc"),
    });
    return true;
  }

  // Diagnostic: warn if a viewport-clearing sequence fires during streaming
  // even if it claims to be from startup (which shouldn't happen).
  if (
    (currentUIStateKind === "RESPONDING" || currentUIStateKind === "THINKING") &&
    !isExplicitRedraw &&
    (sequence.includes("\x1b[2J") || sequence.includes("\x1b[3J"))
  ) {
    renderDebug.traceEvent("terminal", "unexpectedClearDuringStreaming", {
      source,
      uiStateKind: currentUIStateKind,
      sequenceLength: sequence.length,
      isStartupWrite,
    });

    if (!isExplicitRedraw && !isStartupWrite && !isTranscriptClear) {
      return true;
    }
  }

  return writeGuardedTerminalOutput(write, sequence, {
    source,
    stream: channel,
    origin: "ubume",
    action: "allowed",
    lifecycleState: currentUIStateKind,
  });
}

/** Records an explicit clear through the opt-in render diagnostic channel. */
export function traceTerminalClear(source: string, fields: Record<string, unknown>): void {
  renderDebug.traceTerminalClear(source, fields);
}

interface TerminalModeController {
  write(sequence: string, source: string): boolean;
  clearTranscript(source: string): void;
  clearViewport(source: string): void;
  setMouseReporting(enabled: boolean, source: string): void;
  setBracketedPaste(enabled: boolean, source: string): void;
  setAlternateScreen(enabled: boolean, source: string): void;
  resetModes(): void;
}

/**
 * Creates deduplicated mouse/paste/alternate-screen controls. resetModes forgets cached mode
 * state; callers still own physical terminal restoration.
 */
export function createTerminalModeController(write: TerminalWrite): TerminalModeController {
  let mouseReporting: boolean | null = null;
  let bracketedPaste: boolean | null = null;
  let alternateScreen: boolean | null = null;

  const writeStdout = (sequence: string, source: string) =>
    writeTerminalControl(write, "stdout", source, sequence);

  return {
    write: writeStdout,
    clearTranscript(source) {
      writeStdout(
        TERMINAL_SEQUENCES.transcriptClear,
        source.includes(":transcriptClear") ? source : `${source}:transcriptClear`,
      );
    },
    clearViewport(source) {
      writeStdout(
        TERMINAL_SEQUENCES.viewportClear,
        source.includes(":viewportClear") ? source : `${source}:viewportClear`,
      );
    },
    setMouseReporting(enabled, source) {
      if (mouseReporting === enabled) return;
      mouseReporting = enabled;
      writeStdout(
        enabled ? TERMINAL_SEQUENCES.mouseEnable : TERMINAL_SEQUENCES.mouseDisable,
        source,
      );
    },
    setBracketedPaste(enabled, source) {
      if (bracketedPaste === enabled) return;
      bracketedPaste = enabled;
      writeStdout(
        enabled
          ? TERMINAL_SEQUENCES.bracketedPasteEnable
          : TERMINAL_SEQUENCES.bracketedPasteDisable,
        source,
      );
    },
    setAlternateScreen(enabled, source) {
      if (alternateScreen === enabled) return;
      alternateScreen = enabled;
      writeStdout(
        enabled
          ? TERMINAL_SEQUENCES.alternateScreenEnable
          : TERMINAL_SEQUENCES.alternateScreenDisable,
        source,
      );
    },
    resetModes() {
      renderDebug.traceEvent("terminal", "resetModes", {
        mouseReporting,
        bracketedPaste,
        alternateScreen,
      });
      mouseReporting = null;
      bracketedPaste = null;
      alternateScreen = null;
    },
  };
}
