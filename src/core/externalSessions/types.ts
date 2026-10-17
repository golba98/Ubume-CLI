/** Native CLI whose saved sessions /resume can browse. */
export type ExternalSessionSource = "claude" | "codex" | "google" | "vibe" | "antigravity";

export const EXTERNAL_SESSION_SOURCES: readonly ExternalSessionSource[] = [
  "claude",
  "codex",
  "google",
  "vibe",
];

export type ExternalSessionScope = { kind: "workspace"; root: string } | { kind: "all" };

export interface ExternalSessionSummary {
  source: ExternalSessionSource;
  id: string;
  title: string;
  /** Folder the session ran in; null when the store does not record one. */
  cwd: string | null;
  /** ISO timestamp of the last activity. */
  updatedAt: string;
  model?: string;
  messageCount?: number;
  /** Session file the transcript is read from, when the store has one. */
  filePath?: string;
}

export type ExternalTranscriptEntryKind = "user" | "assistant" | "tool" | "note";

export interface ExternalTranscriptEntry {
  id: string;
  kind: ExternalTranscriptEntryKind;
  title: string;
  text: string;
  timestamp?: string;
}

export interface ExternalTranscript {
  summary: ExternalSessionSummary;
  entries: ExternalTranscriptEntry[];
  /** Shown above the transcript when the content is incomplete or approximate. */
  notice?: string;
}

/** Overrides for locating native stores; tests point these at fixture folders. */
export interface ExternalSessionOptions {
  home?: string;
  env?: Record<string, string | undefined>;
}

/** Returns the display name for a native session source, including compatibility aliases. */
export function externalSourceLabel(source: ExternalSessionSource): string {
  switch (source) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "google":
    case "antigravity":
      return "Google";
    case "vibe":
      return "Mistral Vibe";
  }
}
