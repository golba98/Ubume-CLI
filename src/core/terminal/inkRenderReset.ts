/**
 * Locates Ink internals and resets render caches when a deliberately fresh frame is required.
 */

import * as renderDebug from "../perf/renderDebug.js";

/**
 * Typed subset of the internal Ink class instance we reach into.
 *
 * `unsubscribeResize` is used at startup to disable Ink's competing resize
 * handler (see src/index.tsx). The remaining fields are Ink's per-frame render
 * caches; we reset them on the explicit /clear boundary so the next frame is
 * written authoritatively from a clean baseline — exactly like the first frame
 * after a cold startup — rather than diffed against pre-clear output.
 *
 * All fields are optional so the type also describes the minimal capability
 * needed by callers that only disable resize, and so resolution degrades
 * gracefully across Ink versions / test mocks.
 */
export interface InkRenderInstance {
  unsubscribeResize?: () => void;
  renderInteractiveFrame?: (output: string, outputHeight: number, staticOutput: string) => void;
  lastOutput?: string;
  lastOutputToRender?: string;
  lastOutputHeight?: number;
  lastTerminalWidth?: number;
  fullStaticOutput?: string;
  log?: { reset?: () => void };
  throttledOnRender?: { cancel?: () => void };
  throttledLog?: { cancel?: () => void };
}

/**
 * Resolve the real Ink class instance via Ink's internal WeakMap<stdout, Ink>.
 * Returns null if resolution fails (e.g. different Ink version, test mocks).
 *
 * Bun doesn't resolve bare subpath imports like "ink/build/instances.js" so we
 * resolve ink's main entry first, then derive the sibling path.
 */
export function resolveInkRenderInstance(stdout: object): InkRenderInstance | null {
  try {
    const { createRequire } = require("node:module");
    const req = createRequire(import.meta.url);
    const inkMain = req.resolve("ink");
    const instancesPath = inkMain.replace(/index\.js$/, "instances.js");
    const instances = req(instancesPath);
    const weakMap: WeakMap<object, InkRenderInstance> = instances.default ?? instances;
    return weakMap.get(stdout) ?? null;
  } catch {
    return null;
  }
}

interface ResetInkOutputOptions {
  instance: InkRenderInstance | null;
  /** Current terminal column count, used to reseat lastTerminalWidth. */
  columns?: number;
}

/**
 * Reset Ink's render-state caches to the fresh-startup baseline.
 *
 * Call this immediately AFTER the terminal has been physically cleared (e.g. by
 * terminalControl.clearTranscript on /clear) and BEFORE the post-clear React
 * render commits. It mirrors what a brand-new Ink instance looks like at cold
 * startup: empty frame caches and zero previous height, so the next frame is
 * authoritative and the subsequent resize math (Ink's renderInteractiveFrame /
 * shouldClearTerminalForFrame) is evaluated against truthful state.
 *
 * This does NOT emit any clear/erase escape sequences itself — the terminal is
 * already physically cleared, and Ink's log.reset() zeroes log-update's
 * accounting without writing. Returns false (graceful no-op) if no live Ink
 * instance is available.
 */
export function resetInkOutputForFreshFrame({ instance, columns }: ResetInkOutputOptions): boolean {
  if (!instance) {
    renderDebug.traceEvent("terminal", "clearRenderReset", { instanceResolved: false });
    return false;
  }

  const before = {
    lastOutputLength: instance.lastOutput?.length ?? 0,
    lastOutputToRenderLength: instance.lastOutputToRender?.length ?? 0,
    lastOutputHeight: instance.lastOutputHeight ?? 0,
    fullStaticOutputLength: instance.fullStaticOutput?.length ?? 0,
    lastTerminalWidth: instance.lastTerminalWidth,
  };

  // Drop any pending throttled render/log so a stale pre-clear frame can't be
  // flushed after we reset the caches.
  instance.throttledOnRender?.cancel?.();
  instance.throttledLog?.cancel?.();

  // Zero log-update's previousOutput/previousLineCount WITHOUT emitting escape
  // sequences (the terminal was already physically cleared).
  instance.log?.reset?.();

  // Reset Ink's frame caches to the constructor/startup state.
  instance.lastOutput = "";
  instance.lastOutputToRender = "";
  instance.lastOutputHeight = 0;
  instance.fullStaticOutput = "";
  if (typeof columns === "number" && Number.isFinite(columns)) {
    instance.lastTerminalWidth = columns;
  }

  renderDebug.traceEvent("terminal", "clearRenderReset", {
    instanceResolved: true,
    columns,
    before,
    after: {
      lastOutputLength: instance.lastOutput.length,
      lastOutputToRenderLength: instance.lastOutputToRender.length,
      lastOutputHeight: instance.lastOutputHeight,
      fullStaticOutputLength: instance.fullStaticOutput.length,
      lastTerminalWidth: instance.lastTerminalWidth,
    },
  });

  return true;
}
