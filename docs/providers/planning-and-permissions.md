# Plan mode and native permissions

Ubume's plan mode (Shift+Tab after Full Access) is a two-step flow that works the same for
every provider. First a **planning run**: read-only, no file changes, ending with a plan. Then
Ubume's **plan review**, where you approve, revise or cancel. Approving starts an **execution
run** with the Auto mode, which resumes the planning session when the provider supports it.
Plan review is the only approval of the plan itself; providers never get to approve their own
plan.

How the planning run is enforced depends on the provider:

| Provider | Planning run | Native or managed |
|---|---|---|
| Claude Code | `--permission-mode plan`. Claude's `ExitPlanMode` request is answered by Ubume (plan captured, request denied), so Claude stays in plan mode and Ubume reviews Claude's own plan. | Native |
| OpenAI Codex | Read-only sandbox with Ubume's planning prompt. | Ubume-managed |
| Antigravity (AGY) | `--mode plan`. | Native |
| Mistral Vibe | `--agent ask --enabled-tools read_file --enabled-tools grep --enabled-tools todo`. Vibe records the steps in its todo tracker, the list behind Vibe's Alt+\ plan sidebar. The plan Ubume reviews starts with those steps. | Ubume-managed, with Vibe's native todo steps |
| Local (DeepSeek Harness) | Read-only tool policy. | Ubume-managed |

## Mode mapping

| Ubume mode | Claude Code | Mistral Vibe | AGY |
|---|---|---|---|
| Read-only | `dontAsk` | `ask` + read-only tools | `plan` |
| Auto | `auto` | `accept-edits` | `accept-edits` |
| Full Access | `auto` | `smart-approve` | `auto` |
| Plan run | `plan` | `ask` + read-only tools | `plan` |

Ubume never sends Claude `bypassPermissions`, and never sends Vibe `auto-approve` or AGY
`--dangerously-skip-permissions`. When the installed Claude CLI does not offer the mapped mode,
Ubume falls back without broadening permissions: `auto` becomes `acceptEdits`, and anything
else becomes `manual` (or `default` on CLIs older than 2.1). The first progress line of every
Claude run names the mode actually used.

## When approvals still appear

- **Claude Code.** Claude's own policy decides what runs. Its `auto` mode uses a classifier and
  still asks about risky actions. Interactive runs send those questions to Ubume's approval
  overlay over `--permission-prompt-tool stdio`, one at a time. Ubume adds no second layer: it
  only answers what Claude asks. Headless runs pass `--permission-prompts none`, so anything
  Claude would ask about is denied.
- **Mistral Vibe.** Auto and Full Access interactive runs use `vibe-acp`, and Vibe's
  `session/request_permission` reaches the same overlay (one-shot options only). Plan and
  Read-only runs use headless `vibe -p`, where `--enabled-tools` is a hard limit: nothing that
  writes files or runs commands is available.
- **AGY** has no host approval protocol; its `--mode` alone decides.

Switching from plan to normal mode never approves anything. Approving a plan starts a new
execution run, and the provider's normal policy for the Auto mode applies to every action in
that run.

## Isolation between terminals

Each Ubume terminal is its own process. Mode, plan state and approvals live in that process
only. `~/.codex/config.toml` stores the last chosen mode as the default for *new* sessions; a
running terminal never re-reads it. Provider flags are built per request from that request's
provider, mode and intent, so one provider's flags never reach another.

## Troubleshooting

- **`Error: Agent 'plan' not found.` (Mistral).** Vibe 3 removed its builtin `plan` agent, and
  Ubume no longer requests it. If this still appears, the running Ubume predates this change.
- **"This Mistral Vibe CLI does not support the read-only options…"** The installed Vibe has
  no `--agent` or `--enabled-tools`. Update Mistral Vibe (`vibe --check-upgrade`). Ubume will not
  run a plan or Read-only turn with write access. A Vibe older than 3 without the `ask` agent is
  retried once with its legacy read-only `plan` agent.
- **Claude seems to do nothing for minutes.** Watch the run's progress. "Thinking… (Claude has
  not shared its reasoning)" means the model is reasoning with hidden thinking. "Claude reached
  its output limit…" means a step used its whole output budget and Claude Code is continuing.
  "Claude API request failed… retrying" reports Claude Code's own API retries. "Claude is
  preparing Write …" counts a large file being streamed.

## Tests

- `src/core/providerRuntime/mistralVibe.test.ts`: read-only agent arguments, todo-step capture,
  legacy retry, fail-closed rules, Vibe 3 session ids, and plan-to-execution continuation.
- `src/core/providerRuntime/claudePermissions.test.ts`: the mode table and fallbacks.
- `src/core/providerRuntime/claudeApprovalBridge.test.ts`: a fake `claude` speaking the real
  control protocol, including `ExitPlanMode` handling in plan and normal runs.
- `src/core/providerRuntime/claudeStream.test.ts`: retry, hidden-thinking and tool-input
  progress.

## Permission decisions and terminal controls

The approval panel numbers the actions actually available for the request. Selection uses a
stable action ID and a run-scoped request ID; a stale, unknown or forbidden selection denies
or cancels rather than granting permission. Claude's exact-action run allowance remains a
Ubume-managed cache of identical tool inputs. Vibe displays its native one-shot option IDs
and labels; persistent options stay unavailable, and no run allowance is added to its menu.
Native persistent approval support would be a separate policy enhancement.

Up/Down and j/k navigate without wrapping, Enter confirms the marked action, and digits 1–9
select the corresponding displayed actions. Longer menus remain accessible through navigation.
Escape denies or cancels according to the adapter's contract. Ctrl+C uses the normal run
interruption lifecycle. The composer keeps its draft but does not accept permission input.

Long request details scroll with PageUp/PageDown and Home/End. Commands wrap by terminal cells,
retaining whitespace and arguments. Control bytes are shown as literal escapes, never executed;
the provider receives the original input. Resizing preserves selection and never submits a
decision. Approval means consent was given, rather than proof that a tool has executed.

`bun run check:permissions` runs the real-app Claude and Vibe protocol PTY regressions,
including small terminals, resizing, cancellation, disconnects and a no-color run. Generated
terminal recordings and frame captures are stored under ignored `docs/_reports/reliability/`.
