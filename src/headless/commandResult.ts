/**
 * The vocabulary headless command handlers use to report results: exit codes, the typed
 * {@link CommandError}, the {@link CommandOutcome} a handler returns, and the shared
 * workspace resolution.
 *
 * Scripts and CI jobs branch on these process exit codes, and `--json` callers branch on
 * the `error.code` strings. Both are a public contract: add new values rather than
 * renumbering existing ones.
 */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveWorkspaceRoot } from "../core/workspace/workspaceRoot.js";

/** Process exit codes returned by every headless command. */
export const EXIT_CODE = {
  /** The command succeeded. */
  OK: 0,
  /** The provider run failed, `doctor` found a failing check, or an unexpected error escaped. */
  FAILED: 1,
  /** Invalid arguments or input; nothing was executed. */
  USAGE: 2,
  /** A provider, session, model list or workspace lock is unavailable or busy. */
  UNAVAILABLE: 3,
  /** SIGINT/SIGTERM (or the caller's abort signal) interrupted the command. */
  INTERRUPTED: 130,
} as const;

/**
 * An expected, user-facing failure with a stable exit code and machine-readable code.
 *
 * Throw it anywhere below `runTerminalCommand`; the dispatcher converts it into the
 * stderr message or JSON envelope. Unexpected errors should propagate as plain `Error`s
 * so they surface as `FAILED`.
 */
export class CommandError extends Error {
  /**
   * @param message - Human-readable message (redacted before printing).
   * @param exitCode - Process exit code; defaults to {@link EXIT_CODE.UNAVAILABLE}.
   * @param code - Envelope error code, e.g. `USAGE`, `UNAVAILABLE`, `MIGRATION_REQUIRED`.
   */
  constructor(
    message: string,
    readonly exitCode: number = EXIT_CODE.UNAVAILABLE,
    readonly code = "UNAVAILABLE",
  ) {
    super(message);
  }
}

/** Shorthand for a {@link CommandError} with exit code 2 and code `USAGE`. */
export function usageError(message: string): CommandError {
  return new CommandError(message, EXIT_CODE.USAGE, "USAGE");
}

/**
 * Resolves the workspace a command operates on: `--cwd` if given, else the detected root.
 *
 * The result is canonicalised with `realpath` so that session ownership and data-dir
 * hashing agree across symlinked paths.
 *
 * @throws {CommandError} `USAGE` when the path is missing, inaccessible or not a directory.
 */
export function commandWorkspace(cwd?: string): string {
  let workspace: string;
  try {
    workspace = realpathSync(cwd ? resolve(cwd) : resolveWorkspaceRoot());
  } catch {
    throw usageError("Workspace directory does not exist or is inaccessible.");
  }
  if (!statSync(workspace).isDirectory()) throw usageError("--cwd must select a directory.");
  return workspace;
}

/** The `error` member of the JSON envelope. */
export interface EnvelopeError {
  code: string;
  message: string;
}

/**
 * What a command handler returns. Only `commands.ts` turns it into output.
 *
 * - `result`: the dispatcher prints `data` as the JSON envelope, or prints `human`
 *   (falling back to pretty JSON) on stdout, or `error.message` on stderr.
 * - `written`: the handler already streamed its own output (human-mode `exec`); only
 *   the exit code is returned.
 */
export type CommandOutcome =
  | {
      kind: "result";
      data: unknown;
      /** Defaults to {@link EXIT_CODE.OK}. */
      exitCode?: number;
      error?: EnvelopeError | null;
      /** Human-readable form; defaults to `JSON.stringify(data, null, 2)`. */
      human?: string;
    }
  | { kind: "written"; exitCode: number };

/** Shorthand for a `result` outcome. */
export function resultOutcome(
  data: unknown,
  extra: Omit<Extract<CommandOutcome, { kind: "result" }>, "kind" | "data"> = {},
): CommandOutcome {
  return { kind: "result", data, ...extra };
}

/** Per-invocation state shared with command handlers. */
export interface CommandEnv {
  /** Same shape as `HeadlessExecIo`; it is spelled out here to avoid an import cycle with execRunner. */
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
  };
  signal?: AbortSignal;
  /** Injected stdin (tests and embedders); defaults to `process.stdin`. */
  stdin?: AsyncIterable<string | Buffer>;
  /** Output mode. `exec` overwrites it with its parsed `--json` flag. */
  json: boolean;
  /** Extra values to redact. Handlers append configured API keys as soon as they are known. */
  secrets: string[];
  helpOutcome: () => CommandOutcome;
}
