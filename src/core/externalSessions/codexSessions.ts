/**
 * Lists Codex threads from `state_*.sqlite` (rollout scan fallback) and parses rollout JSONL
 * into transcript entries.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { clampText, titleFromText } from "../shared/text.js";
import { isRecord } from "../shared/values.js";
import { sameFolder } from "../workspace/workspaceRoot.js";
import {
  envValue,
  forEachJsonLine,
  type JsonRecord,
  mapWithConcurrency,
  openReadonlyDatabase,
  parseJsonLines,
  readHeadJsonLines,
  resolveHome,
  stringField,
  tableColumns,
} from "./storeIo.js";
import type {
  ExternalSessionOptions,
  ExternalSessionScope,
  ExternalSessionSummary,
  ExternalTranscript,
  ExternalTranscriptEntry,
} from "./types.js";

// The first rollout line carries Codex's full base instructions (~20 KiB).
const HEAD_BYTES = 512 * 1024;
const TOOL_TEXT_LIMIT = 16 * 1024;
const REQUIRED_THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "cwd",
  "title",
  "updated_at",
  "source",
  "archived",
];

function codexHomeDir(options: ExternalSessionOptions = {}): string {
  return envValue(options, "CODEX_HOME") ?? join(resolveHome(options), ".codex");
}

async function newestStateDatabase(home: string): Promise<string | null> {
  try {
    const versions = (await readdir(home))
      .map((name) => /^state_(\d+)\.sqlite$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .sort((left, right) => Number(right[1]) - Number(left[1]));
    return versions[0] ? join(home, versions[0][0]) : null;
  } catch {
    return null;
  }
}

/** Codex's own thread index. Returns null when it is missing or has an unfamiliar schema. */
function listFromThreadIndex(
  path: string,
  scope: ExternalSessionScope,
): ExternalSessionSummary[] | null {
  const database = openReadonlyDatabase(path);
  if (!database) return null;
  try {
    const columns = tableColumns(database, "threads");
    if (!REQUIRED_THREAD_COLUMNS.every((column) => columns.has(column))) return null;
    const optional = ["name", "first_user_message", "model", "updated_at_ms"].filter((column) =>
      columns.has(column),
    );
    const hasFirstMessage = columns.has("first_user_message");
    const rows = database
      .query(
        `SELECT ${[...REQUIRED_THREAD_COLUMNS, ...optional].join(", ")} FROM threads` +
          // `exec` threads are Ubume's own Codex route runs; they already exist as Ubume conversations.
          ` WHERE archived = 0 AND ${hasFirstMessage ? "first_user_message" : "title"} != ''`,
      )
      .all() as JsonRecord[];
    return rows.flatMap((row): ExternalSessionSummary[] => {
      const id = stringField(row, "id");
      const cwd = stringField(row, "cwd");
      if (!id) return [];
      if (scope.kind === "workspace" && (!cwd || !sameFolder(cwd, scope.root))) return [];
      const updatedMs =
        typeof row.updated_at_ms === "number" ? row.updated_at_ms : Number(row.updated_at) * 1000;
      const title =
        stringField(row, "name") ??
        stringField(row, "title") ??
        stringField(row, "first_user_message") ??
        "Untitled session";
      const model = stringField(row, "model");
      const rolloutPath = stringField(row, "rollout_path");
      return [
        {
          source: "codex",
          id,
          title: titleFromText(title),
          cwd,
          updatedAt: new Date(Number.isFinite(updatedMs) ? updatedMs : 0).toISOString(),
          ...(model ? { model } : {}),
          ...(rolloutPath ? { filePath: rolloutPath } : {}),
        },
      ];
    });
  } catch {
    return null;
  } finally {
    database.close();
  }
}

async function rolloutFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return rolloutFiles(path);
      return entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

async function threadNames(home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (const record of parseJsonLines(
      await readFile(join(home, "session_index.jsonl"), "utf8"),
    )) {
      const id = stringField(record, "id");
      const name = stringField(record, "thread_name");
      if (id && name) names.set(id, name);
    }
  } catch {
    // The index is optional; titles fall back to the first prompt.
  }
  return names;
}

function payloadOf(record: JsonRecord): JsonRecord | null {
  return isRecord(record.payload) ? record.payload : null;
}

function contentText(content: unknown, types: readonly string[]): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    isRecord(block) &&
    typeof block.type === "string" &&
    types.includes(block.type) &&
    typeof block.text === "string"
      ? [block.text]
      : [],
  );
}

function isInjectedContext(block: string): boolean {
  const trimmed = block.trimStart();
  return trimmed.startsWith("<") || trimmed.startsWith("# AGENTS.md instructions for ");
}

/** Prompt text without Codex's injected `<environment_context>`, AGENTS.md, image and instruction blocks. */
function userText(payload: JsonRecord): string | null {
  const text = contentText(payload.content, ["input_text"])
    .filter((block) => block.trim() && !isInjectedContext(block))
    .join("\n\n")
    .trim();
  return text || null;
}

async function summarizeRollout(
  path: string,
  names: Map<string, string>,
): Promise<ExternalSessionSummary | null> {
  const info = await stat(path);
  const records = await readHeadJsonLines(path, info.size, HEAD_BYTES);
  const meta = records.find((record) => record.type === "session_meta");
  const payload = meta ? payloadOf(meta) : null;
  const id = payload ? stringField(payload, "id") : null;
  if (!payload || !id) return null;
  let prompt: string | null = null;
  for (const record of records) {
    const item = payloadOf(record);
    if (record.type === "response_item" && item?.type === "message" && item.role === "user")
      prompt = userText(item);
    if (prompt) break;
  }
  if (!prompt) return null;
  return {
    source: "codex",
    id,
    title: titleFromText(names.get(id) ?? prompt),
    cwd: stringField(payload, "cwd"),
    updatedAt: info.mtime.toISOString(),
    filePath: path,
  };
}

/**
 * Reads the native thread index, falling back to rollout scanning when the index is unavailable.
 */
export async function listCodexSessions(
  scope: ExternalSessionScope,
  options: ExternalSessionOptions = {},
): Promise<ExternalSessionSummary[]> {
  const home = codexHomeDir(options);
  const databasePath = await newestStateDatabase(home);
  let sessions = databasePath ? listFromThreadIndex(databasePath, scope) : null;
  if (!sessions) {
    const names = await threadNames(home);
    const files = await rolloutFiles(join(home, "sessions"));
    const summaries = await mapWithConcurrency(files, 16, (file) =>
      summarizeRollout(file, names).catch(() => null),
    );
    sessions = summaries.filter(
      (summary): summary is ExternalSessionSummary =>
        summary !== null &&
        (scope.kind === "all" || (summary.cwd !== null && sameFolder(summary.cwd, scope.root))),
    );
  }
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function toolBody(payload: JsonRecord): string {
  if (typeof payload.input === "string") return payload.input;
  const raw = typeof payload.arguments === "string" ? payload.arguments : "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const command = parsed.cmd ?? parsed.command;
      if (typeof command === "string") return command;
      if (Array.isArray(command))
        return command.filter((part) => typeof part === "string").join(" ");
    }
  } catch {
    // Non-JSON arguments are shown as-is.
  }
  if (isRecord(payload.action) && Array.isArray(payload.action.command))
    return payload.action.command.join(" ");
  return raw;
}

function toolOutput(output: unknown): string {
  if (typeof output === "string") {
    try {
      const parsed: unknown = JSON.parse(output);
      if (isRecord(parsed) && typeof parsed.output === "string") return parsed.output;
    } catch {
      // Plain text output.
    }
    return output;
  }
  if (isRecord(output) && typeof output.content === "string") return output.content;
  return contentText(output, ["input_text", "output_text"]).join("\n");
}

/** Codex's `exec` tool wraps shell commands in JavaScript; show the command it runs. */
function toolDetail(body: string): string {
  const command = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
  if (command) {
    try {
      return JSON.parse(`"${command}"`) as string;
    } catch {
      return command;
    }
  }
  return body.split("\n")[0] ?? "";
}

/** Parses native Codex rollout events into user, assistant and tool display entries. */
export async function readCodexTranscript(
  summary: ExternalSessionSummary,
): Promise<ExternalTranscript> {
  if (!summary.filePath)
    return { summary, entries: [], notice: "This Codex session has no rollout file." };
  const entries: ExternalTranscriptEntry[] = [];
  const tools = new Map<string, ExternalTranscriptEntry>();
  const push = (entry: Omit<ExternalTranscriptEntry, "id">, timestamp: string | null) => {
    const created: ExternalTranscriptEntry = {
      id: `codex-${entries.length}`,
      ...entry,
      ...(timestamp ? { timestamp } : {}),
    };
    entries.push(created);
    return created;
  };

  await forEachJsonLine(summary.filePath, (record) => {
    const payload = payloadOf(record);
    if (!payload) return;
    const timestamp = stringField(record, "timestamp");
    if (record.type === "compacted" && typeof payload.message === "string") {
      push({ kind: "note", title: "Compacted history", text: payload.message }, timestamp);
      return;
    }
    if (record.type !== "response_item") return;
    if (payload.type === "message") {
      if (payload.role === "user") {
        const text = userText(payload);
        if (text) push({ kind: "user", title: "You", text }, timestamp);
      } else if (payload.role === "assistant") {
        const text = contentText(payload.content, ["output_text"]).join("\n\n").trim();
        if (!text) return;
        const last = entries.at(-1);
        if (last?.kind === "assistant") last.text = `${last.text}\n\n${text}`;
        else push({ kind: "assistant", title: "Codex", text }, timestamp);
      }
      return;
    }
    if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call" ||
      payload.type === "local_shell_call"
    ) {
      const name = stringField(payload, "name") ?? "shell";
      const body = toolBody(payload);
      const entry = push(
        {
          kind: "tool",
          title: `${name} · ${titleFromText(toolDetail(body), 60)}`,
          text: clampText(body, TOOL_TEXT_LIMIT),
        },
        timestamp,
      );
      const callId = stringField(payload, "call_id");
      if (callId) tools.set(callId, entry);
      return;
    }
    if (
      payload.type === "function_call_output" ||
      payload.type === "custom_tool_call_output" ||
      payload.type === "local_shell_call_output"
    ) {
      const callId = stringField(payload, "call_id");
      const tool = callId ? tools.get(callId) : undefined;
      const output = toolOutput(payload.output).trim();
      if (tool && output) tool.text = clampText(`${tool.text}\n\n${output}`, TOOL_TEXT_LIMIT);
    }
  });
  return { summary, entries };
}
