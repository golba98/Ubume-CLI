/**
 * Normalizes diagnostic paths, blocks or explains paths and commands outside the active
 * workspace (strict for shell commands, context-classified for prompt text), and classifies
 * destructive shell commands.
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

interface PathReferenceMatch {
  path: string;
  start: number;
  end: number;
}

function pathReferenceKey(pathValue: string): string {
  return detectPathStyle(pathValue) === "posix" ? pathValue : pathValue.toLowerCase();
}

/** Collects every path-like occurrence with its offsets so callers can inspect its context. */
function collectPathReferenceMatches(text: string): PathReferenceMatch[] {
  const matches: PathReferenceMatch[] = [];

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
      const candidate = match[2] ?? match[1] ?? "";
      const cleaned = stripTrailingPunctuation(stripWrappingQuotes(candidate.trim()));
      if (
        cleaned &&
        (detectPathStyle(cleaned) ||
          isExplicitRelativePath(cleaned) ||
          hasRustRelativeDiagnosticShape(cleaned))
      ) {
        // Offsets cover the cleaned path only, so trailing punctuation such as `;` stays a
        // clause boundary for the context checks.
        const start =
          match.index +
          Math.max(match[0].indexOf(candidate), 0) +
          Math.max(candidate.indexOf(cleaned), 0);
        matches.push({ path: cleaned, start, end: start + cleaned.length });
      }
      match = pattern.exec(text);
    }
  }

  return matches;
}

/**
 * Finds explicit path-like references for the workspace guard; this is a heuristic, not a shell
 * parser.
 */
export function extractExplicitPathReferences(text: string): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const { path: pathValue } of collectPathReferenceMatches(text)) {
    const comparisonKey = pathReferenceKey(pathValue);
    if (seen.has(comparisonKey)) {
      continue;
    }

    seen.add(comparisonKey);
    matches.push(pathValue);
  }

  return matches;
}

/**
 * Where guarded text came from. Shell commands are checked strictly: every path-like token is a
 * potential target. Prompt prose (user prompts, generated plans embedded in execution prompts)
 * also mentions paths in explanations, examples and API documentation, so each absolute
 * occurrence there is classified before it counts as a violation.
 */
export type PathReferenceContext = "shell" | "prompt";

// Base-form filesystem actions and shell commands. A clause containing one of these targets the
// path it mentions, so the occurrence stays a violation regardless of other context. Past-tense
// forms ("was created") are deliberately absent: they describe history rather than request work.
const FILESYSTEM_OPERATION_PATTERN =
  /\b(?:re)?(?:create|write|edit|modify|update|change|fix|patch|replace|add|append|delete|remove|rm|rmdir|move|mv|copy|cp|rename|read|open|cat|type|load|save|store|put|output|overwrite|touch|mkdir|chmod|chown|ln|symlink|link|extract|unzip|untar|import|use|run|execute|exec|source|install|cd|navigate|list|ls|access|inspect|view|show|see|check|look|scan|search|grep|find|print|display|dump|download|upload|generate|scaffold|clean|purge|wipe|truncate|format|mount|sync|send|attach|commit|push|deploy)\b/i;
// Wording that marks a clause as describing past or example state rather than requesting work.
const EXPLANATORY_MARKER_PATTERN =
  /\b(?:was|were|previously|originally|formerly|historical|historically|legacy|old|older|outdated|deprecated|used to|for example|for instance|such as)\b/i;
// Wording that marks a path-shaped token as an HTTP route rather than a filesystem location.
const HTTP_CONTEXT_PATTERN = /\b(?:endpoints?|routes?|api|urls?|https?|webhooks?)\b/i;
const HTTP_METHOD_BEFORE_PATH_PATTERN = /\b(?:GET|POST|PUT|PATCH|HEAD|OPTIONS)\s+$/;
// Route template segments such as `{ig-user-id}` or `:id`. A single identifier only, so shell
// brace expansion (`/etc/{passwd,shadow}`) is never mistaken for a template.
const ROUTE_PLACEHOLDER_SEGMENT_PATTERN = /^(?:\{[A-Za-z_][\w-]*\}|:[A-Za-z_][\w-]*)$/;
const ROUTE_QUERY_PATTERN = /\?[A-Za-z_][\w.-]*=/;

function isRouteTemplate(pathValue: string): boolean {
  const [routePath = ""] = pathValue.split("?");
  return (
    ROUTE_QUERY_PATTERN.test(pathValue) ||
    routePath.split("/").some((segment) => ROUTE_PLACEHOLDER_SEGMENT_PATTERN.test(segment))
  );
}

function isClauseBoundary(text: string, index: number): boolean {
  const char = text[index];
  return (
    char === "\n" ||
    char === ";" ||
    char === "!" ||
    char === "?" ||
    (char === "." && /\s/.test(text[index + 1] ?? ""))
  );
}

/** Returns the clause around an occurrence, excluding the path text itself. */
function surroundingClause(
  text: string,
  start: number,
  end: number,
): { before: string; after: string } {
  let clauseStart = start;
  while (clauseStart > 0 && !isClauseBoundary(text, clauseStart - 1)) {
    clauseStart--;
  }
  let clauseEnd = end;
  while (clauseEnd < text.length && !isClauseBoundary(text, clauseEnd)) {
    clauseEnd++;
  }
  return { before: text.slice(clauseStart, start), after: text.slice(end, clauseEnd) };
}

/**
 * Decides whether a prompt occurrence is an incidental mention rather than an operation target.
 * Defaults to "target": only positive evidence makes a mention incidental. Explicit relative
 * paths (including `../` traversal) are never reclassified.
 */
function isIncidentalPromptReference(
  text: string,
  reference: PathReferenceMatch,
  workspaceStyle: PathStyle,
): boolean {
  const style = detectPathStyle(reference.path);
  if (!style) {
    return false;
  }

  // A POSIX host cannot address drive-letter or UNC paths; writing one creates a literal file
  // in the working directory. The reverse does not hold: `/etc/x` resolves on Windows.
  if (style === "windows" && workspaceStyle === "posix") {
    return true;
  }

  if (style === "posix" && isRouteTemplate(reference.path)) {
    return true;
  }

  const { before, after } = surroundingClause(text, reference.start, reference.end);
  const clause = `${before} ${after}`;
  if (FILESYSTEM_OPERATION_PATTERN.test(clause)) {
    return false;
  }

  return (
    EXPLANATORY_MARKER_PATTERN.test(clause) ||
    HTTP_CONTEXT_PATTERN.test(clause) ||
    HTTP_METHOD_BEFORE_PATH_PATTERN.test(before.replace(/[`"']+$/, ""))
  );
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
  options: { context?: PathReferenceContext } = {},
): { violations: WorkspacePathViolation[]; skippedExternalPaths: string[] } {
  const violations: WorkspacePathViolation[] = [];
  const skippedExternalPaths: string[] = [];
  const seen = new Set<string>();
  const workspaceStyle = detectPathStyle(workspaceRoot) ?? "windows";
  const context = options.context ?? "shell";

  // A path counts once; it is incidental only when every one of its occurrences is.
  const references = new Map<string, { path: string; incidental: boolean }>();
  for (const reference of collectPathReferenceMatches(text)) {
    const incidental =
      context === "prompt" && isIncidentalPromptReference(text, reference, workspaceStyle);
    const key = pathReferenceKey(reference.path);
    const existing = references.get(key);
    if (existing) {
      existing.incidental &&= incidental;
    } else {
      references.set(key, { path: reference.path, incidental });
    }
  }

  for (const { path: rawPath, incidental } of references.values()) {
    if (incidental) {
      continue;
    }

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
 * Explains outside-workspace prompt references, or returns null when no guard applies. Mentions
 * classified as incidental (unreachable foreign-platform paths, HTTP route templates, and
 * explanatory clauses without a filesystem action) do not block; this is a pre-flight heuristic,
 * and tool-call/sandbox enforcement still applies during the run.
 */
export function getPromptWorkspaceGuardMessage(
  prompt: string,
  workspaceRoot: string,
  allowedRoots: readonly string[] = [],
): string | null {
  const { violations } = findOutsideWorkspacePaths(prompt, workspaceRoot, allowedRoots, {
    context: "prompt",
  });
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
