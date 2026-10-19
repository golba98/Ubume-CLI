#!/usr/bin/env node
/**
 * NOT OFFLINE-SAFE: integration smoke that runs one real headless request
 * through the installed launcher (`bin/ubume.js exec ...`), using the current
 * directory, environment, provider configuration and authentication. It can
 * contact a real provider and consume quota. Run deliberately from a safe
 * workspace; never part of `bun test`.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const binPath = join(repoRoot, "bin", "ubume.js");
const prompt = "Print the current directory, list files, and stop.";

const child = spawn(
  process.execPath,
  [binPath, "exec", prompt],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
    },
  },
);

child.on("error", (error) => {
  console.error(`[smoke-terminal-bench] failed to launch: ${error.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    console.error(`[smoke-terminal-bench] terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
