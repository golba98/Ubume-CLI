/**
 * Normalizes diagnostic paths, blocks or explains paths and commands outside the active
 * workspace, and classifies destructive shell commands.
 */

import { posix, win32 } from "path";
import { normalizeWorkspaceRoot } from "./workspaceRoot.js";

type PathStyle = "windows" | "posix";

/** Removes diagnostic line/column suffixes while preserving a Windows drive prefix. */
export function normalizeDiagnosticPath(filePath: string): string {
  let pathPart = filePath;
  let drivePrefix = "";

  if (/^[A-Za-z]:[\\/]/.test(filePath)) {
    drivePrefix = filePath.slice(0, 2);
    pathPart = filePath.slice(2);
  }

  // Robustly strip trailing colon-separated line/column numbers.
  // Handles:
  //   path/to/file.rs:109:12
  //   path/to/file.rs:109
  //   C:\path\to\file.rs:12:5
  const diagnosticSuffixRegex = /:(\d+)(?::(\d+))?$/;
  pathPart = pathPart.replace(diagnosticSuffixRegex, "");

  return drivePrefix + pathPart;
}

interface WorkspacePathViolation {
  rawPath: string;
  normalizedPath: string;
}

const QUOTED_ABSOLUTE_PATH_PATTERN =
  /(["'`])((?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/][^\\/\r\n]+[\\/]|\/|~\/)[^"'`\r\n]+?)\1/g;
const QUOTED_RELATIVE_PATH_PATTERN = /(["'`])((?:\.\.?[\\/])[^"'`\r\n]+?)\1/g;
const WINDOWS_DRIVE_PATH_PATTERN = /(?:^|[\s([{\],;=])([A-Za-z]:[\\/][^\s"'`<>|]+)/g;
const WINDOWS_UNC_PATH_PATTERN =
  /(?:^|[\s([{\],;=])(\\\\[^\\/\s"'`<>|]+[\\/][^\\/\s"'`<>|]+(?:[\\/][^\s"'`<>|]+)*)/g;
const POSIX_ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s([{\],;=])((?:\/|~\/)(?:[^\/\s"'`<>|]+\/)+[^\s"'`<>|]+)/g;
const RELATIVE_PATH_PATTERN =
  /(?:^|[\s([{\],;=])((?:\.\.?[\\/])(?:[^\s"'`<>|]+(?:[\\/][^\s"'`<>|]+)*))/g;
const RUST_RELATIVE_DIAGNOSTIC_PATH_PATTERN =
  /(?:^|[\s([{\],;=])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.rs(?::\d+(?::\d+)?)?)/g;
const TRAILING_PUNCTUATION_PATTERN = /[),.;:\]}]+$/;
const DIRECTORY_NAVIGATION_PATTERN = /(?:^|[;&\n]|&&|\|\|)\s*(cd|pushd|set-location)\b/i;
const CARGO_REGISTRY_INDEX_DIRECTORY_PATTERN = /^index\.crates\.io-[A-Za-z0-9-]+$/;

function detectPathStyle(pathValue: string): PathStyle | null {
  if (/^[A-Za-z]:[\\/]/.test(pathValue) || /^\\\\[^\\\/]+[\\\/][^\\\/]+/.test(pathValue)) {
    return "windows";
  }

  if (pathValue.startsWith("/") || pathValue.startsWith("~/")) {
    return "posix";
  }

  return null;
}

function getPathApi(style: PathStyle) {
  return style === "windows" ? win32 : posix;
}

function stripWrappingQuotes(text: string): string {
  return text.replace(/^["'`]|["'`]$/g, "");
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(TRAILING_PUNCTUATION_PATTERN, "");
}

function isExplicitRelativePath(pathValue: string): boolean {
  return /^(?:\.\.?[\\/])/.test(pathValue);
}

function hasRustRelativeDiagnosticShape(pathValue: string): boolean {
  return /^(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.rs(?::\d+(?::\d+)?)?$/.test(pathValue);
}

function normalizedPathSegments(pathValue: string): string[] {
  return normalizeDiagnosticPath(pathValue)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

/**
 * Recognizes known dependency/cache paths that should not be imported into the active workspace.
 */
export function isSkippedExternalDependencyPath(pathValue: string): boolean {
  const segments = normalizedPathSegments(pathValue);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const next = segments[i + 1];
    const afterNext = segments[i + 2];

    if (segment === ".cargo" && next === "registry") return true;
    if (segment === ".cargo" && next === "git" && afterNext === "checkouts") return true;
    if (
      segment === "target" ||
      segment === "node_modules" ||
      segment === ".pnpm-store" ||
      segment === ".npm" ||
      segment === ".cache"
    ) {
      return true;
    }
  }

  return false;
}

function normalizeAbsolutePath(pathValue: string, style: PathStyle): string {
  const pathApi = getPathApi(style);
  const resolved = pathApi.normalize(pathApi.resolve(pathValue));
  const { root } = pathApi.parse(resolved);

  let normalized = resolved;
  while (normalized.length > root.length && /[\\/]+$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function normalizeComparisonPath(pathValue: string, style: PathStyle): string {
  const normalized = normalizeAbsolutePath(pathValue, style);
  return style === "windows" ? normalized.toLowerCase() : normalized;
}

function normalizeAllowedRoots(
  workspaceRoot: string,
  allowedRoots: readonly string[] = [],
): string[] {
  const normalizedWorkspace = normalizeWorkspaceRoot(workspaceRoot);
  const roots = [normalizedWorkspace, ...allowedRoots];
  const seen = new Set<string>();
  const normalizedRoots: string[] = [];

  for (const root of roots) {
    const style = detectPathStyle(root);
    if (!style) continue;
    const normalizedRoot = normalizeAbsolutePath(root, style);
    const comparisonKey = normalizeComparisonPath(normalizedRoot, style);
    if (seen.has(comparisonKey)) continue;
    seen.add(comparisonKey);
    normalizedRoots.push(normalizedRoot);
  }

  return normalizedRoots;
}

/**
 * Resolves diagnostic path text relative to the active workspace using the established platform
 * rules.
 */
export function resolveWorkspacePath(pathValue: string, workspaceRoot: string): string {
  const trimmed = stripWrappingQuotes(pathValue.trim());
  const workspaceStyle = detectPathStyle(workspaceRoot) ?? "windows";
  const explicitStyle = detectPathStyle(trimmed);

  if (explicitStyle) {
    return normalizeAbsolutePath(trimmed, explicitStyle);
  }

  const pathApi = getPathApi(workspaceStyle);
  // Normalize separators in relative paths to match the workspace style so
  // that Windows-style backslashes work correctly on POSIX systems and vice versa.
  const separatorNormalized =
    workspaceStyle === "windows" ? trimmed.replace(/\//g, "\\") : trimmed.replace(/\\/g, "/");
  return normalizeAbsolutePath(pathApi.resolve(workspaceRoot, separatorNormalized), workspaceStyle);
}

/**
 * Checks lexical containment against the normalized workspace; file access requiring symlink
 * protection uses containedFile.
 */
export function isPathInsideWorkspace(pathValue: string, workspaceRoot: string): boolean {
  const normalizedWorkspace = normalizeWorkspaceRoot(workspaceRoot);
  return isPathInsideAllowedRoots(pathValue, normalizedWorkspace);
}

/**
 * Checks the workspace and explicitly permitted writable roots without changing filesystem
 * state.
 */
export function isPathInsideAllowedRoots(
  pathValue: string,
  workspaceRoot: string,
  allowedRoots: readonly string[] = [],
): boolean {
  const normalizedWorkspace = normalizeWorkspaceRoot(workspaceRoot);
  const normalizedRoots = normalizeAllowedRoots(normalizedWorkspace, allowedRoots);
  const resolvedTarget = resolveWorkspacePath(pathValue, normalizedWorkspace);
  const targetStyle = detectPathStyle(resolvedTarget);

  if (!targetStyle) {
    return false;
  }

  for (const root of normalizedRoots) {
    const rootStyle = detectPathStyle(root);
    if (!rootStyle || rootStyle !== targetStyle) {
      continue;
    }

    const pathApi = getPathApi(rootStyle);
    const rootForComparison = normalizeComparisonPath(root, rootStyle);
    const targetForComparison = normalizeComparisonPath(resolvedTarget, rootStyle);
    const relativePath = pathApi.relative(rootForComparison, targetForComparison);

    if (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Finds explicit path-like references for the workspace guard; this is a heuristic, not a shell
 * parser.
 */
export function extractExplicitPathReferences(text: string): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();

  const addMatch = (candidate: string) => {
    const cleaned = stripTrailingPunctuation(stripWrappingQuotes(candidate.trim()));
    if (
      !cleaned ||
      (!detectPathStyle(cleaned) &&
        !isExplicitRelativePath(cleaned) &&
        !hasRustRelativeDiagnosticShape(cleaned))
    ) {
      return;
    }

    const comparisonKey = detectPathStyle(cleaned) === "posix" ? cleaned : cleaned.toLowerCase();
    if (seen.has(comparisonKey)) {
      return;
    }

    seen.add(comparisonKey);
    matches.push(cleaned);
  };

  for (const pattern of [
    QUOTED_ABSOLUTE_PATH_PATTERN,
    QUOTED_RELATIVE_PATH_PATTERN,
    WINDOWS_DRIVE_PATH_PATTERN,
    WINDOWS_UNC_PATH_PATTERN,
    POSIX_ABSOLUTE_PATH_PATTERN,
    RELATIVE_PATH_PATTERN,
    RUST_RELATIVE_DIAGNOSTIC_PATH_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      addMatch(match[2] ?? match[1] ?? "");
      match = pattern.exec(text);
    }
  }

  return matches;
}

/** Formats a dependency/cache diagnostic path without importing it. */
export function formatSkippedDependencyPath(pathValue: string): string {
  const parts = pathValue.replace(/\\/g, "/").split("/");
  const registryIndex = parts.indexOf("registry");
  if (
    registryIndex !== -1 &&
    parts[registryIndex + 1] === "src" &&
    CARGO_REGISTRY_INDEX_DIRECTORY_PATTERN.test(parts[registryIndex + 2] ?? "")
  ) {
    return parts.slice(registryIndex + 3).join("/");
  }
  const gitIndex = parts.indexOf("git");
  if (gitIndex !== -1 && parts[gitIndex + 1] === "checkouts") {
    return parts.slice(gitIndex + 2).join("/");
  }
  return parts[parts.length - 1] ?? pathValue;
}

/**
 * Returns explicit references outside the workspace, excluding recognized dependency
 * diagnostics.
 */
export function findOutsideWorkspacePaths(
  text: string,
  workspaceRoot: string,
  allowedRoots: readonly string[] = [],
): { violations: WorkspacePathViolation[]; skippedExternalPaths: string[] } {
  const violations: WorkspacePathViolation[] = [];
  const skippedExternalPaths: string[] = [];
  const seen = new Set<string>();
  const workspaceStyle = detectPathStyle(workspaceRoot) ?? "windows";

  for (const rawPath of extractExplicitPathReferences(text)) {
    const cleanPath = normalizeDiagnosticPath(rawPath);
    if (isSkippedExternalDependencyPath(cleanPath)) {
      skippedExternalPaths.push(cleanPath);
      continue;
    }

    if (isPathInsideAllowedRoots(cleanPath, workspaceRoot, allowedRoots)) {
      continue;
    }

    const explicitStyle = detectPathStyle(cleanPath) ?? workspaceStyle;
    const normalizedPath = detectPathStyle(cleanPath)
      ? normalizeAbsolutePath(cleanPath, explicitStyle)
      : resolveWorkspacePath(cleanPath, workspaceRoot);
    if (isSkippedExternalDependencyPath(normalizedPath)) {
      skippedExternalPaths.push(normalizedPath);
      continue;
    }

    const comparisonKey =
      explicitStyle === "windows" ? normalizedPath.toLowerCase() : normalizedPath;

    if (seen.has(comparisonKey)) {
      continue;
    }

    seen.add(comparisonKey);
    violations.push({ rawPath, normalizedPath });
  }

  return { violations, skippedExternalPaths };
}

/** Detects directory-changing shell commands covered by the workspace guard. */
export function containsDirectoryNavigationCommand(command: string): boolean {
  return DIRECTORY_NAVIGATION_PATTERN.test(command);
}

function formatOutsidePathBlockMessage(
  heading: string,
  workspaceRoot: string,
  violations: WorkspacePathViolation[],
  allowedRoots: readonly string[] = [],
): string {
  const normalizedWorkspace = normalizeWorkspaceRoot(workspaceRoot);
  const normalizedAllowedRoots = normalizeAllowedRoots(normalizedWorkspace, allowedRoots).filter(
    (root) =>
      normalizeComparisonPath(root, detectPathStyle(root) ?? "windows") !==
      normalizeComparisonPath(
        normalizedWorkspace,
        detectPathStyle(normalizedWorkspace) ?? "windows",
      ),
  );
  const paths = violations.map((item) => `  - ${item.normalizedPath}`).join("\n");
  const extraRootsBlock =
    normalizedAllowedRoots.length > 0
      ? ["Allowed writable roots:", ...normalizedAllowedRoots.map((root) => `  - ${root}`)].join(
          "\n",
        )
      : null;

  return [
    heading,
    `Locked workspace: ${normalizedWorkspace}`,
    extraRootsBlock,
    "Outside path references:",
    paths,
    "Use relative paths inside this workspace, or relaunch the CLI from the folder you want to edit.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Explains explicit outside-workspace prompt references, or returns null when no guard applies.
 */
export function getPromptWorkspaceGuardMessage(
  prompt: string,
  workspaceRoot: string,
  allowedRoots: readonly string[] = [],
): string | null {
  const { violations } = findOutsideWorkspacePaths(prompt, workspaceRoot, allowedRoots);
  if (violations.length === 0) {
    return null;
  }

  return formatOutsidePathBlockMessage(
    "Run blocked: this session can only work inside the locked workspace.",
    workspaceRoot,
    violations,
    allowedRoots,
  );
}

/**
 * Explains blocked directory navigation/outside-root command references without executing shell
 * text.
 */
export function getShellWorkspaceGuardMessage(
  command: string,
  workspaceRoot: string,
  allowedRoots: readonly string[] = [],
): string | null {
  if (containsDirectoryNavigationCommand(command)) {
    return [
      "Shell command blocked: this session is locked to the launch folder.",
      `Locked workspace: ${normalizeWorkspaceRoot(workspaceRoot)}`,
      "Directory-changing commands like cd, Set-Location, and pushd are disabled here.",
    ].join("\n");
  }

  const { violations } = findOutsideWorkspacePaths(command, workspaceRoot, allowedRoots);
  if (violations.length === 0) {
    return null;
  }

  return formatOutsidePathBlockMessage(
    "Shell command blocked: it references paths outside the locked workspace.",
    workspaceRoot,
    violations,
    allowedRoots,
  );
}

const DANGEROUS_SHELL_PATTERNS: RegExp[] = [
  /\brm\s+-[^\n;|&]*r[f]?\b/i,
  /\bsudo\b/i,
  /\bdoas\b/i,
  /\bdd\s+.*\bof=/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
  />\s*\/dev\/(?:sd|hd|nvme|disk)/i,
];

/** Classifies destructive shell patterns; the execution-policy caller owns rejection/approval. */
export function isDangerousShellCommand(command: string): boolean {
  return DANGEROUS_SHELL_PATTERNS.some((pattern) => pattern.test(command));
}
