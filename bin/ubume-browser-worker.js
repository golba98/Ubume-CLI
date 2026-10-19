/**
 * Browser worker host: the private Node process that owns the Playwright
 * browser behind the Ubume tools.
 *
 * There is no model client or agent loop here — only the JSON-RPC surface the
 * Local Harness runtime talks to over stdin/stdout:
 *
 *   Requests:
 *     initialize            -> create the BrowserManager (once); report its pid.
 *     browser/execute       -> run one tool call with a per-call deadline.
 *     browser/approval-state -> describe the focused/target element for approval.
 *     browser/close-session -> tear down one conversation's browser.
 *     shutdown              -> abort all calls, close everything, exit 0.
 *   Notifications:
 *     browser.cancel        -> abort one in-flight call by callId.
 *     browser.process       -> report the Chromium pid (spawned / closed).
 *
 * Error policy: raw Playwright exceptions and call logs never cross the
 * transport; every failure is reduced to one of the generic messages below.
 * The process exits when stdin ends or on SIGINT/SIGTERM, always through the
 * same shutdown path so the browser process does not outlive the worker.
 */

import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { BrowserManager } from "./ubume-browser-backend.js";

const MAX_DEADLINE_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
// Navigation-class tools legitimately take longer than pure actions.
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const NAVIGATION_TOOLS = new Set(["browser_open", "browser_navigate", "browser_back", "browser_forward", "browser_reload"]);

const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
const controllers = new Map();
let backend;
let shuttingDown = false;

function perCallTimeoutMs(method, params) {
  if (method !== "browser/execute") return DEFAULT_ACTION_TIMEOUT_MS;
  const defaultMs = NAVIGATION_TOOLS.has(params.tool) ? DEFAULT_NAVIGATION_TIMEOUT_MS : DEFAULT_ACTION_TIMEOUT_MS;
  return Number(params.arguments?.timeoutMs ?? defaultMs);
}

/** Handles one browser RPC, guarding it with a deadline and cancellation. */
async function executeGuarded(method, params) {
  const controller = new AbortController();
  const callId = String(params.callId);
  if (controllers.has(callId)) throw new Error("Duplicate browser call id.");
  controllers.set(callId, controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Math.min(perCallTimeoutMs(method, params), MAX_DEADLINE_MS)));
  try {
    if (method === "browser/execute") {
      const result = await backend.execute(params, {
        networkAccess: params.networkAccess === true,
        dshHome: String(params.dshHome),
        signal: controller.signal,
      });
      return timedOut
        ? { ok: false, error: { code: "BROWSER_TIMEOUT", message: "Browser action timed out. Inspect the page before retrying." } }
        : result;
    }
    if (method === "browser/approval-state") {
      return await backend.approvalState(String(params.sessionId), params.arguments, params.typing === true, controller.signal);
    }
    throw new Error("Unsupported browser request.");
  } catch {
    // Never forward Playwright's raw exception/call log across the boundary.
    throw new Error(controller.signal.aborted ? "Browser action cancelled." : "Browser target unavailable.");
  } finally {
    clearTimeout(timer);
    controllers.delete(callId);
  }
}

transport.onNotification((method, params) => {
  if (method === "browser.cancel") controllers.get(String(params.callId))?.abort();
});

transport.onRequest(async (method, params) => {
  if (method === "initialize") {
    if (backend) throw new Error("Browser worker already initialized.");
    backend = new BrowserManager(params.capability, (pid, closed = false) => transport.notify("browser.process", { pid, closed }));
    return {};
  }
  if (!backend || shuttingDown) throw new Error("Browser worker unavailable.");
  if (method === "browser/close-session") {
    await backend.closeSession(String(params.sessionId));
    return {};
  }
  if (method === "shutdown") {
    shuttingDown = true;
    for (const controller of controllers.values()) controller.abort();
    await backend.shutdown();
    // Exit from a setImmediate so the response is flushed before process.exit.
    setImmediate(async () => {
      await transport.flush();
      process.exit(0);
    });
    return {};
  }
  return executeGuarded(method, params);
});

transport.start();

/** Single shutdown path for stdin end, SIGINT, SIGTERM and the RPC shutdown. */
const stop = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of controllers.values()) controller.abort();
  await backend?.shutdown();
  process.exit(0);
};

process.stdin.on("end", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
