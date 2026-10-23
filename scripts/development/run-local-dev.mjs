#!/usr/bin/env node
/**
 * Local development launcher behind the `ubume-dev` / `ubd` shims and `bun run dev:run`.
 *
 * Runs this checkout's sources: the interactive app (`src/index.tsx`), or the headless CLI
 * (`src/cli.ts`) for the same commands the installed `bin/ubume.js` routes there. The child is
 * tagged `UBUME_CHANNEL=local-dev`, and its relaunch metadata points back at this checkout.
 * `native` and `numpy` start the local Codexa model chat scripts instead of Ubume.
 *
 * Never installs or modifies the published `ubume` command. Importing this module has no side
 * effects; it launches only when executed directly or through `main()`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exitOnSpawnError, forwardChildExit } from "../lib/child-process.mjs";
import { REPO_ROOT } from "../lib/repo-root.mjs";

const currentFile = fileURLToPath(import.meta.url);

export const DEFAULT_NATIVE_MODEL_ROOT = join(homedir(), "Development", "2-Python", "31-LLM (PyTorch)");

/**
 * Commands `bin/ubume.js` sends to the headless `src/cli.ts`, alongside `exec` and
 * `--headless-benchmark`. `bin/ubume.js` must stay a single self-contained file (it is on the
 * measured startup path), so this list is kept in sync by `run-local-dev.test.ts`, which runs
 * both launchers and compares the entry each one starts.
 */
export const HEADLESS_COMMANDS = ["doctor", "status", "config", "providers", "models", "sessions"];

/**
 * Resolves which local source file the dev launcher runs and the arguments it forwards. A
 * leading `--json` is skipped when reading the command, exactly as the installed launcher does.
 */
export function resolveLocalDevEntry(root, args) {
  const commandName = args[0] === "--json" ? args[1] : args[0];
  const isHeadlessExec = commandName === "exec";
  const isHeadlessBenchmark = commandName === "--headless-benchmark";
  const isHeadlessMode =
    isHeadlessExec || isHeadlessBenchmark || HEADLESS_COMMANDS.includes(commandName);
  return {
    isHeadlessMode,
    isHeadlessExec,
    isHeadlessBenchmark,
    entry: isHeadlessMode ? join(root, "src", "cli.ts") : join(root, "src", "index.tsx"),
    entryArgs: args,
  };
}

/** Resolves the native Codexa model chat command used by `ubume-dev native`. */
export function resolveNativeChatCommand(env = process.env) {
  const modelRoot = env.CODEXA_NATIVE_MODEL_ROOT?.trim() || DEFAULT_NATIVE_MODEL_ROOT;
  const executable = env.CODEXA_NATIVE_PYTHON?.trim() || join(modelRoot, ".venv", "bin", "python");
  const script = join(modelRoot, "scripts", "chat_native.py");
  const checkpoint = env.CODEXA_NATIVE_CHECKPOINT?.trim()
    || join(modelRoot, "checkpoints", "codexa-900m-sft-v2", "latest.pt");
  const tokenizer = env.CODEXA_NATIVE_TOKENIZER?.trim()
    || join(modelRoot, "checkpoints", "tokenizer-base-v1", "tokenizer.json");
  const device = env.CODEXA_NATIVE_DEVICE?.trim() || "cuda";
  return {
    executable,
    cwd: modelRoot,
    requiredPaths: [executable, script, checkpoint, tokenizer],
    args: [script, "--checkpoint", checkpoint, "--tokenizer", tokenizer, "--device", device],
  };
}

/** Resolves the NumPy Codexa checkpoint chat command used by `ubume-dev numpy`. */
export function resolveNumpyChatCommand(env = process.env) {
  const modelRoot = env.CODEXA_NUMPY_MODEL_ROOT?.trim()
    || join(homedir(), "Development", "2-Python", "32-LLM (NumPy)");
  const executable = env.CODEXA_NUMPY_PYTHON?.trim() || "python3";
  const script = join(modelRoot, "scripts", "chat_codexa.py");
  const checkpoint = env.CODEXA_NUMPY_CHECKPOINT?.trim()
    || join(modelRoot, "runs", "pretraining", "pretrain_250m_fineweb_followup_10m", "target_final.npz");
  const tokenizer = env.CODEXA_NUMPY_TOKENIZER?.trim()
    || join(modelRoot, "data", "tokenized", "general-fineweb-10m-v1", "tokenizer.json");
  const device = env.CODEXA_NUMPY_DEVICE?.trim() || "auto";
  return {
    executable,
    cwd: modelRoot,
    requiredPaths: [script, checkpoint, tokenizer],
    args: [script, "--checkpoint", checkpoint, "--tokenizer", tokenizer, "--device", device],
  };
}

/** A flag matches only before `--`; afterwards every argument is literal. */
function hasFlag(args, longFlag, shortFlag) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === longFlag || arg === shortFlag) return true;
  }
  return false;
}

function formatLocalDevVersion() {
  let version = null;
  try {
    const parsed = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    if (typeof parsed.version === "string" && parsed.version.trim()) version = parsed.version.trim();
  } catch {
    // An unreadable package.json is reported as an unknown version below.
  }
  return version ? `${version}-dev local` : "unknown-dev local";
}

function printHelp() {
  console.log(`ubume-dev ${formatLocalDevVersion()}

Usage:
  ubume-dev
  ubume-dev native
  ubume-dev numpy
  ubume-dev "explain this repo"
  ubume-dev exec "print the current directory"
  ubume-dev doctor | status | config | providers | models | sessions [--json]
  ubume-dev [options] [prompt]

This command runs the local repository source with UBUME_CHANNEL=local-dev.
It does not replace or modify the published ubume command.

ubume-dev native talks directly to the local Codexa 900M SFT checkpoint
through native PyTorch inference. It does not use LM Studio or GGUF.
ubume-dev numpy talks directly to the local NumPy 250M checkpoint.
`);
}

/**
 * Starts a local model chat command (`native` / `numpy`) after checking that every required file
 * exists. Arguments after the subcommand go to the chat script.
 */
function launchLocalChat(command, extraArgs, { label, channel, missingRootHint }) {
  const missing = command.requiredPaths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    console.error(`${label} is not available because required files are missing:`);
    for (const path of missing) console.error(`  ${path}`);
    console.error(missingRootHint);
    process.exit(1);
  }
  const child = spawn(command.executable, [...command.args, ...extraArgs], {
    cwd: command.cwd,
    stdio: "inherit",
    env: { ...process.env, UBUME_CHANNEL: channel },
  });
  exitOnSpawnError(child, label);
  forwardChildExit(child);
}

/** Runs this checkout's Ubume with the caller's working directory as the workspace. */
function launchUbume(args) {
  const { isHeadlessBenchmark, entry, entryArgs } = resolveLocalDevEntry(REPO_ROOT, args);
  const bunExecutable = process.env.UBUME_BUN_EXECUTABLE?.trim()
    || (process.platform === "win32" ? "bun.exe" : "bun");
  const child = spawn(
    bunExecutable,
    ["run", "--silent", entry, ...(entryArgs.length > 0 ? ["--", ...entryArgs] : [])],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        CODEX_WORKSPACE_ROOT: process.cwd(),
        UBUME_CHANNEL: "local-dev",
        UBUME_LAUNCH_KIND: "dev-run",
        UBUME_PACKAGE_ROOT: REPO_ROOT,
        UBUME_LAUNCHER_SCRIPT: currentFile,
        UBUME_RELAUNCH_EXECUTABLE: process.execPath,
        UBUME_RELAUNCH_ARGS: JSON.stringify([currentFile, ...args]),
        UBUME_HEADLESS_BENCHMARK: isHeadlessBenchmark ? "1" : "0",
      },
    },
  );
  exitOnSpawnError(
    child,
    "ubume-dev",
    "Bun is required to launch ubume-dev. Install Bun, then run this command again.",
  );
  forwardChildExit(child);
}

/** Entry point: answers --help/--version locally, otherwise starts the selected child. */
export function main(args = process.argv.slice(2)) {
  const { isHeadlessMode, entry } = resolveLocalDevEntry(REPO_ROOT, args);
  if (process.env.UBUME_DEBUG_LAUNCH === "1") {
    process.stderr.write(
      `[ubume-dev:launch] source=local-repo channel=local-dev version=${formatLocalDevVersion()} entry=${entry}\n`,
    );
  }
  if (!isHeadlessMode && hasFlag(args, "--help", "-h")) {
    printHelp();
    process.exit(0);
  }
  if (!isHeadlessMode && hasFlag(args, "--version", "-v")) {
    console.log(formatLocalDevVersion());
    process.exit(0);
  }
  if (args[0] === "native") {
    launchLocalChat(resolveNativeChatCommand(), args.slice(1), {
      label: "Codexa native chat",
      channel: "local-dev-native",
      missingRootHint: "Set CODEXA_NATIVE_MODEL_ROOT if the model repository moved.",
    });
    return;
  }
  if (args[0] === "numpy") {
    launchLocalChat(resolveNumpyChatCommand(), args.slice(1), {
      label: "Codexa NumPy chat",
      channel: "local-dev-numpy",
      missingRootHint: "Set CODEXA_NUMPY_MODEL_ROOT if the model repository moved.",
    });
    return;
  }
  launchUbume(args);
}

function isDirectExecution() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(currentFile);
  } catch {
    return false;
  }
}

if (isDirectExecution()) main();
