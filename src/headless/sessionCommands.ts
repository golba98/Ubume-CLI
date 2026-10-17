/**
 * `ubume sessions list | show ID | transcript ID | diff ID [--turn N] [--file PATH]`.
 *
 * Read-only views over the saved conversations of a workspace, in the same store the
 * TUI uses. `diff` reconstructs patches from the file checkpoints that headless and TUI
 * runs record before and after each turn. Without `--turn`, it spans the first
 * checkpoint to the latest boundary.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CheckpointStore } from "../core/workspace/checkpoints.js";
import type { ConversationStore } from "../core/workspace/conversationStore.js";
import { inspectOwnership } from "../core/workspace/ownership.js";
import { inspectionEntries } from "../session/workbench.js";
import { CommandError, type CommandOutcome, resultOutcome, usageError } from "./commandResult.js";

const SESSION_ACTIONS = ["list", "show", "transcript", "diff"];
/** Saved session ids; validating them also keeps the id from escaping the data dir as a path. */
const SESSION_ID = /^chat_[A-Za-z0-9-]+$/;

/** True when a file restore for `sessionId` was interrupted and still has a journal on disk. */
export function hasPendingRestore(dataRoot: string, sessionId: string): boolean {
  return existsSync(join(dataRoot, "checkpoints", sessionId, "restore.json"));
}

export interface SessionsCommandScope {
  workspace: string;
  dataRoot: string;
  store: ConversationStore;
  /** Parsed inspection arguments: `[action, id]` positionals and the `--turn`/`--file` values. */
  args: { positional: readonly string[]; values: ReadonlyMap<string, string> };
}

function listSessions(store: ConversationStore): CommandOutcome {
  const sessions = store.list();
  const human = sessions.length
    ? sessions
        .map((session) => {
          const provider = session.localBackend
            ? `${session.providerId}:${session.localBackend}`
            : session.providerId;
          return `${session.id}  ${session.updatedAt}  ${provider}/${session.modelId}  ${session.title}`;
        })
        .join("\n")
    : "No saved sessions.";
  return resultOutcome(sessions, { human });
}

/**
 * Builds the patch set for `sessions diff`.
 *
 * Without `--turn`, the range runs from the first checkpoint's "before" to the restored
 * boundary (if the user restored files in the TUI) or the last checkpoint's "after".
 * With `--turn`, it is that turn's own before and after.
 */
async function diffSession(
  { workspace, dataRoot, args }: SessionsCommandScope,
  id: string,
  record: NonNullable<ReturnType<ConversationStore["load"]>>,
): Promise<CommandOutcome> {
  const checkpoints = record.session?.checkpoints ?? [];
  const turn = args.values.get("--turn");
  if (turn !== undefined && !/^[1-9]\d*$/.test(turn)) {
    throw usageError("--turn must be a positive turn number.");
  }

  const selected = turn ? checkpoints.find((point) => point.turnId === Number(turn)) : undefined;
  if (turn && !selected) throw new CommandError(`Turn ${turn} has no file checkpoint.`);
  const before = selected?.before ?? checkpoints[0]?.before;
  const after =
    selected?.after ??
    (turn ? undefined : (record.session?.restoredFileBoundary ?? checkpoints.at(-1)?.after));
  if (!before || !after) {
    throw new CommandError("No finalized file checkpoint is available for this selection.");
  }

  const store = new CheckpointStore(workspace, id, dataRoot);
  const paths = store.changed(before, after);
  const file = args.values.get("--file");
  if (file && !paths.includes(file)) throw new CommandError(`No recorded change for ${file}.`);

  const patches = await Promise.all(
    (file ? [file] : paths).map(async (path) => ({
      path,
      patch: await store.patch(before, after, path),
    })),
  );
  return resultOutcome(
    {
      complete: before.complete && after.complete,
      skipped: [...new Set([...before.skipped, ...after.skipped])],
      patches,
    },
    { human: patches.map((entry) => entry.patch).join("\n") || "No supported text-file changes." },
  );
}

/**
 * Dispatches a `sessions` action.
 *
 * @throws {CommandError} `USAGE` (2) for a malformed action, id or option; exit 3 when the
 *   session cannot be loaded or has no matching checkpoint.
 */
export async function runSessionsCommand(scope: SessionsCommandScope): Promise<CommandOutcome> {
  const { workspace, dataRoot, store, args } = scope;
  const [action, id, ...rest] = args.positional;
  const needsId = action !== "list";
  if (rest.length || !SESSION_ACTIONS.includes(action ?? "") || (needsId ? !id : !!id)) {
    throw usageError("Use sessions list, show ID, transcript ID, or diff ID.");
  }
  if (action !== "diff" && (args.values.has("--turn") || args.values.has("--file"))) {
    throw usageError("--turn and --file apply only to sessions diff.");
  }

  if (action === "list") return listSessions(store);

  // `id` is present: the usage check above requires it for every action except list.
  const sessionId = id!;
  if (!SESSION_ID.test(sessionId)) throw usageError("Invalid session ID.");
  const record = store.load(sessionId);
  if (!record) throw new CommandError(`Session ${sessionId} could not be loaded.`);

  if (action === "show") {
    return resultOutcome({
      ...record.metadata,
      storage: store.location(sessionId),
      draft: record.session?.draft ?? "",
      queuedPrompts: record.session?.queue.length ?? 0,
      checkpoints: record.session?.checkpoints.length ?? 0,
      ownership: inspectOwnership(workspace, sessionId),
      pendingRecovery: hasPendingRestore(dataRoot, sessionId),
    });
  }

  if (action === "transcript") {
    // Sessions saved before workbench snapshots existed only have messages.
    const entries = record.session
      ? inspectionEntries(record.session.events)
      : record.messages.map((message, index) => ({
          id: String(index),
          title: message.role,
          details: [message.content, message.activitySummary].filter(Boolean).join("\n"),
        }));
    return resultOutcome(entries, {
      human: entries.map((entry) => `${entry.title}\n${entry.details}`).join("\n\n"),
    });
  }

  return diffSession(scope, sessionId, record);
}
