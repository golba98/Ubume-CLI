/**
 * Shortens local file references in model output for terminal display.
 *
 * Absolute paths, `file://` URLs and markdown links pointing at local files are
 * rewritten to a compact, project-relative-looking form (`src/foo.ts:12`),
 * with GitHub-style `#L12-L20` anchors converted to `:12-20`. Remote
 * `http(s)` links are left untouched. Used by `markdownParser.ts` (link
 * labels) and `timeline/runActivityView.ts` (action command text). Pure
 * string transforms; no filesystem access, so the "project root" is a
 * heuristic based on well-known top-level folder names, not the real
 * workspace root.
 */
const MARKDOWN_LINK_RE = /!?\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const FILE_URL_RE = /\bfile:\/\/\/?[^\s`"'<>)]*/gi;
const WINDOWS_ABSOLUTE_PATH_RE =
  /\b[A-Za-z]:[\\/][^\n`"'<>)]*?\.(?:tsx?|jsx?|md|json|ya?ml|toml|css|html|py|txt|mjs|cjs)(?:#L\d+(?:-L?\d+)?)?/g;
const UNIX_ABSOLUTE_PATH_RE =
  /(?:^|[\s(])((?:\/Users|\/home|\/workspace|\/workspaces|\/mnt\/[a-z])\/[^\n`"'<>)]*?\.(?:tsx?|jsx?|md|json|ya?ml|toml|css|html|py|txt|mjs|cjs)(?:#L\d+(?:-L?\d+)?)?)/g;

const PATH_ROOT_SEGMENTS = new Set([
  ".github",
  "app",
  "bin",
  "components",
  "docs",
  "lib",
  "pages",
  "preview",
  "scripts",
  "src",
  "test",
  "tests",
]);

const ROOT_FILE_RE =
  /^(?:README|CHANGELOG|LICENSE|SECURITY|package|tsconfig|vite\.config|next\.config|bun\.lock)(?:\.[a-z0-9]+)?$/i;

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripLinkLabelMarkdown(label: string): string {
  return label
    .trim()
    .replace(/^`([^`]+)`$/, "$1")
    .replace(/^\*\*([^*]+)\*\*$/, "$1");
}

function splitLineAnchor(value: string): { path: string; lineSuffix: string } {
  const anchorMatch = /#L(\d+)(?:-L?(\d+))?$/i.exec(value);
  if (!anchorMatch) {
    return { path: value, lineSuffix: "" };
  }

  const start = anchorMatch[1]!;
  const end = anchorMatch[2];
  return {
    path: value.slice(0, anchorMatch.index),
    lineSuffix: end ? `:${start}-${end}` : `:${start}`,
  };
}

function normalizeLocalPathPathname(rawPath: string): { path: string; lineSuffix: string } {
  let value = rawPath.trim();
  value = value.replace(/^<|>$/g, "");
  value = value.replace(/^file:(?:\/\/)?/i, "");
  value = value.replace(/^\/([A-Za-z]:[\\/])/, "$1");
  value = decodePath(value);
  value = value.replace(/\\/g, "/");
  value = value.replace(/[?#][^#]*$/, (suffix) => (suffix.startsWith("#L") ? suffix : ""));
  return splitLineAnchor(value);
}

function looksLikeLocalTarget(target: string): boolean {
  const trimmed = target.trim();
  return (
    /^file:/i.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^\/(?:Users|home|workspace|workspaces|mnt\/[a-z])\//i.test(trimmed)
  );
}

function looksLikePathLabel(label: string): boolean {
  return /[\\/]/.test(label) || /^[\w.-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/.test(label);
}

/**
 * Compact one local path: strip `file:` prefixes and URL decoding, normalize
 * separators to `/`, then keep everything from the first well-known root
 * segment (`src`, `docs`, `test`, …); otherwise keep just the file name.
 * A trailing `#L…` anchor becomes a `:line[-end]` suffix. `http(s)` URLs are
 * returned unchanged.
 */
export function formatLocalPathForTerminal(rawPath: string): string {
  if (/^https?:\/\//i.test(rawPath.trim())) {
    return rawPath;
  }

  const { path, lineSuffix } = normalizeLocalPathPathname(rawPath);
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return path + lineSuffix;
  }

  const rootIndex = segments.findIndex((segment) => PATH_ROOT_SEGMENTS.has(segment));
  if (rootIndex >= 0) {
    return segments.slice(rootIndex).join("/") + lineSuffix;
  }

  const fileName = segments[segments.length - 1]!;
  if (ROOT_FILE_RE.test(fileName)) {
    return fileName + lineSuffix;
  }

  return segments.slice(-1).join("/") + lineSuffix;
}

function formatLocalMarkdownLink(label: string, target: string): string {
  const cleanLabel = stripLinkLabelMarkdown(label);
  const compactTarget = formatLocalPathForTerminal(target);
  const lineSuffix = /(:\d+(?:-\d+)?)$/.exec(compactTarget)?.[1] ?? "";

  if (looksLikePathLabel(cleanLabel)) {
    const compactLabel = formatLocalPathForTerminal(cleanLabel);
    return lineSuffix && !compactLabel.endsWith(lineSuffix)
      ? `${compactLabel}${lineSuffix}`
      : compactLabel;
  }

  return cleanLabel ? `${cleanLabel} (${compactTarget})` : compactTarget;
}

/**
 * Rewrite every local file reference in `text`, in this order: markdown links
 * with local targets, `file://` URLs, Windows absolute paths, and Unix
 * absolute paths under common home/workspace roots. The bare Windows/Unix path
 * patterns only match paths ending in a recognized source-file extension.
 */
export function formatTerminalAnswerInline(text: string): string {
  if (!text) return text;

  let formatted = text.replace(MARKDOWN_LINK_RE, (full, label: string, target: string) => {
    if (!looksLikeLocalTarget(target)) {
      return full;
    }
    return formatLocalMarkdownLink(label, target);
  });

  formatted = formatted.replace(FILE_URL_RE, (match) => formatLocalPathForTerminal(match));
  formatted = formatted.replace(WINDOWS_ABSOLUTE_PATH_RE, (match) =>
    formatLocalPathForTerminal(match),
  );
  formatted = formatted.replace(UNIX_ABSOLUTE_PATH_RE, (full, path: string) => {
    const prefix = full.slice(0, full.length - path.length);
    return `${prefix}${formatLocalPathForTerminal(path)}`;
  });

  return formatted;
}
