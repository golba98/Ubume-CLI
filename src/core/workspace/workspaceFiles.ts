/**
 * Resolves, reads, and guards workspace file selections.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
import type { FileAttachment } from "../../session/workbench.js";

const execute = promisify(execFile);
const excluded = new Set([
  ".git",
  ".ubume",
  ".codexa",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
]);
export const FILE_TEXT_LIMIT = 1024 * 1024;
function safeProjectPath(path: string): boolean {
  return (
    !!path &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== ".." && part !== "." && !excluded.has(part)) &&
    !/(^|\/)\.env(?:\.|$)/.test(path)
  );
}
/**
 * Resolves a supported relative project path and rejects traversal, excluded paths and existing
 * symlink components. Does not create the target.
 */
export async function containedFile(root: string, path: string): Promise<string> {
  if (!safeProjectPath(path)) throw new Error(`Unsupported project path: ${path}`);
  const base = await realpath(root);
  const absolute = resolve(base, path);
  const rel = relative(base, absolute);
  if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Path is outside the workspace.");
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symlink paths are unsupported: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return absolute;
}
/**
 * Resolves the root once for one checkpoint operation. Directory checks stay fresh for
 * every path: caching a successful lstat could miss a directory replaced by a symlink.
 */
export function createContainedFileResolver(root: string): (path: string) => Promise<string> {
  let base: Promise<string> | undefined;
  return async (path) => {
    if (!safeProjectPath(path)) throw new Error(`Unsupported project path: ${path}`);
    base ??= realpath(root);
    const resolvedBase = await base;
    const absolute = resolve(resolvedBase, path);
    const rel = relative(resolvedBase, absolute);
    if (rel.startsWith(`..${sep}`) || rel === "..")
      throw new Error("Path is outside the workspace.");
    let current = resolvedBase;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error(`Symlink paths are unsupported: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return absolute;
  };
}

/**
 * Lists supported project files using Git, with nested-ignore walking as fallback;
 * sensitive/generated paths are excluded.
 */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execute(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    return [...new Set(stdout.split("\0").filter(safeProjectPath))].sort();
  } catch {
    /* No Git repository: apply nested ignore files ourselves. */
  }
  const files: string[] = [];
  async function walk(
    dir: string,
    rules: { base: string; matcher: ReturnType<typeof ignore> }[],
  ): Promise<void> {
    let content = "";
    try {
      content = await readFile(join(root, dir, ".gitignore"), "utf8");
    } catch {
      /* Optional. */
    }
    const current = content ? [...rules, { base: dir, matcher: ignore().add(content) }] : rules;
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (!safeProjectPath(path) || entry.isSymbolicLink()) continue;
      let ignored = false;
      for (const rule of current) {
        const match = rule.matcher.test(
          `${relative(join(root, rule.base), join(root, path)).split(sep).join("/")}${entry.isDirectory() ? "/" : ""}`,
        );
        if (match.ignored) ignored = true;
        else if (match.unignored) ignored = false;
      }
      if (ignored) continue;
      if (entry.isDirectory()) await walk(path, current);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk("", []);
  return files.sort();
}
/** Ranks subsequence matches and returns at most 30 project paths for completion. */
export function fuzzyFiles(paths: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  return paths
    .map((path) => {
      const lower = path.toLowerCase();
      let cursor = 0;
      let score = 0;
      for (const char of needle) {
        const index = lower.indexOf(char, cursor);
        if (index < 0) return { path, score: Infinity };
        score += index - cursor;
        cursor = index + 1;
      }
      return { path, score: score + path.length / 1000 };
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, 30)
    .map((item) => item.path);
}
/**
 * Reads a regular, contained UTF-8 text file up to 1 MiB and hashes its bytes;
 * unsupported/binary/oversized files reject.
 */
export async function readFileAttachment(root: string, path: string): Promise<FileAttachment> {
  const absolute = await containedFile(root, path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.size > FILE_TEXT_LIMIT)
    throw new Error(`${path}: attach a regular text file no larger than 1 MiB.`);
  const bytes = await readFile(absolute);
  if (bytes.length > FILE_TEXT_LIMIT)
    throw new Error(`${path}: file grew beyond the text attachment limit.`);
  if (bytes.includes(0)) throw new Error(`${path}: binary files cannot be attached as text.`);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { path, content, hash: createHash("sha256").update(bytes).digest("hex") };
}
/**
 * Expands registered tokens against the original prompt once, with an 8 MiB aggregate limit;
 * inserted contents are never recursively expanded.
 */
export async function expandFileAttachments(
  value: string,
  registry: Map<string, FileAttachment>,
  root: string,
): Promise<string> {
  const replacements = new Map<string, string>();
  let expandedBytes = Buffer.byteLength(value);
  if (expandedBytes > 8 * FILE_TEXT_LIMIT)
    throw new Error("Attached text exceeds the 8 MiB prompt limit.");
  for (const [token, attachment] of registry) {
    if (!token || !value.includes(token)) continue;
    const loaded =
      attachment.content === undefined
        ? await readFileAttachment(root, attachment.path)
        : attachment;
    const replacement = `\n<file path=${JSON.stringify(loaded.path)}>\n${loaded.content}\n</file>\n`;
    let occurrences = 0;
    for (let offset = 0; ; ) {
      const next = value.indexOf(token, offset);
      if (next < 0) break;
      occurrences++;
      offset = next + token.length;
    }
    expandedBytes += occurrences * (Buffer.byteLength(replacement) - Buffer.byteLength(token));
    if (expandedBytes > 8 * FILE_TEXT_LIMIT)
      throw new Error("Attached text exceeds the 8 MiB prompt limit.");
    replacements.set(token, replacement);
  }
  // Scan the original prompt once: replacement contents are never expanded recursively.
  const tokens = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const chunks: string[] = [];
  let total = 0;
  let cursor = 0;
  const append = (text: string) => {
    total += Buffer.byteLength(text);
    if (total > 8 * FILE_TEXT_LIMIT)
      throw new Error("Attached text exceeds the 8 MiB prompt limit.");
    chunks.push(text);
  };
  while (cursor < value.length) {
    let next = value.length;
    let match: string | undefined;
    for (const token of tokens) {
      if (!token) continue;
      const index = value.indexOf(token, cursor);
      if (index >= 0 && index < next) {
        next = index;
        match = token;
      }
    }
    append(value.slice(cursor, next));
    if (!match) break;
    append(replacements.get(match)!);
    cursor = next + match.length;
  }
  return chunks.join("");
}
