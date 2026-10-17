/**
 * Supervises a separate Node/Playwright worker for Local browser tools. The Harness owns tool
 * orchestration and approvals; this module owns worker generations, ephemeral browser sessions
 * and descendant cleanup.
 */

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { type ComputerUseCapability, resolveBrowserCapability } from "./capability.js";
import type {
  ComputerUseBackend,
  ComputerUsePolicy,
  ComputerUseRequest,
  ComputerUseResult,
} from "./types.js";

export { browserUrl, isLoopbackUrl } from "../../../bin/ubume-browser-url.js";

function processStart(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** Supervise a Node browser worker. Bun's WebSocket implementation cannot run
 * Playwright's browser-server transport reliably. This is an execution backend,
 * not an agent: Harness remains the sole owner of model/tool orchestration. */
export class BrowserManager implements ComputerUseBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private transport: JsonRpcLineTransport | null = null;
  private ready?: Promise<void>;
  private browserPids = new Map<number, { owner: number; start?: string }>();
  private workerDirectory?: string;
  private exitCleanup = () => {
    this.killBrowsers();
    this.removeWorkerDirectory(this.workerDirectory);
  };
  private removeWorkerDirectory(directory?: string): void {
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* host cleanup may already have removed it */
      }
    }
    if (this.workerDirectory === directory) this.workerDirectory = undefined;
  }
  private stopping?: Promise<void>;
  private generation = 0;
  private sessions = new Set<string>();
  /**
   * Checks whether this worker has opened ephemeral state for the session.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
  constructor(private capability?: ComputerUseCapability) {}

  private killBrowsers(): void {
    for (const [pid, record] of this.browserPids) {
      try {
        if (process.platform === "linux") {
          // Verify ownership before signalling, to avoid targeting a reused PID.
          if (
            record.start
              ? processStart(pid) !== record.start
              : !new RegExp(`^PPid:\\s+${record.owner}$`, "m").test(
                  readFileSync(`/proc/${pid}/status`, "utf8"),
                )
          )
            continue;
        }
        if (process.platform === "win32")
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            timeout: 2000,
          });
        else process.kill(-pid, "SIGKILL"); // Playwright launches a detached browser process group.
      } catch {
        /* already exited */
      }
    }
    this.browserPids.clear();
  }

  private async ensureStarted(): Promise<JsonRpcLineTransport> {
    await this.stopping;
    if (!this.child || !this.transport) {
      const generation = ++this.generation;
      const workerDirectory = mkdtempSync(join(tmpdir(), "ubume-browser-worker-"));
      this.workerDirectory = workerDirectory;
      const child = spawn(
        process.env.UBUME_NODE_PATH?.trim() || "node",
        [fileURLToPath(new URL("../../../bin/ubume-browser-worker.js", import.meta.url))],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            DEBUG: "",
            PWDEBUG: "0",
            TMPDIR: workerDirectory,
            TMP: workerDirectory,
            TEMP: workerDirectory,
          },
        },
      );
      const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
      this.child = child;
      this.transport = transport;
      process.once("exit", this.exitCleanup);
      // Do not expose browser protocol logs, argv, or error call logs.
      child.stderr.resume();
      transport.onNotification((method, params) => {
        if (
          this.child === child &&
          method === "browser.process" &&
          Number.isSafeInteger(params.pid) &&
          Number(params.pid) > 0 &&
          child.pid
        ) {
          if (params.closed) this.browserPids.delete(Number(params.pid));
          else
            this.browserPids.set(Number(params.pid), {
              owner: child.pid,
              start: processStart(Number(params.pid)),
            });
        }
      });
      const failed = () => {
        if (this.child !== child || this.generation !== generation) return;
        // Reap descendants before forgetting the worker that owned them.
        this.killBrowsers();
        this.sessions.clear();
        transport.close();
        this.removeWorkerDirectory(workerDirectory);
        this.child = null;
        this.transport = null;
        this.ready = undefined;
        process.removeListener("exit", this.exitCleanup);
      };
      child.once("error", failed);
      child.once("exit", failed);
      transport.start();
      this.ready = transport
        .request(
          "initialize",
          { capability: this.capability ?? resolveBrowserCapability() },
          AbortSignal.timeout(10000),
        )
        .then(() => undefined);
    }
    try {
      await this.ready;
    } catch (error) {
      await this.shutdown();
      throw error;
    }
    if (!this.transport) throw new Error("Browser worker disconnected.");
    return this.transport;
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const transport = await this.ensureStarted();
    signal.throwIfAborted();
    const abort = () => transport.notify("browser.cancel", { callId: params.callId });
    signal.addEventListener("abort", abort, { once: true });
    try {
      // Cancellation asks the worker to drain; it must not abandon the operation.
      let result;
      try {
        result = await transport.request(method, params, AbortSignal.timeout(40000));
      } catch (error) {
        await this.shutdown();
        throw error;
      }
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /**
   * Lazily starts the worker and executes a policy-scoped call; cancellation/disconnect
   * becomes a structured browser error.
   */
  async execute(
    request: ComputerUseRequest,
    policy: ComputerUsePolicy,
  ): Promise<ComputerUseResult> {
    try {
      const result = (await this.call(
        "browser/execute",
        { ...request, networkAccess: policy.networkAccess, dshHome: policy.dshHome },
        policy.signal,
      )) as ComputerUseResult;
      if (result.ok && request.tool === "browser_open") this.sessions.add(request.sessionId);
      if (
        request.tool === "browser_close" ||
        (!result.ok && result.error.code === "BROWSER_CLOSED")
      )
        this.sessions.delete(request.sessionId);
      return result;
    } catch {
      return {
        ok: false,
        error: {
          code: policy.signal.aborted ? "ABORTED" : "BROWSER_CLOSED",
          message: policy.signal.aborted
            ? "Browser action cancelled."
            : "Browser worker disconnected. Call browser_open to start a fresh browser.",
        },
      };
    }
  }

  /**
   * Reads the target identity for an approval without performing the proposed browser
   * interaction; failures reject.
   */
  async approvalState(
    sessionId: string,
    args: Record<string, unknown>,
    typing: boolean,
    signal: AbortSignal,
  ): Promise<{ description: string; identity: string }> {
    return (await this.call(
      "browser/approval-state",
      { sessionId, arguments: args, typing, callId: `approval-${crypto.randomUUID()}` },
      signal,
    )) as { description: string; identity: string };
  }

  /**
   * Drops this session's ephemeral browser state; failed worker cleanup escalates to shared
   * shutdown.
   */
  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    if (!this.transport) return;
    try {
      await this.transport.request(
        "browser/close-session",
        { sessionId },
        AbortSignal.timeout(35000),
      );
    } catch {
      await this.shutdown();
    }
  }

  /**
   * Coalesces shutdown, drains the worker when possible and escalates termination while
   * removing owned browser/temp state.
   */
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.sessions.clear();
    const child = this.child;
    const transport = this.transport;
    const workerDirectory = this.workerDirectory;
    if (!child) {
      this.killBrowsers();
      this.removeWorkerDirectory(workerDirectory);
      return Promise.resolve();
    }
    const stopping = (async () => {
      try {
        await transport?.request("shutdown", {}, AbortSignal.timeout(2000));
      } catch {
        /* forced cleanup below */
      }
      this.killBrowsers();
      transport?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (this.child === child) {
        this.child = null;
        this.transport = null;
        this.ready = undefined;
      }
      this.removeWorkerDirectory(workerDirectory);
      process.removeListener("exit", this.exitCleanup);
    })();
    this.stopping = stopping;
    void stopping.finally(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    return stopping;
  }

  /**
   * Immediately reaps known browser descendants and starts worker shutdown without waiting.
   */
  terminate(): void {
    this.killBrowsers();
    void this.shutdown();
  }
}
