/// <reference path="../../node_modules/bun-types/test.d.ts" />
import { expect, test } from "bun:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../config/runtimeConfig.js";
import { createInitialSessionState, reduceSessionState } from "./appSession.js";
import { toProviderConversationHistory } from "./conversation.js";
import type { PlanFlowState } from "./planFlow.js";
import type { RunEvent, UIState } from "./types.js";
import {
  eventsBeforeTurn,
  PromptQueue,
  parseWorkbench,
  queuedPrompt,
  restoredEvents,
  TOOL_OUTPUT_BYTES,
  ToolOutputBudget,
  type WorkbenchSnapshot,
} from "./workbench.js";

export function emptySnapshot(): WorkbenchSnapshot {
  return {
    version: 1,
    events: [],
    uiState: { kind: "IDLE" },
    plan: { kind: "idle" },
    draft: "draft",
    cursor: 3,
    history: ["earlier"],
    pastes: [],
    images: [],
    files: [],
    queue: [],
    checkpoints: [],
  };
}
test("queue is FIFO and duplicate async drains cannot dispatch twice", async () => {
  const queue = new PromptQueue();
  queue.push(queuedPrompt("first", "expanded first"));
  queue.push(queuedPrompt("second", "second"));
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: string[] = [];
  const start = queue.drain(async (item) => {
    received.push(item.submitted);
    await wait;
    return true;
  });
  expect(
    await queue.drain(() => {
      throw new Error("duplicate");
    }),
  ).toBe(false);
  release();
  await start;
  expect(received).toEqual(["expanded first"]);
  expect(queue.items.map((item) => item.display)).toEqual(["second"]);
});
test("failed acceptance retains instruction and pauses queue", async () => {
  const queue = new PromptQueue();
  queue.push(queuedPrompt("first", "first"));
  expect(await queue.drain(() => false)).toBe(false);
  expect(queue.items).toHaveLength(1);
  expect(queue.paused).toBe(true);
  queue.restore(queue.items);
  expect(await queue.drain(() => true)).toBe(false);
});
test("queue reorder and delete preserve immutable attachment input", () => {
  const queue = new PromptQueue();
  const first = queuedPrompt("chip", "file snapshot");
  const second = queuedPrompt("b", "b");
  queue.push(first);
  queue.push(second);
  queue.move(second.id, -1);
  queue.remove(first.id);
  expect(queue.items).toEqual([second]);
  expect(first.submitted).toBe("file snapshot");
});
test("resume validates snapshot, restores draft, and discards active process state", () => {
  const snapshot = emptySnapshot();
  snapshot.uiState = { kind: "THINKING", turnId: 99 };
  expect(parseWorkbench(snapshot)?.uiState).toEqual({ kind: "IDLE" });
  expect(parseWorkbench({ ...snapshot, files: [["token", null]] })).toBeUndefined();
  expect(parseWorkbench({ ...snapshot, queue: [{ id: "bad" }] })).toBeUndefined();
  expect(parseWorkbench({ ...snapshot, events: [{ id: 1, type: "run" }] })).toBeUndefined();
  const state = reduceSessionState(createInitialSessionState(), {
    type: "RESTORE_SESSION",
    events: [],
    value: snapshot.draft,
    cursor: snapshot.cursor,
    history: snapshot.history,
  });
  expect(state.inputValue).toBe("draft");
  expect(state.history).toEqual(["earlier"]);
  expect(state.activeEvents).toEqual([]);
});
test("restored partial replies stay visible and completed turns preserve IDs", () => {
  const events = restoredEvents([
    {
      type: "assistant",
      id: 1,
      createdAt: 1,
      turnId: 22,
      content: "",
      contentChunks: ["partial", " answer"],
    },
  ]);
  expect(events[0]).toMatchObject({ content: "partial answer", turnId: 22, contentChunks: [] });
});
test("history navigation restores original draft and cursor", () => {
  let state = {
    ...createInitialSessionState(),
    inputValue: "unsent",
    cursor: 2,
    history: ["old", "older"],
  };
  state = reduceSessionState(state, { type: "HISTORY_UP" });
  state = reduceSessionState(state, { type: "HISTORY_UP" });
  state = reduceSessionState(state, { type: "HISTORY_DOWN" });
  state = reduceSessionState(state, { type: "HISTORY_DOWN" });
  expect([state.inputValue, state.cursor]).toEqual(["unsent", 2]);
});
test("queued execution preserves independently edited draft", () => {
  const state = { ...createInitialSessionState(), inputValue: "next draft", cursor: 4 };
  const next = reduceSessionState(state, {
    type: "SUBMIT_PROMPT_RUN",
    turnId: 2,
    runId: 3,
    events: [],
    historyValue: "queued",
    preserveInput: true,
  });
  expect([next.inputValue, next.cursor]).toEqual(["next draft", 4]);
});
test("provider history uses exact submitted context rather than folded labels", () => {
  expect(
    toProviderConversationHistory(
      [{ role: "user", content: "[Pasted Content 1,000 chars]", submittedContent: "full context" }],
      { includeActivitySummaries: false },
    ),
  ).toEqual([{ role: "user", content: "full context" }]);
});
test("tool output is byte bounded without charging repeated updates twice", () => {
  const budget = new ToolOutputBudget();
  const tool = {
    id: "same",
    command: "echo",
    status: "completed" as const,
    startedAt: 1,
    output: "字".repeat(TOOL_OUTPUT_BYTES),
  };
  const first = budget.bound(tool),
    second = budget.bound(tool);
  expect(Buffer.byteLength(first.output!)).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
  expect(first.outputTruncated).toBe(true);
  expect(second.output).toBe(first.output);
});

test("resume finalizes streamed segments so interrupted turns do not keep live cursors", () => {
  const run: RunEvent = {
    id: 1,
    type: "run",
    createdAt: 1,
    turnId: 1,
    backendId: "codex-subprocess",
    backendLabel: "Codex",
    runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})),
    prompt: "prompt",
    summary: "",
    status: "running",
    progressEntries: [],
    toolActivities: [],
    activity: [],
    touchedFileCount: 0,
    truncatedOutput: false,
    startedAt: 1,
    durationMs: null,
    responseSegments: [
      { id: "segment", streamSeq: 1, chunks: ["partial"], status: "active", startedAt: 1 },
    ],
    plan: { id: "plan", streamSeq: 2, chunks: ["partial plan"], status: "active", startedAt: 1 },
    activeResponseSegmentId: "segment",
  };
  const restored = restoredEvents([run])[0] as RunEvent;
  expect(restored.status).toBe("canceled");
  expect(restored.responseSegments?.[0]?.status).toBe("completed");
  expect(restored.plan?.status).toBe("completed");
  expect(restored.activeResponseSegmentId).toBeNull();
  expect(run.responseSegments?.[0]?.status).toBe("active");
});

test("queue rechecks pause, removal, and order after shutdown completes", async () => {
  for (const change of ["pause", "remove", "reorder"] as const) {
    const queue = new PromptQueue();
    const first = queuedPrompt("first", "first");
    const second = queuedPrompt("second", "second");
    queue.push(first);
    queue.push(second);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const draining = queue.drain(
      (item) => {
        started.push(item.id);
        return true;
      },
      async () => {
        await ready;
        return true;
      },
    );
    if (change === "pause") queue.paused = true;
    else if (change === "remove") queue.remove(first.id);
    else queue.move(second.id, -1);
    release();
    await draining;
    expect(started).toEqual(change === "pause" ? [] : [second.id]);
  }
});

test("conversation rewind drops later events without turn IDs", () => {
  const events = [
    { type: "system" as const, id: 1, createdAt: 1, title: "before", content: "keep" },
    { type: "user" as const, id: 2, createdAt: 2, turnId: 1, prompt: "first" },
    { type: "user" as const, id: 3, createdAt: 3, turnId: 2, prompt: "rewind here" },
    { type: "system" as const, id: 4, createdAt: 4, title: "later", content: "discard" },
  ];
  expect(eventsBeforeTurn(events, 2).map((entry) => entry.id)).toEqual([1, 2]);
});

// ─── Snapshot validation (parseWorkbench) ─────────────────────────────────────

/** A snapshot with one field family replaced by an intentionally bad value. */
function corruptSnapshot(patch: Record<string, unknown>): unknown {
  return { ...emptySnapshot(), ...patch };
}

test("snapshot validation rejects every corrupt field family", () => {
  // A cursor beyond the draft would corrupt editing after restore.
  expect(parseWorkbench(corruptSnapshot({ cursor: 99 }))).toBeUndefined();

  expect(parseWorkbench(corruptSnapshot({ history: ["ok", 5] }))).toBeUndefined();

  expect(parseWorkbench(corruptSnapshot({ pastes: [["token", ["line", 7]]] }))).toBeUndefined();

  expect(
    parseWorkbench(corruptSnapshot({ images: [["token", { path: "/p", name: "n" }]] })),
  ).toBeUndefined();

  expect(
    parseWorkbench(
      corruptSnapshot({
        checkpoints: [
          { id: "cp", turnId: 0, messageCount: 0, prompt: "p", before: { complete: true } },
        ],
      }),
    ),
  ).toBeUndefined();

  expect(
    parseWorkbench(
      corruptSnapshot({
        restoredFileBoundary: { complete: "yes", skipped: [], files: {} },
      }),
    ),
  ).toBeUndefined();
});

test("snapshot checkpoints validate their file boundaries", () => {
  const validBoundary = {
    complete: true,
    skipped: [],
    files: { "a.txt": { hash: "a".repeat(64), mode: 0o644 } },
  };
  const checkpoint = {
    id: "cp-1",
    turnId: 2,
    messageCount: 2,
    prompt: "do it",
    before: validBoundary,
  };

  expect(parseWorkbench(corruptSnapshot({ checkpoints: [checkpoint] }))?.checkpoints).toEqual([
    checkpoint,
  ]);

  expect(
    parseWorkbench(
      corruptSnapshot({
        checkpoints: [
          {
            ...checkpoint,
            before: { ...validBoundary, files: { "a.txt": { hash: "zz", mode: 6 } } },
          },
        ],
      }),
    ),
  ).toBeUndefined();
});

test("restore keeps only the ui and plan states that survive a restart", () => {
  // An awaiting question survives; mid-run states restart idle.
  const awaiting: UIState = { kind: "AWAITING_USER_ACTION", turnId: 4, question: "Which file?" };
  expect(parseWorkbench(corruptSnapshot({ uiState: awaiting }))?.uiState).toEqual(awaiting);
  expect(
    parseWorkbench(corruptSnapshot({ uiState: { kind: "RESPONDING", turnId: 9 } }))?.uiState,
  ).toEqual({ kind: "IDLE" });

  // The user-facing plan review states survive; a generating plan restarts idle.
  const reviewPlan: PlanFlowState = {
    kind: "awaiting_action",
    originalPrompt: "p",
    executionMode: "auto-edit",
    constraints: [],
    planFilePath: null,
    currentPlan: "the plan",
  };
  expect(parseWorkbench(corruptSnapshot({ plan: reviewPlan }))?.plan).toEqual(reviewPlan);
  expect(
    parseWorkbench(
      corruptSnapshot({
        plan: {
          kind: "generating",
          originalPrompt: "p",
          executionMode: "suggest",
          constraints: [],
          planFilePath: null,
          currentPlan: null,
          pendingFeedback: null,
        },
      }),
    )?.plan,
  ).toEqual({ kind: "idle" });
});

test("unknown snapshot fields from a newer version survive a parse round-trip", () => {
  const parsed = parseWorkbench(corruptSnapshot({ futureField: { nested: true } }));
  expect((parsed as Record<string, unknown> | undefined)?.futureField).toEqual({ nested: true });
});

test("restoring queue contents pauses draining until the queue is unpaused", async () => {
  const queue = new PromptQueue();
  queue.restore([queuedPrompt("display", "submitted")]);

  expect(queue.paused).toBe(true);
  expect(queue.items).toHaveLength(1);

  const started: string[] = [];
  const pausedDrain = await queue.drain((item) => {
    started.push(item.submitted);
    return true;
  });
  expect(pausedDrain).toBe(false);
  expect(started).toEqual([]);

  queue.paused = false;
  const activeDrain = await queue.drain((item) => {
    started.push(item.submitted);
    return true;
  });
  expect(activeDrain).toBe(true);
  expect(started).toEqual(["submitted"]);
  expect(queue.items).toHaveLength(0);
});
