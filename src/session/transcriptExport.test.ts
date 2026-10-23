import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscriptExport } from "./transcriptExport.js";
import type { TimelineEvent } from "./types.js";

test("copied transcripts drop invisible chip ids and keep every other code point", () => {
  // A composer chip as saved in the transcript: visible label plus its invisible id.
  const chip = "[Pasted Content 22,704 chars]\u2063\ufe01\ufe07\ufe09\ufe00\u2063";
  const reply = "Résumé 👩🏽‍💻\n  e\u0301 and \u{10eeee}\u0305\u0305\n\tdone";
  const events: TimelineEvent[] = [
    { id: 1, type: "user", createdAt: 1, prompt: `Build this ${chip} please`, turnId: 1 },
    { id: 2, type: "assistant", createdAt: 2, content: reply, contentChunks: [], turnId: 1 },
  ];
  const transcript = buildTranscriptExport(events)?.transcript;
  assert.equal(
    transcript,
    `You: Build this [Pasted Content 22,704 chars] please\n\nUbume: ${reply}`,
  );
  assert.equal(/[\u2063\ufe00-\ufe09]/.test(transcript ?? ""), false);
});
