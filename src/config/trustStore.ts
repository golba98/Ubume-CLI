/**
 * @fileoverview Project Trust Store
 *
 * Manages user trust decisions for project-level `.codex/config.toml` configuration files.
 * For security isolation, configuration files inside repository roots are only executed
 * or merged when the project root is explicitly recorded in `ubume-trust.json`.
 *
 * Supports seamless non-destructive migration from legacy `codexa-trust.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import { normalizeWorkspaceRoot } from "../core/workspace/workspaceRoot.js";
import { writeJsonFileAtomic, writeTextFileIfAbsent } from "./atomicFile.js";
import { getLegacyCodexaTrustStoreFile, getUbumeTrustStoreFile } from "./settings.js";

/** Internal schema stored in `ubume-trust.json` */
interface TrustStoreData {
  trustedProjectRoots: string[];
}

/** Returns the empty default trust store structure. */
function getDefaultTrustStore(): TrustStoreData {
  return { trustedProjectRoots: [] };
}

/**
 * Parses and sanitizes trust store data, removing invalid types and duplicates.
 */
function parseTrustStoreData(data: unknown): TrustStoreData {
  if (!data || typeof data !== "object") {
    return getDefaultTrustStore();
  }

  const record = data as Record<string, unknown>;
  const trustedProjectRoots = Array.isArray(record.trustedProjectRoots)
    ? record.trustedProjectRoots
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => normalizeWorkspaceRoot(value))
    : [];

  return {
    trustedProjectRoots: Array.from(new Set(trustedProjectRoots)),
  };
}

/**
 * Loads trusted project roots from the trust store file.
 * Automatically migrates from legacy `codexa-trust.json` if `ubume-trust.json` does not exist.
 */
function loadTrustStore(): TrustStoreData {
  try {
    const ubumeFile = getUbumeTrustStoreFile();
    const legacyFile = getLegacyCodexaTrustStoreFile();

    let text = "";
    if (existsSync(ubumeFile)) {
      text = readFileSync(ubumeFile, "utf-8");
    } else if (existsSync(legacyFile)) {
      text = readFileSync(legacyFile, "utf-8");
      try {
        const parsed = parseTrustStoreData(JSON.parse(text));
        if (!writeTextFileIfAbsent(ubumeFile, JSON.stringify(parsed, null, 2))) {
          text = readFileSync(ubumeFile, "utf8");
        }
      } catch {
        // Non-destructive best-effort migration
      }
    } else {
      return getDefaultTrustStore();
    }

    return parseTrustStoreData(JSON.parse(text));
  } catch {
    // Best-effort persistence; corrupt or missing file silently resets to empty.
    return getDefaultTrustStore();
  }
}

/**
 * Persists the trust store data to disk atomically.
 */
function saveTrustStore(data: TrustStoreData): void {
  try {
    const trustStoreFile = getUbumeTrustStoreFile();
    writeJsonFileAtomic(trustStoreFile, data);
  } catch {
    // Best-effort persistence only; failures must not crash the application.
  }
}

/**
 * Checks whether a project repository root is marked as trusted by the user.
 * Project-level configuration (.codex/config.toml) is only loaded for trusted repositories.
 *
 * @param projectRoot - Absolute path to the repository/project root.
 * @returns True if the project is trusted.
 */
export function isProjectTrusted(projectRoot: string): boolean {
  if (!projectRoot || !projectRoot.trim()) {
    return false;
  }
  const normalizedRoot = normalizeWorkspaceRoot(projectRoot);
  const store = loadTrustStore();
  return store.trustedProjectRoots.includes(normalizedRoot);
}

/**
 * Updates the trust status for a project repository root.
 *
 * @param projectRoot - Absolute path to the repository/project root.
 * @param trusted - Whether the project should be marked as trusted.
 */
export function setProjectTrust(projectRoot: string, trusted: boolean): void {
  if (!projectRoot || !projectRoot.trim()) {
    return;
  }
  const normalizedRoot = normalizeWorkspaceRoot(projectRoot);
  const store = loadTrustStore();
  const nextRoots = trusted
    ? Array.from(new Set([...store.trustedProjectRoots, normalizedRoot]))
    : store.trustedProjectRoots.filter((value) => value !== normalizedRoot);

  saveTrustStore({ trustedProjectRoots: nextRoots });
}
