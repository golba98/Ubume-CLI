/**
 * Public entry point of the headless command surface (`src/cli.ts` calls
 * {@link runTerminalCommand}).
 *
 * This module owns everything that is common to all commands:
 * - selecting the command (including a leading `--json`, which is moved behind it);
 * - help;
 * - the output contract: one versioned JSON envelope on stdout with `--json`;
 *   otherwise the result on stdout and errors on stderr;
 * - redaction of everything it prints;
 * - mapping exceptions onto exit codes and envelope error codes.
 *
 * Command handlers live in `execCommand.ts`, `inspectCommands.ts` and
 * `sessionCommands.ts`. They return a {@link CommandOutcome} or throw a `CommandError`,
 * and never write the envelope themselves.
 */
import { errorMessage } from "../core/shared/values.js";
import { getAppVersion } from "../core/version/channel.js";
import {
  type CommandEnv,
  CommandError,
  type CommandOutcome,
  type EnvelopeError,
  EXIT_CODE,
  resultOutcome,
} from "./commandResult.js";
import { runExecCommand } from "./execCommand.js";
import type { HeadlessExecIo } from "./execRunner.js";
import { runInspectionCommand } from "./inspectCommands.js";
import { redact } from "./redact.js";

/** The single JSON document `--json` prints. Version 1 fields are frozen. */
interface CommandEnvelope {
  schemaVersion: 1;
  command: string;
  ok: boolean;
  data: unknown;
  error: EnvelopeError | null;
}

export const terminalHelp = `Ubume ${getAppVersion()}
Usage:
  ubume                           Open the interactive terminal UI.
  ubume doctor [--probe]           Diagnose local setup; --probe checks auth/network.
  ubume status                    Show workspace, route, ownership and recovery state.
  ubume config                    Show effective configuration and its sources.
  ubume providers                 List providers and local availability.
  ubume models [--provider ID] [--refresh]
  ubume sessions list
  ubume sessions show ID
  ubume sessions transcript ID
  ubume sessions diff ID [--turn NUMBER] [--file PATH]
  ubume exec [options] "prompt"
  ubume exec --stdin               Read a prompt from piped stdin.
  ubume exec --resume ID "prompt"  Continue a saved session.

All terminal commands accept --cwd DIRECTORY, --json, and --help.
Exec options: --provider ID, --model MODEL, --reasoning EFFORT, --profile NAME,
  -c key=value, --prompt TEXT, --file PATH (repeatable), --no-save, --timing,
  --ubume-prompt-policy raw|wrapped (default raw), --skip-git-repo-check.
Normal exec runs save by default; benchmark runs are transient. Session IDs and
activity go to stderr; answers go to stdout. --json emits one versioned object.
Use -- before a prompt containing option-like words. Diagnostics never send a model prompt.
`;

const HELP_OUTCOME: CommandOutcome = resultOutcome(
  { help: terminalHelp },
  { human: terminalHelp.trimEnd() },
);

/**
 * Exit code for an exception: 130 when the run was aborted (whatever was thrown);
 * otherwise the `CommandError`'s code, any numeric `exitCode` the error carries
 * (ownership conflicts throw these), or 1.
 */
function exitCodeForError(error: unknown, aborted: boolean): number {
  if (aborted) return EXIT_CODE.INTERRUPTED;
  if (error instanceof CommandError) return error.exitCode;
  const exitCode = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof exitCode === "number" ? exitCode : EXIT_CODE.FAILED;
}

function envelopeCodeForError(error: unknown, exitCode: number): string {
  if (exitCode === EXIT_CODE.INTERRUPTED) return "INTERRUPTED";
  if (error instanceof CommandError) return error.code;
  // Non-CommandError exit-3 errors come from the session/workspace ownership locks.
  if (exitCode === EXIT_CODE.UNAVAILABLE) return "BUSY";
  return "FAILED";
}

/**
 * Runs one headless command and returns its process exit code.
 *
 * This function never throws and never calls `process.exit`: every failure becomes an
 * exit code plus an error message (stderr) or envelope (stdout with `--json`). With
 * `--json`, stdout carries exactly one newline-terminated JSON object; streaming
 * diagnostics still go to stderr.
 *
 * If `options.signal` is aborted, an otherwise successful command reports 130
 * `INTERRUPTED`, so that a caller's Ctrl-C is never mistaken for success.
 *
 * @param argv - Arguments after the executable (`process.argv.slice(2)`).
 * @param io - Output channels; defaults to the process streams.
 * @param options.signal - Abort signal wired to SIGINT/SIGTERM by `src/cli.ts`.
 * @param options.stdin - Prompt source for `exec --stdin`; defaults to `process.stdin`.
 * @returns 0 success; 1 run/doctor failure; 2 usage; 3 unavailable/busy; 130 interrupted.
 */
export async function runTerminalCommand(
  argv: readonly string[],
  io: HeadlessExecIo = { stdout: process.stdout, stderr: process.stderr },
  options: { signal?: AbortSignal; stdin?: AsyncIterable<string | Buffer> } = {},
): Promise<number> {
  let command = argv[0] ?? "help";
  const env: CommandEnv = {
    io,
    signal: options.signal,
    stdin: options.stdin,
    json: argv.includes("--json"),
    secrets: [],
    helpOutcome: () => HELP_OUTCOME,
  };

  const emit = (
    data: unknown,
    exitCode: number = EXIT_CODE.OK,
    error: EnvelopeError | null = null,
    human?: string,
  ): number => {
    if (options.signal?.aborted && exitCode === EXIT_CODE.OK) {
      exitCode = EXIT_CODE.INTERRUPTED;
      error = { code: "INTERRUPTED", message: "Command interrupted." };
    }
    if (env.json) {
      const envelope: CommandEnvelope = {
        schemaVersion: 1,
        command,
        ok: exitCode === EXIT_CODE.OK,
        data,
        error,
      };
      io.stdout.write(`${JSON.stringify(redact(envelope, env.secrets))}\n`);
    } else if (error) {
      io.stderr.write(`${String(redact(error.message, env.secrets))}\n`);
    } else {
      const text = human ?? JSON.stringify(data, null, 2);
      io.stdout.write(`${String(redact(text, env.secrets))}\n`);
    }
    return exitCode;
  };

  try {
    // `ubume --json status` is equivalent to `ubume status --json`.
    if (command === "--json") {
      command = argv[1] ?? "help";
      argv = [command, ...argv.slice(2), "--json"];
    }

    let outcome: CommandOutcome;
    if (command === "help" || command === "--help" || command === "-h") {
      outcome = HELP_OUTCOME;
    } else if (command === "exec" || command === "--headless-benchmark") {
      outcome = await runExecCommand(command, argv.slice(1), env);
    } else {
      outcome = await runInspectionCommand(command, argv.slice(1), env);
    }

    // Human-mode exec has already streamed its output; its exit code is final.
    if (outcome.kind === "written") return outcome.exitCode;
    return emit(outcome.data, outcome.exitCode, outcome.error, outcome.human);
  } catch (error) {
    const exitCode = exitCodeForError(error, options.signal?.aborted ?? false);
    return emit(null, exitCode, {
      code: envelopeCodeForError(error, exitCode),
      message: errorMessage(error),
    });
  }
}
