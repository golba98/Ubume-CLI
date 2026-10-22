/**
 * Provider-neutral plumbing for bridging a native CLI's permission requests into Ubume's shared
 * tool-approval handler: workspace-boundary checks, exact-signature keys, and a serialized
 * approval queue with duplicate suppression, withdrawal and disposal.
 *
 * Approvals are never broadened: "allow for run" reuses a decision only for a byte-identical
 * signature, and is never available for paths outside the workspace.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  BackendRunHandlers,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../providers/types.js";
import { isRecord } from "../shared/values.js";

/** Key-sorted JSON so equal inputs produce equal approval signatures. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Resolves symlinks through the nearest existing ancestor so not-yet-created files work. */
function realpathLenient(path: string): string {
  let current = path;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...tail);
  } catch {
    return path;
  }
}

/** True when `path` (relative to the workspace, or absolute) resolves outside the workspace. */
export function isOutsideWorkspace(path: string, workspaceRoot: string): boolean {
  const root = realpathLenient(resolve(workspaceRoot));
  const target = realpathLenient(resolve(workspaceRoot, path));
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

/** Workspace-relative display form; paths outside the workspace stay absolute. */
export function displayWorkspacePath(path: string, workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot, path);
  const rel = relative(resolve(workspaceRoot), absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

/** How the provider should be answered for one request. */
export type ProviderApprovalOutcome = "allow" | "deny" | "unavailable";

export interface ProviderApprovalQueueOptions<T> {
  onToolApproval?: BackendRunHandlers["onToolApproval"];
  /** Converts a native request into the shared prompt. */
  toApproval: (item: T) => ToolApprovalRequest;
  /** Answers the provider. Never called after `dispose` or for a withdrawn request. */
  respond: (item: T, outcome: ProviderApprovalOutcome) => void;
  /** Reports whether Ubume is waiting on the user, so quiet-provider notices pause. */
  onAwaitingUser?: (waiting: boolean) => void;
  onDecision?: (request: ToolApprovalRequest, decision: ToolApprovalDecision | "cached") => void;
}

/**
 * Answers native permission requests one at a time, keyed by the provider's request id.
 * Duplicate ids are ignored, `withdraw` removes a queued or visible request, and `dispose`
 * (process exit or run cancel) withdraws everything without answering.
 */
export function createProviderApprovalQueue<T>(options: ProviderApprovalQueueOptions<T>) {
  const queue: { id: string; item: T }[] = [];
  const seen = new Set<string>();
  const allowedForRun = new Set<string>();
  let current: { id: string; abort: AbortController } | null = null;
  let disposed = false;

  const respond = (item: T, outcome: ProviderApprovalOutcome) => {
    if (!disposed) options.respond(item, outcome);
  };

  const pump = async () => {
    while (!current && !disposed && queue.length) {
      const { id, item } = queue.shift()!;
      const approval = options.toApproval(item);
      if (allowedForRun.has(approval.signature)) {
        options.onDecision?.(approval, "cached");
        respond(item, "allow");
        continue;
      }
      if (!options.onToolApproval) {
        options.onDecision?.(approval, "deny");
        respond(item, "unavailable");
        continue;
      }
      const abort = new AbortController();
      current = { id, abort };
      options.onAwaitingUser?.(true);
      let decision: ToolApprovalDecision;
      try {
        // A withdrawn request must not wait on a UI that ignores the abort signal.
        const withdrawn = new Promise<ToolApprovalDecision>((resolveWithdrawn) =>
          abort.signal.addEventListener("abort", () => resolveWithdrawn("deny"), { once: true }),
        );
        decision = await Promise.race([options.onToolApproval(approval, abort.signal), withdrawn]);
      } catch {
        decision = "deny";
      }
      current = null;
      options.onAwaitingUser?.(false);
      if (abort.signal.aborted) continue;
      options.onDecision?.(approval, decision);
      if (decision === "allow-for-run" && approval.allowForRun !== false)
        allowedForRun.add(approval.signature);
      respond(item, decision === "deny" ? "deny" : "allow");
    }
  };

  return {
    /** Queues a request; ignored after dispose or when the id was already seen. */
    enqueue(id: string, item: T): void {
      if (disposed || seen.has(id)) return;
      seen.add(id);
      queue.push({ id, item });
      void pump();
    },
    /** Withdraws a queued or visible request without answering it. */
    withdraw(id: string): void {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) queue.splice(index, 1);
      if (current?.id === id) current.abort.abort();
    },
    get pending(): number {
      return queue.length + (current ? 1 : 0);
    },
    get disposed(): boolean {
      return disposed;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      queue.length = 0;
      current?.abort.abort();
    },
  };
}
