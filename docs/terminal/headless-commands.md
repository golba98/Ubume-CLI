# Headless terminal commands

Ubume can diagnose setup, inspect saved sessions, and run prompts without opening
the interactive UI. Bun is required. Run `ubume --help` or `ubume exec --help`
for usage. `codexa` remains a compatibility alias.

```sh
ubume doctor
ubume doctor --probe
ubume status --json
ubume config
ubume providers
ubume models --provider anthropic
ubume models --provider local --refresh

ubume exec "Explain this repository"
ubume exec --provider anthropic --file src/app/App.tsx "Review this file"
printf 'Explain the failing test\n' | ubume exec --stdin
ubume exec --no-save "Answer a one-off question"

ubume sessions list
ubume sessions show chat_example
ubume sessions transcript chat_example
ubume sessions diff chat_example
ubume sessions diff chat_example --turn 2 --file src/app/App.tsx
ubume exec --resume chat_example "Continue with the next fix"
ubume --cwd /path/to/project status --json
```

Normal `exec` runs save automatically. The session ID and activity are printed to
stderr; assistant output goes to stdout. `--json` produces one object on stdout,
including failures, with `schemaVersion`, `command`, `ok`, `data`, and `error`.
Exec data contains `text` and `sessionId`. Prompts can be positional, passed with
`--prompt`, or read using `--stdin`; choose one source. `--stdin` requires piped
or redirected input. Options may precede or follow a positional prompt; use `--`
before prompt words that start with a dash.

`--file` accepts regular UTF-8 project text files within the workspace. Symlinks,
secret environment files and generated/internal directories are excluded. Files
are limited to 1 MiB each; the expanded prompt is limited to 8 MiB, including
repeated attachments. Relative paths resolve within `--cwd` or the current
workspace. Exec keeps existing profile, config override, reasoning, timing,
raw/wrapped prompt policy, and Git-check options.

Resume uses the supplied provider override first, then the saved route, workspace
selection, and default configuration. Explicit model/reasoning overrides take
precedence. An unavailable saved/selected provider reports an error rather than
silently changing providers. Unsent drafts and queued instructions survive resume;
queues remain paused and only your supplied prompt runs. Sessions awaiting plan
review must be opened in the TUI. Tool requests requiring interactive approval
stop headless execution; configured provider approval policies still apply.
`--no-save` cannot be combined with `--resume`. The legacy
`--headless-benchmark` entry remains transient by default.

A session open in another Ubume process cannot be resumed for writing. Session
ownership persists while the TUI has that conversation open. Workspace execution
and file recovery also use an exclusive lease, held through subprocess shutdown
and final persistence. Locks identify their process and host; demonstrably dead
local owners are reclaimed. Unknown/remote ownership is reported as busy and is
not automatically stolen. Ctrl+C stops a run and saves partial output. Exit codes
are 0 for success, 1 for execution or required diagnostic failures, 2 for usage,
3 for unavailable providers/sessions, approval requirements or ownership conflicts,
and 130 for interruptions. Pending restore journals block new workspace execution;
resume the affected saved session to recover them before continuing.

Diagnostics and session inspection do not migrate storage, save configuration,
apply checkpoints, or recover files. `doctor` checks local setup by default;
`--probe` enables bounded authentication/connectivity checks for the selected
provider and Git remote. It never submits an inference prompt. Unverified auth
and optional unavailable providers are reported separately from required failures.
Models use cached/static discovery unless `--refresh` is explicitly requested;
refresh uses provider metadata discovery, not chat generation. Secret values are
redacted from diagnostic output.

Diffs describe supported text files captured during saved runs; missing/corrupt
checkpoint blobs produce a clear error. File restoration remains a previewed TUI
operation. Legacy conversations containing only dialogue can be resumed, but do
not have a historical tool transcript or file diff.

Interactive startup also accepts `ubume --resume chat_ID` and `ubume --import-session source:SESSION_ID` (sources: `claude`, `codex`, `google`, `vibe`). These restore history without sending a prompt and cannot be combined with an initial prompt. `sessions show` reports the actual snapshot location; `status` exposes `chatStorage` alongside the existing workspace `storage` path. Chats are stored under the user data root's `chats/<workspace-key>/conversations/`; legacy histories remain readable and migrate non-destructively when saved.
