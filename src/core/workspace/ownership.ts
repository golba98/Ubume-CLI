/**
 * Workspace execution and conversation leases backed by exclusive lock directories. Tokens guard
 * release/reclamation against replacement owners; only demonstrably dead processes on the same
 * host are reclaimable.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { resolveUbumeWorkspaceDataDir } from "./appData.js";

export interface OwnershipInfo {
  pid: number;
  host: string;
  token: string;
  createdAt: string;
}
export interface OwnershipLease {
  owner: OwnershipInfo;
  release: () => void;
}
class OwnershipError extends Error {
  readonly exitCode = 3;
  constructor(
    readonly resource: string,
    readonly owner: OwnershipInfo | null,
  ) {
    super(
      `${resource} is busy${owner ? ` (process ${owner.pid} on ${owner.host})` : " (owner information unavailable)"}. Close the owning Ubume process and retry.`,
    );
  }
}
function lockPath(workspace: string, resource: string): string {
  if (!/^(execution|chat_[A-Za-z0-9-]+)$/.test(resource))
    throw new Error("Invalid ownership resource.");
  return join(
    resolveUbumeWorkspaceDataDir(workspace, { readOnly: true }),
    "locks",
    `${resource}.lock`,
  );
}
function readOwner(path: string): OwnershipInfo | null {
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    return Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.host === "string" &&
      typeof owner.token === "string" &&
      typeof owner.createdAt === "string"
      ? owner
      : null;
  } catch {
    return null;
  }
}
/** Reads lock/owner state without reclaiming or creating a lease. */
export function inspectOwnership(
  workspace: string,
  resource: string,
): { locked: boolean; owner: OwnershipInfo | null } {
  const path = lockPath(workspace, resource);
  return { locked: existsSync(path), owner: readOwner(path) };
}
function dead(owner: OwnershipInfo | null): boolean {
  if (!owner || owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
/**
 * Acquires an exclusive resource lease or throws a busy error. Only dead same-host owners are
 * reclaimed; callers must release the returned token-checked lease.
 *
 * @param workspace - Workspace identity used for app-data lock placement.
 * @param resource - `execution` or a validated `chat_...` conversation id.
 * @returns A lease whose release cannot remove a replacement owner's lock.
 * @throws For a live/unknown owner (exit code 3), invalid resource name, or filesystem failure.
 */
export function acquireOwnership(workspace: string, resource: string): OwnershipLease {
  const path = lockPath(workspace, resource);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const owner: OwnershipInfo = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readOwner(path);
      if (!dead(previous)) throw new OwnershipError(resource, previous);
      // Claim reclamation inside this exact lock generation before replacing it.
      const guard = join(path, "reclaim");
      try {
        mkdirSync(guard);
      } catch {
        throw new OwnershipError(resource, readOwner(path));
      }
      let moved = false;
      try {
        const current = readOwner(path);
        if (current?.token !== previous?.token || !dead(current))
          throw new OwnershipError(resource, current);
        const stale = `${path}.stale-${owner.token}`;
        renameSync(path, stale);
        moved = true;
        rmSync(stale, { recursive: true, force: true });
      } finally {
        if (!moved) rmSync(guard, { recursive: true, force: true });
      }
      continue;
    }
    try {
      writeFileSync(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
    let released = false;
    return {
      owner,
      release: () => {
        if (released) return;
        released = true;
        if (readOwner(path)?.token !== owner.token) return;
        const retired = `${path}.released-${owner.token}`;
        try {
          renameSync(path, retired);
          rmSync(retired, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  }
  throw new OwnershipError(resource, readOwner(path));
}
