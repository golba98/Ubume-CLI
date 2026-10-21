import { getResizeGeneration, resizeTraceEnabled, traceResize } from "../perf/resizeTrace.js";
/**
 * Serializes and normalizes Ink stdout frames to prevent interleaving, duplicates, width
 * residue, and resize corruption.
 */

import fs from "node:fs";
import path from "node:path";
import * as benchTrace from "../perf/benchTrace.js";
import * as renderDebug from "../perf/renderDebug.js";
import { resolveUbumeDebugLogPath } from "../workspace/appData.js";
import { getStartupGraphicsChannel } from "./startupGraphics.js";
import { isTerminalResizing } from "./terminalControl.js";

/** The writable surface the frame lock wraps; satisfied by `NodeJS.WriteStream`. */
interface FrameWritable {
  write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean;
}

interface FrameLockOptions<T extends FrameWritable> {
  stdout: T;
  env: Record<string, string | undefined>;
}

const resizeFrameCacheResetters = new WeakMap<object, () => void>();
const frameLockReleases = new WeakMap<object, () => void>();

/** Restores the original writer and releases debug/frame buffers after the app exits. */
export function releaseFrameLock(stdout: object): void {
  frameLockReleases.get(stdout)?.();
}

/**
 * Invalidates the wrapped stream's last-frame cache so identical content can repaint at new
 * dimensions.
 */
export function resetFrameLockForResize(stdout: object): void {
  resizeFrameCacheResetters.get(stdout)?.();
}

/**
 * Wraps the stdout stream to enforce frame-level deduplication, a flush lock,
 * and width-safe row padding via ANSI clear-to-EOL (\x1b[K) injection.
 */
export function wrapStdoutWithFrameLock<T extends FrameWritable>({
  stdout,
  env,
}: FrameLockOptions<T>): T {
  releaseFrameLock(stdout);
  let lastFrame = "";
  let isFlushing = false;
  let debugLogStream: fs.WriteStream | null = null;

  if (env.UBUME_RENDER_DEBUG === "1") {
    try {
      const logPath = env.UBUME_RENDER_DEBUG_FILE?.trim() || resolveUbumeDebugLogPath(env);
      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      debugLogStream = fs.createWriteStream(logPath, { flags: "a" });
    } catch (e) {
      // Gracefully fall back if logging fails (e.g. read-only filesystem)
      void e;
    }
  }

  const logDebug = (msg: string) => {
    if (debugLogStream) {
      debugLogStream.write(`${new Date().toISOString()} ${msg}\n`);
    }
  };

  const previousWrite = stdout.write;
  const originalWrite = previousWrite.bind(stdout);
  let firstFrameMarked = false;

  // A terminal resize can make an otherwise identical Ink frame meaningful:
  // rows reflow at a new width and height-driven spacer/layout changes must be
  // written even when their source text did not change. src/index.tsx owns the
  // single resize listener and invokes this reset through the exported helper.
  resizeFrameCacheResetters.set(stdout, () => {
    lastFrame = "";
    logDebug("Frame cache reset: terminal resize");
  });

  const target: FrameWritable = stdout;
  target.write = (chunk, encoding, callback) => {
    if (typeof chunk !== "string" || chunk.length === 0) {
      return originalWrite(chunk, encoding, callback);
    }

    // Task 7: Frame Lock
    // Ensure only one render flush can write to stdout at a time.
    if (isFlushing) {
      // Node's Writable queue owns serialization. A reentrant write is still
      // real output, and dropping it would violate the stream contract.
      lastFrame = "";
      return originalWrite(chunk, encoding, callback);
    }

    // Task 8: Full-frame Deduplication
    // Skip if identical to last frame.
    if (chunk === lastFrame) {
      logDebug("Frame dropped: identical to last frame");
      // Empty writes still provide an ordered completion barrier to Ink.
      return typeof encoding === "function" || callback
        ? originalWrite("", encoding, callback)
        : true;
    }

    // Task 4: Width-Safe Injection
    // Ensure every row clears to the end of the line. This fixes artifacts
    // left behind when a shorter row replaces a longer row or when terminal
    // wrapping occurs during resize.
    //
    // We inject \x1b[K before every newline and at the end of the frame.
    // padding via \x1b[K injection.
    // Only apply if the chunk is non-empty and doesn't look like a control-only
    // sequence (e.g. terminal title OSC).
    let processed = chunk;
    const isControlSequence = /\x1b[\]_P]/.test(chunk);
    if (chunk.length > 0 && !isControlSequence) {
      processed = chunk.replace(/\n/g, "\x1b[K\n");
      if (!processed.endsWith("\x1b[K") && !processed.endsWith("\x1b[K\n")) {
        processed += "\x1b[K";
      }
    }

    isFlushing = true;
    try {
      lastFrame = chunk;
      // Negotiation, cursor and mode-control writes are not rendered content.
      const hasVisibleText =
        !firstFrameMarked &&
        /[^\s]/.test(
          chunk
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
            .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ""),
        );
      if (!firstFrameMarked && !isControlSequence && hasVisibleText) {
        firstFrameMarked = true;
        benchTrace.startupMark("first-frame-write", { bytes: processed.length });
      }
      benchTrace.traceFrameTokens(chunk);
      const resizing = isTerminalResizing();
      logDebug(
        `Frame written: length=${processed.length} original=${chunk.length} resizing=${resizing}`,
      );
      const traceGeneration = resizeTraceEnabled ? getResizeGeneration() : 0;
      const traceCols = (stdout as { columns?: number }).columns;
      const traceRows = (stdout as { rows?: number }).rows;
      if (resizeTraceEnabled)
        traceResize("write", {
          visible: /[^\s]/.test(chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")),
          cols: (stdout as { columns?: number }).columns,
          rows: (stdout as { rows?: number }).rows,
          bytes: processed.length,
        });
      const completed = resizeTraceEnabled
        ? (error?: Error | null) => {
            traceResize("writeComplete", {
              generation: traceGeneration,
              colsAtWrite: traceCols,
              rowsAtWrite: traceRows,
              cols: (stdout as { columns?: number }).columns,
              rows: (stdout as { rows?: number }).rows,
            });
            callback?.(error);
          }
        : callback;
      return originalWrite(
        (getStartupGraphicsChannel(stdout)?.prepareFrame(chunk) ?? "") +
          (getStartupGraphicsChannel(stdout)?.transformFrame(processed) ?? processed),
        encoding,
        completed,
      );
    } catch (error) {
      lastFrame = "";
      getStartupGraphicsChannel(stdout)?.reportWriteFailure();
      renderDebug.traceEvent("terminal", "frameWriteFailed", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      isFlushing = false;
    }
  };

  const wrappedWrite = target.write;
  frameLockReleases.set(stdout, () => {
    if (target.write === wrappedWrite) target.write = previousWrite;
    lastFrame = "";
    debugLogStream?.end();
    debugLogStream = null;
    resizeFrameCacheResetters.delete(stdout);
    frameLockReleases.delete(stdout);
  });
  return stdout;
}
