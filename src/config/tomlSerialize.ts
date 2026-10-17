/**
 * @fileoverview TOML Serialization Utility
 *
 * Provides functions for serializing JavaScript objects, primitives, and arrays
 * into standard TOML document format with proper key quoting, nested tables,
 * and array-of-tables (`[[table]]`) formatting.
 */

import { isRecord } from "../core/shared/values.js";

/** Checks if a value is a string, number, or boolean primitive. */
function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Formats a single TOML key, quoting if it contains special characters or whitespace.
 *
 * Bare keys may only contain ASCII letters, digits, underscores, and dashes (`[A-Za-z0-9_-]`).
 *
 * @param key - The key name to format.
 * @returns The bare key or a JSON-quoted string key.
 */
export function formatTomlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

/**
 * Formats a dotted path sequence into a valid TOML table or section header.
 * Each segment is individually quoted if necessary.
 *
 * @example
 * formatTomlPath(["projects", "C:/Workspace"]) // 'projects."C:/Workspace"'
 *
 * @param path - Segments representing the hierarchy path.
 * @returns Dot-joined path with quoted segments where needed.
 */
export function formatTomlPath(path: readonly string[]): string {
  return path.map(formatTomlKey).join(".");
}

/** Formats a primitive string, boolean, or number for TOML value representation. */
function formatTomlPrimitive(value: string | number | boolean): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return `${value}`;
}

/** Formats an array of values into a TOML inline array representation. */
function formatTomlArray(values: readonly unknown[]): string {
  return `[${values.map((item) => formatTomlValue(item)).join(", ")}]`;
}

/** Formats an arbitrary JavaScript value into a valid TOML value string. */
function formatTomlValue(value: unknown): string {
  if (isPrimitive(value)) {
    return formatTomlPrimitive(value);
  }

  if (Array.isArray(value)) {
    return formatTomlArray(value);
  }

  if (isRecord(value)) {
    const properties = Object.entries(value)
      .map(([key, item]) => `${formatTomlKey(key)} = ${formatTomlValue(item)}`)
      .join(", ");
    return `{ ${properties} }`;
  }

  // TOML has no null literal; fall back to JSON encoding for unknown types.
  return JSON.stringify(value ?? null);
}

/**
 * Serializes a single TOML section recursively into the provided output lines array.
 */
function serializeTomlSection(
  path: readonly string[],
  value: Record<string, unknown>,
  lines: string[],
): void {
  const isArrayOfTables = (item: unknown): item is Record<string, unknown>[] =>
    Array.isArray(item) && item.length > 0 && item.every(isRecord);

  const scalarEntries = Object.entries(value).filter(
    ([, item]) => !isRecord(item) && !Array.isArray(item),
  );
  const arrayEntries = Object.entries(value).filter(
    ([, item]) => Array.isArray(item) && !isArrayOfTables(item),
  );
  const tableEntries = Object.entries(value).filter(([, item]) => isRecord(item));
  const arrayTableEntries = Object.entries(value).filter(([, item]) => isArrayOfTables(item));

  if (path.length > 0) {
    lines.push(`[${formatTomlPath(path)}]`);
  }

  for (const [key, item] of [...scalarEntries, ...arrayEntries]) {
    lines.push(`${formatTomlKey(key)} = ${formatTomlValue(item)}`);
  }

  for (const [key, item] of tableEntries) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    serializeTomlSection([...path, key], item as Record<string, unknown>, lines);
  }

  for (const [key, item] of arrayTableEntries) {
    for (const table of item as Record<string, unknown>[]) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(`[[${formatTomlPath([...path, key])}]]`);
      const tableLines: string[] = [];
      serializeTomlSection([], table, tableLines);
      lines.push(...tableLines);
    }
  }
}

/**
 * Serializes a nested JavaScript object into a standard TOML document string.
 *
 * @param data - The root record to serialize.
 * @returns A formatted TOML document string ending with a newline.
 */
export function serializeTomlDocument(data: Record<string, unknown>): string {
  const lines: string[] = [];
  serializeTomlSection([], data, lines);
  return `${lines.join("\n").trim()}\n`;
}
