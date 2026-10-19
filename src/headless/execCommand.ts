/**
 * The `ubume exec` and `ubume --headless-benchmark` commands.
 *
 * This module connects the parsed arguments, the prompt source (argv or stdin) and the
 * workspace to `runSavedExec`, and picks the output mode:
 * - **human**: the answer streams to stdout as it arrives, and diagnostics and the
 *   session id go to stderr.
 * - **`--json`**: streaming stdout is discarded, and the dispatcher prints one envelope
 *   holding `{ text, sessionId }` at the end, so stdout always parses as a single JSON
 *   document.
 *
 * Benchmark runs (`--headless-benchmark` or `UBUME_HEADLESS_BENCHMARK=1`) are never saved.
 */
import {
  type CommandEnv,
  CommandError,
  type CommandOutcome,
  commandWorkspace,
  EXIT_CODE,
  usageError,
} from "./commandResult.js";
import { parseHeadlessExecArgs } from "./execArgs.js";
import type { HeadlessExecIo } from "./execRunner.js";
import { createHeadlessExecTiming } from "./execTiming.js";

const MAX_STDIN_PROMPT_BYTES = 8 * 1024 * 1024;

/** Discards the runner's streaming stdout in `--json` mode. */
const NULL_STDOUT: HeadlessExecIo["stdout"] = { write: (_text: string) => true };

/**
 * Reads the whole prompt from stdin as strict UTF-8.
 *
 * Cancellation is raced against each read, so an idle pipe cannot keep an interrupted
 * command alive. The iterator's `return()` is requested in the background for the same
 * reason: a custom iterator may only finish it after its pending `next()` settles.
 *
 * @throws {CommandError} `INTERRUPTED` (130) on abort; `USAGE` (2) when the prompt is
 *   empty or larger than 8 MiB.
 * @throws {TypeError} when the input is not valid UTF-8; this surfaces as `FAILED` (1).
 */
export async function readStdinPrompt(
  input: AsyncIterable<string | Buffer>,
  signal?: AbortSignal,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const iterator = input[Symbol.asyncIterator]();
  const interrupted = () =>
    new CommandError("Run interrupted.", EXIT_CODE.INTERRUPTED, "INTERRUPTED");
  let abort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => reject(interrupted());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });

  try {
    while (true) {
      const next = await Promise.race([iterator.next(), cancellation]);
      if (signal?.aborted) throw interrupted();
      if (next.done) break;

      const value = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      bytes += value.length;
      if (bytes > MAX_STDIN_PROMPT_BYTES) throw usageError("Stdin prompt exceeds 8 MiB.");
      chunks.push(value);
    }
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    // A custom iterator's return may wait for its outstanding next call.
    // Request cleanup without delaying cancellation.
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
  }

  const prompt = new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks));
  if (!prompt.trim()) throw usageError("Stdin prompt is empty.");
  return prompt;
}

/**
 * Runs `exec` / `--headless-benchmark`.
 *
 * Sets `env.json` from the parsed flags, so that a literal `--json` after `--` in the
 * prompt does not switch output modes.
 *
 * @param command - `exec` or `--headless-benchmark`.
 * @param argv - Arguments after the command name.
 * @throws {CommandError} for usage errors, and for any error from `runSavedExec`
 *   that happens before the run starts.
 */
export async function runExecCommand(
  command: string,
  argv: readonly string[],
  env: CommandEnv,
): Promise<CommandOutcome> {
  const parsed = parseHeadlessExecArgs(argv);
  if (!parsed.ok) throw usageError(parsed.error);
  const args = parsed.value;
  env.json = args.json;
  if (args.help) return env.helpOutcome();

  if (args.stdin && !env.stdin && process.stdin.isTTY) {
    throw usageError("--stdin requires piped or redirected input.");
  }
  const prompt = args.stdin
    ? await readStdinPrompt(env.stdin ?? process.stdin, env.signal)
    : args.prompt;
  const workspace = commandWorkspace(args.cwd);

  // Provider runtimes load only after argument and help handling.
  const { runSavedExec } = await import("./savedExec.js");
  const result = await runSavedExec(
    {
      prompt,
      workspaceRoot: workspace,
      launchArgs: args.launchArgs,
      providerId: args.providerId,
      resumeId: args.resumeId,
      noSave:
        args.noSave ||
        command === "--headless-benchmark" ||
        process.env.UBUME_HEADLESS_BENCHMARK === "1",
      files: args.files,
      promptPolicy: args.promptPolicy,
      signal: env.signal,
      benchmarkDiagnostics: createHeadlessExecTiming({
        enabled: args.timing || process.env.UBUME_EXEC_TIMING === "1",
        stderr: env.io.stderr,
        // The launcher passes its own start time, so that phases cover the whole process.
        startTimeMs: Number(process.env.UBUME_EXEC_TIMING_EPOCH_MS) || undefined,
      }),
    },
    args.json ? { stdout: NULL_STDOUT, stderr: env.io.stderr } : env.io,
  );

  if (args.json) {
    const failed = result.exitCode !== EXIT_CODE.OK;
    return {
      kind: "result",
      data: { text: result.text ?? "", sessionId: result.sessionId ?? null },
      exitCode: result.exitCode,
      error: failed
        ? {
            code: result.exitCode === EXIT_CODE.INTERRUPTED ? "INTERRUPTED" : "RUN_FAILED",
            message: result.error ?? "Run failed.",
          }
        : null,
    };
  }

  // The answer has already streamed. End it with a newline so that the shell prompt
  // starts on its own line.
  if (result.text && !result.text.endsWith("\n")) env.io.stdout.write("\n");
  return { kind: "written", exitCode: result.exitCode };
}
