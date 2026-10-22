import { realpathSync } from "node:fs";
import { parse, resolve, win32 } from "path";

/** Recognizes drive-rooted or UNC paths independently of the host platform. */
export function isWindowsStylePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

/**
 * Normalizes a root without filesystem access, preserving drive roots and falling back to cwd
 * for control-character input.
 */
export function normalizeWorkspaceRoot(pathValue: string): string {
  let candidate = pathValue.trim();
  // Guard against obviously unsafe values that could break command-line parsing.
  if (candidate.includes("\n") || candidate.includes("\r") || candidate.includes("\0")) {
    candidate = process.cwd();
  }

  if (isWindowsStylePath(candidate)) {
    const resolved = win32.normalize(candidate);
    const { root } = win32.parse(resolved);
    let normalized = resolved;
    while (normalized.length > root.length && /[\\/]+$/.test(normalized)) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  const resolved = resolve(candidate);
  const { root } = parse(resolved);

  let normalized = resolved;
  while (normalized.length > root.length && /[\\/]+$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/** Uses CODEX_WORKSPACE_ROOT when supplied, otherwise the current working directory. */
export function resolveWorkspaceRoot(): string {
  const candidates = [process.env.CODEX_WORKSPACE_ROOT, process.cwd()];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return canonicalWorkspaceRoot(value);
  }

  return normalizeWorkspaceRoot(process.cwd());
}

/**
 * Compares normalized folder spellings; does not resolve filesystem symlinks or case aliases.
 */
export function sameFolder(left: string, right: string): boolean {
  return canonicalWorkspaceRoot(left) === canonicalWorkspaceRoot(right);
}

/** Resolve existing aliases for comparisons without changing legacy storage keys. */
export function canonicalWorkspaceRoot(value: string): string {
  const normalized = normalizeWorkspaceRoot(value);
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}
