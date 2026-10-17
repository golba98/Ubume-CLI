import { expect, test } from "bun:test";
import { settle, waitFor } from "./async.js";

test("settle yields to queued timer and promise work", async () => {
  let completed = false;
  setTimeout(() => {
    void Promise.resolve().then(() => {
      completed = true;
    });
  }, 0);
  await settle(1);
  expect(completed).toBe(true);
});

test("waitFor observes scheduled state and checks immediately when ready", async () => {
  let checks = 0;
  queueMicrotask(() => {
    checks = 1;
  });
  await waitFor(() => checks === 1, { label: "queued state", intervalMs: 1 });
  let calls = 0;
  await waitFor(
    () => {
      calls += 1;
      return true;
    },
    { label: "ready", timeoutMs: 0 },
  );
  expect(calls).toBe(1);
});

test("waitFor timeout includes the condition and current diagnostics", async () => {
  await expect(
    waitFor(() => false, {
      label: "provider ready",
      timeoutMs: 0,
      diagnostics: () => "frame: loading",
    }),
  ).rejects.toThrow("Timed out: provider ready\nframe: loading");
});

test("waitFor propagates predicate errors without retrying", async () => {
  const error = new Error("fixture failed");
  let checks = 0;
  await expect(
    waitFor(
      () => {
        checks += 1;
        throw error;
      },
      { label: "invalid" },
    ),
  ).rejects.toBe(error);
  expect(checks).toBe(1);
});

test("waitFor rejects invalid polling limits", async () => {
  for (const options of [
    { timeoutMs: -1 },
    { timeoutMs: Infinity },
    { intervalMs: 0 },
    { intervalMs: NaN },
  ])
    await expect(waitFor(() => false, { label: "invalid", ...options })).rejects.toBeInstanceOf(
      RangeError,
    );
});
