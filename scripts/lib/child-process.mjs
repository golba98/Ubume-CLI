/**
 * Process helpers for launcher-style scripts that hand the terminal to a child process and must
 * report its outcome to the caller unchanged.
 */

/**
 * Mirrors the child's termination to this process: a fatal signal is re-raised on ourselves (so
 * shells see the same "killed by SIGINT" status), otherwise the child's exit code is returned.
 */
export function forwardChildExit(child) {
  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

/** Reports a child that could not be started and exits 1; `hint` explains how to fix it. */
export function exitOnSpawnError(child, label, hint) {
  child.on("error", (error) => {
    console.error(`${label}: failed to launch: ${error.message}`);
    if (hint) console.error(hint);
    process.exit(1);
  });
}
