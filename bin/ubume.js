#!/usr/bin/env node

import { spawn } from "child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

process.title = "UBUME";

function resolveLauncherDebugDir() {
  const dataDir = process.env.UBUME_DATA_DIR?.trim()
    || (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA?.trim() || process.env.APPDATA?.trim() || join(homedir(), "AppData", "Local"), "Ubume")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "Ubume")
        : join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "ubume"));
  return join(dataDir, "debug");
}

const currentFile = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(currentFile));
const forwardArgs = [];
let workspaceRoot = process.cwd();
const originalArgs = process.argv.slice(2);
let literalArgs = false;
for (let i = 0; i < originalArgs.length; i++) {
  const arg = originalArgs[i];
  if (arg === "--") literalArgs = true;
  if (!literalArgs && (arg === "--cwd" || arg.startsWith("--cwd="))) {
    const value = arg === "--cwd" ? originalArgs[++i] : arg.slice(6);
    try {
      if (!value || value.startsWith("--")) throw new Error("Missing value for --cwd.");
      workspaceRoot = realpathSync(resolve(process.cwd(), value));
      if (!statSync(workspaceRoot).isDirectory()) throw new Error("--cwd must select a directory.");
    } catch (error) {
      const message = `Invalid --cwd: ${error.message}`;
      if (originalArgs.includes("--json")) process.stdout.write(JSON.stringify({ schemaVersion: 1, command: originalArgs.find((item) => ["exec", "doctor", "status", "config", "providers", "models", "sessions"].includes(item)) ?? "exec", ok: false, data: null, error: { code: "USAGE", message } }) + "\n");
      else process.stderr.write(message + "\n");
      process.exit(2);
    }
  } else forwardArgs.push(arg);
}
const launcherStartTimeMs = Number(process.env.UBUME_EXEC_TIMING_EPOCH_MS) || Date.now();
let launcherPreviousElapsedMs = 0;
let intendedTerminalTitle = "Ubume";

function writeRenderDebugRecord(kind, fields) {
  if (
    process.env.UBUME_RENDER_DEBUG !== "1"
    && process.env.UBUME_DEBUG_RENDER !== "1"
  ) {
    return;
  }

  try {
    const debugDir = resolveLauncherDebugDir();
    mkdirSync(debugDir, { recursive: true });
    appendFileSync(
      process.env.UBUME_RENDER_DEBUG_FILE?.trim()
        || join(debugDir, "render-status.log"),
      JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        sessionId: `launcher-${Date.now()}-${process.pid}`,
        kind,
        ...fields,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Debug logging must never disturb launcher startup.
  }
}

function debugLaunch(message, fields = {}) {
  if (process.env.UBUME_DEBUG_LAUNCH !== "1") {
    return;
  }

  const serializedFields = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  process.stderr.write(`[ubume:launch] ${message}${serializedFields ? ` ${serializedFields}` : ""}\n`);
}

function writeTerminalTitleDebugRecord(fields) {
  if (process.env.UBUME_DEBUG_TERMINAL_TITLE !== "1") {
    return;
  }

  try {
    const debugDir = resolveLauncherDebugDir();
    mkdirSync(debugDir, { recursive: true });
    appendFileSync(
      process.env.UBUME_TERMINAL_TITLE_DEBUG_FILE?.trim()
        || process.env.UBUME_RENDER_DEBUG_FILE?.trim()
        || join(debugDir, "render-status.log"),
      JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        lifecycleState: "launcher",
        ...fields,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Debug logging must never disturb launcher startup.
  }
}

function sanitizeTerminalTitle(title) {
  return String(title ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\x1b/g, "")
    .trim();
}

function normalizeTerminalTitle(title) {
  const cleanTitle = sanitizeTerminalTitle(title);
  if (!cleanTitle || /^[a-zA-Z]:[\\/]/.test(cleanTitle) || /^\\\\/.test(cleanTitle)) {
    return "Ubume";
  }
  return cleanTitle;
}

function recordIntendedTitle(reason, force = true) {
  writeTerminalTitleDebugRecord({
    event: "ubumeTitleSkipped",
    source: `bin/ubume.js:${reason}`,
    title: intendedTerminalTitle,
    reason,
    force,
  });
  writeRenderDebugRecord("title", {
    event: "launcherTitleSkipped",
    source: `bin/ubume.js:${reason}`,
    title: intendedTerminalTitle,
    reason,
    force,
  });
}

function hasFlag(args, longFlag, shortFlag) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === longFlag || arg === shortFlag) return true;
  }
  return false;
}

function readPackageVersion() {
  try {
    const raw = readFileSync(join(packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function printHelp() {
  const version = readPackageVersion();
  const versionLine = version ? `ubume ${version}` : "ubume";
  console.log(`${versionLine}

Usage:
  ubume
  ubume "explain this repo"
  ubume --resume <id>
  ubume --import-session <source>:<id>
  ubume exec "print the current directory"
  ubume browser install
  ubume doctor [--probe]
  ubume status | config | providers | models
  ubume sessions list | show <id> | transcript <id> | diff <id>
  ubume exec --resume <id> "next instruction"
  ubume exec --stdin
  ubume --headless-benchmark "print the current directory"
  ubume [options] [prompt]

Options:
  -h, --help              Show this help text and exit.
  -v, --version           Show the installed Ubume version and exit.
      --headless-benchmark
                           Run Ubume through the headless benchmark path.
      --cwd <directory>   Select the workspace.
      --json              Machine-readable output for terminal commands.
      --provider <id>     Select a provider for exec/models.
      --no-save           Run exec without saving a conversation.
      --file <path>       Attach a project text file to exec (repeatable).
      --resume <id>       Open a saved chat without sending a prompt.
      --import-session <source>:<id>
                           Import native history (claude, codex, google, vibe).
      --profile <name>    Load a profile from config.
  -m, --model <name>      Select the model for this launch.
      --reasoning <effort>
                           Reasoning effort for ubume exec: none, minimal, low, medium, high, xhigh.
  -c, --config <key=val>  Override a runtime config value.

Inside Ubume:
  /help                   Show interactive commands.
  /model                  Open model selection.
  /mode                   Open mode selection.
  /exit                   Exit the interactive UI.
`);
}

const commandName = forwardArgs[0] === "--json" ? forwardArgs[1] : forwardArgs[0];
if (commandName === "browser") {
  if (forwardArgs.length !== 2 || forwardArgs[1] !== "install") {
    process.stderr.write("Usage: ubume browser install\n"); process.exit(2);
  }
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("playwright/package.json");
  const installer = spawn(process.execPath, [join(dirname(manifestPath), "cli.js"), "install", "chromium"], { stdio: "inherit" });
  installer.once("error", (error) => { process.stderr.write(`Browser installation failed: ${error.message}\n`); process.exit(1); });
  installer.once("exit", (code) => process.exit(code ?? 1));
  // This installer command never launches the Ink application.
  await new Promise(() => {});
}
const isHeadlessExec = commandName === "exec";
const isHeadlessBenchmark = commandName === "--headless-benchmark";
const isHeadlessMode = isHeadlessExec || isHeadlessBenchmark || ["doctor", "status", "config", "providers", "models", "sessions"].includes(commandName);
const execTimingEnabled = isHeadlessMode
  && (
    process.env.UBUME_EXEC_TIMING === "1"
    || forwardArgs.includes("--timing")
    || forwardArgs.includes("--benchmark-diagnostics")
  );
const parentStdinIsTTY = Boolean(process.stdin.isTTY);
const parentStdoutIsTTY = Boolean(process.stdout.isTTY);
const parentStderrIsTTY = Boolean(process.stderr.isTTY);
const parentHasTTY = parentStdinIsTTY && parentStdoutIsTTY;

function markExecTiming(phase, fields = {}) {
  if (!execTimingEnabled) return;
  const elapsedMs = Date.now() - launcherStartTimeMs;
  const deltaMs = elapsedMs - launcherPreviousElapsedMs;
  launcherPreviousElapsedMs = elapsedMs;
  const formattedFields = Object.entries(fields)
    .map(([key, value]) => {
      const serialized = Array.isArray(value) || typeof value === "string"
        ? JSON.stringify(value)
        : String(value);
      return `${key}=${serialized}`;
    })
    .join(" ");
  process.stderr.write(`[ubume exec timing] phase=${phase} elapsed_ms=${elapsedMs} delta_ms=${deltaMs}${formattedFields ? ` ${formattedFields}` : ""}\n`);
}

markExecTiming("launcher_start", { pid: process.pid });

if (!isHeadlessMode && parentHasTTY) {
  intendedTerminalTitle = normalizeTerminalTitle(
    process.env.UBUME_INITIAL_TERMINAL_TITLE
      || "Ubume",
  );
  recordIntendedTitle("launcher-startup-title-disabled");
}

if (!isHeadlessMode && hasFlag(forwardArgs, "--help", "-h")) {
  printHelp();
  process.exit(0);
}

if (!isHeadlessMode && hasFlag(forwardArgs, "--version", "-v")) {
  console.log(readPackageVersion() ?? "unknown");
  process.exit(0);
}

/**
 * Filters out terminal mouse reporting escape sequences from stdin data.
 * Prevents SGR mouse clicks and scroll events from leaking into the TUI app.
 */
function createMouseFilter() {
  let buffer = "";
  let timer = null;

  return (data) => {
    buffer += data;

    // Clear existing timer
    if (timer) clearTimeout(timer);

    // Check for complete SGR mouse sequences: ESC [ < button ; x ; y M/m
    // Also handle scroll events: button 64/96 (scroll up), 65/97 (scroll down)
    const sgrMouseRegex = /\x1b\[<[0-9]+;[0-9]+;[0-9]+[Mm]/g;
    let hasFullSequence = sgrMouseRegex.test(buffer);

    // If we have a complete sequence, filter and emit immediately
    if (hasFullSequence) {
      buffer = buffer.replace(sgrMouseRegex, "");
      return buffer;
    }

    // If we have partial SGR start, wait for completion or timeout
    if (/\x1b\[<[0-9]*;?[0-9]*;?[0-9]*$/.test(buffer)) {
      timer = setTimeout(() => {
        // Timeout: assume incomplete mouse sequence, just emit filtered buffer
        timer = null;
      }, 50);
      return null; // Wait for more data
    }

    // Otherwise, emit immediately (normal input)
    return buffer;
  };
}

const bunExecutable = process.env.UBUME_BUN_EXECUTABLE?.trim()
  || (process.platform === "win32" ? "bun.exe" : "bun");

const appEntry = join(packageRoot, "src", "index.tsx");
const execEntry = join(packageRoot, "src", "cli.ts");
const bunEntry = isHeadlessMode ? execEntry : appEntry;
const bunForwardArgs = forwardArgs;

// Detect if parent process has a real TTY
const childStdio = isHeadlessMode
  ? ["inherit", "inherit", "inherit"]
  : parentHasTTY
    ? ["inherit", "inherit", "inherit"]
    : ["pipe", "pipe", "pipe"];

debugLaunch("resolved launch mode", {
  mode: isHeadlessMode ? "headless" : "interactive-ui",
  stdinIsTTY: parentStdinIsTTY,
  stdoutIsTTY: parentStdoutIsTTY,
  stderrIsTTY: parentStderrIsTTY,
  TERM: process.env.TERM,
  WT_SESSION: process.env.WT_SESSION,
  TERM_PROGRAM: process.env.TERM_PROGRAM,
  argv: process.argv,
  childStdio,
});

markExecTiming("bun_spawn_start", { executable: bunExecutable });
if (!isHeadlessMode && parentHasTTY) {
  recordIntendedTitle("before-bun-spawn-disabled");
}

const child = spawn(
  bunExecutable,
  ["run", "--silent", bunEntry, ...(bunForwardArgs.length > 0 ? ["--", ...bunForwardArgs] : [])],
  {
    cwd: workspaceRoot,
    stdio: childStdio,
    env: {
      ...process.env,
      CODEX_WORKSPACE_ROOT: workspaceRoot,
      UBUME_LAUNCH_KIND: "installed-bin",
      UBUME_PACKAGE_ROOT: packageRoot,
      UBUME_LAUNCHER_SCRIPT: currentFile,
      UBUME_RELAUNCH_EXECUTABLE: process.execPath,
      UBUME_RELAUNCH_ARGS: JSON.stringify([currentFile, ...forwardArgs]),
      UBUME_PARENT_HAS_TTY: parentHasTTY ? "1" : "0",
      UBUME_HEADLESS_BENCHMARK: isHeadlessBenchmark ? "1" : "0",
      UBUME_EXEC_TIMING_EPOCH_MS: String(launcherStartTimeMs),
      UBUME_INITIAL_TERMINAL_TITLE: intendedTerminalTitle,
    },
  },
);

const forwardInterrupt = (signal) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
const onSigint = () => forwardInterrupt("SIGINT");
const onSigterm = () => forwardInterrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

child.once("spawn", () => {
  if (!isHeadlessMode && parentHasTTY) {
    recordIntendedTitle("after-bun-spawn-disabled");
  }
});

if (!isHeadlessMode && !parentHasTTY) {
  const mouseFilter = createMouseFilter();

  process.stdin.on("data", (data) => {
    const filtered = mouseFilter(data);
    if (filtered) {
      child.stdin.write(filtered);
    }
  });

  process.stdin.on("end", () => {
    child.stdin.end();
  });

  process.stdin.on("error", (error) => {
    console.error(`stdin error: ${error.message}`);
  });

  child.stdin.on("error", (error) => {
    // Ignore broken pipe errors
    if (error.code !== "EPIPE") {
      console.error(`child stdin error: ${error.message}`);
    }
  });
}

if (!isHeadlessMode) {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
}

child.on("error", (error) => {
  if (!isHeadlessMode && parentHasTTY) {
    recordIntendedTitle("bun-spawn-error-disabled");
  }
  markExecTiming("bun_spawn_error", { message: error.message });
  if (isHeadlessMode && forwardArgs.includes("--json")) process.stdout.write(JSON.stringify({ schemaVersion: 1, command: commandName, ok: false, data: null, error: { code: "RUNTIME_UNAVAILABLE", message: `Failed to launch Bun: ${error.message}` } }) + "\n");
  console.error(`Failed to launch Bun: ${error.message}`);
  console.error("Bun is required to launch ubume. Install Bun, then run this command again.");
  process.exit(1);
});

child.on("close", (code, signal) => {
  process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm);
  if (!isHeadlessMode && parentHasTTY) {
    recordIntendedTitle("bun-close-disabled");
  }
  markExecTiming("launcher_exit", { exit_code: code ?? 0, signal: signal ?? null });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
