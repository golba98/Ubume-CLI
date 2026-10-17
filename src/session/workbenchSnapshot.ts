/**
 * The persisted workbench snapshot: validation, restoration and normalization.
 *
 * A `WorkbenchSnapshot` is the workbench half of a saved conversation — the
 * transcript events, composer draft and history, attachment registries, prompt
 * queue and file checkpoints. `conversationStore` serializes it into the
 * conversation record's `session` field and passes it back as untyped JSON,
 * so `parseWorkbench` is the trust boundary that decides whether a snapshot is
 * loadable. Its rules are deliberately conservative: every field family must
 * validate, or the whole snapshot is rejected (`undefined`), and invalid
 * `uiState`/`plan` fields fall back to safe idle states instead of failing the
 * load, so a partially understood snapshot still restores its transcript.
 */

import type { ProviderImageAttachment } from "../core/providerRuntime/types.js";
import type { FileBoundary, FileCheckpoint } from "../core/workspace/checkpoints.js";
import type { PlanFlowState } from "./planFlow.js";
import type { QueuedPrompt } from "./promptQueue.js";
import type { TimelineEvent, UIState } from "./types.js";

export interface FileAttachment {
  path: string;
  content?: string;
  hash?: string;
}

export interface WorkbenchSnapshot {
  version: 1;
  events: TimelineEvent[];
  uiState: UIState;
  plan: PlanFlowState;
  draft: string;
  cursor: number;
  history: string[];
  pastes: [string, string[]][];
  images: [string, ProviderImageAttachment][];
  files: [string, FileAttachment][];
  queue: QueuedPrompt[];
  checkpoints: FileCheckpoint[];
  restoredFileBoundary?: FileBoundary;
}

// ─── Untyped-JSON shape checks ────────────────────────────────────────────────

// Persisted snapshots are validated field by field; `any` keeps those chained
// shape checks readable, and every value is type-checked before use.
// biome-ignore lint/suspicious/noExplicitAny: guard for untyped JSON shape validation
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A [token, value] registry entry as persisted in the snapshot. */
function isRegistryEntry(value: unknown): value is [string, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

function isImageAttachment(value: unknown): value is ProviderImageAttachment {
  return (
    record(value) &&
    typeof value.path === "string" &&
    typeof value.name === "string" &&
    typeof value.mediaType === "string"
  );
}

/** A file checkpoint boundary: recorded hashes are sha-256 hex with sane modes. */
function isFileBoundary(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.complete === "boolean" &&
    strings(value.skipped) &&
    record(value.files) &&
    Object.values(value.files).every(
      (file) =>
        record(file) &&
        typeof file.hash === "string" &&
        /^[a-f0-9]{64}$/.test(file.hash) &&
        Number.isInteger(file.mode) &&
        file.mode >= 0 &&
        file.mode <= 0o777,
    )
  );
}

/** A streamed text block (response segment or plan block) as persisted. */
function isChunkBlock(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.id === "string" &&
    strings(value.chunks) &&
    ["active", "completed"].includes(value.status)
  );
}

/** The resolved runtime config recorded with a saved run event. */
function isPersistedRuntime(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.reasoningLevel === "string" &&
    typeof value.mode === "string" &&
    typeof value.planMode === "boolean" &&
    record(value.policy) &&
    typeof value.policy.approvalPolicy === "string" &&
    typeof value.policy.sandboxMode === "string" &&
    typeof value.policy.networkAccess === "boolean" &&
    strings(value.policy.writableRoots) &&
    typeof value.policy.serviceTier === "string" &&
    typeof value.policy.personality === "string"
  );
}

function isPersistedEvent(value: unknown): value is TimelineEvent {
  if (!record(value) || !Number.isInteger(value.id) || typeof value.createdAt !== "number")
    return false;

  switch (value.type) {
    case "user":
      return typeof value.prompt === "string" && Number.isInteger(value.turnId);
    case "assistant":
      return (
        typeof value.content === "string" &&
        Array.isArray(value.contentChunks) &&
        value.contentChunks.every((chunk: unknown) => typeof chunk === "string") &&
        Number.isInteger(value.turnId)
      );
    case "system":
    case "error":
      return typeof value.title === "string" && typeof value.content === "string";
    case "shell":
      return (
        typeof value.command === "string" &&
        strings(value.lines) &&
        strings(value.stderrLines) &&
        ["running", "completed", "failed"].includes(value.status)
      );
    case "run":
      return (
        Number.isInteger(value.turnId) &&
        isPersistedRuntime(value.runtime) &&
        typeof value.backendLabel === "string" &&
        typeof value.prompt === "string" &&
        ["running", "completed", "failed", "canceled"].includes(value.status) &&
        Array.isArray(value.toolActivities) &&
        value.toolActivities.every(
          (tool: unknown) =>
            record(tool) &&
            typeof tool.id === "string" &&
            typeof tool.command === "string" &&
            (tool.summary == null || typeof tool.summary === "string") &&
            ["running", "completed", "failed"].includes(tool.status) &&
            (tool.output === undefined || typeof tool.output === "string"),
        ) &&
        Array.isArray(value.activity) &&
        value.activity.every(
          (item: unknown) =>
            record(item) &&
            typeof item.path === "string" &&
            ["created", "modified", "deleted"].includes(item.operation) &&
            (item.diffLines === undefined ||
              (Array.isArray(item.diffLines) &&
                item.diffLines.every(
                  (line: unknown) =>
                    record(line) &&
                    ["added", "removed"].includes(line.kind) &&
                    typeof line.text === "string",
                ))),
        ) &&
        Array.isArray(value.progressEntries) &&
        value.progressEntries.every(
          (item: unknown) =>
            record(item) &&
            typeof item.id === "string" &&
            typeof item.text === "string" &&
            Array.isArray(item.blocks) &&
            item.blocks.every(
              (block: unknown) =>
                record(block) && typeof block.id === "string" && typeof block.text === "string",
            ),
        ) &&
        (value.responseSegments === undefined ||
          (Array.isArray(value.responseSegments) && value.responseSegments.every(isChunkBlock))) &&
        (value.streamItems === undefined ||
          (Array.isArray(value.streamItems) &&
            value.streamItems.every(
              (item: unknown) =>
                record(item) && typeof item.refId === "string" && Number.isInteger(item.streamSeq),
            ))) &&
        (!value.plan || isChunkBlock(value.plan)) &&
        typeof value.summary === "string"
      );
    default:
      return false;
  }
}

// ─── Snapshot field families ─────────────────────────────────────────────────

/**
 * The composer draft and its cursor. The cursor must stay inside the draft:
 * a stale cursor from a longer draft would corrupt editing after restore.
 */
function isEditableDraft(draft: unknown, cursor: unknown): boolean {
  if (typeof draft !== "string" || !Number.isInteger(cursor)) return false;
  const cursorPosition = cursor as number;
  return cursorPosition >= 0 && cursorPosition <= draft.length;
}

function hasPasteEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRegistryEntry(entry) &&
        Array.isArray(entry[1]) &&
        entry[1].every((text: unknown) => typeof text === "string"),
    )
  );
}

function hasImageEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => isRegistryEntry(entry) && isImageAttachment(entry[1]))
  );
}

function hasFileEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRegistryEntry(entry) &&
        record(entry[1]) &&
        typeof entry[1].path === "string" &&
        (entry[1].content === undefined || typeof entry[1].content === "string"),
    )
  );
}

function hasQueuedPrompts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        record(item) &&
        typeof item.id === "string" &&
        typeof item.display === "string" &&
        typeof item.submitted === "string" &&
        typeof item.createdAt === "number" &&
        Array.isArray(item.images) &&
        item.images.every(isImageAttachment),
    )
  );
}

function hasCheckpoints(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        record(item) &&
        typeof item.id === "string" &&
        Number.isInteger(item.turnId) &&
        Number.isInteger(item.messageCount) &&
        item.messageCount >= 0 &&
        typeof item.prompt === "string" &&
        (item.recoveryInvalidated === undefined || typeof item.recoveryInvalidated === "boolean") &&
        isFileBoundary(item.before) &&
        (item.after === undefined || isFileBoundary(item.after)),
    )
  );
}

// ─── Restoration ──────────────────────────────────────────────────────────────

/**
 * The UI state to restore. Only an awaiting-question state survives a restart;
 * anything mid-run is dropped because its run is gone.
 */
function restoredUiState(value: unknown): UIState {
  if (
    record(value) &&
    value.kind === "AWAITING_USER_ACTION" &&
    typeof value.question === "string" &&
    Number.isInteger(value.turnId)
  ) {
    return value as UIState;
  }
  return { kind: "IDLE" };
}

/**
 * The plan flow to restore. Only the user-facing review states survive a
 * restart; a generating or executing plan lost its run, so it restarts idle.
 */
function restoredPlanFlow(value: unknown): PlanFlowState {
  if (
    record(value) &&
    (value.kind === "awaiting_action" || value.kind === "collecting_feedback") &&
    typeof value.currentPlan === "string" &&
    typeof value.originalPrompt === "string" &&
    strings(value.constraints) &&
    ["suggest", "auto-edit", "full-auto"].includes(value.executionMode) &&
    (value.planFilePath === null || typeof value.planFilePath === "string") &&
    (value.kind !== "collecting_feedback" || ["revise", "constraints"].includes(value.mode))
  ) {
    return value as PlanFlowState;
  }
  return { kind: "idle" };
}

/**
 * Validates an untyped persisted snapshot and returns it as a
 * {@link WorkbenchSnapshot}, or `undefined` when any field family is invalid.
 *
 * The returned object is the parsed value itself, not a reconstruction: fields
 * this version does not know about survive loading and re-saving, so a
 * snapshot written by a newer Ubume keeps its extra data through a
 * round-trip on this version. `uiState` and `plan` are the only fields
 * replaced — invalid or mid-run values fall back to safe idle states.
 */
export function parseWorkbench(value: unknown): WorkbenchSnapshot | undefined {
  if (!record(value) || value.version !== 1) return undefined;
  if (!Array.isArray(value.events) || !value.events.every(isPersistedEvent)) return undefined;
  if (!isEditableDraft(value.draft, value.cursor)) return undefined;
  if (!strings(value.history)) return undefined;
  if (!hasPasteEntries(value.pastes)) return undefined;
  if (!hasImageEntries(value.images)) return undefined;
  if (!hasFileEntries(value.files)) return undefined;
  if (!hasQueuedPrompts(value.queue)) return undefined;
  if (!hasCheckpoints(value.checkpoints)) return undefined;
  if (value.restoredFileBoundary !== undefined && !isFileBoundary(value.restoredFileBoundary))
    return undefined;

  return {
    ...value,
    uiState: restoredUiState(value.uiState),
    plan: restoredPlanFlow(value.plan),
  } as WorkbenchSnapshot;
}

/**
 * Normalizes saved events for display after a restart.
 *
 * A conversation may have been saved mid-run (autosave runs during runs), so
 * everything still marked live is finalized as interrupted: running runs and
 * shells become canceled/failed, streaming assistant text is committed from
 * its chunks, and in-flight tools, progress blocks, response segments and plan
 * blocks are marked completed so nothing keeps live cursors.
 */
export function restoredEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return events.map((entry) => {
    if (entry.type === "assistant")
      return {
        ...entry,
        content: entry.contentChunks.length ? entry.contentChunks.join("") : entry.content,
        contentChunks: [],
      };
    if (entry.type === "run")
      return {
        ...entry,
        status: entry.status === "running" ? "canceled" : entry.status,
        summary:
          entry.status === "running" ? "Interrupted before the session closed" : entry.summary,
        toolActivities: entry.toolActivities.map((tool) =>
          tool.status === "running"
            ? { ...tool, status: "failed" as const, summary: "Interrupted" }
            : tool,
        ),
        progressEntries: entry.progressEntries.map((progress) => ({
          ...progress,
          blocks: progress.blocks.map((block) => ({ ...block, status: "completed" as const })),
        })),
        responseSegments: entry.responseSegments?.map((segment) => ({
          ...segment,
          status: "completed" as const,
        })),
        plan: entry.plan ? { ...entry.plan, status: "completed" } : entry.plan,
        activeResponseSegmentId: null,
      };
    if (entry.type === "shell" && entry.status === "running")
      return { ...entry, status: "failed", summary: "Interrupted before the session closed" };
    return entry;
  });
}

/** Untagged shell/system events belong to their position in the transcript. */
export function eventsBeforeTurn(
  events: readonly TimelineEvent[],
  turnId: number,
): TimelineEvent[] {
  const firstTurnEvent = events.findIndex((entry) => "turnId" in entry && entry.turnId >= turnId);
  return firstTurnEvent < 0 ? [...events] : events.slice(0, firstTurnEvent);
}
