/**
 * Read-only native-store primitives: SQLite fallback, bounded JSONL reads, protobuf text
 * extraction and concurrent mapping. Database handles belong to callers; file/line readers close
 * their own resources.
 */

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { getHomeDir } from "../../config/settings.js";
import { isRecord } from "../shared/values.js";

import type { ExternalSessionOptions } from "./types.js";

interface ReadonlyStatement {
  all: (...params: unknown[]) => unknown[];
}

interface ReadonlyDatabase {
  query: (sql: string) => ReadonlyStatement;
  close: () => void;
}

type DatabaseConstructor = new (path: string, options: { readonly: boolean }) => ReadonlyDatabase;

function databaseConstructor(): DatabaseConstructor | null {
  try {
    // Ubume always runs under Bun; the project's tsconfig does not load Bun's
    // module types (same pattern as providerRuntime/unsloth.ts).
    return (require("bun:sqlite") as { Database: DatabaseConstructor }).Database;
  } catch {
    return null;
  }
}

/**
 * Opens another tool's SQLite store without ever writing to it. WAL databases
 * can refuse a plain read-only open (the reader needs the -shm file), so fall
 * back to `immutable=1`, which reads the main file as a snapshot.
 */
export function openReadonlyDatabase(path: string): ReadonlyDatabase | null {
  const Database = databaseConstructor();
  if (!Database) return null;
  try {
    return new Database(path, { readonly: true });
  } catch {
    try {
      return new Database(`file:${encodeURI(path)}?immutable=1`, { readonly: true });
    } catch {
      return null;
    }
  }
}

/**
 * Reads SQLite column names; unsupported schemas/query failures yield an empty set. The caller
 * still owns the database handle.
 */
export function tableColumns(database: ReadonlyDatabase, table: string): Set<string> {
  try {
    const rows = database.query(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
    return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  } catch {
    return new Set();
  }
}

/**
 * Schemaless protobuf text extraction. Antigravity stores conversation steps as
 * protobuf blobs without a published schema, so the transcript viewer walks the
 * wire format and keeps every length-delimited field that reads as text.
 */

const decoder = new TextDecoder("utf-8", { fatal: true });

interface Cursor {
  offset: number;
}

function readVarint(bytes: Uint8Array, cursor: Cursor): number | null {
  let result = 0;
  let multiplier = 1;
  for (let index = 0; index < 10; index += 1) {
    if (cursor.offset >= bytes.length) return null;
    const byte = bytes[cursor.offset++]!;
    result += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return result;
    multiplier *= 128;
  }
  return null;
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return null;
  }
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && char !== "\n" && char !== "\r" && char !== "\t") || code === 0x7f)
      return null;
  }
  return text;
}

/** Parses one message; returns null when the bytes are not a well-formed message. */
function walkMessage(
  bytes: Uint8Array,
  depth: number,
  maxDepth: number,
  output: string[],
): boolean {
  const cursor: Cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const tag = readVarint(bytes, cursor);
    if (tag === null || tag >>> 3 === 0) return false;
    const wireType = tag & 7;
    if (wireType === 0) {
      if (readVarint(bytes, cursor) === null) return false;
    } else if (wireType === 1) {
      cursor.offset += 8;
    } else if (wireType === 5) {
      cursor.offset += 4;
    } else if (wireType === 2) {
      const length = readVarint(bytes, cursor);
      if (length === null || cursor.offset + length > bytes.length) return false;
      const payload = bytes.subarray(cursor.offset, cursor.offset + length);
      cursor.offset += length;
      const text = decodeText(payload);
      if (text !== null) {
        output.push(text);
      } else if (depth < maxDepth) {
        const nested: string[] = [];
        if (walkMessage(payload, depth + 1, maxDepth, nested)) output.push(...nested);
      }
    } else {
      return false;
    }
    if (cursor.offset > bytes.length) return false;
  }
  return true;
}

/** Text fields of a protobuf message in wire order. Never throws; malformed tails are dropped. */
export function extractProtobufStrings(bytes: Uint8Array, maxDepth = 6): string[] {
  const output: string[] = [];
  walkMessage(bytes, 0, maxDepth, output);
  return output;
}

export type JsonRecord = Record<string, unknown>;

/** Returns a nonblank string field without coercing or trimming its stored value. */
export function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Uses the explicit native-session home override before the injected environment's home. */
export function resolveHome(options: ExternalSessionOptions = {}): string {
  return options.home ?? getHomeDir(options.env);
}

/** Reads a trimmed, nonempty environment override from the supplied session context. */
export function envValue(options: ExternalSessionOptions, key: string): string | undefined {
  const value = (options.env ?? process.env)[key]?.trim();
  return value || undefined;
}

const textDecoder = new TextDecoder("utf-8");

async function readRange(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return textDecoder.decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Complete JSON lines from the first `bytes` of a file. */
export async function readHeadJsonLines(
  path: string,
  size: number,
  bytes: number,
): Promise<JsonRecord[]> {
  const text = await readRange(path, 0, Math.min(size, bytes));
  return parseJsonLines(text, { dropLast: size > bytes });
}

/** Complete JSON lines from the last `bytes` of a file. */
export async function readTailJsonLines(
  path: string,
  size: number,
  bytes: number,
): Promise<JsonRecord[]> {
  const start = Math.max(0, size - bytes);
  const text = await readRange(path, start, size - start);
  return parseJsonLines(text, { dropFirst: start > 0 });
}

/**
 * Parses object-valued JSONL records, skipping malformed lines and optionally dropping partial
 * boundary lines.
 */
export function parseJsonLines(
  text: string,
  options: { dropFirst?: boolean; dropLast?: boolean } = {},
): JsonRecord[] {
  const lines = text.split("\n");
  if (options.dropFirst) lines.shift();
  if (options.dropLast) lines.pop();
  const records: JsonRecord[] = [];
  for (const line of lines) {
    const record = parseJsonLine(line);
    if (record) records.push(record);
  }
  return records;
}

function parseJsonLine(line: string): JsonRecord | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Streams a JSONL file without loading it whole; malformed lines are skipped. */
export async function forEachJsonLine(
  path: string,
  visit: (record: JsonRecord) => void,
): Promise<void> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const record = parseJsonLine(line);
    if (record) visit(record);
  }
}

/** Maps with bounded parallelism so scanning hundreds of session files keeps file handles low. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
