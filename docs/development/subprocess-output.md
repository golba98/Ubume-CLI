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
text has no per-chunk truncation. Cancellation may resolve the command result before all
descendants stop; await `stopped` when resource cleanup must have completed. Short-lived
Codex app-server sessions do this before returning, including on timeout and cancellation.

Regression coverage lives beside the command runner, output capture, terminal sanitizers,
and Codex app-server client. All subprocess fixtures use controlled local executables.
