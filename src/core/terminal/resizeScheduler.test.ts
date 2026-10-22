import { expect, test } from "bun:test";
import { createResizeScheduler } from "./resizeScheduler.js";

test("resize commits leading dimensions, coalesces a burst and never starves a drag", () => {
  const callbacks = new Map<number, () => void>();
  let id = 0,
    width = 100;
  const seen: number[] = [];
  const scheduler = createResizeScheduler({
    commit: () => seen.push(width),
    schedule: ((callback: () => void) => {
      callbacks.set(++id, callback);
      return id;
    }) as unknown as typeof setTimeout,
    cancel: ((timer: number) => {
      callbacks.delete(timer);
    }) as unknown as typeof clearTimeout,
  });
  const tick = () => {
    const entry = callbacks.entries().next().value!;
    callbacks.delete(entry[0]);
    entry[1]();
  };
  scheduler.request();
  expect(seen).toEqual([100]);
  for (width of [120, 160, 200, 80, 60]) scheduler.request();
  expect(callbacks.size).toBe(1);
  tick();
  expect(seen).toEqual([100, 60]);
  width = 100;
  scheduler.request();
  tick();
  expect(seen).toEqual([100, 60, 100]);
  scheduler.dispose();
  expect(callbacks.size).toBe(0);
  scheduler.request();
  expect(seen).toHaveLength(3);
});
