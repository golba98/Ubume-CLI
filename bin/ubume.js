#!/usr/bin/env node
/**
 * Installed Ubume launcher (`bin` entry point of the npm package).
 *
 * Responsibilities, in execution order:
 *   1. Emit optional startup-trace marks (UBUME_STARTUP_TRACE) for benchmarking.
 *   2. Parse the launcher-owned arguments (`--cwd`; everything else is forwarded).
 *   3. Answer `browser install`, `--help` and `--version` without starting the app.
 *   4. Select the application entry point (interactive Ink app vs. headless CLI).
 *   5. Spawn the Bun runtime with the workspace and relaunch metadata in the
 *      child environment.
 *   6. Forward signals and (when the parent has no TTY) filtered stdio.
 *   7. Mirror the child's exit code or fatal signal to the caller.
 *
 * The launcher is deliberately a single file: it sits on the measured startup
 * path (`bench:startup`, `UBUME_STARTUP_TRACE`) and every extra ESM module
 * import would add real wall-clock time. Keep it self-contained.
 *
 * Headless routing contract: `exec`, `--headless-benchmark`, `doctor`, `status`,
 * `config`, `providers`, `models` and `sessions` go to `src/cli.ts`; every other
 * invocation goes to the interactive app `src/index.tsx`.
 */

import { spawn } from "child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// ---------------------------------------------------------------------------
// Startup trace (benchmark-only)
// ---------------------------------------------------------------------------

// UBUME_STARTUP_TRACE=<file> appends one JSON line per stage; disabled otherwise.
// The suite `scripts/bench/startup-timeline.py` consumes these stages by name.
const startupTraceFile = process.env.UBUME_STARTUP_TRACE?.trim();

function launcherStartupMark(stage, t = performance.timeOrigin + performance.now()) {
  if (!startupTraceFile) return;
  try {
    appendFileSync(startupTraceFile, `${JSON.stringify({ t, pid: process.pid, stage })}\n`);
  } catch {
    // Tracing never affects the launcher.
  }
}

launcherStartupMark("launcher-process-start", performance.timeOrigin);
launcherStartupMark("launcher-script-start");

process.title = "UBUME";

// ---------------------------------------------------------------------------
// Package paths
// ---------------------------------------------------------------------------

const currentFile = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(currentFile));

// ---------------------------------------------------------------------------
// Debug logging (all opt-in through UBUME_DEBUG_* variables)
// ---------------------------------------------------------------------------

/** Platform data directory holding the `debug/` logs (never created unless used). */
function resolveLauncherDebugDir() {
  const dataDir = process.env.UBUME_DATA_DIR?.trim()
    || (process.platform === "win32"
      ? join(
        process.env.LOCALAPPDATA?.trim()
          || process.env.APPDATA?.trim()
          || join(homedir(), "AppData", "Local"),
        "Ubume",
      )
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "Ubume")
        : join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "ubume"));
  return join(dataDir, "debug");
}

/**
 * Appends one JSON debug record. Every debug logger swallows write failures:
 * debug output must never disturb the launcher startup path. Only the platform
 * debug directory is created — an explicit *_DEBUG_FILE inside a missing
 * directory is expected to fail silently, matching the original behavior.
 */
function appendDebugRecord(filePath, record) {
  try {
    mkdirSync(resolveLauncherDebugDir(), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Debug logging must never disturb launcher startup.
  }
}

function renderDebugEnabled() {
  return process.env.UBUME_RENDER_DEBUG === "1"
    || process.env.UBUME_DEBUG_RENDER === "1";
}

function writeRenderDebugRecord(kind, fields) {
  if (!renderDebugEnabled()) return;
  appendDebugRecord(
    process.env.UBUME_RENDER_DEBUG_FILE?.trim()
      || join(resolveLauncherDebugDir(), "render-status.log"),
    {
      ts: Date.now(),
      pid: process.pid,
      sessionId: `launcher-${Date.now()}-${process.pid}`,
      kind,
      ...fields,
    },
  );
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

  appendDebugRecord(
    process.env.UBUME_TERMINAL_TITLE_DEBUG_FILE?.trim()
      || process.env.UBUME_RENDER_DEBUG_FILE?.trim()
      || join(resolveLauncherDebugDir(), "render-status.log"),
    {
      ts: Date.now(),
      pid: process.pid,
      lifecycleState: "launcher",
      ...fields,
    },
  );
}

// ---------------------------------------------------------------------------
// Terminal title bookkeeping
// ---------------------------------------------------------------------------

function sanitizeTerminalTitle(title) {
  return String(title ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\x1b/g, "")
    .trim();
}

/** Windows drive and UNC paths are not useful terminal titles; fall back to "Ubume". */
function normalizeTerminalTitle(title) {
  const cleanTitle = sanitizeTerminalTitle(title);
  if (!cleanTitle || /^[a-zA-Z]:[\\/]/.test(cleanTitle) || /^\\\\/.test(cleanTitle)) {
    return "Ubume";
  }
  return cleanTitle;
}

/**
 * The launcher intentionally does not set the terminal title; every launch
 * phase records *why* it was skipped so title bugs stay diagnosable from the
 * debug logs. The intended title travels to the child via
 * UBUME_INITIAL_TERMINAL_TITLE, which owns the actual title.
 */
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

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Reads the version from the package manifest; null when unreadable. */
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

/** A flag matches only before `--`; afterwards every argument is literal. */
function hasFlag(args, longFlag, shortFlag) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === longFlag || arg === shortFlag) return true;
  }
  return false;
}

/**
 * Validates and resolves the workspace selected by `--cwd`, or exits with
 * status 2. `--json` runs receive the structured USAGE error on stdout;
 * everything else gets the plain message on stderr.
 */
function resolveWorkspaceRoot(value, originalArgs) {
  try {
    if (!value || value.startsWith("--")) throw new Error("Missing value for --cwd.");
    const resolvedRoot = realpathSync(resolve(process.cwd(), value));
    if (!statSync(resolvedRoot).isDirectory()) throw new Error("--cwd must select a directory.");
    return resolvedRoot;
  } catch (error) {
    const message = `Invalid --cwd: ${error.message}`;
    if (originalArgs.includes("--json")) {
      const command = originalArgs.find((item) =>
        ["exec", "doctor", "status", "config", "providers", "models", "sessions"].includes(item)
      ) ?? "exec";
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, command, ok: false, data: null, error: { code: "USAGE", message } })}\n`,
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exit(2);
  }
}

/**
 * Splits argv into forwarded application arguments plus the resolved workspace.
 * `--cwd <dir>` / `--cwd=<dir>` is consumed here (and validated); everything
 * else, including arguments after `--`, is forwarded untouched.
 */
function parseForwardArguments(originalArgs) {
  const forwardArgs = [];
  let workspaceRoot = process.cwd();
  let literalArgs = false;

  for (let i = 0; i < originalArgs.length; i++) {
    const arg = originalArgs[i];
    if (arg === "--") literalArgs = true;
    if (!literalArgs && (arg === "--cwd" || arg.startsWith("--cwd="))) {
      const value = arg === "--cwd" ? originalArgs[++i] : arg.slice(6);
      workspaceRoot = resolveWorkspaceRoot(value, originalArgs);
    } else {
      forwardArgs.push(arg);
    }
  }

  return { forwardArgs, workspaceRoot };
}

const originalArgs = process.argv.slice(2);
const { forwardArgs, workspaceRoot } = parseForwardArguments(originalArgs);

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

const commandName = forwardArgs[0] === "--json" ? forwardArgs[1] : forwardArgs[0];

const isHeadlessExec = commandName === "exec";
const isHeadlessBenchmark = commandName === "--headless-benchmark";
const isHeadlessMode = isHeadlessExec
  || isHeadlessBenchmark
  || ["doctor", "status", "config", "providers", "models", "sessions"].includes(commandName);

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

// ---------------------------------------------------------------------------
// `ubume browser install`
// ---------------------------------------------------------------------------

// Downloads the Playwright Chromium build through the bundled CLI. It never
// launches the Ink application.
async function runBrowserInstall() {
  if (forwardArgs.length !== 2 || forwardArgs[1] !== "install") {
    process.stderr.write("Usage: ubume browser install\n");
    process.exit(2);
  }
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("playwright/package.json");
  const installer = spawn(
    process.execPath,
    [join(dirname(manifestPath), "cli.js"), "install", "chromium"],
    { stdio: "inherit" },
  );
  installer.once("error", (error) => {
    process.stderr.write(`Browser installation failed: ${error.message}\n`);
    process.exit(1);
  });
  installer.once("exit", (code) => process.exit(code ?? 1));
  // This installer command never launches the Ink application.
  await new Promise(() => {});
}

if (commandName === "browser") {
  await runBrowserInstall();
}

// ---------------------------------------------------------------------------
// Exec timing (headless diagnostics; phase deltas on stderr)
// ---------------------------------------------------------------------------

const launcherStartTimeMs = Number(process.env.UBUME_EXEC_TIMING_EPOCH_MS) || Date.now();
let launcherPreviousElapsedMs = 0;
let intendedTerminalTitle = "Ubume";

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
  process.stderr.write(
    `[ubume exec timing] phase=${phase} elapsed_ms=${elapsedMs} delta_ms=${deltaMs}${formattedFields ? ` ${formattedFields}` : ""}\n`,
  );
}

markExecTiming("launcher_start", { pid: process.pid });

if (!isHeadlessMode && parentHasTTY) {
  intendedTerminalTitle = normalizeTerminalTitle(
    process.env.UBUME_INITIAL_TERMINAL_TITLE || "Ubume",
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

// ---------------------------------------------------------------------------
// Stdin mouse-report filter (used only when the parent has no TTY)
// ---------------------------------------------------------------------------

/**
 * Filters terminal mouse reporting escape sequences out of stdin data.
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

// ---------------------------------------------------------------------------
// Runtime resolution and child launch
// ---------------------------------------------------------------------------

const bunExecutable = process.env.UBUME_BUN_EXECUTABLE?.trim()
  || (process.platform === "win32" ? "bun.exe" : "bun");

const appEntry = join(packageRoot, "src", "index.tsx");
const execEntry = join(packageRoot, "src", "cli.ts");
const bunEntry = isHeadlessMode ? execEntry : appEntry;
const bunForwardArgs = forwardArgs;

// With a real TTY the child inherits the terminal; without one every stream is
// piped and explicitly forwarded below (headless always inherits, matching the
// terminal-command contract for stdout/stderr separation).
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

launcherStartupMark("launcher-spawn");

/**
 * Environment handed to the Bun child. The UBUME_* fields are the launcher
 * contract consumed by `src/` (relaunch support, package metadata, timing
 * epoch, title ownership and benchmark mode).
 */
function buildChildEnvironment() {
  return {
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
  };
}

const child = spawn(
  bunExecutable,
  ["run", "--silent", bunEntry, ...(bunForwardArgs.length > 0 ? ["--", ...bunForwardArgs] : [])],
  {
    cwd: workspaceRoot,
    stdio: childStdio,
    env: buildChildEnvironment(),
  },
);

// ---------------------------------------------------------------------------
// Signal forwarding, stdio piping and exit handling
// ---------------------------------------------------------------------------

/** Forward a terminating signal to the child only while it is still running. */
const forwardInterrupt = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
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
  if (isHeadlessMode && forwardArgs.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command: commandName,
        ok: false,
        data: null,
        error: { code: "RUNTIME_UNAVAILABLE", message: `Failed to launch Bun: ${error.message}` },
      })}\n`,
    );
  }
  console.error(`Failed to launch Bun: ${error.message}`);
  console.error("Bun is required to launch ubume. Install Bun, then run this command again.");
  process.exit(1);
});

child.on("close", (code, signal) => {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  if (!isHeadlessMode && parentHasTTY) {
    recordIntendedTitle("bun-close-disabled");
  }
  markExecTiming("launcher_exit", { exit_code: code ?? 0, signal: signal ?? null });
  if (signal) {
    // Die by the same signal so wrappers (shells, test harnesses) observe it.
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
