/**
 * Adds session persistence to a headless run (`ubume exec` and `--resume`).
 *
 * Each run records one turn in the same `ConversationStore` / `WorkbenchSnapshot`
 * format the TUI uses, so a headless session can be resumed in the TUI and the other
 * way round. The turn holds a user event, a run event, the streamed assistant event,
 * and a file checkpoint taken before and after the run so that `sessions diff` can show
 * what changed.
 *
 * Concurrency: the run holds the session lease and the workspace-wide `execution`
 * ownership for its whole duration, so a second writer (TUI or headless) is refused
 * with exit 3 instead of interleaving. Both are released in `finally` blocks.
 *
 * With `noSave`, nothing is written: there is no record, checkpoint or session line,
 * and the data dir is opened read-only. The execution lock is still taken.
 */
import { closeLocalHarnessSession } from "../core/providerRuntime/localHarness/runtime.js";
import { refreshProviderModels } from "../core/providerRuntime/registry.js";
import { errorMessage } from "../core/shared/values.js";
import { resolveUbumeWorkspaceDataDir } from "../core/workspace/appData.js";
import {
  assertFileRecoveryReady,
  CheckpointStore,
  type FileCheckpoint,
} from "../core/workspace/checkpoints.js";
import { type ConversationRecord, ConversationStore } from "../core/workspace/conversationStore.js";
import { acquireOwnership } from "../core/workspace/ownership.js";
import { expandFileAttachments, readFileAttachment } from "../core/workspace/workspaceFiles.js";
import { createRunEvent } from "../session/chatLifecycle.js";
import { conversationMessagesToTimeline } from "../session/conversation.js";
import type { AssistantEvent, RunEvent } from "../session/types.js";
import { restoredEvents, ToolOutputBudget, type WorkbenchSnapshot } from "../session/workbench.js";
import { CommandError, EXIT_CODE } from "./commandResult.js";
import { type HeadlessExecutionContext, resolveExecutionContext } from "./context.js";
import {
  type HeadlessExecIo,
  type HeadlessExecOptions,
  type HeadlessExecResult,
  runHeadlessExec,
} from "./execRunner.js";
import { providerSecrets, redact } from "./redact.js";

/** Delay that batches bursts of streaming updates into a single session write. */
const SAVE_DEBOUNCE_MS = 200;
/** Caps on what one run may persist, so that a runaway provider cannot bloat the session file. */
const MAX_PROGRESS_ENTRIES = 500;
const MAX_TOOL_ACTIVITIES = 1000;
const MAX_PROMPT_HISTORY = 50;

interface SavedExecOptions extends HeadlessExecOptions {
  /** Canonical workspace directory (from `commandWorkspace`). */
  workspaceRoot: string;
  /** Run without creating or updating a saved session. */
  noSave?: boolean;
  /** `chat_…` id to continue. */
  resumeId?: string;
  /** Workspace-relative text files to attach to the prompt. */
  files?: string[];
}

export type SavedExecResult = HeadlessExecResult & { sessionId?: string };

// ─── Resume ───────────────────────────────────────────────────────────────────

/**
 * If the last run was cut off by a crash (still `running`, with a partial answer and
 * a dangling user message), appends that partial answer to the provider history once.
 * Otherwise the provider would see a user turn with no reply. Mutates `record.messages`.
 */
export function appendCrashInterruptedAnswer(record: ConversationRecord): void {
  const run = record.session?.events.findLast((event) => event.type === "run");
  const answer = record.session?.events.findLast((event) => event.type === "assistant");
  if (
    run?.type === "run" &&
    run.status === "running" &&
    answer?.type === "assistant" &&
    answer.turnId === run.turnId &&
    record.messages.at(-1)?.role === "user"
  ) {
    record.messages.push({
      role: "assistant",
      content: `${answer.contentChunks.join("") || answer.content}\n\n[Run interrupted before session closed]`,
      turnId: run.turnId,
    });
  }
}

/**
 * Takes the session lease and loads the session for `--resume`.
 *
 * @throws {CommandError} (exit 3) if the session is busy, cannot be loaded, or is
 *   waiting for plan review, which only the TUI can complete.
 */
function loadResumeRecord(store: ConversationStore, resumeId: string): ConversationRecord {
  store.acquire(resumeId);
  const record = store.load(resumeId);
  if (!record) throw new CommandError(`Session ${resumeId} could not be loaded.`);
  if (record.session?.plan.kind !== undefined && record.session.plan.kind !== "idle") {
    throw new CommandError(
      "This session is awaiting plan review. Open it in the TUI before executing more work.",
    );
  }
  appendCrashInterruptedAnswer(record);
  return record;
}

// ─── Turn setup ───────────────────────────────────────────────────────────────

/**
 * Appends `--file` attachments to the prompt as placeholder tokens, then expands them
 * using the same attachment pipeline as the TUI composer.
 */
async function buildSubmittedPrompt(
  prompt: string,
  files: readonly string[],
  workspace: string,
): Promise<string> {
  const attachments = new Map<string, Awaited<ReturnType<typeof readFileAttachment>>>();
  let submitted = prompt;
  for (const [index, path] of files.entries()) {
    // Control characters cannot appear in typed text, so the token cannot collide with it.
    const token = `\u0001ubume-file-${index}\u0002`;
    attachments.set(token, await readFileAttachment(workspace, path));
    submitted += `\n${token}`;
  }
  return expandFileAttachments(submitted, attachments, workspace);
}

function emptySnapshot(events: WorkbenchSnapshot["events"]): WorkbenchSnapshot {
  return {
    version: 1,
    events,
    uiState: { kind: "IDLE" },
    plan: { kind: "idle" },
    draft: "",
    cursor: 0,
    history: [],
    pastes: [],
    images: [],
    files: [],
    queue: [],
    checkpoints: [],
  };
}

interface Turn {
  session: WorkbenchSnapshot;
  run: RunEvent;
  turnId: number;
  nextEventId: () => number;
  checkpointStore?: CheckpointStore;
  checkpoint?: FileCheckpoint;
}

/**
 * Builds the session snapshot for this turn. It restores the previous events, takes the
 * "before" file checkpoint, and appends the user and run events.
 *
 * Without a record (`noSave`), the snapshot only lives in memory and no checkpoint is taken.
 */
async function startTurn(params: {
  record: ConversationRecord | undefined;
  workspace: string;
  dataRoot: string;
  prompt: string;
  submitted: string;
  context: HeadlessExecutionContext;
  startedAt: number;
}): Promise<Turn> {
  const { record, workspace, dataRoot, prompt, submitted, context, startedAt } = params;

  let eventId = Math.max(0, ...(record?.session?.events.map((event) => event.id) ?? []));
  const nextEventId = () => ++eventId;

  // Sessions written by older versions have only messages, so their timeline is rebuilt.
  const existingEvents = record?.session
    ? restoredEvents(record.session.events)
    : conversationMessagesToTimeline(record?.messages ?? [], nextEventId);
  const turnId =
    Math.max(
      0,
      ...existingEvents.map((event) => ("turnId" in event ? event.turnId : 0)),
      ...(record?.messages.map((message) => message.turnId ?? 0) ?? []),
    ) + 1;

  const session: WorkbenchSnapshot = record?.session
    ? { ...record.session, events: existingEvents, uiState: { kind: "IDLE" } }
    : emptySnapshot(existingEvents);

  let checkpointStore: CheckpointStore | undefined;
  let checkpoint: FileCheckpoint | undefined;
  if (record) {
    checkpointStore = new CheckpointStore(workspace, record.metadata.id, dataRoot);
    // Finish any restore journal left behind by a crash before taking a new "before" snapshot.
    await checkpointStore.recover();
    checkpoint = {
      id: String(nextEventId()),
      turnId,
      messageCount: record.messages.length,
      prompt,
      before: await checkpointStore.capture(),
    };
    session.checkpoints = [...session.checkpoints, checkpoint];
  }
  // A new turn supersedes any boundary the user restored to in the TUI.
  session.restoredFileBoundary = undefined;

  session.events.push({ id: nextEventId(), type: "user", createdAt: startedAt, turnId, prompt });
  const run = createRunEvent({
    id: nextEventId(),
    turnId,
    backendId: context.runtime.provider,
    backendLabel: context.provider.label,
    runtime: context.runtime,
    prompt: submitted,
    startedAtMs: startedAt,
  });
  session.events.push(run);

  return { session, run, turnId, nextEventId, checkpointStore, checkpoint };
}

// ─── Persistence during the run ───────────────────────────────────────────────

/**
 * Mirrors the run into the session record while it streams.
 *
 * Writes are debounced, so a crash mid-run still leaves a recent partial answer on
 * disk without a write for every token. Errors during a debounced write are reported
 * and swallowed, so that a full disk cannot abort the run. Errors from `save()` itself
 * (the initial and final writes) propagate.
 */
function createSessionRecorder(params: {
  record: ConversationRecord | undefined;
  store: ConversationStore;
  turn: Turn;
  stderr: HeadlessExecIo["stderr"];
  onHarnessSession: (id: string | undefined) => void;
}) {
  const { record, store, turn, stderr } = params;
  const { session, run } = turn;
  const budget = new ToolOutputBudget();
  let assistant: AssistantEvent | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    if (!record) return;
    record.session = session;
    store.save(record);
  };
  const scheduleSave = () => {
    saveTimer ??= setTimeout(() => {
      saveTimer = undefined;
      try {
        save();
      } catch (error) {
        stderr.write(`[ubume exec] save: ${errorMessage(error)}\n`);
      }
    }, SAVE_DEBOUNCE_MS);
  };
  const cancelScheduledSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
  };
  /** Creates the assistant event the first time it is needed, then replaces its content. */
  const setAnswer = (text: string) => {
    if (!assistant) {
      assistant = {
        id: turn.nextEventId(),
        type: "assistant",
        createdAt: Date.now(),
        turnId: turn.turnId,
        content: "",
        contentChunks: [],
      };
      session.events.push(assistant);
    }
    assistant.content = text;
    assistant.contentChunks = [];
    scheduleSave();
  };

  const handlers: NonNullable<HeadlessExecOptions["handlers"]> = {
    onAssistantDelta: (chunk) => setAnswer((assistant?.content ?? "") + chunk),
    onResponse: setAnswer,
    onProgress: (update) => {
      const previous = run.progressEntries.find((entry) => entry.id === update.id);
      if (previous) previous.text = update.text;
      else if (run.progressEntries.length < MAX_PROGRESS_ENTRIES)
        run.progressEntries.push({
          ...update,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sequence: run.progressEntries.length + 1,
          pendingNewlineCount: 0,
          blocks: [],
        });
      scheduleSave();
    },
    onToolActivity: (activity) => {
      const bounded = budget.bound(activity);
      const index = run.toolActivities.findIndex((item) => item.id === activity.id);
      if (index >= 0) run.toolActivities[index] = bounded;
      else if (run.toolActivities.length < MAX_TOOL_ACTIVITIES) run.toolActivities.push(bounded);
      scheduleSave();
    },
    onLocalContextCheckpoint: (checkpoint) => {
      if (record) record.metadata.localContextCheckpoint = checkpoint;
      scheduleSave();
    },
    onNativeSession: (reference) => {
      if (record)
        record.metadata.nativeSessions = [
          ...(record.metadata.nativeSessions ?? []).filter(
            (previous) =>
              previous.source !== reference.source || previous.sessionId !== reference.sessionId,
          ),
          reference,
        ];
      scheduleSave();
    },
    onLocalHarnessSession: (metadata, id) => {
      params.onHarnessSession(id);
      if (record) {
        if (metadata) record.metadata.localHarnessSession = metadata;
        else delete record.metadata.localHarnessSession;
      }
      scheduleSave();
    },
    // Headless runs never approve tools interactively.
    onToolApproval: async () => "deny",
  };

  return { save, setAnswer, cancelScheduledSave, handlers };
}

// ─── Finalization ─────────────────────────────────────────────────────────────

/** Maps a headless exit code onto the persisted run status. */
export function runStatusForExitCode(exitCode: number): RunEvent["status"] {
  if (exitCode === EXIT_CODE.OK) return "completed";
  if (exitCode === EXIT_CODE.INTERRUPTED) return "canceled";
  return "failed";
}

/**
 * Closes out the run event. Tools still marked `running` are recorded as failed and
 * interrupted, because the provider has stopped and they cannot finish.
 */
function finalizeRunEvent(run: RunEvent, result: HeadlessExecResult, startedAt: number): void {
  run.status = runStatusForExitCode(result.exitCode);
  run.summary = result.exitCode === EXIT_CODE.OK ? "Completed" : (result.error ?? "Run failed");
  run.durationMs = Date.now() - startedAt;
  for (const tool of run.toolActivities) {
    if (tool.status === "running") {
      tool.status = "failed";
      tool.summary = "Interrupted";
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Runs one headless turn and records it in a new or resumed session.
 *
 * Order of operations:
 * 1. Load the resume target.
 * 2. Resolve the context.
 * 3. Take the execution lock.
 * 4. Verify file recovery.
 * 5. Create the record.
 * 6. Expand attachments.
 * 7. Checkpoint and append the turn events.
 * 8. Save.
 * 9. Run.
 * 10. Finalize, take the "after" checkpoint, and save again.
 *
 * Steps 1–5 throw before anything is executed or recorded for this turn.
 *
 * All stderr output from this point on is redacted with the configured provider API
 * keys. The `[ubume exec] session: <id>` line on stderr is the stable way for scripts
 * to discover the session id outside `--json` mode.
 *
 * @param options - Run options; `workspaceRoot` must already be canonical.
 * @param io - Output channels; stdout is passed to the runner unchanged.
 * @returns The runner result with a redacted `error`, and `sessionId` when one was saved.
 * @throws {CommandError} for busy or missing sessions, plan review, pending file recovery,
 *   or an unavailable route (exit 3).
 */
export async function runSavedExec(
  options: SavedExecOptions,
  io: HeadlessExecIo,
): Promise<SavedExecResult> {
  const workspace = options.workspaceRoot;
  const dataRoot = resolveUbumeWorkspaceDataDir(workspace, { readOnly: options.noSave ?? false });
  // Swapped for a redacting stream once the provider secrets are known (below), so that
  // later store diagnostics are redacted too.
  let stderr: HeadlessExecIo["stderr"] = io.stderr;
  const store = new ConversationStore(workspace, {
    ownership: true,
    onDiagnostic: (message) => stderr.write(`${message}\n`),
  });
  let execution: ReturnType<typeof acquireOwnership> | undefined;
  let harnessToClose: string | undefined;

  try {
    let record = options.resumeId ? loadResumeRecord(store, options.resumeId) : undefined;
    const context =
      options.context ??
      resolveExecutionContext(workspace, options.launchArgs, {
        providerId: options.providerId,
        saved: record,
      });
    // Mistral's model list comes from the Vibe CLI. Refresh it so that the routed model
    // is validated against what the installed CLI actually offers.
    if (!options.context && context.route.providerId === "mistral") {
      await refreshProviderModels("mistral", {
        cwd: workspace,
        providerConfig: context.config.providers?.mistral,
      });
    }

    const secrets = providerSecrets(context.config);
    const redactedIo: HeadlessExecIo = {
      stdout: io.stdout,
      stderr: { write: (text: string) => io.stderr.write(String(redact(text, secrets))) },
    };
    stderr = redactedIo.stderr;

    execution = acquireOwnership(workspace, "execution");
    try {
      await assertFileRecoveryReady(workspace, options.resumeId);
    } catch (error) {
      throw new CommandError(errorMessage(error));
    }
    if (!options.noSave) {
      record ??= store.createConversation(context.route);
      store.acquire(record.metadata.id);
      record.metadata = { ...record.metadata, ...context.route };
    }

    const submitted = await buildSubmittedPrompt(options.prompt, options.files ?? [], workspace);
    const startedAt = Date.now();
    const turn = await startTurn({
      record,
      workspace,
      dataRoot,
      prompt: options.prompt,
      submitted,
      context,
      startedAt,
    });
    const recorder = createSessionRecorder({
      record,
      store,
      turn,
      stderr: redactedIo.stderr,
      onHarnessSession: (id) => {
        harnessToClose = id;
      },
    });

    // The provider sees the history from before this turn; the record gains the new
    // user message right away, so that a crash mid-run still saves the prompt.
    const history = record ? { ...record, messages: [...record.messages] } : undefined;
    record?.messages.push({
      role: "user",
      content: options.prompt,
      submittedContent: submitted,
      turnId: turn.turnId,
      createdAt: startedAt,
    });
    turn.session.history = [options.prompt, ...turn.session.history].slice(0, MAX_PROMPT_HISTORY);
    recorder.save();

    let result: HeadlessExecResult;
    try {
      result = await runHeadlessExec(
        {
          ...options,
          prompt: submitted,
          saved: history,
          context,
          handlers: recorder.handlers,
        },
        redactedIo,
      );
    } finally {
      recorder.cancelScheduledSave();
    }

    // setAnswer schedules another debounced write; cancel it, because the final save below covers it.
    if (result.text) recorder.setAnswer(result.text);
    recorder.cancelScheduledSave();
    finalizeRunEvent(turn.run, result, startedAt);
    if (result.text) {
      record?.messages.push({
        role: "assistant",
        content:
          result.text + (result.exitCode === EXIT_CODE.INTERRUPTED ? "\n\n[Run interrupted]" : ""),
        turnId: turn.turnId,
        createdAt: Date.now(),
        activitySummary: turn.run.toolActivities
          .map((tool) => `${tool.status}: ${tool.command}`)
          .join("\n"),
      });
    }
    if (turn.checkpoint && turn.checkpointStore) {
      turn.checkpoint.after = await turn.checkpointStore.capture();
    }
    recorder.save();
    if (record) redactedIo.stderr.write(`[ubume exec] session: ${record.metadata.id}\n`);

    return {
      ...result,
      ...(result.error ? { error: String(redact(result.error, secrets)) } : {}),
      ...(record ? { sessionId: record.metadata.id } : {}),
    };
  } finally {
    try {
      // A Local harness session spans only this process; close it so that the server does not leak it.
      if (harnessToClose) await closeLocalHarnessSession(harnessToClose);
    } finally {
      execution?.release();
      store.release();
    }
  }
}
