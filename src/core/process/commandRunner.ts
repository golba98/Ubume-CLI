/**
 * Runs shell commands with streamed output, cancellation, summaries, and platform-aware process
 * cleanup.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { normalizeLineBreaks } from "../shared/text.js";
import {
  sanitizeTerminalOutput,
  sanitizeTerminalStreamChunk,
} from "../terminal/terminalSanitize.js";
import { createTerminalTitleSequenceStripper } from "../terminal/terminalTitle.js";
import { createOutputBuffer, type OutputCapture } from "./outputCapture.js";
import { validateExecutableForSpawn } from "./processValidation.js";

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdinData?: string;
  keepStdinOpen?: boolean;
  signal?: AbortSignal;
  /**
   * What `result.stdout`/`result.stderr` retain. Defaults to `"full"`, which callers that
   * parse or persist complete output rely on. Stream handlers always receive every chunk.
   */
  capture?: OutputCapture;
}

export interface CommandResult {
  status: "completed" | "failed" | "spawn_error" | "timeout" | "canceled";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  errorCode?: string;
  userMessage: string;
  debugMessage?: string;
  /** Characters a bounded `capture` dropped from the retained output, when any were. */
  omittedOutputChars?: { stdout: number; stderr: number };
}

export interface CommandStreamHandlers {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onProcessLifecycle?: (event: "before-spawn" | "spawned" | "exit" | "error" | "cancel") => void;
}

interface InternalCommandSpec extends CommandSpec {
  displayExecutable?: string;
}

// Sanitize before splitting: title sequences can span newlines and must not corrupt the line output.
function* splitOutputLines(text: string): Generator<string> {
  const safe = normalizeLineBreaks(sanitizeTerminalOutput(text));
  for (const match of safe.matchAll(/[^\n]+/g)) {
    const line = match[0].trim();
    if (line) yield line;
  }
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function looksLikePath(line: string): boolean {
  return /[\\/]/.test(line) || /\.[a-z0-9_-]+$/i.test(line);
}

function buildUserMessage(result: {
  executable: string;
  code?: string;
  exitCode: number | null;
  stderr: string;
  signal: NodeJS.Signals | null;
  status: CommandResult["status"];
}): string {
  const stderrLine = sanitizeTerminalOutput(result.stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (result.status === "spawn_error" && result.code === "ENOENT") {
    return `\`${result.executable}\` is not installed or not available on PATH.`;
  }
  if (result.status === "spawn_error" && result.code === "EACCES") {
    return `\`${result.executable}\` could not be executed because permission was denied.`;
  }
  if (result.status === "timeout") {
    return `Command timed out before it could finish.`;
  }
  if (result.status === "canceled") {
    return "Command was canceled.";
  }
  if (result.signal) {
    return `Command exited after receiving signal ${result.signal}.`;
  }
  if (result.exitCode === 1 && stderrLine?.match(/not recognized|not found|No such file/i)) {
    return stderrLine;
  }
  if (result.exitCode === 1 && result.executable === "rg" && !stderrLine) {
    return "ripgrep returned no matches.";
  }
  if (result.exitCode && result.exitCode !== 0) {
    return stderrLine ?? `Command exited with code ${result.exitCode}.`;
  }
  return "Command completed.";
}

/** Builds a display summary from sanitized output while preserving failure messages. */
export function summarizeCommandResult(
  command: string,
  result: Pick<
    CommandResult,
    "status" | "exitCode" | "signal" | "stdout" | "stderr" | "userMessage"
  >,
): string {
  if (result.status !== "completed" || result.exitCode !== 0 || result.signal) {
    return result.userMessage;
  }

  let lineCount = 0;
  let firstLine = "";
  let allPaths = true;
  for (const line of splitOutputLines(result.stdout)) {
    lineCount++;
    if (lineCount === 1) firstLine = line;
    if (!looksLikePath(line)) allPaths = false;
  }
  if (lineCount === 0) {
    return "Completed with no output.";
  }

  const lowerCommand = command.toLowerCase();
  if (/\brg\b/.test(lowerCommand) && /--files\b/.test(lowerCommand)) {
    return `Found ${pluralize(lineCount, "file")}.`;
  }

  if (/\b(get-childitem|ls|dir)\b/.test(lowerCommand)) {
    return `Listed ${pluralize(lineCount, "item")}.`;
  }

  if (/\b(rg|grep|select-string|findstr)\b/.test(lowerCommand)) {
    return `Found ${pluralize(lineCount, "match", "matches")}.`;
  }

  if (lineCount === 1) {
    return firstLine;
  }

  if (allPaths) {
    return `Returned ${pluralize(lineCount, "path")}.`;
  }

  return `Produced ${pluralize(lineCount, "line")} of output.`;
}

/**
 * Spawns validated argv directly. result reports completion/timeout; stopped tracks teardown
 * separately, so cancellation callers should await it before releasing ownership.
 */
export function runCommand(
  spec: CommandSpec,
  handlers: CommandStreamHandlers = {},
): {
  child: ChildProcess;
  result: Promise<CommandResult>;
  stopped?: Promise<void>;
  cancel: () => void;
} {
  return runProcess(spec, handlers);
}

/**
 * Runs shell text through /bin/sh or cmd.exe. The caller owns command-policy validation; the
 * returned runner retains process-group cancellation semantics.
 */
export function runShellCommand(
  command: string,
  options: Pick<CommandSpec, "cwd" | "env" | "timeoutMs" | "capture">,
  handlers: CommandStreamHandlers = {},
): {
  child: ChildProcess;
  result: Promise<CommandResult>;
  stopped?: Promise<void>;
  cancel: () => void;
} {
  const shellSpec =
    process.platform === "win32"
      ? { executable: "cmd.exe", args: ["/d", "/s", "/c", command] }
      : { executable: "/bin/sh", args: ["-c", command] };

  return runProcess(
    {
      ...options,
      executable: shellSpec.executable,
      args: shellSpec.args,
      displayExecutable: command,
    },
    handlers,
  );
}

function runProcess(
  spec: InternalCommandSpec,
  handlers: CommandStreamHandlers,
): {
  child: ChildProcess;
  result: Promise<CommandResult>;
  stopped?: Promise<void>;
  cancel: () => void;
} {
  const startedAt = Date.now();
  const executable = validateExecutableForSpawn(spec.executable, {
    label: "Command executable",
    cwd: spec.cwd,
  });
  const displayExecutable = spec.displayExecutable ?? executable;
  const stdout = createOutputBuffer(spec.capture);
  const stderr = createOutputBuffer(spec.capture);
  let canceled = false;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const stdoutTitleStripper = createTerminalTitleSequenceStripper({
    source: "src/core/process/commandRunner.ts:shell.stdout",
    stream: "stdout",
    origin: "shell",
  });
  const stderrTitleStripper = createTerminalTitleSequenceStripper({
    source: "src/core/process/commandRunner.ts:shell.stderr",
    stream: "stderr",
    origin: "shell",
  });

  handlers.onProcessLifecycle?.("before-spawn");
  const child = spawn(executable, spec.args, {
    detached: process.platform !== "win32",
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    stdio: [spec.stdinData !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  handlers.onProcessLifecycle?.("spawned");

  if (spec.stdinData !== undefined) {
    try {
      child.stdin?.on("error", () => {
        /* EPIPE when the process exits before reading stdin */
      });
      child.stdin?.write(spec.stdinData);
      if (!spec.keepStdinOpen) child.stdin?.end();
    } catch {
      // stdin already closed; the close/error handlers report the outcome
    }
  }

  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let stopping = false;
  const groupAlive = () => {
    if (process.platform === "win32" || !child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  child.once("close", () => {
    closed = true;
    // A leader can exit while a detached descendant ignores SIGTERM.
    if (!stopping || !groupAlive()) {
      if (killTimer) clearTimeout(killTimer);
      resolveStopped();
    }
  });
  const stop = () => {
    if (stopping || closed) return;
    stopping = true;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else if (process.platform === "win32" && child.pid)
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            shell: false,
          }).on("error", () => child.kill(signal));
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* Already stopped. */
        }
      }
    };
    kill("SIGTERM");
    killTimer = setTimeout(() => {
      kill("SIGKILL");
      if (closed) resolveStopped();
    }, 1500);
    // Keep the escalation alive even after the group leader closes its stdio.
  };
  const result = new Promise<CommandResult>((resolve) => {
    let settled = false;
    const finish = (
      partial: Omit<
        CommandResult,
        "stdout" | "stderr" | "startedAt" | "endedAt" | "durationMs" | "userMessage"
      > & { endedAt?: number },
    ) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      stdout.append(stdoutTitleStripper.flush());
      stderr.append(stderrTitleStripper.flush());
      const endedAt = partial.endedAt ?? Date.now();
      const stderrText = stderr.text();
      const omitted = stdout.omittedChars + stderr.omittedChars;
      resolve({
        ...partial,
        stdout: sanitizeTerminalStreamChunk(stdout.text()),
        stderr: sanitizeTerminalStreamChunk(stderrText),
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        userMessage: buildUserMessage({
          executable: displayExecutable,
          code: partial.errorCode,
          exitCode: partial.exitCode,
          stderr: stderrText,
          signal: partial.signal,
          status: partial.status,
        }),
        ...(omitted > 0
          ? { omittedOutputChars: { stdout: stdout.omittedChars, stderr: stderr.omittedChars } }
          : {}),
      });
    };

    child.stdout?.on("data", (buffer: Buffer) => {
      const text = stdoutTitleStripper.process(buffer);
      stdout.append(text);
      handlers.onStdout?.(sanitizeTerminalStreamChunk(text));
    });

    child.stderr?.on("data", (buffer: Buffer) => {
      const text = stderrTitleStripper.process(buffer);
      stderr.append(text);
      handlers.onStderr?.(sanitizeTerminalStreamChunk(text));
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      handlers.onProcessLifecycle?.("error");
      finish({
        status: canceled ? "canceled" : "spawn_error",
        exitCode: null,
        signal: null,
        errorCode: error.code,
        debugMessage: error.message,
      });
    });

    child.once("close", (code, signal) => {
      handlers.onProcessLifecycle?.("exit");
      finish({
        status: canceled ? "canceled" : timedOut ? "timeout" : code === 0 ? "completed" : "failed",
        exitCode: code,
        signal,
        ...(timedOut ? { debugMessage: `Timed out after ${spec.timeoutMs}ms` } : {}),
      });
    });

    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (closed || canceled) return;
        timedOut = true;
        stop();
      }, spec.timeoutMs);
    }
  });

  const cancel = () => {
    if (closed || canceled) return;
    canceled = true;
    handlers.onProcessLifecycle?.("cancel");
    if (!child.killed) stop();
  };
  spec.signal?.addEventListener("abort", cancel, { once: true });
  if (spec.signal?.aborted) cancel();
  void result.finally(() => spec.signal?.removeEventListener("abort", cancel));

  return {
    child,
    result,
    stopped,
    cancel,
  };
}
