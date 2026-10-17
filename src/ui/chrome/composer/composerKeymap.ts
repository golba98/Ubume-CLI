/**
 * Key → action mapping for the composer, plus the raw escape sequences the composer
 * watches on stdin.
 *
 * `composerKeymap` is the single source of truth for composer key bindings. It is
 * pure: Ink's `(input, key)` plus a snapshot of composer state (open search, file
 * or command suggestions, pending Ctrl+X chord, raw-stdin signals) map to one
 * `ComposerAction`. The order of the checks is the precedence: global shortcuts
 * first, then modal states (history search, suggestion lists), then editing.
 * `useComposerInput` performs the action.
 */

/** Which delete the terminal actually sent, from the raw byte (see `resolveDeleteIntentFromRawInput`). */
export type DeleteIntent = "backspace" | "delete";

export const BRACKETED_PASTE_START = /(?:\u001B)?\[200~/;

export const BRACKETED_PASTE_END = /(?:\u001B)?\[201~/;

export const DELETE_ESCAPE_SEQUENCE = /^\u001b\[3(?:;\d+)?~$/;

export const BACKTAB_ESCAPE_SEQUENCE = /(?:\u001b\[Z|\u001b\[1;2Z|\u001b\[9;2u|\u001b\[27;2;9~)/;

export const CTRL_M_ESCAPE_SEQUENCE = /^\u001b\[109;5u$/;

export const CTRL_ALT_P_ESCAPE_SEQUENCE = /(?:\x1b\x10|\x1b\[112;[78]u)/;

export const PASTE_CHUNK_CANDIDATE_MIN = 64;

export const PASTE_CHUNK_SETTLE_MS = 12;

export function resolveDeleteIntentFromRawInput(raw: string): DeleteIntent | null {
  if (raw === "\b" || raw === "\x08" || raw === "\u007f" || raw === "\u001b\u007f") {
    return "backspace";
  }

  if (DELETE_ESCAPE_SEQUENCE.test(raw)) {
    return "delete";
  }

  return null;
}

export function isBacktabSequence(raw: string): boolean {
  return BACKTAB_ESCAPE_SEQUENCE.test(raw);
}

import type { Key } from "ink";

interface ComposerKeyContext {
  mouseEvent: boolean;
  backtabEvent: boolean;
  ctrlMEvent: boolean;
  ctrlAltPEvent: boolean;
  searchQuery: string | null;
  fileSuggestionCount: number;
  fileQuery: string | undefined;
  showSuggestions: boolean;
  suggestionCount: number;
  chord: boolean;
}

export type ComposerAction =
  | "ignore"
  | "raw-cycle-mode"
  | "cycle-mode"
  | "raw-model-picker"
  | "raw-provider-picker"
  | "quit"
  | "interrupt"
  | "redraw"
  | "history-search"
  | "dismiss-files"
  | "cancel"
  | "start-chord"
  | "transcript"
  | "external-editor"
  | "start-history-search"
  | "model-picker"
  | "line-boundary"
  | "line-shortcut"
  | "character-shortcut"
  | "word-boundary"
  | "kill-text"
  | "yank"
  | "undo"
  | "paste-image"
  | "send-now"
  | "newline"
  | "vertical"
  | "accept-file"
  | "accept-command"
  | "submit"
  | "left"
  | "right"
  | "backspace"
  | "delete"
  | "text"
  | "send-now-chord";

export function composerKeymap(input: string, key: Key, ctx: ComposerKeyContext): ComposerAction {
  if (ctx.mouseEvent) return "ignore";
  if (ctx.backtabEvent) return "raw-cycle-mode";
  if (key.tab && key.shift) return "cycle-mode";
  if (ctx.ctrlMEvent) return "raw-model-picker";
  if (ctx.ctrlAltPEvent) return "raw-provider-picker";
  if (key.ctrl && input === "q") return "quit";
  if (key.ctrl && input === "c") return "interrupt";
  if (key.ctrl && input === "l") return "redraw";
  if (ctx.searchQuery !== null) return "history-search";
  if (key.escape && ctx.fileSuggestionCount) return "dismiss-files";
  if (key.escape) return "cancel";
  if (ctx.chord && key.ctrl && input === "s") return "send-now-chord";
  if (key.ctrl && input === "x") return "start-chord";
  if (key.ctrl && input === "t") return "transcript";
  if (key.ctrl && input === "g") return "external-editor";
  if (key.ctrl && input === "r") return "start-history-search";
  if ((key.ctrl && input === "o") || (key.meta && input === "p")) return "model-picker";
  if (key.home || key.end) return "line-boundary";
  if (key.ctrl && (input === "a" || input === "e")) return "line-shortcut";
  if (key.ctrl && (input === "b" || input === "f")) return "character-shortcut";
  if (key.meta && (input === "b" || input === "f")) return "word-boundary";
  if (key.ctrl && ["w", "u", "k"].includes(input)) return "kill-text";
  if (key.ctrl && input === "y") return "yank";
  if (key.ctrl && (input === "_" || input === "\x1f")) return "undo";
  if (key.ctrl && input === "v") return "paste-image";
  if (key.ctrl && key.return) return "send-now";
  if ((key.return && (key.shift || key.meta)) || (key.ctrl && (input === "j" || input === "\n")))
    return "newline";
  if (key.upArrow || key.downArrow || (key.ctrl && (input === "p" || input === "n")))
    return "vertical";
  if ((key.tab || key.return) && ctx.fileSuggestionCount && ctx.fileQuery !== undefined)
    return "accept-file";
  if ((key.tab || key.rightArrow) && ctx.showSuggestions && ctx.suggestionCount > 0)
    return "accept-command";
  if (key.return) return "submit";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.backspace || input === "\b" || (input === "\u007f" && !key.delete)) return "backspace";
  if (key.delete || (input === "\u007f" && key.delete)) return "delete";
  if (
    !key.ctrl &&
    !key.meta &&
    !key.escape &&
    input &&
    input.length > 0 &&
    input !== "\u007f" &&
    input !== "\b"
  )
    return "text";
  return "ignore";
}
