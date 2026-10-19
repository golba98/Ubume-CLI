/**
 * Lazy entry points for the Local Harness runtime. The runtime pulls in the DeepSeek Harness
 * SDK, browser tooling and JSON-RPC transport, which most sessions never use, so it is loaded
 * on the first Local run instead of at startup. Concurrent first calls share one import.
 *
 * Shutdown and session close need no import: before the runtime has loaded there is no
 * Harness child, browser or session to release.
 */
import type { BackendRunHandlers } from "../../providers/types.js";
import type { ProviderChatRequest } from "../types.js";

type HarnessRuntime = typeof import("./runtime.js");

let runtime: Promise<HarnessRuntime> | undefined;
let loaded: HarnessRuntime | undefined;

function loadRuntime(): Promise<HarnessRuntime> {
  runtime ??= import("./runtime.js").then((module) => {
    loaded = module;
    return module;
  });
  return runtime;
}

/**
 * Same contract as `runtime.runLocalHarness`; an import failure rejects the run. Once loaded the
 * runtime is called synchronously, as before lazy loading. A run cancelled while the first
 * import is in flight never starts the Harness.
 */
export function runLocalHarness(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
  signal: AbortSignal,
): Promise<string> {
  if (loaded) return loaded.runLocalHarness(request, handlers, signal);
  return loadRuntime().then((module) => {
    if (signal.aborted) throw new DOMException("Local request cancelled.", "AbortError");
    return module.runLocalHarness(request, handlers, signal);
  });
}

/** Shuts down the shared Harness if the runtime was ever loaded. */
export function shutdownLocalHarness(): Promise<void> {
  return runtime ? runtime.then((loaded) => loaded.shutdownLocalHarness()) : Promise.resolve();
}

/** Closes a saved Harness session if the runtime was ever loaded; otherwise a no-op. */
export function closeLocalHarnessSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId || !runtime) return Promise.resolve();
  return runtime.then((loaded) => loaded.closeLocalHarnessSession(sessionId));
}

/** Whether the runtime module has been requested (for startup-cost regression tests). */
export function isLocalHarnessRuntimeRequested(): boolean {
  return runtime !== undefined;
}
