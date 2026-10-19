# Provider executable selection

For Codex, an explicit `codexCommandPath` takes precedence over `CODEX_EXECUTABLE` and
`PATH`. User TOML accepts `codex_command_path`; profiles and command-line config overrides
can select a different executable. Blank overrides are ignored. Runtime normalization,
configuration diffs and diagnostic field sources preserve the selected path.

An invalid explicit path fails rather than silently selecting another installed binary.
Executable resolution caches are scoped to the working directory and relevant environment,
so switching workspaces or PATH does not reuse another context's executable.

Execution, auth probes, short-lived app-server discovery, native session resume and headless
`models --refresh` use the selected executable. Refresh verifies discovery metadata; it does
not perform inference. Failed/unverified refresh exits with the existing readiness failure
code (3); cancellation exits with the interrupted contract (130) and waits for discovery
process cleanup.

Regression tests install controlled executables and decoys. They exercise source APIs and
the Node launcher, so PATH fallback cannot accidentally invoke an installed provider CLI.
