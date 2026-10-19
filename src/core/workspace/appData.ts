/**
 * Platform app-data and workspace artifact paths. Most resolvers only name paths; normal
 * workspace initialization may resume a non-destructive legacy import unless readOnly is set.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { getHomeDir } from "../../config/settings.js";
import { importLegacyData } from "./legacyDataMigration.js";

type Platform = "win32" | "darwin" | "linux" | string;
type Environment = Record<string, string | undefined>;

function resolveDataDir(platform: Platform, env: Environment, home: string, name: string): string {
  if (platform === "win32") {
    return join(
      env["LOCALAPPDATA"]?.trim() || env["APPDATA"]?.trim() || join(home, "AppData", "Local"),
      name,
    );
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", name);
  return join(env["XDG_DATA_HOME"]?.trim() || join(home, ".local", "share"), name.toLowerCase());
}

/**
 * Resolves the legacy app-data location from live overrides and platform conventions without
 * creating it.
 */
export function resolveLegacyCodexaDataDir(
  platformOverride?: Platform,
  env: Environment = process.env,
  home = getHomeDir(),
): string {
  return (
    env["CODEXA_DATA_DIR"]?.trim() ||
    resolveDataDir(platformOverride ?? process.platform, env, home, "Codexa")
  );
}

/**
 * Resolves the current write destination. CODEXA_DATA_DIR only locates migration input.
 */
export function resolveUbumeDataDir(
  platformOverride?: Platform,
  env: Environment = process.env,
  home = getHomeDir(),
): string {
  return (
    env["UBUME_DATA_DIR"]?.trim() ||
    resolveDataDir(platformOverride ?? process.platform, env, home, "Ubume")
  );
}

const migratedPairs = new Set<string>();

/**
 * Imports missing legacy artifacts. Failed attempts remain retryable; current data and legacy
 * originals are retained. Successful source/destination pairs are cached per process.
 */
export function maybeMigrateLegacyData(
  platformOverride?: Platform,
  env: Environment = process.env,
  home = getHomeDir(),
): void {
  try {
    const ubumeDir = resolveUbumeDataDir(platformOverride, env, home);
    const legacyDir = resolveLegacyCodexaDataDir(platformOverride, env, home);
    const sources: [string, string][] = [[legacyDir, ubumeDir]];
    // A customized pre-rename plan directory is data, not an active write alias.
    if (env["CODEXA_PLAN_DIR"]?.trim()) {
      sources.push([
        env["CODEXA_PLAN_DIR"].trim(),
        env["UBUME_PLAN_DIR"]?.trim() || join(ubumeDir, "plans"),
      ]);
    }
    for (const [source, destination] of sources) {
      const pair = JSON.stringify([source, destination]);
      if (!migratedPairs.has(pair) && importLegacyData(source, destination))
        migratedPairs.add(pair);
    }
  } catch {
    // Non-destructive best-effort migration
  }
}

/**
 * Allows another legacy-data migration attempt in an isolated test environment.
 */
export function resetDataMigrationForTests(): void {
  migratedPairs.clear();
}

/**
 * Hashes the supplied workspace identity into a stable app-data key; callers provide the
 * normalized root.
 */
export function workspaceStorageKey(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

/**
 * Names workspace app data. Normal calls may migrate legacy data; readOnly selects existing
 * legacy data without migration.
 */
export function resolveUbumeWorkspaceDataDir(
  workspaceRoot: string,
  options: { readOnly?: boolean } = {},
): string {
  if (!options.readOnly) maybeMigrateLegacyData();
  const current = resolveUbumeDataDir();
  const legacy = resolveLegacyCodexaDataDir();
  const root = options.readOnly && !existsSync(current) && existsSync(legacy) ? legacy : current;
  return join(root, "workspaces", workspaceStorageKey(workspaceRoot));
}

/** Names the current conversation directory under app-data chats without creating it. */
export function resolveUbumeConversationDir(workspaceRoot: string): string {
  return join(resolveUbumeChatWorkspaceDir(workspaceRoot), "conversations");
}

/** Chat artifacts are user data, never files in the project being edited. */
export function resolveUbumeChatWorkspaceDir(workspaceRoot: string): string {
  return join(resolveUbumeDataDir(), "chats", workspaceStorageKey(workspaceRoot));
}

/** Names the historical workspace conversation directory without triggering migration. */
export function resolveLegacyConversationDir(workspaceRoot: string): string {
  return join(resolveUbumeWorkspaceDataDir(workspaceRoot, { readOnly: true }), "conversations");
}

/**
 * Resolves a configured attachment directory; relative paths stay under workspace app data using
 * the existing normalization rules.
 */
export function resolveUbumeAttachmentDir(workspaceRoot: string, configuredDir: string): string {
  if (isAbsolute(configuredDir)) return configuredDir;

  const normalized =
    configuredDir
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.(?:ubume|codexa)\/?/, "") || "attachments";
  const safeRelativeDir = normalize(normalized).replace(/^(\.\.([/\\]|$))+/, "") || "attachments";
  return join(resolveUbumeWorkspaceDataDir(workspaceRoot), safeRelativeDir);
}

/** Names the shared render diagnostic log in the selected app-data root. */
export function resolveUbumeDebugLogPath(env: Environment = process.env): string {
  return join(resolveUbumeDataDir(undefined, env), "debug", "render-status.log");
}
