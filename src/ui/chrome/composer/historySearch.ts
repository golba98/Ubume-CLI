/**
 * Reverse incremental history search (Ctrl+R) for the composer, as a pure transition.
 *
 * While a search is open, every key goes to this transition instead of normal
 * editing. The composer stores `{ query, offset }`, previews the matching history
 * entry in the draft, and restores the original draft if the search is cancelled.
 */
import type { Key } from "ink";
import { searchHistory } from "../../input/inputBuffer.js";

/** Open search state: the query typed so far and how many older matches to skip. */
export interface HistorySearchState {
  query: string;
  offset: number;
}

export type HistorySearchStep =
  /** Esc: close the search and put back the draft from before it opened. */
  | { kind: "cancel" }
  /** Enter: close the search and keep the previewed entry as the draft. */
  | { kind: "accept" }
  /** The query or offset changed; `match` is the entry to preview, if any. */
  | { kind: "update"; state: HistorySearchState; match: string | undefined }
  /** A key with no meaning inside the search (e.g. another Ctrl chord). */
  | { kind: "ignore" };

/**
 * Applies one key to an open history search.
 *
 * Ctrl+R steps to the next older match for the same query. Backspace removes one code
 * point (so an emoji is not split) and restarts from the newest match. Any other plain
 * input extends the query and also restarts from the newest match.
 */
export function stepHistorySearch(
  state: HistorySearchState,
  input: string,
  key: Pick<Key, "escape" | "return" | "ctrl" | "meta" | "backspace">,
  history: readonly string[],
): HistorySearchStep {
  if (key.escape) return { kind: "cancel" };
  if (key.return) return { kind: "accept" };

  let query = state.query;
  let offset = 0;
  if (key.ctrl && input === "r") offset = state.offset + 1;
  else if (key.backspace) query = Array.from(query).slice(0, -1).join("");
  else if (!key.ctrl && !key.meta && input) query += input;
  else return { kind: "ignore" };

  return { kind: "update", state: { query, offset }, match: searchHistory(history, query, offset) };
}
