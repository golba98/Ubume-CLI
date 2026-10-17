import { describe, expect, test } from "bun:test";
import { createFakeClock } from "./fakeClock.js";

describe("createFakeClock", () => {
  test("fires in deadline order and preserves insertion order at equal deadlines", async () => {
    const clock = createFakeClock();
    const fired: string[] = [];
    clock.setTimer(() => fired.push(`late:${clock.now()}`), 20);
    clock.setTimer(() => fired.push(`first:${clock.now()}`), 10);
    clock.setTimer(() => fired.push(`second:${clock.now()}`), 10);
    await clock.advance(20);
    expect(fired).toEqual(["first:10", "second:10", "late:20"]);
    expect(clock.now()).toBe(20);
    expect(clock.pending()).toEqual([]);
  });

  test("cancels handles and retains timers beyond the advance window", async () => {
    const clock = createFakeClock();
    let calls = 0;
    const cancelled = clock.setTimer(() => calls++, 1);
    const retained = clock.setTimer(() => calls++, 11);
    if (typeof retained !== "number") throw new Error("Expected numeric fake timer handle");
    clock.clearTimer(cancelled);
    clock.clearTimer(cancelled);
    await clock.advance(10);
    expect(calls).toBe(0);
    expect(clock.pending().map((timer) => timer.id)).toEqual([retained]);
    await clock.advance(1);
    expect(calls).toBe(1);
  });

  test("runs newly scheduled timers within the same advance window", async () => {
    const clock = createFakeClock();
    const fired: number[] = [];
    clock.setTimer(() => {
      fired.push(clock.now());
      void Promise.resolve().then(() => {
        clock.setTimer(() => fired.push(clock.now()), 3);
      });
    }, 2);
    await clock.advance(5);
    expect(fired).toEqual([2, 5]);
  });

  test("pending snapshots cannot mutate timer scheduling or callbacks", async () => {
    const clock = createFakeClock();
    let calls = 0;
    clock.setTimer(() => calls++, 10);
    const snapshot = clock.pending();
    const timer = snapshot[0];
    expect(timer).toBeDefined();
    if (!timer) throw new Error("Expected scheduled timer");
    timer.at = 0;
    timer.fn = () => {
      throw new Error("Snapshot callback must not replace the timer");
    };
    snapshot.pop();
    await clock.advance(9);
    expect(calls).toBe(0);
    await clock.advance(1);
    expect(calls).toBe(1);
  });
});
