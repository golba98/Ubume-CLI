import type { BackendRunHandlers } from "./types.js";

/** A logical run can retry subprocesses; it stops only after every owned task settles. */
export function createRunControl(handlers: BackendRunHandlers) {
  let resolve: () => void = () => undefined;
  let pending = 0;
  let finished = false;
  const stopped = new Promise<void>((done) => {
    resolve = done;
  });
  const settle = () => {
    if (finished && pending === 0) resolve();
  };
  handlers.onRunControl?.({ stopped });
  return {
    stopped,
    /** Register owned work before finish; rejection still counts as settled cleanup. */
    track<T>(promise: Promise<T>): Promise<T> {
      pending++;
      void promise.then(
        () => {
          pending--;
          settle();
        },
        () => {
          pending--;
          settle();
        },
      );
      return promise;
    },
    /** Marks logical completion; stopped resolves only after the registered work settles. */
    finish() {
      finished = true;
      settle();
    },
  };
}
