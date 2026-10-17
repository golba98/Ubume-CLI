/**
 * Runs shell commands with streamed output, cancellation, summaries, and platform-aware process
 * cleanup.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { normalizeLineBreaks } from "../shared/text.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import { createTerminalTitleSequenceStripper } from "../terminal/terminalTitle.js";
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
function splitOutputLines(text: string): string[] {
  return normalizeLineBreaks(sanitizeTerminalOutput(text))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

  const stdoutLines = splitOutputLines(result.stdout);
  if (stdoutLines.length === 0) {
    return "Completed with no output.";
  }

  const lowerCommand = command.toLowerCase();
  if (/\brg\b/.test(lowerCommand) && /--files\b/.test(lowerCommand)) {
    return `Found ${pluralize(stdoutLines.length, "file")}.`;
  }

  if (/\b(get-childitem|ls|dir)\b/.test(lowerCommand)) {
    return `Listed ${pluralize(stdoutLines.length, "item")}.`;
  }

  if (/\b(rg|grep|select-string|findstr)\b/.test(lowerCommand)) {
    return `Found ${pluralize(stdoutLines.length, "match", "matches")}.`;
  }

  if (stdoutLines.length === 1) {
    return stdoutLines[0]!;
  }

  if (stdoutLines.every(looksLikePath)) {
    return `Returned ${pluralize(stdoutLines.length, "path")}.`;
  }

  return `Produced ${pluralize(stdoutLines.length, "line")} of output.`;
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
  options: Pick<CommandSpec, "cwd" | "env" | "timeoutMs">,
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
  let stdout = "";
  let stderr = "";
  let canceled = false;
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
    if (stopping) return;
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
    const finish = (
      partial: Omit<
        CommandResult,
        "stdout" | "stderr" | "startedAt" | "endedAt" | "durationMs" | "userMessage"
      > & { endedAt?: number },
    ) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      stdout += stdoutTitleStripper.flush();
      stderr += stderrTitleStripper.flush();
      const endedAt = partial.endedAt ?? Date.now();
      resolve({
        ...partial,
        stdout: sanitizeTerminalOutput(stdout),
        stderr: sanitizeTerminalOutput(stderr),
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        userMessage: buildUserMessage({
          executable: displayExecutable,
          code: partial.errorCode,
          exitCode: partial.exitCode,
          stderr,
          signal: partial.signal,
          status: partial.status,
        }),
      });
    };

    child.stdout?.on("data", (buffer: Buffer) => {
      const text = stdoutTitleStripper.process(buffer);
      stdout += text;
      handlers.onStdout?.(sanitizeTerminalOutput(text));
    });

    child.stderr?.on("data", (buffer: Buffer) => {
      const text = stderrTitleStripper.process(buffer);
      stderr += text;
      handlers.onStderr?.(sanitizeTerminalOutput(text));
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
        status: canceled ? "canceled" : code === 0 ? "completed" : "failed",
        exitCode: code,
        signal,
      });
    });

    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (child.killed) return;
        stop();
        finish({
          status: "timeout",
          exitCode: null,
          signal: null,
          debugMessage: `Timed out after ${spec.timeoutMs}ms`,
        });
      }, spec.timeoutMs);
    }
  });

  const cancel = () => {
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
    cancel: () => {
      canceled = true;
      handlers.onProcessLifecycle?.("cancel");
      if (!child.killed) {
        try {
          stop();
        } catch {
          // ignore cancellation failures
        }
      }
    },
  };
}
