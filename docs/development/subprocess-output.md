# Subprocess output and cleanup

`runCommand` and `runShellCommand` stream every chunk and retain complete output by default.
Callers that need only diagnostics can pass `capture: { maxChars: 65536 }`: retained output
contains a head, a tail, and an explicit count of omitted UTF-16 characters. The budget must
be a safe integer of at least two. The omission marker is additional to the retained budget;
`omittedOutputChars` reports omissions separately for stdout and stderr.

Complete-output consumers must keep the default. In particular, legacy Codex transcript
parsing remains complete. Structured Codex events are parsed before bounding their raw
fallback diagnostics; streamed tool output and parsed answers remain intact.

UTF-8 decoding and terminal-title stripping carry partial sequences across reads. Ordinary
text has no per-chunk truncation. Timeout results drain stdout/stderr through process closure. Cancellation is idempotent and cannot signal a process after closure. The command result can resolve before all
descendants stop; await `stopped` when resource cleanup must have completed. Short-lived
Codex app-server sessions do this before returning, including on timeout and cancellation.

Regression coverage lives beside the command runner, output capture, terminal sanitizers,
and Codex app-server client. All subprocess fixtures use controlled local executables.

## Native provider tasks

Claude Code, Google/Antigravity (`agy`) and Mistral Vibe run through the shared native
execution supervisor. A whole agent task has no automatic two-minute or ten-minute deadline.
Authentication, executable checks, model discovery and direct Anthropic API requests retain
their separate operation deadlines. Tool timeouts remain owned by each native agent.

A provider override in the workspace `providers.json` may set `execution_timeout_ms` to a
positive integer up to 2147483647. Zero or omission permits unlimited task duration. This
budget starts with the first task subprocess and is shared by compatibility/recovery attempts.
It applies to Claude, AGY and Vibe; Codex retains its existing execution implementation.
For AGY, `--print-timeout 0` also removes the native print deadline on supported installations.
An older CLI rejecting the required streaming/deadline flags reports an explicit error.

A quiet interval of 120 seconds produces a progress notice without terminating execution.
Any stdout, stderr or tool activity resets this notice. Users can still interrupt a quiet task;
headless callers can supply an abort signal. Completion of a tool is separate from completion
of the provider turn and from completion of subprocess teardown.

`UBUME_PROVIDER_TRACE=1` writes payload-free JSON lines to the app-data
`debug/provider-execution.jsonl`. Records include process ID, hashed workspace identity,
logical run ID, provider, phase and monotonic elapsed milliseconds. `ubume exec --timing`
includes these native phases in its existing timing output. Prompts, credentials and tool
contents are excluded from tracing.

The JSON framer limits a single unfinished record to 8388608 UTF-16 characters and fails
malformed records explicitly. Native stdout/stderr diagnostic retention is bounded to 65536
characters per stream, while parsers receive every chunk. Claude snapshots reconcile with
partial messages; AGY uses `event`/`step_update` envelopes; Vibe accepts legacy messages and
new typed public-history entries. Structured data never becomes an answer fallback.

Native permission policies remain authoritative. Interactive Claude runs are an approval
host: the prompt goes to stdin as a stream-json user message, Claude escalates through
`--permission-prompt-tool stdio`, and Ubume answers each `can_use_tool` request from the
approval overlay (stdin closes after the terminal result). The quiet-provider notice pauses
while a person decides; an optional `executionTimeoutMs` deadline still runs. Headless Claude
runs, or CLIs without stream-json input, use `--permission-prompts none` when advertised and
warn before the run. Interactive Vibe runs use `vibe-acp`: the `initialize` request is the
child's first stdin line, `session/request_permission` is answered from the same overlay with
one-shot options only, and stdin closes after the `session/prompt` result (the server is
stopped if it lingers). A `vibe-acp` failure before the prompt was sent falls back once to
`vibe -p`; after that it never retries, so the agent cannot act twice. AGY soft denials and
headless Vibe callback restrictions are surfaced as progress/tool failures. Ubume does not add blanket
approval flags to these runs. A configured native allow rule can still permit a tool; blocked
tools are not rerun automatically with weaker permissions.

Completed native references include model, dialogue watermark and transcript hash. Matching
Claude and AGY sessions resume by exact ID; Vibe prefers the ID in its typed stream. Legacy
Vibe discovery requires a unique workspace/transcript match instead of choosing the newest
session. Missing-session recovery waits for teardown and retries once with saved dialogue,
only before productive work. Other errors retain their original evidence.
