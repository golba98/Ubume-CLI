import assert from "node:assert/strict";
import test from "node:test";
import { getSlashCommandSuggestions, SLASH_COMMANDS } from "./slashCommands.js";

test("/usage is in the slash-command menu", () => {
  assert.ok(SLASH_COMMANDS.some((command) => command.cmd === "/usage"));
  assert.deepEqual(
    getSlashCommandSuggestions("/us").map((command) => command.cmd),
    ["/usage"],
  );
});

test("/preferences is suggested from the slash-command menu", () => {
  assert.ok(SLASH_COMMANDS.some((command) => command.cmd === "/preferences"));
  assert.deepEqual(
    getSlashCommandSuggestions("/pref").map((command) => command.cmd),
    ["/preferences"],
  );
});
