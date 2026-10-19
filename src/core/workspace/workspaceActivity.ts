/**
 * Snapshots workspace files, detects changes, aggregates activity, and tracks modifications
 * during runs.
 */

import { type Dirent, readdirSync, readFileSync, type Stats, statSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative, sep } from "path";
import { normalizeLineBreaks } from "../shared/text.js";
import { SCRATCH_RELATIVE_DIR } from "./scratchDir.js";

export type RunFileOperation = "created" | "modified" | "deleted";
type RunDiffLineKind = "added" | "removed";

export interface RunDiffLine {
  kind: RunDiffLineKind;
  text: string;
}

export interface RunFileActivity {
  path: string;
  operation: RunFileOperation;
  detectedAt: number;
  addedLines?: number;
  removedLines?: number;
  diffLines?: RunDiffLine[];
}

export interface RunActivitySummary {
  created: number;
  modified: number;
  deleted: number;
  totalActivityCount: number;
  recent: RunFileActivity[];
}

interface WorkspaceActivityTracker {
  stop: () => void;
}

interface WorkspaceActivityTrackerOptions {
  rootDir: string;
  onActivity: (activity: RunFileActivity[]) => void;
  pollIntervalMs?: number;
  initialSnapshot?: Map<string, WorkspaceFileSnapshot>;
  /** Content cache shared with the caller's own (final) snapshots of the same run. */
  contentCache?: WorkspaceContentCache;
}

interface WorkspaceFileSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  content?: string;
}

interface CachedFileContent {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  content: string | undefined;
}

/**
 * Tracked text keyed by absolute path and validated by full stat identity, so a poll only
 * reads files whose stat changed. ctime is part of the key because every content write
 * updates it, which catches same-size rewrites within one mtime tick. This is a display
 * cache: recovery never relies on it (checkpoints hash exact bytes).
 */
export type WorkspaceContentCache = Map<string, CachedFileContent>;

export function createWorkspaceContentCache(): WorkspaceContentCache {
  return new Map();
}

const DEFAULT_POLL_INTERVAL_MS = 400;
// Slow scans back off to at most this interval so polling never saturates the disk.
const MAX_ADAPTIVE_POLL_INTERVAL_MS = 2000;
// Parallel filesystem operations per asynchronous scan.
const SCAN_CONCURRENCY = 32;
// Bun can settle fs promises without returning to the event loop, so an "async" scan would
// still starve timers and input; the scan yields a macrotask after this many operations.
const SCAN_OPERATIONS_PER_YIELD = 64;
const MAX_TRACKED_TEXT_BYTES = 128 * 1024;
const MAX_DIFFABLE_LINE_COUNT = 240;
const MAX_DIFF_PREVIEW_LINES = 6;
const MAX_SUMMARY_ACTIVITY_ITEMS = 6;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".parcel-cache",
  ".turbo",
  ".vercel",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "temp",
  "tmp",
]);

const BINARY_EXTENSIONS = new Set([
  ".bmp",
  ".class",
  ".dll",
  ".dylib",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function shouldIgnoreDirectory(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name);
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function shouldTrackTextContent(path: string, size: number): boolean {
  const lower = path.toLowerCase();
  const dotIndex = lower.lastIndexOf(".");
  const ext = dotIndex >= 0 ? lower.slice(dotIndex) : "";
  if (size > MAX_TRACKED_TEXT_BYTES) return false;
  if (BINARY_EXTENSIONS.has(ext)) return false;
  return true;
}

function decodeTrackedContent(buffer: Buffer): string | undefined {
  if (isBinaryBuffer(buffer)) return undefined;
  return normalizeLineBreaks(buffer.toString("utf8"));
}

function cachedContent(
  cache: WorkspaceContentCache | undefined,
  fullPath: string,
  stats: Stats,
): { hit: true; content: string | undefined } | { hit: false } {
  const cached = cache?.get(fullPath);
  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.ctimeMs === stats.ctimeMs &&
    cached.size === stats.size &&
    cached.ino === stats.ino
  ) {
    return { hit: true, content: cached.content };
  }
  return { hit: false };
}

function rememberContent(
  cache: WorkspaceContentCache | undefined,
  fullPath: string,
  stats: Stats,
  content: string | undefined,
): void {
  cache?.set(fullPath, {
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
    ino: stats.ino,
    content,
  });
}

function readTrackedFileContent(
  path: string,
  stats: Stats,
  cache?: WorkspaceContentCache,
): string | undefined {
  if (!shouldTrackTextContent(path, stats.size)) return undefined;
  const cached = cachedContent(cache, path, stats);
  if (cached.hit) return cached.content;
  const content = decodeTrackedContent(readFileSync(path));
  rememberContent(cache, path, stats, content);
  return content;
}

async function readTrackedFileContentAsync(
  path: string,
  stats: Stats,
  cache?: WorkspaceContentCache,
): Promise<string | undefined> {
  if (!shouldTrackTextContent(path, stats.size)) return undefined;
  const cached = cachedContent(cache, path, stats);
  if (cached.hit) return cached.content;
  const content = decodeTrackedContent(await readFile(path));
  rememberContent(cache, path, stats, content);
  return content;
}

/** Whether a directory entry is excluded from display tracking (by name or scratch path). */
function isExcludedDirectory(rootDir: string, childDir: string, name: string): boolean {
  if (shouldIgnoreDirectory(name)) return true;
  const normalizedRel = normalizePath(relative(rootDir, childDir));
  return normalizedRel === SCRATCH_RELATIVE_DIR;
}

/** Drops cache entries for files a complete scan no longer saw (deleted or now excluded). */
function pruneContentCache(cache: WorkspaceContentCache | undefined, seen: Set<string>): void {
  if (!cache) return;
  for (const fullPath of cache.keys()) {
    if (!seen.has(fullPath)) cache.delete(fullPath);
  }
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Runs `work` over `items` with at most `limit` operations in flight, yielding to the event
 * loop every {@link SCAN_OPERATIONS_PER_YIELD} operations.
 */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let sinceYield = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
      if (++sinceYield >= SCAN_OPERATIONS_PER_YIELD) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
  });
  await Promise.all(workers);
}

function splitTextLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

interface DiffOperation {
  kind: "equal" | RunDiffLineKind;
  text: string;
}

// LCS diff has O(n*m) complexity. Skip diffing for large files to avoid
// blocking the poll loop — callers treat null as "too large to diff".
function buildLineDiff(before: string[], after: string[]): DiffOperation[] | null {
  if (before.length + after.length > MAX_DIFFABLE_LINE_COUNT) {
    return null;
  }

  const rows = before.length + 1;
  const cols = after.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let col = after.length - 1; col >= 0; col -= 1) {
      if (before[row] === after[col]) {
        matrix[row]![col] = 1 + matrix[row + 1]![col + 1]!;
      } else {
        matrix[row]![col] = Math.max(matrix[row + 1]![col]!, matrix[row]![col + 1]!);
      }
    }
  }

  const operations: DiffOperation[] = [];
  let row = 0;
  let col = 0;
  while (row < before.length && col < after.length) {
    if (before[row] === after[col]) {
      operations.push({ kind: "equal", text: before[row]! });
      row += 1;
      col += 1;
      continue;
    }

    if (matrix[row + 1]![col]! >= matrix[row]![col + 1]!) {
      operations.push({ kind: "removed", text: before[row]! });
      row += 1;
    } else {
      operations.push({ kind: "added", text: after[col]! });
      col += 1;
    }
  }

  while (row < before.length) {
    operations.push({ kind: "removed", text: before[row]! });
    row += 1;
  }

  while (col < after.length) {
    operations.push({ kind: "added", text: after[col]! });
    col += 1;
  }

  return operations;
}

/** Builds a bounded display diff; it is not an exact recovery checkpoint. */
export function createTextDiffExcerpt(
  beforeContent: string,
  afterContent: string,
): Pick<RunFileActivity, "addedLines" | "removedLines" | "diffLines"> | null {
  const operations = buildLineDiff(splitTextLines(beforeContent), splitTextLines(afterContent));
  if (!operations) {
    return {
      addedLines: afterContent ? splitTextLines(afterContent).length : 0,
      removedLines: beforeContent ? splitTextLines(beforeContent).length : 0,
    };
  }

  const diffOperations = operations.filter(
    (operation) => operation.kind === "added" || operation.kind === "removed",
  );

  const diffLines: RunDiffLine[] = diffOperations
    .slice(0, MAX_DIFF_PREVIEW_LINES)
    .map((operation) => ({
      kind: operation.kind as RunDiffLineKind,
      text: operation.text,
    }));

  const addedLines = operations.filter((operation) => operation.kind === "added").length;
  const removedLines = operations.filter((operation) => operation.kind === "removed").length;

  if (addedLines === 0 && removedLines === 0) {
    return null;
  }

  return {
    addedLines,
    removedLines,
    diffLines,
  };
}

/**
 * Captures bounded display-oriented file metadata/content while skipping excluded workspace
 * trees. Symlinks are never followed. With a `contentCache`, files whose stat is unchanged
 * since they were last read are not read again.
 */
export function captureWorkspaceSnapshot(
  rootDir: string,
  contentCache?: WorkspaceContentCache,
): Map<string, WorkspaceFileSnapshot> {
  const snapshot = new Map<string, WorkspaceFileSnapshot>();
  const seen = new Set<string>();

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Skip directories we can't read (EPERM, locked temp dirs, etc.)
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childDir = join(dir, entry.name);
        if (!isExcludedDirectory(rootDir, childDir, entry.name)) walk(childDir);
        continue;
      }

      if (!entry.isFile()) continue;

      const fullPath = join(dir, entry.name);
      try {
        const stats = statSync(fullPath);
        const path = normalizePath(relative(rootDir, fullPath));
        snapshot.set(path, {
          path,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          content: readTrackedFileContent(fullPath, stats, contentCache),
        });
        seen.add(fullPath);
      } catch {
        // Skip files we can't stat (deleted between readdir and stat, etc.)
      }
    }
  }

  walk(rootDir);
  pruneContentCache(contentCache, seen);
  return snapshot;
}

/**
 * Asynchronous equivalent of {@link captureWorkspaceSnapshot} (same exclusions, symlink and
 * content rules) that keeps the event loop responsive in large workspaces. Filesystem work is
 * bounded to {@link SCAN_CONCURRENCY} operations in flight. Entry order may differ from the
 * synchronous walk; consumers compare snapshots by path.
 */
export async function captureWorkspaceSnapshotAsync(
  rootDir: string,
  contentCache?: WorkspaceContentCache,
): Promise<Map<string, WorkspaceFileSnapshot>> {
  const snapshot = new Map<string, WorkspaceFileSnapshot>();
  const seen = new Set<string>();
  let directories = [rootDir];
  while (directories.length > 0) {
    const files: string[] = [];
    const nextDirectories: string[] = [];
    await forEachLimited(directories, SCAN_CONCURRENCY, async (dir) => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // Same as the synchronous walk: unreadable directories are skipped.
      }
      for (const entry of entries) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!isExcludedDirectory(rootDir, child, entry.name)) nextDirectories.push(child);
        } else if (entry.isFile()) {
          files.push(child);
        }
      }
    });
    await forEachLimited(files, SCAN_CONCURRENCY, async (fullPath) => {
      try {
        const stats = await stat(fullPath);
        const path = normalizePath(relative(rootDir, fullPath));
        snapshot.set(path, {
          path,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          content: await readTrackedFileContentAsync(fullPath, stats, contentCache),
        });
        seen.add(fullPath);
      } catch {
        // Deleted or unreadable between listing and stat/read.
      }
    });
    directories = nextDirectories;
  }
  pruneContentCache(contentCache, seen);
  return snapshot;
}

/** Classifies created/modified/deleted files between display snapshots. */
export function diffWorkspaceSnapshots(
  previous: Map<string, WorkspaceFileSnapshot>,
  next: Map<string, WorkspaceFileSnapshot>,
  detectedAt = Date.now(),
): RunFileActivity[] {
  const activity: RunFileActivity[] = [];
  const allPaths = new Set([...previous.keys(), ...next.keys()]);

  for (const path of [...allPaths].sort()) {
    const before = previous.get(path);
    const after = next.get(path);

    if (!before && after) {
      const diff = createTextDiffExcerpt("", after.content ?? "");
      activity.push({
        path,
        operation: "created",
        detectedAt,
        addedLines: diff?.addedLines,
        removedLines: diff?.removedLines,
        diffLines: diff?.diffLines,
      });
      continue;
    }

    if (before && !after) {
      const diff = createTextDiffExcerpt(before.content ?? "", "");
      activity.push({
        path,
        operation: "deleted",
        detectedAt,
        addedLines: diff?.addedLines,
        removedLines: diff?.removedLines,
        diffLines: diff?.diffLines,
      });
      continue;
    }

    if (!before || !after) continue;

    const metadataChanged = before.mtimeMs !== after.mtimeMs || before.size !== after.size;
    const contentChanged = before.content !== after.content;
    if (!metadataChanged && !contentChanged) continue;

    const diff =
      before.content !== undefined && after.content !== undefined
        ? createTextDiffExcerpt(before.content, after.content)
        : undefined;

    activity.push({
      path,
      operation: "modified",
      detectedAt,
      addedLines: diff?.addedLines,
      removedLines: diff?.removedLines,
      diffLines: diff?.diffLines,
    });
  }

  return activity;
}

/** Aggregates file counts and paths for a completed run; no changes yield undefined. */
export function summarizeRunActivity(activity: RunFileActivity[]): RunActivitySummary | undefined {
  if (activity.length === 0) return undefined;

  let created = 0;
  let modified = 0;
  let deleted = 0;
  for (const item of activity) {
    if (item.operation === "created") created += 1;
    if (item.operation === "modified") modified += 1;
    if (item.operation === "deleted") deleted += 1;
  }

  return {
    created,
    modified,
    deleted,
    totalActivityCount: activity.length,
    recent: activity.slice(-MAX_SUMMARY_ACTIVITY_ITEMS),
  };
}

/**
 * Owns a run's baseline and bounded polling for display activity; stop/finalization remains with
 * the caller.
 *
 * Polls are asynchronous and never overlap: the next poll is scheduled only after the previous
 * one finished, at the configured interval or, for slow scans, twice the scan duration (capped
 * at {@link MAX_ADAPTIVE_POLL_INTERVAL_MS}). A poll that finishes after `stop()` reports nothing.
 */
export function createWorkspaceActivityTracker(
  options: WorkspaceActivityTrackerOptions,
): WorkspaceActivityTracker {
  let stopped = false;
  const contentCache = options.contentCache ?? createWorkspaceContentCache();
  let previous = options.initialSnapshot ?? captureWorkspaceSnapshot(options.rootDir, contentCache);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(poll, delayMs);
    timer.unref?.();
  };

  const poll = async () => {
    if (stopped) return;
    const startedAt = performance.now();
    let scanMs = 0;
    try {
      const next = await captureWorkspaceSnapshotAsync(options.rootDir, contentCache);
      scanMs = performance.now() - startedAt;
      if (stopped) return;
      const activity = diffWorkspaceSnapshots(previous, next);
      previous = next;
      if (activity.length > 0) options.onActivity(activity);
    } catch {
      // Display tracking is best effort; the caller's final poll still runs.
    } finally {
      const backoff = Math.min(MAX_ADAPTIVE_POLL_INTERVAL_MS, scanMs * 2);
      schedule(Math.max(pollIntervalMs, backoff));
    }
  };

  schedule(pollIntervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
