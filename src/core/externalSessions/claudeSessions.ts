/**
 * Lists Claude Code sessions from `~/.claude/projects` (head/tail reads) and streams a session
 * JSONL into transcript entries.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { clampText, titleFromText } from "../shared/text.js";
import { isRecord } from "../shared/values.js";
import { sameFolder } from "../workspace/workspaceRoot.js";
import {
  envValue,
  forEachJsonLine,
  type JsonRecord,
  mapWithConcurrency,
  readHeadJsonLines,
  readTailJsonLines,
  resolveHome,
  stringField,
} from "./storeIo.js";
import type {
  ExternalSessionOptions,
  ExternalSessionScope,
  ExternalSessionSummary,
  ExternalTranscript,
  ExternalTranscriptEntry,
} from "./types.js";

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const TOOL_TEXT_LIMIT = 16 * 1024;

function claudeProjectsDir(options: ExternalSessionOptions = {}): string {
  return join(
    envValue(options, "CLAUDE_CONFIG_DIR") ?? join(resolveHome(options), ".claude"),
    "projects",
  );
}

/** Claude Code names each project folder after its cwd with every non-alphanumeric character replaced. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
}

/** Visible prompt text; injected context (`<system-reminder>`, command wrappers, caveats) is dropped. */
function userPromptText(record: JsonRecord): string | null {
  if (!isRecord(record.message)) return null;
  const text = textBlocks(record.message.content)
    .filter((block) => block.trim() && !block.trimStart().startsWith("<"))
    .join("\n\n")
    .trim();
  return text || null;
}

function isTranscriptRecord(record: JsonRecord): boolean {
  return record.isMeta !== true && record.isSidechain !== true;
}

async function summarizeSessionFile(path: string): Promise<ExternalSessionSummary | null> {
  const info = await stat(path);
  const head = await readHeadJsonLines(path, info.size, HEAD_BYTES);
  let cwd: string | null = null;
  let prompt: string | null = null;
  for (const record of head) {
    cwd ??= stringField(record, "cwd");
    if (!prompt && record.type === "user" && isTranscriptRecord(record))
      prompt = userPromptText(record);
  }
  if (!prompt && info.size <= HEAD_BYTES) return null;

  let model: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let summaryTitle: string | null = null;
  const titleRecords =
    info.size > HEAD_BYTES
      ? [...head, ...(await readTailJsonLines(path, info.size, TAIL_BYTES))]
      : head;
  for (const record of titleRecords) {
    // Latest model wins: sessions can switch models with /model.
    if (record.type === "assistant" && isRecord(record.message)) {
      const candidate = stringField(record.message, "model");
      if (candidate && !candidate.startsWith("<")) model = candidate;
    } else if (record.type === "custom-title")
      customTitle = stringField(record, "customTitle") ?? customTitle;
    else if (record.type === "ai-title") aiTitle = stringField(record, "aiTitle") ?? aiTitle;
    else if (record.type === "summary")
      summaryTitle = stringField(record, "summary") ?? summaryTitle;
  }

  return {
    source: "claude",
    id: basename(path, ".jsonl"),
    title: titleFromText(customTitle ?? aiTitle ?? summaryTitle ?? prompt ?? "Untitled session"),
    cwd,
    updatedAt: info.mtime.toISOString(),
    ...(model ? { model } : {}),
    filePath: path,
  };
}

async function sessionFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Lists native Claude sessions using bounded head/tail metadata reads and optional workspace
 * filtering.
 */
export async function listClaudeSessions(
  scope: ExternalSessionScope,
  options: ExternalSessionOptions = {},
): Promise<ExternalSessionSummary[]> {
  const root = claudeProjectsDir(options);
  let dirs: string[];
  if (scope.kind === "workspace") {
    dirs = [join(root, encodeClaudeProjectDir(scope.root))];
  } else {
    try {
      dirs = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name));
    } catch {
      return [];
    }
  }
  const files = (await Promise.all(dirs.map(sessionFiles))).flat();
  const summaries = await mapWithConcurrency(files, 16, (file) =>
    summarizeSessionFile(file).catch(() => null),
  );
  return (
    summaries
      .filter((summary): summary is ExternalSessionSummary => summary !== null)
      // Encoded folder names can collide ("a b" and "a-b"); the recorded cwd is authoritative.
      .filter(
        (summary) =>
          scope.kind === "all" || summary.cwd === null || sameFolder(summary.cwd, scope.root),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  );
}

function toolLabel(name: string, input: JsonRecord): { title: string; body: string } {
  const body =
    stringField(input, "command") ??
    stringField(input, "file_path") ??
    stringField(input, "path") ??
    stringField(input, "pattern") ??
    stringField(input, "url") ??
    stringField(input, "query") ??
    stringField(input, "prompt") ??
    JSON.stringify(input, null, 2);
  // Unfamiliar inputs fall back to JSON; label them by their first text value instead of "{".
  const firstValue = Object.values(input).find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  const detail =
    stringField(input, "description") ??
    titleFromText((body.startsWith("{") ? firstValue : body.split("\n")[0]) ?? "", 60);
  return { title: detail ? `${name} · ${detail}` : name, body };
}

function toolResultText(block: JsonRecord): string {
  const text = textBlocks(block.content).join("\n").trim();
  return block.is_error === true ? `Error: ${text}` : text;
}

/**
 * Streams a native Claude JSONL transcript, pairing tool results and excluding injected context.
 */
export async function readClaudeTranscript(
  summary: ExternalSessionSummary,
): Promise<ExternalTranscript> {
  if (!summary.filePath)
    return { summary, entries: [], notice: "This Claude Code session has no transcript file." };
  const entries: ExternalTranscriptEntry[] = [];
  const toolEntries = new Map<string, ExternalTranscriptEntry>();
  const push = (entry: Omit<ExternalTranscriptEntry, "id">, timestamp: string | null) => {
    const created: ExternalTranscriptEntry = {
      id: `claude-${entries.length}`,
      ...entry,
      ...(timestamp ? { timestamp } : {}),
    };
    entries.push(created);
    return created;
  };

  await forEachJsonLine(summary.filePath, (record) => {
    if (!isTranscriptRecord(record) || !isRecord(record.message)) return;
    const timestamp = stringField(record, "timestamp");
    const content = record.message.content;
    if (record.type === "user") {
      if (record.isCompactSummary === true) {
        push(
          { kind: "note", title: "Compacted history", text: textBlocks(content).join("\n\n") },
          timestamp,
        );
        return;
      }
      const command =
        typeof content === "string" ? /<command-name>([^<]*)<\/command-name>/.exec(content) : null;
      if (command) {
        const args = /<command-args>([^<]*)<\/command-args>/.exec(content as string)?.[1]?.trim();
        push(
          {
            kind: "note",
            title: "Command",
            text: args ? `${command[1]!.trim()} ${args}` : command[1]!.trim(),
          },
          timestamp,
        );
        return;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            !isRecord(block) ||
            block.type !== "tool_result" ||
            typeof block.tool_use_id !== "string"
          )
            continue;
          const tool = toolEntries.get(block.tool_use_id);
          const result = toolResultText(block);
          if (tool && result) tool.text = clampText(`${tool.text}\n\n${result}`, TOOL_TEXT_LIMIT);
        }
      }
      const prompt = userPromptText(record);
      if (prompt) push({ kind: "user", title: "You", text: prompt }, timestamp);
      return;
    }
    if (record.type !== "assistant" || !Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const last = entries.at(-1);
        if (last?.kind === "assistant") last.text = `${last.text}\n\n${block.text.trim()}`;
        else push({ kind: "assistant", title: "Claude", text: block.text.trim() }, timestamp);
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const { title, body } = toolLabel(
          typeof block.name === "string" ? block.name : "Tool",
          isRecord(block.input) ? block.input : {},
        );
        toolEntries.set(
          block.id,
          push({ kind: "tool", title, text: clampText(body, TOOL_TEXT_LIMIT) }, timestamp),
        );
      }
    }
  });
  return { summary, entries };
}
