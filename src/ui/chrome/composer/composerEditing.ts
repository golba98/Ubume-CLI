/**
 * Pure text-editing transitions for the bottom composer.
 *
 * Each function maps a composer action (see `composerKeymap.ts`) and the current
 * `{ value, cursor }` to the next draft, with no React state, refs or callbacks.
 * `useComposerInput` decides *which* action runs, then calls these functions and
 * commits the result. That keeps the editing rules (pasted-content tokens moving
 * as one unit, readline kill/yank, `\`+Enter line continuation, slash-command
 * completion on Enter) testable without rendering the composer.
 *
 * Cursor offsets are UTF-16 offsets into `value`, normalised by the
 * `inputBuffer.ts` helpers. Pasted and attached content is an atomic token (see
 * `pastedContent.ts`), so left/right/backspace/delete step over a whole token
 * before falling back to per-character movement.
 */

import {
  deleteInputBackward,
  deleteInputForward,
  lineBoundary,
  moveCursorLeft,
  moveCursorRight,
  wordBoundary,
} from "../../input/inputBuffer.js";
import { deleteAdjacentPastedContent, moveAcrossPastedContent } from "../../input/pastedContent.js";
import type { CommandSuggestion } from "../../input/slashCommands.js";
import { getSlashCommandSuggestions } from "../../input/slashCommands.js";

/** The editable draft: text plus a cursor offset into it. */
export interface DraftState {
  value: string;
  cursor: number;
}

/** One character left, or across a whole pasted-content token if one is adjacent. */
export function moveDraftLeft(value: string, cursor: number): number {
  return moveAcrossPastedContent(value, cursor, "left") ?? moveCursorLeft(value, cursor);
}

/** One character right, or across a whole pasted-content token if one is adjacent. */
export function moveDraftRight(value: string, cursor: number): number {
  return moveAcrossPastedContent(value, cursor, "right") ?? moveCursorRight(value, cursor);
}

/** Backspace: removes an adjacent pasted-content token whole, else one character. */
export function deleteDraftBackward({ value, cursor }: DraftState): DraftState {
  const next =
    deleteAdjacentPastedContent(value, cursor, "backward") ??
    deleteInputBackward({ value, cursorOffset: cursor });
  return { value: next.value, cursor: next.cursorOffset };
}

/**
 * Forward delete: removes an adjacent pasted-content token whole, else one character.
 *
 * `rawIntent === "backspace"` covers terminals that send the Backspace byte (`DEL`,
 * 0x7f) where Ink reports it as `key.delete`. The raw listener saw the real byte, so
 * the edit is a plain backward delete. Unlike `deleteDraftBackward`, that path is not
 * token-aware; this matches the composer's established behaviour.
 */
export function deleteDraftForward(
  { value, cursor }: DraftState,
  rawIntent: "backspace" | "delete" | null,
): DraftState {
  if (rawIntent === "backspace") {
    const next = deleteInputBackward({ value, cursorOffset: cursor });
    return { value: next.value, cursor: next.cursorOffset };
  }
  const next =
    deleteAdjacentPastedContent(value, cursor, "forward") ??
    deleteInputForward({ value, cursorOffset: cursor });
  return { value: next.value, cursor: next.cursorOffset };
}

/**
 * Readline kill. Ctrl+W removes the previous word, Ctrl+U removes to the start of the
 * line, and Ctrl+K removes to the end of the line.
 *
 * @returns The next draft and the removed text (for Ctrl+Y yank).
 */
export function killDraftText(
  { value, cursor }: DraftState,
  shortcut: string,
): DraftState & { killed: string } {
  const edge =
    shortcut === "w"
      ? wordBoundary(value, cursor, -1, true)
      : lineBoundary(value, cursor, shortcut === "k");
  const from = Math.min(edge, cursor);
  const to = Math.max(edge, cursor);
  return {
    value: value.slice(0, from) + value.slice(to),
    cursor: from,
    killed: value.slice(from, to),
  };
}

/**
 * Replaces the `@query` being typed before the cursor with an attachment token plus
 * a trailing space.
 *
 * @param fileQuery - The text after `@` (it may be empty).
 * @param token - The atomic `[File: …]` token. The caller creates it, because
 *   token ids are not deterministic.
 */
export function insertFileToken(
  { value, cursor }: DraftState,
  fileQuery: string,
  token: string,
): DraftState {
  const start = cursor - fileQuery.length - 1;
  return {
    value: `${value.slice(0, start)}${token} ${value.slice(cursor)}`,
    cursor: start + token.length + 1,
  };
}

/** Replaces the draft with a completed slash command plus a trailing space. */
export function completeSlashCommand(command: string): DraftState {
  return { value: `${command} `, cursor: command.length + 1 };
}

function matchesCommandOrAlias(command: CommandSuggestion, typed: string): boolean {
  return (
    command.cmd === typed ||
    ("aliases" in command && (command.aliases?.some((alias) => alias === typed) ?? false))
  );
}

/** What pressing Enter should do with the current draft. */
export type SubmitResolution =
  | { kind: "continue-line"; draft: DraftState }
  | { kind: "complete-command"; draft: DraftState }
  | { kind: "submit" }
  | { kind: "ignore" };

/**
 * Decides the outcome of Enter, in this order:
 * 1. A `\` just before the cursor becomes a newline (line continuation).
 * 2. A partial slash command with a highlighted suggestion is completed rather than
 *    submitted, unless the draft already names a command or one of its aliases.
 * 3. A non-blank draft is submitted.
 * 4. A blank draft is ignored.
 */
export function resolveSubmit(params: {
  draft: DraftState;
  showSuggestions: boolean;
  suggestions: readonly CommandSuggestion[];
  selectedIndex: number;
}): SubmitResolution {
  const { draft, showSuggestions, suggestions, selectedIndex } = params;
  const { value, cursor } = draft;

  if (value.slice(0, cursor).endsWith("\\")) {
    return {
      kind: "continue-line",
      draft: { value: `${value.slice(0, cursor - 1)}\n${value.slice(cursor)}`, cursor },
    };
  }

  const typed = value.trim().toLowerCase();
  const namesExactCommand = getSlashCommandSuggestions(value.trim()).some((command) =>
    matchesCommandOrAlias(command, typed),
  );
  if (!namesExactCommand && showSuggestions && suggestions.length > 0) {
    const selected = suggestions[selectedIndex];
    if (selected && !matchesCommandOrAlias(selected, typed)) {
      return { kind: "complete-command", draft: completeSlashCommand(selected.cmd) };
    }
  }

  return value.trim() ? { kind: "submit" } : { kind: "ignore" };
}
