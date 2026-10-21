/**
 * Converts a native transcript into Ubume conversation messages for "continue in Ubume". Routes
 * listing and transcript reads to the store for each source. Builds the `claude --resume` /
 * `codex resume` / `agy --conversation` / `vibe --resume` launch in the session's folder.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { verifyAgyExecutable } from "../executables/antigravityExecutable.js";
import { resolveCodexExecutable } from "../executables/codexExecutable.js";
import {
  resolveAgyExecutable,
  resolveClaudeExecutable,
  resolveVibeExecutable,
} from "../executables/executableResolver.js";
import type { ProviderId } from "../providerLauncher/types.js";
import type { ConversationMessage } from "../workspace/conversationStore.js";
import { listAntigravitySessions, readAntigravityTranscript } from "./antigravitySessions.js";
import { listClaudeSessions, readClaudeTranscript } from "./claudeSessions.js";
import { listCodexSessions, readCodexTranscript } from "./codexSessions.js";
import type {
  ExternalSessionOptions,
  ExternalSessionScope,
  ExternalSessionSource,
  ExternalSessionSummary,
  ExternalTranscript,
} from "./types.js";
import { externalSourceLabel, isSafeNativeSessionId } from "./types.js";
import { listVibeSessions, readVibeTranscript } from "./vibeSessions.js";

export * from "./types.js";

/** Native sessions for one CLI, newest first. Stores are read-only inputs; missing stores yield []. */
export function listExternalSessions(
  source: ExternalSessionSource,
  scope: ExternalSessionScope,
  options: ExternalSessionOptions = {},
): Promise<ExternalSessionSummary[]> {
  switch (source) {
    case "claude":
      return listClaudeSessions(scope, options);
    case "codex":
      return listCodexSessions(scope, options);
    case "google":
    case "antigravity":
      return listAntigravitySessions(scope, options);
    case "vibe":
      return listVibeSessions(scope, options);
  }
}

/**
 * Dispatches transcript reads by source; returned entries are display data rather than live tool
 * state.
 */
export function readExternalTranscript(
  summary: ExternalSessionSummary,
  options: ExternalSessionOptions = {},
): Promise<ExternalTranscript> {
  switch (summary.source) {
    case "claude":
      return readClaudeTranscript(summary);
    case "codex":
      return readCodexTranscript(summary);
    case "google":
    case "antigravity":
      return readAntigravityTranscript(summary, options);
    case "vibe":
      return readVibeTranscript(summary);
  }
}

interface ExternalResumeLaunch {
  displayName: string;
  executable: string;
  args: string[];
  cwd: string;
}

type ExternalResumeLaunchResult =
  | { ok: true; launch: ExternalResumeLaunch }
  | { ok: false; message: string };

/** Configured provider executables (from providers.json), honored before env/PATH lookup. */
export interface ExternalSessionExecutablePaths {
  claude?: string;
  codex?: string;
  antigravity?: string;
}

interface ResumeLaunchOptions {
  /** Current folder retained for API compatibility; unknown original workspaces are never guessed. */
  fallbackCwd: string;
  configuredPaths?: ExternalSessionExecutablePaths;
  resolveExecutable?: (source: ExternalSessionSource) => Promise<string>;
  folderExists?: (path: string) => boolean;
}

function resumeArgs(summary: ExternalSessionSummary): string[] {
  switch (summary.source) {
    case "claude":
      return ["--resume", summary.id];
    case "codex":
      return ["resume", summary.id];
    case "google":
    case "antigravity":
      return ["--conversation", summary.id];
    case "vibe":
      return ["--resume", summary.id];
  }
}

/**
 * Resolves the native CLI like the provider runtimes do: a configured path first, then
 * CLAUDE_EXECUTABLE / CODEX_EXECUTABLE / AGY_EXECUTABLE / VIBE_EXECUTABLE, then PATH.
 */
function resolveSourceExecutable(
  source: ExternalSessionSource,
  cwd: string,
  configured: ExternalSessionExecutablePaths = {},
): Promise<string> {
  switch (source) {
    case "claude":
      return resolveClaudeExecutable({ configuredPath: configured.claude });
    case "codex":
      return resolveCodexExecutable({ configuredPath: configured.codex });
    case "google":
    case "antigravity":
      return resolveAgyExecutable({ cwd, configuredPath: configured.antigravity }).then(
        async (executable) => {
          await verifyAgyExecutable(executable, { cwd });
          return executable;
        },
      );
    case "vibe":
      return resolveVibeExecutable().then((path) => {
        if (!path) throw new Error("Mistral Vibe executable is unavailable.");
        return path;
      });
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Builds a native resume launch in the recorded original directory. Missing/removed directories
 * return a refusal; executable resolution failures reject.
 */
export async function buildExternalResumeLaunch(
  summary: ExternalSessionSummary,
  options: ResumeLaunchOptions,
): Promise<ExternalResumeLaunchResult> {
  const displayName = externalSourceLabel(summary.source);
  if (!isSafeNativeSessionId(summary.id))
    return {
      ok: false,
      message: "The native session identifier is invalid. Open its transcript for viewing.",
    };
  // Claude Code looks sessions up by the project folder they were started in.
  if (!summary.cwd || !isAbsolute(summary.cwd)) {
    return {
      ok: false,
      message: `${displayName} resumes a session from its original folder, which this session does not record.`,
    };
  }
  const cwd = summary.cwd ?? options.fallbackCwd;
  if (!(options.folderExists ?? isDirectory)(cwd)) {
    return { ok: false, message: `The session's folder no longer exists: ${cwd}` };
  }
  const executable = await (
    options.resolveExecutable ??
    ((source) => resolveSourceExecutable(source, cwd, options.configuredPaths))
  )(summary.source);
  return { ok: true, launch: { displayName, executable, args: resumeArgs(summary), cwd } };
}

/** Imported history is replayed to the provider on every turn, so keep it bounded. */
const DEFAULT_MAX_CHARS = 200_000;

/**
 * Maps a native transcript source, including the historical Antigravity alias, to Ubume's
 * provider identity.
 */
export function externalProviderId(source: ExternalSessionSource): ProviderId {
  switch (source) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "google":
    case "antigravity":
      return "google";
    case "vibe":
      return "mistral";
  }
}

function toolName(title: string): string {
  return title.split(" · ")[0]?.trim() || "Tool";
}

function formatToolCounts(counts: Map<string, number>): string {
  return `Tools used: ${[...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ")}`;
}

/**
 * Converts a native transcript into Ubume conversation messages: prompts and
 * replies become alternating user/assistant messages, tool calls are folded
 * into the reply's activity summary, and command notes are dropped.
 */
export function externalTranscriptToConversationMessages(
  transcript: ExternalTranscript,
  options: { maxChars?: number; includeToolDetails?: boolean } = {},
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let tools = new Map<string, number>();
  const flushTools = () => {
    if (tools.size === 0) return;
    const last = messages.at(-1);
    if (last?.role === "assistant") last.activitySummary = formatToolCounts(tools);
    else
      messages.push({
        role: "assistant",
        content: "[No reply text; tool activity only]",
        activitySummary: formatToolCounts(tools),
      });
    tools = new Map();
  };

  for (const entry of transcript.entries) {
    if (entry.kind === "user") {
      flushTools();
      const last = messages.at(-1);
      if (last?.role === "user") last.content = `${last.content}\n\n${entry.text}`;
      else messages.push({ role: "user", content: entry.text });
    } else if (entry.kind === "assistant") {
      const last = messages.at(-1);
      if (last?.role === "assistant") last.content = `${last.content}\n\n${entry.text}`;
      else messages.push({ role: "assistant", content: entry.text });
    } else if (entry.kind === "tool") {
      const name =
        toolName(entry.title) +
        (entry.status === "failed" || entry.status === "interrupted" ? ` (${entry.status})` : "");
      tools.set(name, (tools.get(name) ?? 0) + 1);
      if (options.includeToolDetails) {
        const fence = "`".repeat(
          Math.max(3, ...[...entry.text.matchAll(/`+/g)].map((match) => match[0].length + 1)),
        );
        const detail = `Historical tool · ${entry.title} · ${entry.status ?? "outcome unknown"}\n\n${fence}text\n${entry.text}\n${fence}`;
        const last = messages.at(-1);
        if (last?.role === "assistant") last.content += `\n\n${detail}`;
        else messages.push({ role: "assistant", content: detail });
      }
    }
  }
  flushTools();

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  let total = messages.reduce((sum, message) => sum + message.content.length, 0);
  let omitted = 0;
  // Drop whole turns from the front so the kept history still starts with a prompt.
  while (total > maxChars && messages.length > 2) {
    const dropped = messages.shift()!;
    total -= dropped.content.length;
    omitted += 1;
    while (messages.length > 1 && messages[0]?.role !== "user") {
      total -= messages.shift()!.content.length;
      omitted += 1;
    }
  }
  if (omitted > 0 && messages[0]) {
    messages[0] = {
      ...messages[0],
      content: `[Imported from ${externalSourceLabel(transcript.summary.source)} session ${transcript.summary.id}; ${omitted} earlier messages omitted]\n\n${messages[0].content}`,
    };
  }
  return messages;
}
