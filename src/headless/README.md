# Headless subsystem

`src/headless/` is Ubume's non-interactive command surface. It covers `ubume exec`,
`ubume --headless-benchmark`, and the read-only inspection commands (`doctor`,
`status`, `config`, `providers`, `models`, `sessions`). It is built for scripts, CI and
subprocess callers:

- It never renders Ink or React.
- It never reads the keyboard, depends on terminal dimensions, or prompts. Tool
  approvals are denied, and `--stdin` refuses an interactive TTY.
- It reports every result as an exit code plus a fixed stdout/stderr split.

The headless commands reuse the interactive app's configuration, provider routing,
session storage and file checkpoints. A session started with `ubume exec` can be
resumed in the TUI, and the reverse also works.

User-facing usage lives in [docs/terminal/headless-commands.md](../../docs/terminal/headless-commands.md).
This document is for contributors.

## Module map

| File | Responsibility |
| --- | --- |
| `commands.ts` | **Public entry**: `runTerminalCommand(argv, io?, { signal?, stdin? })` and `terminalHelp`. Selects the command, prints help, writes the JSON envelope or human output, redacts output, and maps errors to exit codes. |
| `commandResult.ts` | Shared vocabulary for handlers: `EXIT_CODE`, `CommandError` / `usageError`, `CommandOutcome`, `CommandEnv`, and `commandWorkspace` (`--cwd` resolution). |
| `execCommand.ts` | The `exec` / `--headless-benchmark` handler, plus `readStdinPrompt` for strict UTF-8 input capped at 8 MiB. |
| `execArgs.ts` | Pure parser for `exec` arguments (`parseHeadlessExecArgs`). |
| `inspectCommands.ts` | Inspection argument parser, and the `config` / `providers` / `status` / `doctor` / `models` handlers. |
| `sessionCommands.ts` | `sessions list / show / transcript / diff`. |
| `context.ts` | `resolveExecutionContext`: provider, model and reasoning precedence, plus execution-readiness checks. |
| `savedExec.ts` | `runSavedExec`: wraps one run with session persistence, locking, attachments and file checkpoints. |
| `execRunner.ts` | `runHeadlessExec`: runs one provider turn and maps its callbacks onto stdout/stderr and an exit code. |
| `execOutput.ts` | Stream filtering and formatting (sanitising, noise suppression, `[ubume exec]` diagnostic lines). |
| `execTiming.ts` | Opt-in `[ubume exec timing]` phase marks. |
| `diagnostics.ts` | `listProviderStatus`, `providerExecutable` and the `doctor` checks. |
| `redact.ts` | `redact` and `providerSecrets`. Everything printed passes through `redact`. |

Dependencies point one way: `commands` → `execCommand` / `inspectCommands` → `savedExec` /
`sessionCommands` → `execRunner` → `context` / `execOutput` / `execTiming`. `commandResult`
and `redact` are leaves. There are no import cycles.

`context.ts`, `diagnostics.ts` and `execRunner.ts` re-export `CommandError`, `redact` and
`createHeadlessExecTiming` from their old locations for compatibility. New code should
import them from `commandResult.ts`, `redact.ts` and `execTiming.ts`.

## Lifecycle

```text
bin/ubume.js            routes exec/doctor/status/config/providers/models/sessions → src/cli.ts
src/cli.ts              wires SIGINT/SIGTERM to an AbortController; sets process.exitCode
commands.ts             runTerminalCommand: choose command, catch errors, print the outcome
 ├─ execCommand.ts      parse → prompt (argv | stdin) → workspace → runSavedExec
 │   └─ savedExec.ts    resume → context → lock → recovery check → record → turn events → save
 │       └─ execRunner  resolve inputs → startup diagnostics → provider.run → settle → teardown
 └─ inspectCommands.ts  options → --help → workspace → (sessions) → args → context(inspect) → handler
```

`exec` resolves its context once in `savedExec.ts` and passes it down, so the runner
does not resolve config twice. Inspection commands resolve the context with
`{ inspect: true }`, which skips readiness checks, so a broken setup can still be
inspected.

## Commands and options

The canonical list is `terminalHelp` in `commands.ts`:

```sh
ubume doctor [--probe]
ubume status | config | providers
ubume models [--provider ID] [--refresh]
ubume sessions list | show ID | transcript ID | diff ID [--turn N] [--file PATH]
ubume exec [options] "prompt"
ubume exec --stdin            # prompt from a pipe or redirect
ubume exec --resume ID "next" # continue a saved session
```

Every command accepts `--cwd DIR`, `--json` and `--help`. A leading `--json`
(`ubume --json status`) is moved behind the command. `exec` value options accept
`--flag value` and `--flag=value`, except `-m`. Use the `=` form, or `--` before the
prompt, when a value starts with `-`.

## Output contract

| Mode | stdout | stderr |
| --- | --- | --- |
| human, success | the result (help text, a table, pretty JSON, or the streamed answer) | `[ubume exec] …` diagnostics, `[ubume exec] session: <id>` |
| human, failure | nothing, except an already-streamed partial `exec` answer, or the `doctor` check table (exit 1) | the error message |
| `--json` | exactly **one** newline-terminated envelope | streaming diagnostics only |

The envelope (version 1 is frozen; add fields rather than changing them):

```json
{ "schemaVersion": 1, "command": "exec", "ok": true,
  "data": { "text": "…", "sessionId": "chat_…" }, "error": null }
```

On failure, `ok` is false and `error` is `{ "code", "message" }`. `doctor` is the
exception: when a check fails, it returns `ok: false` with `error: null` and the checks in
`data`. In `--json` exec mode, the streamed answer is discarded and returned only in
`data.text`, so stdout always parses as a single JSON document.

Everything printed (envelope, human output, run diagnostics, store diagnostics) is
passed through `redact`. It removes secret-named fields, URL credentials, secret query
parameters, values of `*KEY*/*TOKEN*/*SECRET*/*PASSWORD*/*CREDENTIAL*` environment
variables, and configured provider API keys.

## Streaming

`execRunner.ts` writes assistant deltas to stdout as they arrive, after
`sanitizeTerminalOutput` (tabs become two spaces). It drops chunks made entirely of
leaked Codex JSONL events or Windows `taskkill` confirmations, and keeps mixed chunks
whole.

When the final response arrives:
- if it extends the streamed text, only the missing suffix is printed;
- if it differs, it is printed on a new line after the draft.

The result settles exactly once. Callbacks that arrive after the result is settled
(late deltas, a response after an abort) are ignored. Progress and tool activity go to
stderr, and progress lines that duplicate a reported tool row are suppressed. The
command layer appends a trailing newline in human mode.

## Exit codes and error codes

| Exit | Meaning | Envelope `error.code` |
| --- | --- | --- |
| 0 | success | — |
| 1 | provider run failed; `doctor` found a failing check; unexpected error (e.g. invalid UTF-8 on stdin) | `RUN_FAILED` (exec), `FAILED` |
| 2 | usage: bad option or value, prompt conflict, empty or oversized stdin, bad `--cwd` | `USAGE` |
| 3 | unavailable: provider or executable missing, approval denied, session not found, models not ready, pending file recovery | `UNAVAILABLE`, `MIGRATION_REQUIRED`, `BUSY` (lock held), `RUN_FAILED` (exec) |
| 130 | interrupted by SIGINT/SIGTERM or the caller's signal | `INTERRUPTED` |

Expected failures throw `CommandError(message, exitCode, code)`. Everything else
propagates as a plain error and becomes `FAILED` (1), or keeps its own numeric
`exitCode` (the ownership locks use 3 → `BUSY`). `runTerminalCommand` never throws and
never calls `process.exit`.

## Cancellation and cleanup

- `src/cli.ts` aborts the signal on SIGINT/SIGTERM and destroys a piped stdin.
- `readStdinPrompt` races every read against the signal, so an idle pipe cannot keep an
  interrupted command alive.
- On abort, the runner cancels the provider *then* settles with 130 and the partial
  text. It always calls the provider's cancel function once, then awaits
  `ProviderRunControl.stopped` before returning, so no provider subprocess outlives
  the call.
- On a denied approval, the runner settles with 3 and then cancels.
- `savedExec.ts` records the partial answer with `[Run interrupted]`, marks running
  tools as failed, takes the "after" checkpoint and saves. In `finally` blocks, it closes
  any Local harness session and releases the execution lock and session lease.
- An abort that happens after a command has otherwise succeeded still reports 130.

## Configuration and environment

Provider precedence: `--provider` → the resumed
session → the workspace active route → the workspace default → `openai`. Model and
reasoning precedence is documented on `buildProviderRoute` in `context.ts`.
`providers.json` is only ever read. Plan mode is always forced off.

| Variable | Effect |
| --- | --- |
| `UBUME_EXEC_TIMING=1` | Same as `--timing`. |
| `UBUME_EXEC_TIMING_EPOCH_MS` | Epoch for timing marks (the launcher sets it so that phases cover the whole process). |
| `UBUME_HEADLESS_BENCHMARK=1` | Treat `exec` as a transient benchmark run (no save). The launcher sets it for `--headless-benchmark`. |
| `UBUME_DATA_DIR` | Data root for sessions and checkpoints (used by tests for isolation). |
| `CODEX_EXECUTABLE`, `CLAUDE_EXECUTABLE`, `AGY_EXECUTABLE`, `VIBE_EXECUTABLE` | Provider CLI overrides, after `providers.json`. |

## Testing

```sh
bun test src/headless                 # everything below (~20 s)
bun test src/headless/execArgs.test.ts
```

- `execArgs.test.ts`: parser behavior and exact error wording.
- `execRunner.test.ts`: the runner with mock `BackendProvider`s injected through the
  `dependencies` argument. Covers streaming, the stdout/stderr split, settle-once,
  abort, approval denial and teardown. No real provider is spawned.
- `execOutput.test.ts`, `redact.test.ts`, `savedExec.test.ts`: unit tests for the
  extracted helpers.
- `commands.test.ts`: in-process tests of `runTerminalCommand` (usage errors, envelopes,
  help, stdin) with `UBUME_DATA_DIR` isolated. Also end-to-end tests through the real
  `bin/ubume.js` launcher with the fake provider in `src/test/fixtures/headlessProvider.mjs`
  (save, resume, transcript, diff, interrupt, busy locks, recovery).
- `googleRegression.test.ts`: Google/AGY routing through the launcher with
  `src/test/fixtures/antigravityProvider.mjs`.
- `diagnostics.test.ts`: provider listing.

Tests never use real credentials or contact a provider. End-to-end tests run inside a
temporary root with `UBUME_DATA_DIR`, `CODEX_HOME` and executable overrides.

For a manual smoke test through the real launcher:
`bun run dev:run -- exec --help`, `bun run dev:run -- --json status`. For an
authenticated end-to-end run, use `bun run smoke:terminal-bench`.

## Changing headless behavior

- **New inspection command**: add a `case` to `runInspectionCommand`, list its options in
  `COMMAND_OPTIONS`, add the command name to the launcher's headless list in
  `bin/ubume.js`, and update `terminalHelp` and `docs/terminal/headless-commands.md`.
- **New exec option**: add it to the `switch` in `parseHeadlessExecArgs` (and to
  `INLINE_VALUE_FLAGS` if it takes `=value`), document it in `terminalHelp`, and add a
  case to the error-wording table test.
- **Return results, don't print them.** Handlers return a `CommandOutcome`; only
  `commands.ts` writes the envelope. Throw `CommandError` for expected failures.
- **Keep stdout clean.** Diagnostics go through `writeDiagnostic` (stderr). Never write
  to stdout from below `execRunner` except assistant text.
- **Route precedence is a compatibility surface.** `context.ts` resolves routes from the
  same `providers.json` and session metadata that the TUI writes. When changing it,
  check that a session saved by either side still resumes on the same provider and model.
- Exit codes, envelope fields, error codes, `[ubume exec]` prefixes and the
  `[ubume exec timing]` format are consumed by scripts. Treat them as public API.
