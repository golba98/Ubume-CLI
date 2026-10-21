import { type Instance, type RenderOptions, render } from "ink";
import type React from "react";
import { App } from "./app/App.js";
import { type LaunchArgs, parseLaunchArgs } from "./config/launchArgs.js";
import { loadSettings } from "./config/persistence.js";
import { APP_NAME, formatTerminalTitlePath } from "./config/settings.js";
import * as benchTrace from "./core/perf/benchTrace.js";
import * as renderDebug from "./core/perf/renderDebug.js";
import type { BackendProvider } from "./core/providers/types.js";
import {
  releaseFrameLock,
  resetFrameLockForResize,
  wrapStdoutWithFrameLock,
} from "./core/terminal/frameLock.js";
import {
  type InkRenderInstance,
  resolveInkRenderInstance,
} from "./core/terminal/inkRenderReset.js";
import {
  createStartupGraphicsChannel,
  registerStartupGraphicsChannel,
} from "./core/terminal/startupGraphics.js";
import { getTerminalCapability } from "./core/terminal/terminalCapabilities.js";
import {
  createTerminalModeController,
  writeTerminalControl,
} from "./core/terminal/terminalControl.js";
import { createTerminalQueryInput } from "./core/terminal/terminalQueryInput.js";
import { setIntendedTerminalTitle } from "./core/terminal/terminalTitle.js";
import { resolveWorkspaceRoot } from "./core/workspace/workspaceRoot.js";
import { MIN_VIEWPORT_COLS, MIN_VIEWPORT_ROWS } from "./ui/layout.js";

/** After the resize repaint, then once more for slow (large or remote) frames. */
const KITTY_PLACEMENT_REFRESH_DELAYS_MS = [350, 1200];

type RenderHandle = Pick<Instance, "clear" | "cleanup" | "waitUntilExit">;

export function resolveKittyKeyboardOptions(
  env: Record<string, string | undefined>,
): RenderOptions["kittyKeyboard"] | undefined {
  // Ink's auto mode probes with CSI ? u. Kitty's response can race Ink's
  // regular input listeners and leak into both the first frame and composer.
  // A direct Kitty session is already known to support the protocol, so enable
  // it without probing. Avoid protocol negotiation in all other terminals.
  if ((env.TERM ?? "").toLowerCase() !== "xterm-kitty") {
    return undefined;
  }

  return {
    mode: "enabled",
    flags: ["disambiguateEscapeCodes"],
  };
}

export interface AppStdout {
  isTTY: boolean;
  write: (chunk: string) => boolean;
  on: (event: "resize" | string, listener: (...args: unknown[]) => void) => void;
  off: (event: "resize" | string, listener: (...args: unknown[]) => void) => void;
  columns?: number;
  rows?: number;
}

export interface StartAppDependencies {
  stdin: Pick<NodeJS.ReadStream, "isTTY">;
  stdout: AppStdout;
  stderr: Pick<NodeJS.WriteStream, "write"> & Partial<Pick<NodeJS.WriteStream, "isTTY">>;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  argv: string[];
  renderApp: (node: React.ReactElement, options?: RenderOptions) => RenderHandle;
  resolveInkInstanceForStdout: (stdout: AppStdout) => InkRenderInstance | null;
  registerExitHandler: (handler: () => void) => void | (() => void);
  /** Offline benchmark/embedding seam (never a CLI flag): the App's provider override. */
  providerOverride?: BackendProvider;
}

export interface StartAppResult {
  started: boolean;
  exitCode: number;
}

interface ActiveRootState {
  cleanup: () => void;
}

let activeRoot: ActiveRootState | null = null;

function debugLaunch(
  env: Record<string, string | undefined>,
  write: (chunk: string, source: string) => boolean,
  fields: Record<string, unknown>,
): void {
  if (env.UBUME_DEBUG_LAUNCH !== "1") {
    return;
  }

  write(`[ubume:launch] ${JSON.stringify(fields)}\n`, "src/index.tsx:launchDebug");
}

function hasInvalidRestoreDimensions(stdout: Pick<AppStdout, "columns" | "rows">): boolean {
  const cols = stdout.columns;
  const rows = stdout.rows;
  return (
    !Number.isFinite(cols) ||
    !Number.isFinite(rows) ||
    (cols ?? 0) < MIN_VIEWPORT_COLS ||
    (rows ?? 0) < MIN_VIEWPORT_ROWS
  );
}

export function startApp({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  platform = process.platform,
  argv = process.argv.slice(2),
  renderApp = render,
  resolveInkInstanceForStdout = resolveInkRenderInstance,
  registerExitHandler = (handler) => {
    process.once("exit", handler);
    return () => {
      process.off("exit", handler);
    };
  },
  providerOverride,
}: Partial<StartAppDependencies> = {}): StartAppResult {
  benchTrace.startupMark("start-app");
  renderDebug.configureRenderDebug(env);

  if (activeRoot) {
    return { started: true, exitCode: 0 };
  }

  // Wrap stdout to implement frame locking, deduplication, and width-safe row
  // padding via \x1b[K injection across the entire TUI.
  const wrappedStdout = wrapStdoutWithFrameLock({ stdout, env });

  const terminal = createTerminalModeController((chunk) => wrappedStdout.write(chunk));
  const writeStdout = (chunk: string, source: string): boolean => terminal.write(chunk, source);

  const writeStderr = (chunk: string, source: string): boolean => {
    return writeTerminalControl((value) => stderr.write(value), "stderr", source, chunk);
  };

  debugLaunch(env, writeStderr, {
    phase: "startApp",
    resolvedLaunchMode: "interactive-ui",
    stdinIsTTY: Boolean(stdin.isTTY),
    stdoutIsTTY: Boolean(stdout.isTTY),
    stderrIsTTY: Boolean(stderr.isTTY),
    TERM: env.TERM,
    WT_SESSION: env.WT_SESSION,
    TERM_PROGRAM: env.TERM_PROGRAM,
    argv,
  });

  const capability = getTerminalCapability({
    stdinIsTTY: Boolean(stdin.isTTY),
    stdoutIsTTY: Boolean(stdout.isTTY),
    platform,
    env,
  });

  if (!capability.supported) {
    writeStderr(`${capability.message}\n`, "src/index.tsx:unsupportedTerminal");
    releaseFrameLock(stdout);
    return { started: false, exitCode: 1 };
  }
  if (capability.warning) {
    writeStderr(`${capability.warning}\n`, "src/index.tsx:terminalCapabilityWarning");
  }

  const parsedLaunchArgs = parseLaunchArgs(argv);
  if (!parsedLaunchArgs.ok) {
    writeStderr(`${parsedLaunchArgs.error}\n`, "src/index.tsx:launchArgs");
    releaseFrameLock(stdout);
    return { started: false, exitCode: 1 };
  }
  const launchArgs: LaunchArgs = parsedLaunchArgs.value;
  // Main chat starts in the normal screen buffer so the startup frame and later
  // transcript rows are owned by native terminal scrollback. Overlay screens
  // enter alternate-screen mode from app.tsx only while an overlay is active.
  const startupWorkspaceRoot = resolveWorkspaceRoot();
  const startupSettings = loadSettings();
  benchTrace.startupMark("settings-loaded");
  const startupTitle =
    formatTerminalTitlePath(startupWorkspaceRoot, startupSettings.ui.terminalTitleMode) || APP_NAME;
  setIntendedTerminalTitle(startupTitle, {
    force: true,
    reason: "startup-title",
    write: (chunk) => writeStdout(chunk, "src/index.tsx:startup.title"),
  });
  terminal.setMouseReporting(false, "src/index.tsx:startup.nativeScroll");
  terminal.setBracketedPaste(true, "src/index.tsx:startup.bracketedPaste");

  const queryInput =
    stdin.isTTY && stdout.isTTY && "setRawMode" in stdin && "on" in stdin
      ? createTerminalQueryInput(stdin as NodeJS.ReadStream, (chunk) => wrappedStdout.write(chunk))
      : null;
  const graphics = queryInput
    ? createStartupGraphicsChannel({
        query: queryInput.query,
        tmux: Boolean(env.TMUX),
        disabled: Boolean(env.STY) || env.TERM === "dumb" || env.INK_SCREEN_READER === "true",
      })
    : null;
  const unregisterGraphics = graphics
    ? registerStartupGraphicsChannel(wrappedStdout, graphics)
    : null;
  let unregisterExitHandler: void | (() => void);
  let cleanupDone = false;
  let repaintArmed = false;
  let renderHandle: RenderHandle | null = null;
  let inkInstance: InkRenderInstance | null = null;
  let previousResizeCols = stdout.columns;
  let previousResizeRows = stdout.rows;

  // Kitty may leave an image placed while it is still settling an OS-window
  // resize unpainted until some unrelated redraw. Once the resize repaint has
  // landed (the viewport commits within 50ms), re-issue the
  // data-free placements so the logo appears without waiting for input.
  let placementRefreshTimers: ReturnType<typeof setTimeout>[] = [];
  let capabilityRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePlacementRefresh = () => {
    for (const timer of placementRefreshTimers) clearTimeout(timer);
    placementRefreshTimers = graphics
      ? KITTY_PLACEMENT_REFRESH_DELAYS_MS.map((delay) =>
          // Best effort: a pending refresh must never delay process exit.
          setTimeout(() => {
            const commands = graphics.refreshPlacements();
            if (commands) writeStdout(commands, "src/index.tsx:kittyPlacementRefresh");
          }, delay).unref(),
        )
      : [];
  };

  const onResize = () => {
    if (graphics && !capabilityRefreshTimer)
      capabilityRefreshTimer = setTimeout(() => {
        capabilityRefreshTimer = undefined;
        if (!cleanupDone) graphics.probe(true);
      }, 50).unref();
    schedulePlacementRefresh();
    resetFrameLockForResize(wrappedStdout);
    renderDebug.traceEvent("terminal", "resize", {
      previousCols: previousResizeCols,
      previousRows: previousResizeRows,
      cols: stdout.columns,
      rows: stdout.rows,
      invalid: hasInvalidRestoreDimensions(stdout),
    });
    previousResizeCols = stdout.columns;
    previousResizeRows = stdout.rows;

    if (hasInvalidRestoreDimensions(stdout)) {
      // Transient invalid dimensions (e.g. during maximize/restore on
      // Windows). Keep the previous frame visible and let useTerminalViewport
      // preserve the last renderable layout until valid dimensions return.
      repaintArmed = true;
      return;
    }

    if (repaintArmed) {
      repaintArmed = false;
    }

    // useTerminalViewport owns resize-driven React state. Do not clear the
    // terminal, reset Ink output caches, or force Ink renders here; those
    // imperative paths can produce a transient empty frame during streaming.
  };

  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    clearTimeout(capabilityRefreshTimer);
    stdout.off("resize", onResize);
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    process.off("uncaughtException", handleFatal);
    process.off("unhandledRejection", handleFatal);
    unregisterExitHandler?.();
    try {
      renderHandle?.cleanup();
    } finally {
      try {
        // Restore terminal modes even when the renderer fails during teardown.
        terminal.setMouseReporting(false, "src/index.tsx:cleanup.mouse");
        terminal.setBracketedPaste(false, "src/index.tsx:cleanup.bracketedPaste");
        terminal.setAlternateScreen(false, "src/index.tsx:cleanup.alternateScreen");
        terminal.resetModes();
      } finally {
        for (const timer of placementRefreshTimers) clearTimeout(timer);
        try {
          // Deleting owned Kitty images is best effort on a closing terminal;
          // a failed write must not skip stdin/frame-lock restoration below.
          if (graphics) wrappedStdout.write(graphics.dispose());
        } finally {
          unregisterGraphics?.();
          queryInput?.dispose();
          releaseFrameLock(stdout);
          activeRoot = null;
        }
      }
    }
  };

  const handleFatal = (error: unknown) => {
    cleanup();
    if (error instanceof Error) {
      writeStderr(`${error.stack || error.message}\n`, "src/index.tsx:fatalError");
    } else if (error) {
      writeStderr(`${String(error)}\n`, "src/index.tsx:fatalUnknown");
    }
    process.exit(1);
  };

  const handleSignal = () => {
    cleanup();
    process.exit(0);
  };

  stdout.on("resize", onResize);
  unregisterExitHandler = registerExitHandler(cleanup);

  // Ensure clean teardown on signals and unhandled failures to prevent
  // leaving the terminal in mouse-reporting mode.
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("uncaughtException", handleFatal);
  process.on("unhandledRejection", handleFatal);

  const kittyKeyboard = resolveKittyKeyboardOptions(env);
  benchTrace.startupMark("render-start");
  try {
    renderHandle = renderApp(<App launchArgs={launchArgs} providerOverride={providerOverride} />, {
      // App owns cancel, draft clearing, and the deliberate second Ctrl-C quit.
      exitOnCtrlC: false,
      onRender: () => {
        benchTrace.startupMarkOnce("ink-output-generated");
        benchTrace.traceInkOutputGenerated();
      },
      ...(kittyKeyboard ? { kittyKeyboard } : {}),
      // AppStdout is the narrow surface the app uses; Ink wants the full stream type.
      stdout: wrappedStdout as unknown as NodeJS.WriteStream,
      ...(queryInput ? { stdin: queryInput.stream as unknown as NodeJS.ReadStream } : {}),
    });
  } catch (error) {
    cleanup();
    throw error;
  }

  // Resolve the real Ink class instance to get access to lastOutput,
  // onRender, calculateLayout, etc.  Gracefully degrades to null in tests.
  inkInstance = resolveInkInstanceForStdout(wrappedStdout);

  // Remove Ink's own resize handler so the app is the sole resize handler.
  // This eliminates the race where Ink's resized() fires alongside our
  // onResize, causing interleaved renders that desync logUpdate.
  if (inkInstance?.unsubscribeResize) {
    inkInstance.unsubscribeResize();
  }

  benchTrace.startupMark("render-returned");
  void renderHandle.waitUntilExit().finally(cleanup);

  activeRoot = { cleanup };
  return { started: true, exitCode: 0 };
}

const isMainModule = Boolean((import.meta as ImportMeta & { main?: boolean }).main);

if (isMainModule) {
  benchTrace.startupMarkProcessStart();
  benchTrace.startupMark("modules-loaded");
  benchTrace.installMemoryReporter();
  const result = startApp();
  if (!result.started) {
    process.exitCode = result.exitCode;
  }
}
