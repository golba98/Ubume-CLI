/**
 * Exact file snapshots and journaled restore operations, separate from display-only activity
 * tracking. Conflicting edits and incomplete coverage block restoration; interrupted journals
 * must be recovered before new workspace execution.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { resolveUbumeWorkspaceDataDir } from "./appData.js";
import { containedFile, FILE_TEXT_LIMIT, listWorkspaceFiles } from "./workspaceFiles.js";

export interface CheckpointFile {
  hash: string;
  mode: number;
}
export interface FileBoundary {
  files: Record<string, CheckpointFile>;
  complete: boolean;
  skipped: string[];
}
export interface FileCheckpoint {
  id: string;
  turnId: number;
  messageCount: number;
  prompt: string;
  before: FileBoundary;
  after?: FileBoundary;
  recoveryInvalidated?: boolean;
}
export interface RestoreOperation {
  path: string;
  current?: CheckpointFile;
  target?: CheckpointFile;
}
const BOUNDARY_LIMIT = 64 * FILE_TEXT_LIMIT;
const STORE_LIMIT = 256 * FILE_TEXT_LIMIT;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a?: CheckpointFile, b?: CheckpointFile) => a?.hash === b?.hash && a?.mode === b?.mode;
const fileAt = (boundary: FileBoundary, path: string): CheckpointFile | undefined =>
  Object.hasOwn(boundary.files, path) ? boundary.files[path] : undefined;

/** Exact byte snapshots are distinct from the display-only activity tracker. */
export class CheckpointStore {
  readonly directory: string;
  constructor(
    readonly workspace: string,
    conversationId: string,
    dataRoot?: string,
  ) {
    if (!/^chat_[A-Za-z0-9-]+$/.test(conversationId))
      throw new Error("Invalid checkpoint conversation.");
    this.directory = join(
      dataRoot ?? resolveUbumeWorkspaceDataDir(workspace),
      "checkpoints",
      conversationId,
    );
  }
  private blob(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid checkpoint hash.");
    return join(this.directory, "blobs", hash);
  }
  private async bytes(file: CheckpointFile): Promise<Buffer> {
    const bytes = await readFile(this.blob(file.hash));
    if (digest(bytes) !== file.hash) throw new Error("Checkpoint content is corrupt.");
    return bytes;
  }
  private async saveBytes(bytes: Buffer): Promise<string> {
    const hash = digest(bytes);
    await mkdir(join(this.directory, "blobs"), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.blob(hash), bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return hash;
  }
  /**
   * Stores exact eligible file bytes/modes within snapshot/store limits; skipped paths and
   * incomplete coverage remain explicit.
   */
  async capture(): Promise<FileBoundary> {
    const boundary: FileBoundary = { files: Object.create(null), complete: true, skipped: [] };
    let size = 0;
    let stored = 0;
    try {
      for (const entry of await readdir(join(this.directory, "blobs")))
        stored += (await lstat(join(this.directory, "blobs", entry))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const path of await listWorkspaceFiles(this.workspace)) {
      try {
        const absolute = await containedFile(this.workspace, path);
        const stat = await lstat(absolute);
        if (!stat.isFile() || stat.size > FILE_TEXT_LIMIT) {
          boundary.skipped.push(path);
          continue;
        }
        const bytes = await readFile(absolute);
        if (bytes.length > FILE_TEXT_LIMIT || bytes.includes(0)) {
          boundary.skipped.push(path);
          continue;
        }
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          boundary.skipped.push(path);
          continue;
        }
        size += bytes.length;
        const hash = digest(bytes);
        let exists = false;
        try {
          await lstat(this.blob(hash));
          exists = true;
        } catch {
          /* New blob. */
        }
        if (size > BOUNDARY_LIMIT || (!exists && stored + bytes.length > STORE_LIMIT)) {
          boundary.complete = false;
          boundary.skipped.push(path);
          continue;
        }
        await this.saveBytes(bytes);
        if (!exists) stored += bytes.length;
        boundary.files[path] = { hash, mode: stat.mode & 0o777 };
      } catch (error) {
        // Git still lists tracked deletions. Absence is a valid checkpoint state.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        boundary.complete = false;
        boundary.skipped.push(path);
      }
    }
    return boundary;
  }
  /**
   * Builds a display diff from verified blobs with bounded diff computation; does not change
   * workspace files.
   */
  async patch(before: FileBoundary, after: FileBoundary, path: string): Promise<string> {
    const a = fileAt(before, path);
    const b = fileAt(after, path);
    const [left, right] = await Promise.all([
      a ? this.bytes(a) : Buffer.alloc(0),
      b ? this.bytes(b) : Buffer.alloc(0),
    ]);
    // jsdiff's timeout prevents pathological inputs from blocking the UI indefinitely.
    return new Promise<string>((resolve) => {
      createTwoFilesPatch(
        path,
        path,
        left.toString("utf8"),
        right.toString("utf8"),
        "before",
        "after",
        {
          context: 3,
          timeout: 1000,
          callback: (patch) =>
            resolve(patch ?? "Diff too complex to display within the time limit."),
        },
      );
    });
  }
  /**
   * Returns paths whose captured byte hash or permission mode changed.
   */
  changed(before: FileBoundary, after: FileBoundary): string[] {
    return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
      .filter((path) => !same(fileAt(before, path), fileAt(after, path)))
      .sort();
  }
  /**
   * Builds and verifies restore operations, refusing incomplete history, missing blobs and
   * conflicting later edits.
   */
  async preview(checkpoints: readonly FileCheckpoint[]): Promise<RestoreOperation[]> {
    if (checkpoints.some((point) => point.recoveryInvalidated))
      throw new Error(
        "File recovery is unavailable: a later restoration superseded this file history.",
      );
    if (
      !checkpoints.length ||
      checkpoints.some((point) => !point.before.complete || !point.after?.complete)
    )
      throw new Error("File recovery is unavailable: a required checkpoint is incomplete.");
    const targets = new Map<string, RestoreOperation>();
    for (const point of checkpoints) {
      const after = point.after!;
      for (const path of this.changed(point.before, after)) {
        if (point.before.skipped.includes(path) || after.skipped.includes(path))
          throw new Error(`File recovery has incomplete coverage for ${path}.`);
        const previous = targets.get(path);
        if (previous && !same(previous.current, fileAt(point.before, path)))
          throw new Error(`Manual edits between recorded turns conflict: ${path}`);
        targets.set(path, {
          path,
          target: previous ? previous.target : fileAt(point.before, path),
          current: fileAt(after, path),
        });
      }
      // Detect manual changes even when a later run did not itself touch the file.
      for (const operation of targets.values()) {
        if (!same(operation.current, fileAt(after, operation.path)))
          throw new Error(`Unrecorded edits conflict: ${operation.path}`);
      }
    }
    const operations = [...targets.values()].filter((op) => !same(op.target, op.current));
    await this.verify(operations);
    for (const op of operations) {
      if (op.target) await this.bytes(op.target);
    }
    return operations;
  }
  private async current(path: string): Promise<CheckpointFile | undefined> {
    const absolute = await containedFile(this.workspace, path);
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile()) throw new Error(`Unsupported restore target: ${path}`);
      return { hash: digest(await readFile(absolute)), mode: stat.mode & 0o777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async verify(operations: readonly RestoreOperation[]): Promise<void> {
    for (const op of operations) {
      if (!same(await this.current(op.path), op.current))
        throw new Error(`Later edits conflict with recovery: ${op.path}`);
    }
  }
  private async apply(path: string, target?: CheckpointFile): Promise<void> {
    const absolute = await containedFile(this.workspace, path);
    if (!target) {
      try {
        await unlink(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    const bytes = await this.bytes(target);
    await mkdir(dirname(absolute), { recursive: true });
    const temp = `${absolute}.ubume-restore-${randomUUID()}`;
    try {
      await writeFile(temp, bytes, { flag: "wx", mode: target.mode });
      await rename(temp, absolute);
      await chmod(absolute, target.mode);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  /**
   * Journals verified operations before changing files. Failure attempts rollback; an
   * unresolved journal blocks later workspace execution.
   */
  async restore(operations: readonly RestoreOperation[]): Promise<void> {
    await this.verify(operations);
    for (const op of operations) {
      if (op.current) await this.bytes(op.current);
      if (op.target) await this.bytes(op.target);
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const journal = join(this.directory, "restore.json");
    await writeFile(`${journal}.tmp`, JSON.stringify({ version: 1, operations }), { mode: 0o600 });
    await rename(`${journal}.tmp`, journal);
    try {
      for (const op of operations) {
        await this.verify([op]);
        await this.apply(op.path, op.target);
      }
      await unlink(journal);
    } catch (error) {
      await this.recover();
      throw error;
    }
  }
  /**
   * Rolls an interrupted journal back after checking every current path; conflicting later
   * edits throw without overwriting them.
   */
  async recover(): Promise<boolean> {
    const journal = join(this.directory, "restore.json");
    let value: { version: number; operations: RestoreOperation[] };
    try {
      value = JSON.parse(await readFile(journal, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (value.version !== 1 || !Array.isArray(value.operations))
      throw new Error("Invalid recovery journal.");
    // Check the entire journal before changing any file during crash recovery.
    for (const op of value.operations) {
      if (!op || typeof op.path !== "string") throw new Error("Invalid recovery operation.");
      const current = await this.current(op.path);
      if (!same(current, op.current) && !same(current, op.target))
        throw new Error(`Recovery journal conflicts with later edits: ${op.path}`);
      if (op.current) await this.bytes(op.current);
    }
    for (const op of [...value.operations].reverse()) {
      const current = await this.current(op.path);
      if (same(current, op.current)) continue;
      if (!same(current, op.target))
        throw new Error(`Recovery journal conflicts with later edits: ${op.path}`);
      await this.apply(op.path, op.current);
    }
    await unlink(journal);
    return true;
  }
}

/** A crashed file transaction must be resolved before any subsequent workspace write. */
export async function pendingFileRecoveries(workspace: string): Promise<string[]> {
  const root = join(resolveUbumeWorkspaceDataDir(workspace, { readOnly: true }), "checkpoints");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const pending: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^chat_[A-Za-z0-9-]+$/.test(entry.name)) continue;
    try {
      await lstat(join(root, entry.name, "restore.json"));
      pending.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return pending.sort();
}
/**
 * Blocks workspace execution when another conversation has an interrupted restore journal; the
 * recovering conversation may exempt itself.
 */
export async function assertFileRecoveryReady(
  workspace: string,
  recoveringSession?: string,
): Promise<void> {
  const pending = (await pendingFileRecoveries(workspace)).filter((id) => id !== recoveringSession);
  if (pending.length)
    throw new Error(
      `Pending file recovery blocks workspace execution. Resume ${pending.join(", ")} to recover the interrupted transaction first.`,
    );
}
