/**
 * Repository root for scripts, resolved from this module's own location so it is independent
 * of the caller's working directory and of how deep the calling script sits under `scripts/`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository checkout (the directory holding `package.json`). */
export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Joins path segments onto the repository root. */
export function repoPath(...segments) {
  return join(REPO_ROOT, ...segments);
}
