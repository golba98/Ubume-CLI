import assert from "node:assert/strict";
import test from "node:test";
import { externalProviderId, externalTranscriptToConversationMessages } from "./index.js";
import type { ExternalTranscript, ExternalTranscriptEntry } from "./types.js";

let nextId = 0;
const entry = (
  kind: ExternalTranscriptEntry["kind"],
  text: string,
  title: string = kind,
): ExternalTranscriptEntry => ({ id: `e${nextId++}`, kind, title, text });
const transcript = (entries: ExternalTranscriptEntry[]): ExternalTranscript => ({
  summary: {
    source: "claude",
    id: "abc",
    title: "t",
    cwd: "/w",
    updatedAt: "2026-09-30T10:00:00.000Z",
  },
  entries,
});

test("externalProviderId maps each CLI to the Ubume provider that talks to it", () => {
  assert.equal(externalProviderId("claude"), "anthropic");
  assert.equal(externalProviderId("codex"), "openai");
  assert.equal(externalProviderId("vibe"), "mistral");
  assert.equal(externalProviderId("google"), "google");
  assert.equal(externalProviderId("antigravity"), "google");
});

test("externalTranscriptToConversationMessages merges replies and folds tool calls into activity", () => {
  const messages = externalTranscriptToConversationMessages(
    transcript([
      entry("note", "/model", "Command"),
      entry("user", "List files"),
      entry("assistant", "Checking."),
      entry("tool", "ls", "Bash · List files"),
      entry("tool", "ls -a", "Bash · List all"),
      entry("tool", "a.txt", "Read · a.txt"),
      entry("assistant", "Two files."),
      entry("user", "Thanks"),
      entry("user", "Also this"),
      entry("tool", "x", "Edit · x"),
    ]),
  );
  assert.deepEqual(messages, [
    { role: "user", content: "List files" },
    {
      role: "assistant",
      content: "Checking.\n\nTwo files.",
      activitySummary: "Tools used: Bash ×2, Read",
    },
    { role: "user", content: "Thanks\n\nAlso this" },
    {
      role: "assistant",
      content: "[No reply text; tool activity only]",
      activitySummary: "Tools used: Edit",
    },
  ]);
});

test("externalTranscriptToConversationMessages keeps the newest turns within the size limit", () => {
  const messages = externalTranscriptToConversationMessages(
    transcript([
      entry("user", "old prompt"),
      entry("assistant", "old reply ".repeat(10)),
      entry("user", "new prompt"),
      entry("assistant", "new reply"),
    ]),
    { maxChars: 40 },
  );
  assert.deepEqual(messages, [
    {
      role: "user",
      content: "[Imported from Claude Code session abc; 2 earlier messages omitted]\n\nnew prompt",
    },
    { role: "assistant", content: "new reply" },
  ]);
});

test("imported display history retains tool output, failures and chronological response fragments", () => {
  const messages = externalTranscriptToConversationMessages(
    transcript([
      entry("user", "task"),
      entry("assistant", "before tool"),
      {
        ...entry("tool", "exit 7\npermission denied\n```embedded fence```", "Bash"),
        status: "failed",
      },
      entry("assistant", "after tool"),
    ]),
    { includeToolDetails: true },
  );
  const content = messages[1]!.content;
  assert(content.indexOf("before tool") < content.indexOf("permission denied"));
  assert(content.indexOf("permission denied") < content.indexOf("after tool"));
  assert(content.includes("failed"));
  assert(content.includes("````text"));
  assert.match(messages[1]!.activitySummary!, /Bash \(failed\)/);
});
