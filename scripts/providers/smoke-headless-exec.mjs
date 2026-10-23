#!/usr/bin/env node
/**
 * NOT OFFLINE-SAFE. Runs one real headless request through the installed launcher path
 * (`bin/ubume.js exec`, the same path Terminal-Bench uses) with the current directory,
 * environment, provider configuration and authentication. It contacts the configured provider
 * and consumes quota. Run it deliberately from a safe workspace; it is never part of `bun test`.
 *
 * Usage: bun run smoke:terminal-bench   (or: node scripts/providers/smoke-headless-exec.mjs)
 * Exit status: the launcher's exit code; 1 when it cannot start or is killed by a signal.
 */

import { spawn } from "node:child_process";
import { exitOnSpawnError } from "../lib/child-process.mjs";
import { repoPath } from "../lib/repo-root.mjs";

const PROMPT = "Print the current directory, list files, and stop.";

const child = spawn(process.execPath, [repoPath("bin", "ubume.js"), "exec", PROMPT], {
  cwd: process.cwd(),
  stdio: "inherit",
});

exitOnSpawnError(child, "smoke-headless-exec");

// A signal is a failed smoke (exit 1), not a re-raised signal like the dev launcher.
child.on("close", (code, signal) => {
  if (signal) {
    console.error(`[smoke-headless-exec] terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
