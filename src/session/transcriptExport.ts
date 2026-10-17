/**
 * Copy-the-conversation support: turns the transcript into clipboard text.
 *
 * Pairs each user prompt with its latest assistant reply in submission order
 * and formats them as a readable dialogue. Returns null when there is
 * nothing to copy (a fresh or just-cleared session) so the caller can stay
 * quiet instead of showing an error.
 */

import { useCallback } from "react";
import { copyToClipboard } from "../core/shared/clipboard.js";
import type { TimelineEvent } from "./types.js";

export function buildTranscriptExport(
  staticEvents: readonly TimelineEvent[],
): { transcript: string; turnCount: number } | null {
  const turns = collectTranscriptTurns(staticEvents);

  if (turns.size === 0) {
    // After /clear, the conversation is empty and that's expected.
    // Don't show "Copy unavailable" error - maintain clean post-clear state.
    // Only show this error if the user tries to copy on a fresh session, not post-clear.
    return null;
  }

  // Sort turns by creation time and format as a readable dialogue.
  const lines: string[] = [];
  const sorted = [...turns.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const turn of sorted) {
    lines.push(`You: ${turn.prompt.trim()}`);
    if (turn.response?.trim()) {
      lines.push("");
      lines.push(`Ubume: ${turn.response.trim()}`);
    }
    lines.push("");
  }
  const transcript = lines.join("\n").trimEnd();

  return { transcript, turnCount: turns.size };
}

export function useTranscriptExport(
  staticEvents: TimelineEvent[],
  appendEvent: (type: "system" | "error", title: string, content: string) => void,
) {
  const handleCopy = useCallback(async () => {
    const exported = buildTranscriptExport(staticEvents);
    if (!exported) return;
    const ok = await copyToClipboard(exported.transcript);
    const turnWord = exported.turnCount === 1 ? "1 turn" : `${exported.turnCount} turns`;
    appendEvent(
      "system",
      "Clipboard",
      ok ? `Copied full conversation (${turnWord}) to clipboard.` : "Clipboard unavailable.",
    );
  }, [appendEvent, staticEvents]);
  return { handleCopy };
}

interface TranscriptTurnPair {
  createdAt: number;
  prompt: string;
  response: string | null;
}

/** Pair each first user prompt with its latest following assistant reply. */
function collectTranscriptTurns(
  staticEvents: readonly TimelineEvent[],
): Map<number, TranscriptTurnPair> {
  const turns = new Map<number, TranscriptTurnPair>();

  for (const event of staticEvents) {
    if (event.type === "user") {
      const existing = turns.get(event.turnId);
      if (!existing) {
        turns.set(event.turnId, {
          createdAt: event.createdAt,
          prompt: event.prompt,
          response: null,
        });
      }
    } else if (event.type === "assistant") {
      const existing = turns.get(event.turnId);
      if (existing) {
        existing.response = event.content;
      }
    }
  }

  return turns;
}
