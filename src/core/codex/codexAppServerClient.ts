/**
 * Short-lived Codex app-server sessions shared by model discovery and usage queries. Owns the
 * initialize handshake, response correlation, timeout/abort listeners and best-effort child
 * termination; callers supply only the session work.
 */

import type { ChildProcess } from "node:child_process";
import { APP_NAME, APP_VERSION } from "../../config/settings.js";
import { spawnCodexProcess } from "../executables/codexExecutable.js";
import { isRecord } from "../shared/values.js";

/**
 * Minimal JSON-RPC client for one short-lived `codex app-server --listen stdio://`
 * process. It performs the `initialize` handshake, correlates responses by id,
 * ignores server notifications, and always kills the child when the session ends.
 */
export interface CodexAppServerClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface CodexAppServerSessionOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Names the operation in timeout/cancel/exit errors, e.g. "Codex model discovery". */
  operation: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Extracts a message from RPC errors or serializes other error values for diagnostics. */
export function describeAppServerError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown Codex app-server error";
  }
}

/**
 * Runs work after the initialize handshake. Timeout, abort, parse or process failures reject;
 * finally removes session listeners and requests child termination.
 *
 * @param executable - Resolved Codex command; platform wrapping is delegated to the spawn helper.
 * @param options - Session-wide deadline, cancellation and diagnostic operation name.
 * @param run - Work whose returned promise defines the successful session lifetime.
 * @returns The callback result after session teardown has been requested.
 * @throws When initialization, a request, the callback, or the session deadline/abort fails.
 */
export async function withCodexAppServer<T>(
  executable: string,
  options: CodexAppServerSessionOptions,
  run: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const proc: ChildProcess = spawnCodexProcess(executable, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderr = "";
  let nextRequestId = 0;
  let closedError: Error | null = null;
  const pending = new Map<number, PendingRequest>();
  let failSession: (error: Error) => void = () => undefined;
  const sessionFailure = new Promise<never>((_, reject) => {
    failSession = (error) => {
      if (closedError) return;
      closedError = error;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      reject(error);
    };
  });
  // The race below observes the rejection; this keeps an unobserved one quiet.
  sessionFailure.catch(() => undefined);

  const parseLine = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      failSession(
        new Error(`Unable to parse Codex app-server response: ${describeAppServerError(error)}`),
      );
      return;
    }
    // Server-initiated requests carry their own ids; only responses resolve ours.
    if (!isRecord(message) || typeof message.id !== "number" || "method" in message) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error !== undefined && message.error !== null) {
      request.reject(
        new Error(`Codex app-server request failed: ${describeAppServerError(message.error)}`),
      );
      return;
    }
    request.resolve(message.result);
  };

  const processStdout = (flush: boolean) => {
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        if (flush && stdoutBuffer.trim()) {
          const line = stdoutBuffer;
          stdoutBuffer = "";
          parseLine(line);
        }
        return;
      }
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      parseLine(line);
    }
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    if (closedError) return;
    stdoutBuffer += chunk.toString("utf8");
    processStdout(false);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  proc.on("error", (error) => failSession(error));
  proc.on("close", (exitCode) => {
    if (closedError) return;
    processStdout(true);
    if (closedError) return;
    const stderrSummary = stderr.trim() ? ` stderr: ${stderr.trim().slice(0, 300)}` : "";
    failSession(
      new Error(
        `Codex app-server exited before ${options.operation} completed (code ${exitCode}).${stderrSummary}`,
      ),
    );
  });
  // A child that exits early can close stdin; the close handler reports that failure.
  proc.stdin?.on("error", () => undefined);

  const timer = setTimeout(() => {
    failSession(
      new Error(`Timed out waiting for ${options.operation} after ${options.timeoutMs}ms.`),
    );
  }, options.timeoutMs);
  const abort = () => failSession(new Error(`${options.operation} canceled.`));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const client: CodexAppServerClient = {
    request(method, params = {}) {
      if (closedError) return Promise.reject(closedError);
      const id = ++nextRequestId;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
  };

  try {
    return await Promise.race([
      (async () => {
        await client.request("initialize", {
          clientInfo: { name: APP_NAME.toLowerCase(), title: APP_NAME, version: APP_VERSION },
          capabilities: { experimentalApi: true },
        });
        return run(client);
      })(),
      sessionFailure,
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (!closedError) closedError = new Error(`${options.operation} finished.`);
    pending.clear();
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.removeAllListeners();
    proc.on("error", () => undefined);
    if (!proc.killed) {
      try {
        proc.kill();
      } catch {
        // Best-effort shutdown.
      }
    }
  }
}
