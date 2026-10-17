/**
 * Lists and reads native Mistral Vibe session transcripts.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseTomlDocument } from "../../config/layeredConfig.js";
import { clampText, titleFromText } from "../shared/text.js";
import { isRecord } from "../shared/values.js";
import { sameFolder } from "../workspace/workspaceRoot.js";
import {
  envValue,
  forEachJsonLine,
  mapWithConcurrency,
  readHeadJsonLines,
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

/**
 * Resolves Vibe's configured session directory with the native-home fallback; does not create
 * it.
 */
export async function vibeSessionDir(options: ExternalSessionOptions = {}): Promise<string> {
  const home = envValue(options, "VIBE_HOME") ?? join(resolveHome(options), ".vibe");
  try {
    const config = parseTomlDocument(await readFile(join(home, "config.toml"), "utf8"));
    const logging = isRecord(config.session_logging) ? config.session_logging : null;
    const configured = logging ? stringField(logging, "save_dir") : null;
    if (configured) {
      const expanded = configured.replace(/^~(?=[/\\]|$)/, resolveHome(options));
      return isAbsolute(expanded) ? expanded : resolve(home, expanded);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return join(home, "logs", "session");
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

async function summarize(path: string): Promise<ExternalSessionSummary | null> {
  const metadata = JSON.parse(await readFile(join(path, "meta.json"), "utf8"));
  if (!isRecord(metadata)) return null;
  const id = stringField(metadata, "session_id");
  if (!id) return null;
  const filePath = join(path, "messages.jsonl");
  const info = await stat(filePath);
  const head = await readHeadJsonLines(filePath, info.size, 64 * 1024);
  const prompt = head.find((message) => message.role === "user");
  if (!prompt && info.size === 0) return null;
  const environment = isRecord(metadata.environment) ? metadata.environment : {};
  const config = isRecord(metadata.config) ? metadata.config : {};
  const model = stringField(metadata, "model") ?? stringField(config, "active_model");
  return {
    source: "vibe",
    id,
    title: titleFromText(
      stringField(metadata, "title") ?? (textContent(prompt?.content) || "Untitled session"),
    ),
    cwd: stringField(environment, "working_directory"),
    updatedAt: info.mtime.toISOString(),
    filePath,
    ...(model ? { model } : {}),
    ...(typeof metadata.total_messages === "number"
      ? { messageCount: metadata.total_messages }
      : {}),
  };
}

/** Lists native Vibe metadata for the requested scope without modifying Vibe's store. */
export async function listVibeSessions(
  scope: ExternalSessionScope,
  options: ExternalSessionOptions = {},
): Promise<ExternalSessionSummary[]> {
  const root = await vibeSessionDir(options);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const summaries = await mapWithConcurrency(
    entries.filter((entry) => entry.isDirectory()),
    8,
    async (entry) => {
      try {
        return await summarize(join(root, entry.name));
      } catch {
        return null;
      } // One malformed or actively-written session cannot hide others.
    },
  );
  return summaries
    .filter(
      (summary): summary is ExternalSessionSummary =>
        summary !== null &&
        (scope.kind === "all" || (summary.cwd !== null && sameFolder(summary.cwd, scope.root))),
    )
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
}

/**
 * Reads Vibe messages and tool activity into a display transcript; native files remain
 * unchanged.
 */
export async function readVibeTranscript(
  summary: ExternalSessionSummary,
): Promise<ExternalTranscript> {
  if (!summary.filePath) throw new Error("Mistral Vibe session has no transcript location.");
  const entries: ExternalTranscriptEntry[] = [];
  await forEachJsonLine(summary.filePath, (message) => {
    const role = message.role;
    const text = textContent(message.content);
    if (text)
      entries.push({
        id: `vibe-${entries.length}`,
        kind:
          role === "user"
            ? "user"
            : role === "assistant"
              ? "assistant"
              : role === "tool"
                ? "tool"
                : "note",
        title: role === "tool" ? (stringField(message, "name") ?? "Tool") : String(role ?? "Note"),
        text: clampText(text, 64 * 1024),
      });
    if (Array.isArray(message.tool_calls))
      for (const call of message.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        entries.push({
          id: `vibe-${entries.length}`,
          kind: "tool",
          title: stringField(call.function, "name") ?? "Tool",
          text: clampText(stringField(call.function, "arguments") ?? "", 16 * 1024),
        });
      }
  });
  return { summary, entries };
}
