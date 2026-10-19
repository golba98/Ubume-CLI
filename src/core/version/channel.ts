/**
 * Leaf version/channel resolution used by settings. Keep settings and other version modules out
 * of its imports to avoid initialization cycles; package metadata precedes generated build-info
 * fallback.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION as BUILD_INFO_VERSION } from "../../config/buildInfo.js";

export const UBUME_CHANNEL_ENV = "UBUME_CHANNEL";
export const LOCAL_DEV_CHANNEL = "local-dev";

function getUbumeChannel(env: NodeJS.ProcessEnv = process.env): string {
  return env[UBUME_CHANNEL_ENV]?.trim() || "published";
}

/** Recognizes the explicit development channel. */
export function isLocalDevChannel(env: NodeJS.ProcessEnv = process.env): boolean {
  return getUbumeChannel(env) === LOCAL_DEV_CHANNEL;
}

/** Adds the local development label only when the selected channel requires it. */
export function formatUbumeVersionLabel(
  version: string = getAppVersion(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isLocalDevChannel(env) ? `${version}-dev local` : version;
}

/** Builds the application brand using the resolved installed version and channel label. */
export function formatUbumeBrandLabel(env: NodeJS.ProcessEnv = process.env): string {
  return `Ubume v${formatUbumeVersionLabel(getAppVersion(), env)}`;
}

// Leaf module: must not import settings.ts or anything under src/core/version
// (settings.ts re-exports APP_VERSION from here, so that would be a cycle).

const UBUME_PACKAGE_NAME = "ubume";
const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

function readPackageVersion(
  packageJsonPath: string,
  allowedNames?: readonly string[],
): string | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (allowedNames && typeof parsed.name === "string" && !allowedNames.includes(parsed.name)) {
      return null;
    }
    if (typeof parsed.version !== "string") return null;
    const version = parsed.version.trim();
    return SEMVER_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the version of the running Ubume install:
 * 1. `UBUME_PACKAGE_ROOT` (set by bin/ubume.js) → that package.json's version
 * 2. Walk up from this module for a package.json named "ubume"
 * 3. The committed buildInfo.ts APP_VERSION as the last resort
 *
 * `startDir` overrides the walk-up starting directory (test seam).
 */
export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env, startDir?: string): string {
  const packageRoot = env.UBUME_PACKAGE_ROOT?.trim();
  if (packageRoot) {
    const version = readPackageVersion(join(packageRoot, "package.json"));
    if (version) return version;
  }

  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  const allowedNames = [UBUME_PACKAGE_NAME] as const;
  for (;;) {
    const version = readPackageVersion(join(dir, "package.json"), allowedNames);
    if (version) return version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return BUILD_INFO_VERSION;
}

let cachedVersion: string | null = null;

/** Cached form of resolveAppVersion() — the installed version cannot change mid-process. */
export function getAppVersion(): string {
  if (cachedVersion === null) {
    cachedVersion = resolveAppVersion();
  }
  return cachedVersion;
}
