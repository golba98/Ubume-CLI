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
  // Buffered lines per stream, plus the flush timer.
  let pendingStdout: string[] = [];
  let pendingStderr: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    const stdout = pendingStdout;
    const stderr = pendingStderr;
    pendingStdout = [];
    pendingStderr = [];
    if (stdout.length === 0 && stderr.length === 0) return;
    emit(stdout, stderr);
  };

  const enqueue = (stream: "stdout" | "stderr", lines: string[]) => {
    const pending = stream === "stdout" ? pendingStdout : pendingStderr;
    for (const line of lines) pending.push(line);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, LIVE_UPDATE_FLUSH_MS);
  };

  const cancel = () => {
    clearTimer();
    pendingStdout = [];
    pendingStderr = [];
  };
  return { enqueue, flush, cancel };
}
