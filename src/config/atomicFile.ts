import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  mkdirSync(dir, { recursive: true });

  const seq = ++atomicSequence;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${seq}.tmp`;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup of temporary file on failure.
    }
    throw error;
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
