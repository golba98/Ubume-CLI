import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveRenderScheduler,
  type LiveRenderUpdate,
  schedulePromptRunStartAfterVisibleCommit,
} from "./liveRenderScheduler.js";

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
};

function createFakeTimers() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimer(callback: () => void, delayMs: number) {
      const timer: FakeTimer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer: ReturnType<typeof setTimeout>) {
      (timer as unknown as FakeTimer).cleared = true;
    },
  };
}

function progress(id: string, text: string): LiveRenderUpdate {
  return { type: "progress", update: { id, source: "reasoning", text } };
}

function tool(id: string, status: "running" | "completed"): LiveRenderUpdate {
  return {
    type: "tool",
    activity: {
      id,
      command: "Get-Content README.md",
      status,
      startedAt: 1,
      completedAt: status === "completed" ? 2 : undefined,
    },
  };
}

test("coalesces adjacent assistant chunks at the cadence flush", () => {
  const flushed: LiveRenderUpdate[][] = [];
  const fakeTimers = createFakeTimers();
  const scheduler = createLiveRenderScheduler({
    assistantFlushMs: 50,
    progressOnlyFlushMs: 50,
    flush: (updates) => flushed.push(updates),
    setTimer: fakeTimers.setTimer,
    clearTimer: fakeTimers.clearTimer,
  });

  scheduler.enqueue({ type: "assistant", chunk: "Hello" });
  scheduler.enqueue({ type: "assistant", chunk: ", world" });

  assert.equal(flushed.length, 0);
  assert.equal(fakeTimers.timers.length, 1);
  assert.equal(fakeTimers.timers[0]?.delayMs, 50);
  fakeTimers.timers[0]!.callback();

  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0], [{ type: "assistant", chunk: "Hello, world" }]);
});

test("first progress-only update waits for the progress cadence", () => {
  const flushed: LiveRenderUpdate[][] = [];
  const fakeTimers = createFakeTimers();
  const scheduler = createLiveRenderScheduler({
    assistantFlushMs: 50,
    progressOnlyFlushMs: 50,
    flush: (updates) => flushed.push(updates),
    setTimer: fakeTimers.setTimer,
    clearTimer: fakeTimers.clearTimer,
  });

  scheduler.enqueue(tool("t1", "running"));

  assert.equal(flushed.length, 0);
  assert.equal(fakeTimers.timers.length, 1);
  assert.equal(fakeTimers.timers[0]?.delayMs, 50);

  fakeTimers.timers[0]!.callback();
  assert.deepEqual(
    flushed[0]?.map((update) => update.type),
    ["tool"],
  );
});

test("preserves event order while keeping only the latest same-id progress update", () => {
  const flushed: LiveRenderUpdate[][] = [];
  const scheduler = createLiveRenderScheduler({
    assistantFlushMs: 50,
    progressOnlyFlushMs: 50,
    flush: (updates) => flushed.push(updates),
  });

  scheduler.enqueue(progress("p1", "Thinking"));
  scheduler.enqueue(tool("t1", "running"));
  scheduler.enqueue({ type: "assistant", chunk: "First" });
  scheduler.enqueue({ type: "assistant", chunk: " segment" });
  scheduler.enqueue(progress("p1", "Thinking harder"));
  scheduler.flushNow();

  assert.deepEqual(
    flushed[0]?.map((update) => update.type),
    ["progress", "tool", "assistant"],
  );
  assert.equal(
    (flushed[0]?.[2] as Extract<LiveRenderUpdate, { type: "assistant" }>).chunk,
    "First segment",
  );
  assert.equal(
    (flushed[0]?.[0] as Extract<LiveRenderUpdate, { type: "progress" }>).update.text,
    "Thinking harder",
  );
});

test("coalesces repeated keyed progress and tool updates across a noisy flush window", () => {
  const flushed: LiveRenderUpdate[][] = [];
  const scheduler = createLiveRenderScheduler({
    assistantFlushMs: 50,
    progressOnlyFlushMs: 175,
    flush: (updates) => flushed.push(updates),
  });

  scheduler.enqueue(progress("p1", "Reading file 1"));
  scheduler.enqueue(tool("t1", "running"));
  scheduler.enqueue(progress("p1", "Reading file 2"));
  scheduler.enqueue(tool("t1", "completed"));
  scheduler.enqueue(progress("p2", "Listing files"));
  scheduler.flushNow();

  assert.deepEqual(
    flushed[0]?.map((update) => update.type),
    ["progress", "tool", "progress"],
  );
  assert.equal(
    (flushed[0]?.[0] as Extract<LiveRenderUpdate, { type: "progress" }>).update.text,
    "Reading file 2",
  );
  assert.equal(
    (flushed[0]?.[1] as Extract<LiveRenderUpdate, { type: "tool" }>).activity.status,
    "completed",
  );
});

test("records scheduler flush diagnostics", () => {
  const flushed: LiveRenderUpdate[][] = [];
  const fakeTimers = createFakeTimers();
  const scheduler = createLiveRenderScheduler({
    assistantFlushMs: 50,
    progressOnlyFlushMs: 175,
    flush: (updates) => flushed.push(updates),
    setTimer: fakeTimers.setTimer,
    clearTimer: fakeTimers.clearTimer,
  });

  scheduler.enqueue(progress("p1", "Listing files"));
  assert.equal(scheduler.getStats().providerEvents, 1);
  assert.equal(fakeTimers.timers[0]?.delayMs, 175);
  fakeTimers.timers[0]!.callback();

  scheduler.enqueue({ type: "assistant", chunk: "hello" });
  assert.equal(fakeTimers.timers[1]?.delayMs, 50);
  fakeTimers.timers[1]!.callback();

  const stats = scheduler.getStats();
  assert.equal(stats.providerEvents, 2);
  assert.equal(stats.flushes, 2);
  assert.ok(stats.maxFlushIntervalMs >= 0);
  assert.ok(stats.averageFlushIntervalMs >= 0);
});

test("prevents reentrant flushes when a producer enqueues during a flush", () => {
  const flushed: LiveRenderUpdate[][] = [];
  let inFlush = false;
  let scheduler: ReturnType<typeof createLiveRenderScheduler>;

  scheduler = createLiveRenderScheduler({
    assistantFlushMs: 50,
    progressOnlyFlushMs: 50,
    flush: (updates) => {
      assert.equal(inFlush, false, "flush should not reenter itself");
      inFlush = true;
      flushed.push(updates);
      if (flushed.length === 1) {
        scheduler.enqueue({ type: "assistant", chunk: "queued during flush" });
      }
      inFlush = false;
    },
  });

  scheduler.enqueue({ type: "assistant", chunk: "first" });

  assert.equal(scheduler.flushNow(), true);
  assert.equal(flushed.length, 2);
  assert.equal(
    (flushed[0]?.[0] as Extract<LiveRenderUpdate, { type: "assistant" }>).chunk,
    "first",
  );
  assert.equal(
    (flushed[1]?.[0] as Extract<LiveRenderUpdate, { type: "assistant" }>).chunk,
    "queued during flush",
  );
});

test("flushNow drains queued updates before finalization", () => {
  const flushed: LiveRenderUpdate[][] = [];
  const fakeTimers = createFakeTimers();
  const scheduler = createLiveRenderScheduler({
    assistantFlushMs: 50,
    progressOnlyFlushMs: 50,
    flush: (updates) => flushed.push(updates),
    setTimer: fakeTimers.setTimer,
    clearTimer: fakeTimers.clearTimer,
  });

  scheduler.enqueue({ type: "assistant", chunk: "final chunk" });

  assert.equal(scheduler.flushNow(), true);
  assert.equal(flushed.length, 1);
  assert.equal(scheduler.hasPendingUpdates(), false);

  assert.equal(fakeTimers.timers[0]?.cleared, true);
  fakeTimers.timers[0]?.callback();
  assert.equal(flushed.length, 1);
});

// ─── Prompt-run start scheduling ──────────────────────────────────────────────

function waitForTimerTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
test("schedulePromptRunStartAfterVisibleCommit waits past the reducer microtask before starting work", async () => {
  const order: string[] = [];

  schedulePromptRunStartAfterVisibleCommit(() => {
    order.push("provider-started");
  });
  order.push("visible-run-dispatched");

  await Promise.resolve();
  assert.deepEqual(order, ["visible-run-dispatched"]);

  await waitForTimerTurn();
  assert.deepEqual(order, ["visible-run-dispatched", "provider-started"]);
});

test("schedulePromptRunStartAfterVisibleCommit can be canceled before provider start", async () => {
  let started = false;

  const cancel = schedulePromptRunStartAfterVisibleCommit(() => {
    started = true;
  });
  cancel();

  await Promise.resolve();
  await waitForTimerTurn();

  assert.equal(started, false);
});
