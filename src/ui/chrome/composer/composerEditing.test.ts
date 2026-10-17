import assert from "node:assert/strict";
import test from "node:test";
import { createAtomicContentToken } from "../../input/pastedContent.js";
import { getSlashCommandSuggestions } from "../../input/slashCommands.js";
import {
  completeSlashCommand,
  deleteDraftBackward,
  deleteDraftForward,
  insertFileToken,
  killDraftText,
  moveDraftLeft,
  moveDraftRight,
  resolveSubmit,
} from "./composerEditing.js";

test("cursor moves and deletes treat a pasted-content token as one unit", () => {
  const token = createAtomicContentToken("[Pasted Content 3,000 chars]");
  const value = `a${token}b`;
  const afterToken = 1 + token.length;

  assert.equal(moveDraftLeft(value, afterToken), 1);
  assert.equal(moveDraftRight(value, 1), afterToken);
  assert.equal(moveDraftLeft(value, 1), 0, "plain characters still move one step");

  assert.deepEqual(deleteDraftBackward({ value, cursor: afterToken }), { value: "ab", cursor: 1 });
  assert.deepEqual(deleteDraftForward({ value, cursor: 1 }, null), { value: "ab", cursor: 1 });
});

test("a raw backspace byte reported as delete removes the previous character", () => {
  assert.deepEqual(deleteDraftForward({ value: "abc", cursor: 2 }, "backspace"), {
    value: "ac",
    cursor: 1,
  });
  assert.deepEqual(deleteDraftForward({ value: "abc", cursor: 2 }, "delete"), {
    value: "ab",
    cursor: 2,
  });
});

test("readline kills return the removed text for yank", () => {
  const draft = { value: "one two three", cursor: 8 };
  assert.deepEqual(killDraftText(draft, "w"), { value: "one three", cursor: 4, killed: "two " });
  assert.deepEqual(killDraftText(draft, "u"), { value: "three", cursor: 0, killed: "one two " });
  assert.deepEqual(killDraftText(draft, "k"), { value: "one two ", cursor: 8, killed: "three" });
});

test("accepting a file replaces the @query with the token and a space", () => {
  const token = createAtomicContentToken("[File: src/a.ts]");
  assert.deepEqual(insertFileToken({ value: "see @sr now", cursor: 7 }, "sr", token), {
    value: `see ${token}  now`,
    cursor: 4 + token.length + 1,
  });
  assert.deepEqual(completeSlashCommand("/model"), { value: "/model ", cursor: 7 });
});

test("Enter continues a line after a trailing backslash", () => {
  assert.deepEqual(
    resolveSubmit({
      draft: { value: "first\\rest", cursor: 6 },
      showSuggestions: false,
      suggestions: [],
      selectedIndex: 0,
    }),
    { kind: "continue-line", draft: { value: "first\nrest", cursor: 6 } },
  );
});

test("Enter completes a partial slash command but submits an exact one", () => {
  const partial = getSlashCommandSuggestions("/mo");
  assert.ok(partial.length > 0);
  const completed = resolveSubmit({
    draft: { value: "/mo", cursor: 3 },
    showSuggestions: true,
    suggestions: partial,
    selectedIndex: 0,
  });
  assert.equal(completed.kind, "complete-command");
  if (completed.kind === "complete-command") {
    assert.equal(completed.draft.value, `${partial[0]!.cmd} `);
  }

  const exact = partial[0]!.cmd;
  assert.deepEqual(
    resolveSubmit({
      draft: { value: exact, cursor: exact.length },
      showSuggestions: true,
      suggestions: getSlashCommandSuggestions(exact),
      selectedIndex: 0,
    }),
    { kind: "submit" },
  );
});

test("an alias counts as an exact command", () => {
  const withAlias = getSlashCommandSuggestions("/").find(
    (command) => "aliases" in command && (command.aliases?.length ?? 0) > 0,
  );
  assert.ok(withAlias && "aliases" in withAlias && withAlias.aliases?.[0]);
  const alias = withAlias.aliases![0]!;
  assert.deepEqual(
    resolveSubmit({
      draft: { value: alias, cursor: alias.length },
      showSuggestions: true,
      suggestions: getSlashCommandSuggestions(alias),
      selectedIndex: 0,
    }),
    { kind: "submit" },
  );
});

test("Enter on a blank draft does nothing", () => {
  assert.deepEqual(
    resolveSubmit({
      draft: { value: "   ", cursor: 3 },
      showSuggestions: false,
      suggestions: [],
      selectedIndex: 0,
    }),
    { kind: "ignore" },
  );
});
