import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let atomicSequence = 0;

/**
 * Writes text content to a destination file atomically.
 *
 * Ensures the target directory exists, writes to a temporary file,
 * and replaces the destination using renameSync to guarantee atomic updates
 * and prevent readers from observing partially written files.
 *
 * @param filePath - The absolute path of the destination file.
 * @param content - The UTF-8 string content to write.
 */
export function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const seq = ++atomicSequence;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${seq}.tmp`;
  let created = false;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    created = true;
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (created) rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup of temporary file on failure.
    }
    throw error;
  }
}

/** Publishes validated migration content atomically without replacing an existing destination. */
export function writeTextFileIfAbsent(filePath: string, content: string): boolean {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${++atomicSequence}.tmp`;
  let created = false;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    try {
      linkSync(tmpPath, filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    if (created) rmSync(tmpPath, { force: true });
  }
}

/**
 * Serializes data to formatted JSON and writes it to a destination file atomically.
 *
 * @param filePath - The absolute path of the destination file.
 * @param data - The JavaScript value to serialize.
 * @param indent - JSON indentation space count (defaults to 2).
 */
export function writeJsonFileAtomic(filePath: string, data: unknown, indent = 2): void {
  const serialized = JSON.stringify(data, null, indent);
  writeTextFileAtomic(filePath, serialized);
}
