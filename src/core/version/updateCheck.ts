/**
 * Caches update-check results in app data with expiry and corruption-tolerant reads. Checks npm
 * `dist-tags` for newer versions with an abortable timeout and SemVer-precedence comparison.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_VERSION, getHomeDir } from "../../config/settings.js";
import { errorMessage } from "../shared/values.js";
import { isLocalDevChannel } from "./channel.js";

export const UBUME_NPM_PACKAGE = "ubume";
// The dist-tags document is tiny and served uncached, unlike the full packument (CDN-cached
// for minutes and growing with every release). `latest` is what `npm install ubume@latest` uses.
export const UBUME_NPM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${UBUME_NPM_PACKAGE}/dist-tags`;
export const UBUME_UPDATE_COMMAND = `npm install -g ${UBUME_NPM_PACKAGE}@latest --prefer-online --legacy-peer-deps`;

export type UpdateStatus = "up-to-date" | "update-available" | "unknown" | "error";

export interface NpmDistTags {
  latest?: unknown;
}

export interface UpdateCheckResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  errorMessage?: string;
  checkedAt: number;
  source?: "npm" | "cache";
}

const FETCH_TIMEOUT_MS = 5000;

/** Strip a leading "v" so "v1.0.2" and "1.0.2" are treated as equal. */
export function normalizeVersion(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

/** Normalizes and prefixes a nonblank version for display. */
export function formatVersionLabel(version: string): string {
  const normalized = normalizeVersion(version.trim());
  return normalized ? `v${normalized}` : version;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** Returns true for valid semver strings with or without a leading "v". */
export function isValidSemver(v: string): boolean {
  return SEMVER_RE.test(normalizeVersion(v));
}

/** Allows automatic checking only when enabled outside the local development channel. */
export function shouldRunStartupUpdateCheck(
  env: NodeJS.ProcessEnv = process.env,
  enabled = true,
): boolean {
  return enabled && !isLocalDevChannel(env);
}

// Compares a single dot-separated prerelease identifier per SemVer §11: numeric identifiers
// compare numerically and always sort below alphanumeric ones.
function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Compares two semver strings numerically. Returns negative if a < b, 0 if equal, positive if a > b.
// Pre-release versions (e.g. 1.0.2-beta.1) sort below their release counterpart (1.0.2 > 1.0.2-beta.1),
// and prerelease identifiers follow SemVer precedence (rc.9 < rc.10, alpha < alpha.1 < beta).
// Leading "v" is stripped before comparison.
/**
 * Compares normalized numeric versions and prerelease identifiers; release versions sort above
 * prereleases.
 */
export function compareSemver(a: string, b: string): number {
  const parseParts = (v: string): { numeric: number[]; prerelease: string[] | null } => {
    const norm = normalizeVersion(v);
    const dashIdx = norm.indexOf("-");
    const base = dashIdx === -1 ? norm : norm.slice(0, dashIdx);
    const prerelease = dashIdx === -1 ? null : norm.slice(dashIdx + 1).split(".");
    const numeric = base.split(".").map((p) => parseInt(p, 10) || 0);
    return { numeric, prerelease };
  };

  const pa = parseParts(a);
  const pb = parseParts(b);
  const len = Math.max(pa.numeric.length, pb.numeric.length);

  for (let i = 0; i < len; i++) {
    const diff = (pa.numeric[i] ?? 0) - (pb.numeric[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Same numeric version: no pre-release > has pre-release
  if (pa.prerelease === null && pb.prerelease !== null) return 1;
  if (pa.prerelease !== null && pb.prerelease === null) return -1;
  if (pa.prerelease !== null && pb.prerelease !== null) {
    const ids = Math.max(pa.prerelease.length, pb.prerelease.length);
    for (let i = 0; i < ids; i++) {
      const left = pa.prerelease[i];
      const right = pb.prerelease[i];
      // A shorter identifier list sorts first when every preceding identifier is equal.
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      const diff = comparePrereleaseIdentifier(left, right);
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

/** Checks SemVer precedence rather than lexicographic ordering. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

interface UpdateCheckOverrides {
  currentVersion?: string;
  /** Aborts the registry request, e.g. when the app shuts down mid-check. */
  signal?: AbortSignal;
  fetchNpmMetadataFn?: (url: string, signal?: AbortSignal) => Promise<NpmDistTags>;
}

interface FetchDistTagsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Fetches npm dist-tags with a hard timeout that also covers reading the body. */
export async function fetchNpmDistTags(
  url: string,
  options: FetchDistTagsOptions = {},
): Promise<NpmDistTags> {
  const { signal, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = fetch } = options;
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent": `${UBUME_NPM_PACKAGE}-update-checker/1.0`,
      },
    });
    if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status}`);
    return (await res.json()) as NpmDistTags;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Compares installed version with npm dist-tags; disabled checks return unknown and
 * transport/abort failures become error results.
 */
export async function checkForUpdates(
  opts?: { enabled?: boolean },
  overrides?: UpdateCheckOverrides,
): Promise<UpdateCheckResult> {
  const currentVersion = normalizeVersion(overrides?.currentVersion ?? APP_VERSION);

  if (opts?.enabled === false) {
    return {
      status: "unknown",
      currentVersion,
      latestVersion: null,
      checkedAt: Date.now(),
      source: "npm",
    };
  }

  try {
    const fetchFn =
      overrides?.fetchNpmMetadataFn ??
      ((url: string, signal?: AbortSignal) => fetchNpmDistTags(url, { signal }));
    const metadata: unknown = await fetchFn(UBUME_NPM_DIST_TAGS_URL, overrides?.signal);
    const rawLatest =
      typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
        ? (metadata as NpmDistTags).latest
        : undefined;

    if (typeof rawLatest !== "string" || !rawLatest.trim()) {
      return {
        status: "error",
        currentVersion,
        latestVersion: null,
        errorMessage: "npm registry response did not include dist-tags.latest",
        checkedAt: Date.now(),
        source: "npm",
      };
    }

    const latestVersion = normalizeVersion(rawLatest.trim());

    if (!isValidSemver(latestVersion) || !isValidSemver(currentVersion)) {
      return {
        status: "unknown",
        currentVersion,
        latestVersion: rawLatest,
        errorMessage: `Invalid semver — current: "${currentVersion}", latest: "${rawLatest}"`,
        checkedAt: Date.now(),
        source: "npm",
      };
    }

    const status = isNewerVersion(latestVersion, currentVersion)
      ? "update-available"
      : "up-to-date";
    return { status, currentVersion, latestVersion, checkedAt: Date.now(), source: "npm" };
  } catch (err) {
    return {
      status: "error",
      currentVersion,
      latestVersion: null,
      errorMessage: errorMessage(err),
      checkedAt: Date.now(),
      source: "npm",
    };
  }
}

/** Formats check outcomes and a manual update command without installing anything. */
export function formatUpdateInstructions(
  result: UpdateCheckResult | null,
  updateCommand: string = UBUME_UPDATE_COMMAND,
): string {
  const current = result?.currentVersion ?? APP_VERSION;
  const latest = result?.latestVersion ?? "unknown";

  if (result?.status === "error") {
    return [
      `Current installed version: ${current}`,
      `npm latest version:        ${latest}`,
      `Error checking npm update status: ${result.errorMessage ?? "unknown error"}`,
    ].join("\n");
  }

  if (result?.status === "up-to-date") {
    return [
      "Ubume is up to date.",
      `Current installed version: ${current}`,
      `npm latest version:        ${latest}`,
    ].join("\n");
  }

  const statusLine =
    result?.status === "update-available" && result.latestVersion
      ? `Update available: Ubume ${formatVersionLabel(result.latestVersion)}`
      : "Status unknown — could not reach npm registry.";

  return [
    `Current installed version: ${current}`,
    `npm latest version:        ${latest}`,
    `Status:          ${statusLine}`,
    "",
    `Run: ${updateCommand}`,
  ].join("\n");
}

/** Explains the development-channel policy while retaining manual published-version checks. */
export function formatLocalDevUpdateStatus(): string {
  return [
    "Running local-dev Ubume.",
    "Automatic published npm update prompts are disabled for this channel.",
    "Run /update check to explicitly check the published npm package.",
  ].join("\n");
}

export interface UpdateCheckCache {
  lastChecked: number;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

// Resolved per call (not at module load) so HOME changes — e.g. test isolation —
// are honored. See the same pattern in src/core/models/modelCache.ts.
/**
 * Names the update cache using the live home environment so test and launch overrides are
 * honored.
 */
export function getUpdateCheckCacheFilePath(): string {
  const home = getHomeDir();
  return join(home, ".ubume-update-check.json");
}

/** Cache file written by pre-rename (Codexa) releases; read only as a fallback. */
function getLegacyUpdateCheckCacheFilePath(): string {
  const home = getHomeDir();
  return join(home, ".codexa-update-check.json");
}

/**
 * Reads validated current/legacy cache data or null for missing, unreadable or malformed files.
 */
export function loadUpdateCheckCache(
  filePath = getUpdateCheckCacheFilePath(),
): UpdateCheckCache | null {
  try {
    let resolvedPath = filePath;
    if (!existsSync(resolvedPath) && filePath === getUpdateCheckCacheFilePath()) {
      const legacyPath = getLegacyUpdateCheckCacheFilePath();
      if (existsSync(legacyPath)) {
        resolvedPath = legacyPath;
      }
    }
    const text = readFileSync(resolvedPath, "utf-8");
    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data.lastChecked !== "number") return null;
    if (typeof data.currentVersion !== "string") return null;
    return {
      lastChecked: data.lastChecked,
      currentVersion: data.currentVersion,
      latestVersion: typeof data.latestVersion === "string" ? data.latestVersion : null,
      updateAvailable: data.updateAvailable === true,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort cache write via temporary-file rename; persistence failure never fails an update
 * check.
 */
export function saveUpdateCheckCache(
  cache: UpdateCheckCache,
  filePath = getUpdateCheckCacheFilePath(),
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch {
    // Best-effort — never crash on cache write failure.
  }
}

function stripV(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

/** Returns true when a cache entry was created by the running Ubume version. */
export function isCacheForRunningVersion(cache: UpdateCheckCache, runningVersion: string): boolean {
  return stripV(cache.currentVersion) === stripV(runningVersion);
}

/**
 * Returns true only when the cache is still usable:
 * - `runningVersion` matches the version the cache was written for (version-mismatch = stale)
 * - The cache was written within `intervalHours`
 */
export function isCacheValid(
  cache: UpdateCheckCache,
  intervalHours: number,
  runningVersion?: string,
): boolean {
  if (runningVersion !== undefined) {
    if (!isCacheForRunningVersion(cache, runningVersion)) {
      return false;
    }
  }
  const maxAgeMs = intervalHours * 60 * 60 * 1000;
  return Date.now() - cache.lastChecked < maxAgeMs;
}
