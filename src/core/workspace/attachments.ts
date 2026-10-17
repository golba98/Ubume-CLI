/**
 * Imports external attachments into app data, identifies images, and rewrites prompts to safe
 * workspace-visible paths.
 */

import { existsSync } from "node:fs";
import { access, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSkippedExternalDependencyPath, normalizeDiagnosticPath } from "./workspaceGuard.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".svg",
]);

/**
 * Recognizes supported image extensions case-insensitively; it does not inspect file contents.
 */
export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a collision-free attachment name without reserving or creating it; callers perform the
 * copy/write.
 */
export async function resolveAttachmentDestPath(
  srcPath: string,
  attachmentsDir: string,
): Promise<string> {
  const ext = path.extname(srcPath);
  const base = path.basename(srcPath, ext);
  let dest = path.join(attachmentsDir, `${base}${ext}`);
  let counter = 1;
  while (await fileExists(dest)) {
    dest = path.join(attachmentsDir, `${base}-${counter}${ext}`);
    counter++;
  }
  return dest;
}

/**
 * Copies an eligible external file to attachment storage. Missing/dependency paths return null;
 * destination I/O failures reject.
 */
export async function importExternalFile(
  srcPath: string,
  attachmentsDir: string,
): Promise<string | null> {
  const normalized = normalizeDiagnosticPath(srcPath);

  if (isSkippedExternalDependencyPath(normalized)) {
    return null;
  }

  try {
    if (!existsSync(normalized)) {
      return null;
    }
    const s = await stat(normalized);
    if (!s.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  await mkdir(attachmentsDir, { recursive: true });
  const destPath = await resolveAttachmentDestPath(normalized, attachmentsDir);
  await copyFile(normalized, destPath);
  return destPath;
}

/**
 * Persists supplied clipboard PNG bytes under a private attachment filename and returns its
 * path.
 */
export async function saveClipboardImage(
  data: Uint8Array,
  attachmentsDir: string,
): Promise<string> {
  await mkdir(attachmentsDir, { recursive: true });
  const destPath = await resolveAttachmentDestPath("clipboard-image.png", attachmentsDir);
  await writeFile(destPath, data, { mode: 0o600 });
  return destPath;
}

/** Replaces imported path references, quoting replacement paths containing whitespace. */
export function rewritePromptWithImportedPaths(
  prompt: string,
  replacements: Array<{ rawPath: string; replacementPath: string }>,
): string {
  let result = prompt;
  for (const { rawPath, replacementPath } of replacements) {
    const needsQuotes = /\s/.test(replacementPath);
    const quotedReplacement = needsQuotes ? `"${replacementPath}"` : replacementPath;
    // Replace quoted forms first so the unquoted pass doesn't double-replace
    result = result.split(`"${rawPath}"`).join(quotedReplacement);
    result = result.split(`'${rawPath}'`).join(quotedReplacement);
    // Replace any remaining unquoted occurrences
    result = result.split(rawPath).join(quotedReplacement);
  }
  return result;
}
