/**
 * Lists Antigravity sessions from SQLite and reads session protobuf state.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clampText, titleFromText } from "../shared/text.js";
import { isRecord } from "../shared/values.js";
import { sameFolder } from "../workspace/workspaceRoot.js";
import {
  extractProtobufStrings,
  type JsonRecord,
  openReadonlyDatabase,
  parseJsonLines,
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

const TOOL_TEXT_LIMIT = 16 * 1024;
const REQUIRED_SUMMARY_COLUMNS = [
  "conversation_id",
  "title",
  "step_count",
  "last_modified_time",
  "workspace_uris",
];

// Step kinds observed in the Antigravity CLI's step database.
const USER_INPUT_STEP = 14;
const PLANNER_RESPONSE_STEP = 15;
const TOOL_CALL_STEP = 132;

const STEP_NOTICE =
  "Text is a best-effort extraction from Antigravity's binary format; o opens the exact view in agy.";
const HISTORY_NOTICE = "Older Antigravity conversation: prompts only; o opens the replies in agy.";

function antigravityCliDir(options: ExternalSessionOptions = {}): string {
  return join(resolveHome(options), ".gemini", "antigravity-cli");
}

function workspaceFolders(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const uris: unknown = JSON.parse(value);
    if (!Array.isArray(uris)) return [];
    return uris.flatMap((uri) => {
      if (typeof uri !== "string" || !uri.startsWith("file:")) return [];
      try {
        return [fileURLToPath(uri)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** `2026-09-30 02:59:07.896083311+00:00` → ISO (nanoseconds trimmed to milliseconds). */
function parseAntigravityTime(value: unknown): string {
  if (typeof value !== "string") return new Date(0).toISOString();
  const normalized = value
    .trim()
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1");
  const time = Date.parse(normalized);
  return new Date(Number.isNaN(time) ? 0 : time).toISOString();
}

/**
 * Lists read-only native AGY summaries for the requested scope; a missing store yields no
 * sessions.
 */
export async function listAntigravitySessions(
  scope: ExternalSessionScope,
  options: ExternalSessionOptions = {},
): Promise<ExternalSessionSummary[]> {
  const path = join(antigravityCliDir(options), "conversation_summaries.db");
  if (!existsSync(path)) return [];
  const database = openReadonlyDatabase(path);
  if (!database) return [];
  try {
    const columns = tableColumns(database, "conversation_summaries");
    if (!REQUIRED_SUMMARY_COLUMNS.every((column) => columns.has(column))) return [];
    const filters = [
      "step_count > 0",
      // Subagent conversations are children of a resumable top-level conversation.
      ...(columns.has("nesting_depth") ? ["nesting_depth = 0"] : []),
      ...(columns.has("killed") ? ["killed = 0"] : []),
    ];
    const rows = database
      .query(
        `SELECT conversation_id, title, ${columns.has("preview") ? "preview" : "'' AS preview"}, last_modified_time, workspace_uris FROM conversation_summaries WHERE ${filters.join(" AND ")}`,
      )
      .all() as JsonRecord[];
    return rows
      .flatMap((row): ExternalSessionSummary[] => {
        const id = stringField(row, "conversation_id");
        if (!id) return [];
        const folders = workspaceFolders(row.workspace_uris);
        if (scope.kind === "workspace" && !folders.some((folder) => sameFolder(folder, scope.root)))
          return [];
        const cwd = scope.kind === "workspace" ? scope.root : (folders[0] ?? null);
        return [
          {
            source: "antigravity",
            id,
            title: titleFromText(
              stringField(row, "title") ?? stringField(row, "preview") ?? "Untitled session",
            ),
            cwd,
            updatedAt: parseAntigravityTime(row.last_modified_time),
          },
        ];
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  } finally {
    database.close();
  }
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Ids, counters and routing keys that surround the text fields in a step payload. */
function isNoise(value: string): boolean {
  const trimmed = value.trim();
  return (
    !trimmed ||
    /^-?\d+$/.test(trimmed) ||
    /^(bot-|call_)/.test(trimmed) ||
    trimmed === "sessionID" ||
    (!/\s/.test(trimmed) && UUID_PATTERN.test(trimmed))
  );
}

/** A user step leads with the prompt as typed, ahead of the model's expanded copy and tool policy. */
function promptText(strings: readonly string[]): string | null {
  return strings.find((value) => !isNoise(value))?.trim() ?? null;
}

/**
 * Replies are stored twice in their step (display copy + model copy) while
 * hidden reasoning is stored once, so the first repeated text field is the
 * visible reply.
 */
function replyText(strings: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of strings) counts.set(value, (counts.get(value) ?? 0) + 1);
  const match = strings.find((value) => !isNoise(value) && (counts.get(value) ?? 0) >= 2);
  return match?.trim() ?? null;
}

function toolFromStrings(strings: readonly string[]): { title: string; text: string } | null {
  const callIndex = strings.findIndex((value) => value.startsWith("call_"));
  const name = callIndex >= 0 ? strings[callIndex + 1] : undefined;
  if (!name || !/^[A-Za-z_][\w-]*$/.test(name)) return null;
  const args = strings.find((value) => value.trimStart().startsWith("{")) ?? "";
  let body = args;
  try {
    const parsed: unknown = JSON.parse(args);
    if (isRecord(parsed)) {
      body =
        stringField(parsed, "CommandLine") ??
        stringField(parsed, "AbsolutePath") ??
        stringField(parsed, "TargetFile") ??
        stringField(parsed, "Url") ??
        stringField(parsed, "Query") ??
        args;
    }
  } catch {
    // Keep the raw arguments.
  }
  const summaryIndex = strings.indexOf("toolSummary");
  const summary = summaryIndex >= 0 ? strings[summaryIndex + 1] : undefined;
  const skip = new Set([name, args, summary, "toolSummary", "toolAction"]);
  const output = strings
    .filter(
      (value) =>
        !skip.has(value) &&
        !isNoise(value) &&
        !value.trimStart().startsWith("{") &&
        !/^(file:|type\.googleapis\.com)/.test(value),
    )
    .reduce((longest, value) => (value.length > longest.length ? value : longest), "");
  const detail = summary ?? titleFromText(body.split("\n")[0] ?? "", 60);
  return {
    title: detail ? `${name} · ${detail}` : name,
    text: clampText([body, output.trim()].filter(Boolean).join("\n\n"), TOOL_TEXT_LIMIT),
  };
}

function entriesFromSteps(path: string): ExternalTranscriptEntry[] | null {
  const database = openReadonlyDatabase(path);
  if (!database) return null;
  try {
    const rows = database
      .query("SELECT step_type, step_payload FROM steps ORDER BY idx")
      .all() as JsonRecord[];
    const entries: ExternalTranscriptEntry[] = [];
    for (const row of rows) {
      if (!(row.step_payload instanceof Uint8Array)) continue;
      const type = Number(row.step_type);
      if (type !== USER_INPUT_STEP && type !== PLANNER_RESPONSE_STEP && type !== TOOL_CALL_STEP)
        continue;
      const strings = extractProtobufStrings(row.step_payload);
      const id = `antigravity-${entries.length}`;
      if (type === TOOL_CALL_STEP) {
        const tool = toolFromStrings(strings);
        if (tool) entries.push({ id, kind: "tool", ...tool });
        continue;
      }
      const text = type === USER_INPUT_STEP ? promptText(strings) : replyText(strings);
      if (!text) continue;
      const last = entries.at(-1);
      if (type === PLANNER_RESPONSE_STEP && last?.kind === "assistant")
        last.text = `${last.text}\n\n${text}`;
      else
        entries.push(
          type === USER_INPUT_STEP
            ? { id, kind: "user", title: "You", text }
            : { id, kind: "assistant", title: "Antigravity", text },
        );
    }
    return entries;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

async function entriesFromHistory(root: string, id: string): Promise<ExternalTranscriptEntry[]> {
  try {
    return parseJsonLines(await readFile(join(root, "history.jsonl"), "utf8"))
      .filter(
        (record) =>
          record.conversationId === id &&
          record.type !== "slash_command" &&
          stringField(record, "display"),
      )
      .map((record, index) => ({
        id: `antigravity-history-${index}`,
        kind: "user" as const,
        title: "You",
        text: stringField(record, "display")!,
        ...(typeof record.timestamp === "number"
          ? { timestamp: new Date(record.timestamp).toISOString() }
          : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * Reads native AGY steps into display entries, falling back to prompt history when step data is
 * unavailable.
 */
export async function readAntigravityTranscript(
  summary: ExternalSessionSummary,
  options: ExternalSessionOptions = {},
): Promise<ExternalTranscript> {
  const root = antigravityCliDir(options);
  const stepsPath = join(root, "conversations", `${summary.id}.db`);
  const fromSteps = existsSync(stepsPath) ? entriesFromSteps(stepsPath) : null;
  if (fromSteps && fromSteps.length > 0)
    return { summary, entries: fromSteps, notice: STEP_NOTICE };
  return { summary, entries: await entriesFromHistory(root, summary.id), notice: HISTORY_NOTICE };
}
