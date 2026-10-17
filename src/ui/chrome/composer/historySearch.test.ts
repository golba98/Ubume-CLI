import assert from "node:assert/strict";
import test from "node:test";
import { stepHistorySearch } from "./historySearch.js";

const history = ["git status", "npm test", "git log --oneline", "ship it 🚀"];
const none = { escape: false, return: false, ctrl: false, meta: false, backspace: false };

test("typing extends the query and previews the first match", () => {
  assert.deepEqual(stepHistorySearch({ query: "gi", offset: 3 }, "t", none, history), {
    kind: "update",
    state: { query: "git", offset: 0 },
    match: "git status",
  });
});

test("Ctrl+R steps to the next match for the same query", () => {
  assert.deepEqual(
    stepHistorySearch({ query: "git", offset: 0 }, "r", { ...none, ctrl: true }, history),
    { kind: "update", state: { query: "git", offset: 1 }, match: "git log --oneline" },
  );
  const exhausted = stepHistorySearch(
    { query: "git", offset: 1 },
    "r",
    { ...none, ctrl: true },
    history,
  );
  assert.deepEqual(exhausted, {
    kind: "update",
    state: { query: "git", offset: 2 },
    match: undefined,
  });
});

test("Backspace removes a whole code point", () => {
  assert.deepEqual(
    stepHistorySearch({ query: "🚀🚀", offset: 0 }, "", { ...none, backspace: true }, history),
    { kind: "update", state: { query: "🚀", offset: 0 }, match: "ship it 🚀" },
  );
});

test("Esc cancels, Enter accepts, other chords are ignored", () => {
  const state = { query: "npm", offset: 0 };
  assert.deepEqual(stepHistorySearch(state, "", { ...none, escape: true }, history), {
    kind: "cancel",
  });
  assert.deepEqual(stepHistorySearch(state, "", { ...none, return: true }, history), {
    kind: "accept",
  });
  assert.deepEqual(stepHistorySearch(state, "x", { ...none, ctrl: true }, history), {
    kind: "ignore",
  });
  assert.deepEqual(stepHistorySearch(state, "x", { ...none, meta: true }, history), {
    kind: "ignore",
  });
});
