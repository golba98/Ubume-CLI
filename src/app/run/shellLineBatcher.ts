/**
 * Batches shell output lines so a chatty command produces one transcript
 * update per flush interval instead of one per line.
 */

import { LIVE_UPDATE_FLUSH_MS } from "./promptRunPrep.js";

/**
 * Creates a batcher that collects stdout/stderr lines and emits them together
 * at most once per {@link LIVE_UPDATE_FLUSH_MS}. `flush` emits immediately
 * (and is a no-op when nothing is pending); `cancel` drops the pending timer
 * without emitting.
 */
export function createShellLineBatcher(emit: (stdout: string[], stderr: string[]) => void) {
  let pendingStdout: string[] = [];
  let pendingStderr: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const flush = () => {
    cancel();
    const stdout = pendingStdout;
    const stderr = pendingStderr;
    pendingStdout = [];
    pendingStderr = [];
    if (stdout.length === 0 && stderr.length === 0) return;
    emit(stdout, stderr);
  };
  const enqueue = (stream: "stdout" | "stderr", lines: string[]) => {
    (stream === "stdout" ? pendingStdout : pendingStderr).push(...lines);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, LIVE_UPDATE_FLUSH_MS);
  };
  return { enqueue, flush, cancel };
}
