/**
 * The pending prompt queue.
 *
 * Prompts submitted while a run is active wait here instead of being sent
 * immediately; the app drains the queue whenever it becomes idle again (see
 * `app/run/usePlanFlow`). The queue is deliberately plain mutable state that
 * is independent of React commits, so duplicate effects cannot dispatch the
 * same prompt twice.
 */

import { randomUUID } from "node:crypto";
import type { ProviderImageAttachment } from "../core/providerRuntime/types.js";

export interface QueuedPrompt {
  /** Stable identity used for removal, reordering and queue-state tracking. */
  id: string;
  /** Text shown in the transcript and queue UI. */
  display: string;
  /** Text handed to the provider. */
  submitted: string;
  images: ProviderImageAttachment[];
  createdAt: number;
}

/** Creates a queued prompt with a fresh identity. */
export function queuedPrompt(
  display: string,
  submitted: string,
  images: readonly ProviderImageAttachment[] = [],
): QueuedPrompt {
  return { id: randomUUID(), display, submitted, images: [...images], createdAt: Date.now() };
}

/**
 * FIFO queue of prompts waiting for the active run to finish.
 *
 * Draining is single-flight: while one drain is in flight, a second call
 * returns immediately instead of double-starting a prompt. A start that is
 * rejected (or throws) pauses the queue so the user stays in control of what
 * runs next; `restore` also pauses it until the next explicit drain.
 */
export class PromptQueue {
  items: QueuedPrompt[] = [];
  paused = false;
  private dispatching = false;

  push(item: QueuedPrompt): void {
    this.items = [...this.items, item];
  }

  remove(id: string): void {
    this.items = this.items.filter((item) => item.id !== id);
  }

  /** Moves the prompt with `id` by `direction` slots (-1 up, +1 down). */
  move(id: string, direction: number): void {
    const index = this.items.findIndex((item) => item.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= this.items.length) return;
    const items = [...this.items];
    [items[index], items[next]] = [items[next]!, items[index]!];
    this.items = items;
  }

  /** Replaces the queue's contents; used when restoring a saved snapshot. */
  restore(items: QueuedPrompt[]): void {
    this.items = [...items];
    this.paused = true;
  }

  /**
   * Starts the first queued prompt when the queue is running.
   *
   * `ready` is a second readiness check evaluated after the drain begins, so
   * a cancel or /clear that happened while waiting can still abort it. The
   * started prompt is removed only after `start` accepted it.
   *
   * @returns Whether a prompt was started.
   */
  async drain(
    start: (item: QueuedPrompt) => boolean | Promise<boolean>,
    ready?: () => Promise<boolean>,
  ): Promise<boolean> {
    if (this.paused || this.dispatching || !this.items.length) return false;

    this.dispatching = true;
    try {
      if (ready && !(await ready())) return false;
      if (this.paused || !this.items.length) return false;

      const item = this.items[0]!;
      if (!(await start(item))) {
        this.paused = true;
        return false;
      }

      this.remove(item.id);
      return true;
    } catch (error) {
      this.paused = true;
      throw error;
    } finally {
      this.dispatching = false;
    }
  }
}
