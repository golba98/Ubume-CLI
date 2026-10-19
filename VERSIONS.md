# Ubume CLI Versions

This file explains what users get in each release. For exact implementation
details and test notes, see the [changelog](CHANGELOG.md).

## v0.1.18 — 2026-10-17 (prepared)

Failed model selections now leave provider and model controls usable. Older validation results cannot overwrite a newer choice, and failed saves preserve the previous route and preferences.

Codexa Native can run five experimental local 934M checkpoint variants through a managed Python worker. Generation settings, unload and replay controls are available in the TUI. The model files, tokenizer and Python environment must be configured separately; they are not included in the npm package.

The interactive app is organized into domain hooks, and `/status`, `/runtime`, `/workspace` and `/help` output is restored.

This version is prepared for review and has not been published by this release preparation.

## v0.1.17 — 2026-10-09 (prepared)

`/usage` shows account usage for Codex, Claude Code and Google Antigravity in a refreshable panel. Local routes show context and token usage, and unsupported providers are identified in the panel.

Mistral selection now respects Vibe's effective model list and Default entry. Configured routing aliases and thinking levels are preserved, and headless execution discovers effective models before dispatch.

Update checks continue during long sessions and retry after failures. Failed checks preserve already-detected updates, and npm version discovery uses the uncached latest dist-tag endpoint.

This version is prepared locally and has not been published by this release preparation.

## v0.1.16 — 2026-10-09

Google uses the original Antigravity (`agy`) backend again, including native model discovery and session access. Saved Antigravity preferences and sessions retain compatibility aliases. Ambiguous legacy Google routes require an explicit provider/model selection, and conflicting legacy credentials remain archived and inactive.

Mistral Vibe's configured models stay separate from API-discovered custom models. Configured routes work without API catalogue access, while custom API routes require a verified refresh. Selected API IDs survive picker refresh and are sent exactly; configured selectors retain their original model name, settings and provider.

"Vibe current/default" follows Vibe's saved selection and inherited environment overrides. Custom API entries say "request unverified." No live Mistral Large 4 completion was sent, so successful inference remains unverified.

Local verification passed 1,986 tests, TypeScript, Biome, build, the capability audit and package/version checks.

The public npm registry confirms that this version is published (verified 2026-10-09).

## v0.1.15 — 2026-10-09

Assistant responses now render as terminal-native Markdown. Tables align and wrap at normal widths, and switch to readable header/value groups on narrow terminals. Headings, nested lists, checkboxes, quotes and code blocks share a restrained visual style across providers.

Code keeps its original indentation and blank lines. Long code lines have marked visual continuations, while copy/export retains the original response. Streaming reuses stable blocks and bounded caches to reduce repeated work.

This release also includes the DeepSeek Harness 0.1.2-rc.1 security update merged after 0.1.14 was prepared.

The public npm registry confirms that this version is published (verified 2026-10-09).

## v0.1.14 — 2026-10-09 (prepared)

Model lists are more reliable for every provider. Ubume fetches them from each provider, caches them, and keeps showing the last good list if a refresh fails. If a model you saved disappears, Ubume asks you to pick one instead of quietly switching to a different model.

Reasoning settings now match what each model supports: levels, a thinking budget, or auto/off. Ubume remembers your choice for each model. Models with fixed reasoning say so.

Gemini is back as a native provider, and Mistral models now come from the Mistral API.

Antigravity is no longer a provider. If you used it, Ubume switches to your default provider. Saved Antigravity chats still open, but ask you to pick a provider before you send.

This version is prepared but has not been published to npm.

## v0.1.13 — 2026-10-08

Ctrl+O opens the model picker again, as it did before 0.1.3. Alt+P still works too.

The transcript inspector, which used Ctrl+O since 0.1.3, is now Ctrl+T. `/transcript` still works.

## v0.1.12 — 2026-10-08 (prepared)

Ctrl+C now works like it does in Claude Code and Codex:

- During a run, it stops the run.
- With a draft, it clears the draft.
- On an empty prompt, it shows "Press Ctrl+C again to exit" under the input, and a second press within two seconds exits.

In 0.1.11 the first press quit immediately.

Local models can now use a browser to test web apps: they open pages, read them, click, type, and take screenshots. Run `ubume browser install` once to set it up.

Other changes:

- The `openai-native` backend, which never worked, and the `/backend` commands are gone.
- hono, the MCP SDK, proxy-addr, and sharp are updated to versions with security fixes.

This version is prepared but has not been published to npm.

## v0.1.11 — 2026-10-01 (prepared)

`/resume` brings every provider into one history picker. Local chats have their own section with LM Studio, Unsloth and model filters. Ubume owns the saved chats in its user data folder, restores the original workspace and route, and durably saves the local agent session before completing a turn. Older histories migrate without deleting their originals. Antigravity uses the `agy` CLI; Mistral Vibe continuation belongs to each chat.

The package passed packed-install verification and npm accepted the `0.1.11` upload. Public registry availability is pending npm processing.

## v0.1.10 — 2026-09-30 (prepared)

Typing after a `[Pasted Content …]` label keeps the text and cursor inside the input border. The editor uses the space its container actually provides, including the prompt, padding, and cursor. Unicode display widths and resizing stay aligned, and pasted attachment IDs remain intact when you edit or send a prompt. This patch retains the Local stall and resume-border fixes from 0.1.9.

This version is prepared but has not been published to npm.

## v0.1.9 — 2026-09-30

Fixes the misaligned side border in `/resume` for conversations that start with a pasted-content or attachment label. The existing layout and saved conversations stay the same. This patch also retains the Local server stall fixes from 0.1.8.

## v0.1.8 — 2026-09-30

Local models no longer hang silently for over half an hour when the inference server stops responding. This most often happens during context compaction on a machine that is short of RAM. Ubume now gives up after about 10 minutes with an error that explains the likely cause and what to change on the server. Retries and failed compactions show up in the transcript instead of happening invisibly, and a failed compaction is no longer reported as successful.

## v0.1.7 — 2026-09-30

`/resume` now lists your Claude Code, Codex, and Antigravity sessions next to Ubume's own conversations. Use Left/Right to switch sections and `a` to see every project instead of just the current folder. Press Enter to scroll through a session's transcript. Press `o` to reopen it in its own CLI, or `c` to continue it inside Ubume. Ubume only reads those CLIs' session files and never changes them.

Starting Ubume no longer leaves empty "Untitled conversation" entries in `/resume`. A chat is saved once you send your first prompt.

## v0.1.6 — 2026-09-30

Includes the 0.1.5 terminal fixes and pins the compatible Harness dependencies so local inference works in a fresh installation. Upgrade to this version rather than 0.1.5, whose clean-install Harness startup failed.

Run `npm install -g ubume@latest --prefer-online --legacy-peer-deps` to avoid npm’s slow cyclic peer resolution. This version’s updater uses that flag automatically.

## v0.1.5 — 2026-09-30

Local backend selection responds sooner and distinguishes a slow check from a stopped server. Local Harness startup can be interrupted and disconnected sessions give actionable errors. Ctrl+C works across panels and plan actions while preserving your active draft.

After a plan, choose **Implement in Auto** or **Redo plan** directly. While a model is working, its status says so and shows a flowing highlight; typing another command keeps that status visible.

## v0.1.4 — 2026-09-30

The built-in npm updater now refreshes registry metadata before installing.
This fixes updates failing with "No matching version found" just after a new
release when npm has cached an older package listing. To upgrade from an older
version that lacks the fix, run `npm install -g ubume@latest --prefer-online`,
then restart Ubume.

## v0.1.3 — 2026-09-30

You can keep typing while the agent works, queue your next instructions, and
manage them with `/queue`. Terminal editing supports familiar shortcuts,
multiline navigation, history search, undo, and an external editor. Interrupting
preserves your draft and conversation.

Use `@` to attach files, `/transcript` to inspect tool activity, `/diff` to review
changes, and `/rewind` to preview conversation or supported file recovery.
Resume restores partial replies, drafts, attachments, and queued instructions;
resumed queues stay paused until you continue them.

The new terminal commands let you run prompts, diagnose setup, inspect models
and providers, and read saved sessions without opening the TUI. `ubume exec`
saves automatically, and `ubume exec --resume <id> "next instruction"` continues
the same conversation with its saved context and route.

## v0.1.2 — 2026-09-29

Ubume now tells you what is really going on during a run. The status bar no
longer says it is still waiting for Codex, Claude, or Gemini while the model
is already running commands or replying. Failed runs show their real error
instead of a false "authentication/session error", and a false alarm can no
longer block your next prompt. After attaching an image, the arrow keys move
the cursor normally again.

## v0.1.1 — 2026-09-13

Ubume no longer adds files to your project on its own. Local chats used to
create an empty `.ubume/scratch` folder in the workspace every turn, even when
nothing was put in it. That folder now only appears if the agent actually saves
a throwaway test or debug file there, and it is removed again when it ends up
empty.

## v0.1.0 — 2026-09-13

Initial pre-1.0 release of **Ubume CLI** (`ubume`).
- Renamed project from Codexa CLI to Ubume CLI across all launchers, UI chrome, settings, persistence stores, and scripts.
- Existing `CODEXA_*` environment variables, `codexa.mode` config keys, and `--codexa-prompt-policy` keep working.
- The local native models keep their Codexa name ("Codexa Native").
- Introduced `ubume` binary with `bin/codexa.js` as a backward-compatibility deprecation wrapper.
- Renamed configuration and state directories to `.ubume/` (`~/.local/share/ubume`, `~/.ubume-settings.json`, `.ubume/scratch`) with automated, non-destructive migration of existing `.codexa` settings and workspaces.
- Rebranded ASCII logo art, top header, status indicators, and wordmarks to Ubume.
- Set initial package version to 0.1.0.

## v1.0.28 — 2026-09-12

`/resume` now brings back the whole conversation. Replies from runs you
interrupted, runs that failed, or runs still going when you quit are saved
instead of lost, and each reply notes which files changed and which commands
ran. Resuming also no longer prints the Codexa logo twice, new prompts no
longer get mixed into restored messages, and the context meter keeps its value
after a failed request. Resumed Local chats reconnect to the backend they were
using, so an Unsloth model no longer fails with a connection error because
Codexa tried LM Studio instead.

## v1.0.27 — 2026-09-12

Approving a plan no longer prints the whole plan a second time underneath the
"Plan approved" line — Codexa goes straight from approval into the work. Long
cards in a running turn also stay properly framed when they are taller than the
terminal: instead of a borderless box that starts mid-sentence, the card keeps
its title and shows how many rows are hidden above.

## v1.0.26 — 2026-09-03

Shell command blocks are now deliberately plain and copy-ready: the commands
have no line numbers, border text, or fake copy control. Clipboard screenshots
and images can also be attached with Ctrl+V or `/paste-image` when using Codex
CLI or a vision-enabled Local model; unsupported routes are blocked without
discarding the draft.

## v1.0.25 — 2026-09-03

Long Local responses no longer stop abruptly when a model fills one output
window. Codexa now continues the same task automatically in the same Harness
session, keeping the composer locked and preserving the accumulated answer,
tool work, approvals, context compaction, and workspace state until the model
actually finishes. The result is saved as one complete assistant message.

Continuation stays bounded when a model stalls: Codexa allows any number of
windows that produce text or tool progress, but stops with an actionable error
after two consecutive windows do neither. Canceling a run also prevents another
continuation from starting.

## v1.0.24 — 2026-09-03

Codexa no longer slows down the longer a session runs. Typing used to get
laggy and the terminal felt heavy after enough turns because Codexa was
quietly rebuilding the entire visible history on every keystroke and hashing
the whole scrollback on every screen update; both now scale with what's
actually changing, not with how long the session has been running. Only the
most recent 200 turns are kept fully in memory — earlier ones stay visible in
your terminal's scrollback, so nothing is lost, but redraws after resizing the
window only cover the recent window.

Local models that think a lot before answering (reasoning models) could
previously hit their internal output limit mid-thought and fail with a
confusing "no visible output" error even though they were clearly working.
Codexa now recognizes this, automatically asks the model to wrap up and
answer, and raises the default output limit so it happens less often. If it
still can't get an answer, the error now explains what actually happened
instead of suggesting the model itself might be broken.

## v1.0.23 — 2026-09-03

Plan mode is fixed on the Local provider. Previously the model's exploration
commentary could open the plan panel above the tool calls it ran and end up
mixed into the plan text; now that commentary renders as normal conversation
and the plan panel only ever holds the plan itself, placed after the tool
calls. Pressing "Implement" on an approved plan now reliably writes the
changes instead of just producing more text and leaving you stuck in plan
mode — approving a plan turns plan mode off and switches to a mode that can
actually edit files.

Scrolling up in the terminal while Codexa is streaming a response no longer
gets yanked back down to the bottom. You can now read earlier output while a
long response keeps streaming, the same way any normal terminal program
behaves.

## v1.0.22 — 2026-09-02

Codexa no longer goes unresponsive right after startup. Previously, once the
startup update check finished and the main screen appeared, keyboard input
(including Ctrl+C) could stop working entirely because moving the input box
between screens briefly detached it from the terminal. Codexa now keeps that
connection alive for the whole session, so typing always works after the
updater closes.

## v1.0.21 — 2026-09-01

Codexa's updater now behaves as one coherent state machine: starting an install
replaces the available-update card, and pressing Escape cancels safely back to
that card without clearing or partially repainting the terminal. Canceled
attempts cannot leak stale progress or completion, and the updater keeps focus
so it can be used again immediately.

Startup update checks also preserve the complete Codexa screen. The logo,
workspace/provider details, composer, and model/context footer now appear
together when the checker closes instead of leaving a large blank area.

## v1.0.19 — 2026-08-30

Codexa now keeps long Local workflows moving beyond ten tool calls and completes
explicitly authorized Git and pull-request work instead of stopping early with
commands for the user. Restored Local models refresh their discovered context
size after startup, so the header no longer remains at `Unknown` when the model
server reports a limit.

Long Local conversations also preserve continuity through validated semantic
checkpoints, Local streaming has opt-in privacy-aware diagnostics, runtime mode
choices persist safely, and terminal history uses native scrollback with less
obsolete mouse and viewport machinery.

## v1.0.18 — 2026-08-28

Codexa now supports Unsloth Studio as a selectable Local backend. It discovers
loaded Unsloth models, routes inference through the OpenAI-compatible Studio
endpoint, persists the selected Local backend per workspace, and shows
independent backend diagnostics in the provider picker.

## v1.0.17 — 2026-08-24

Codexa now supports native OpenAI-compatible tool calls for verified Local
models, including structured multi-call turns, streamed argument assembly,
reasoning preservation, matching tool-result IDs, approvals, and malformed-call
recovery. DeepSeek-family Local models receive bounded compatibility defaults
without guessed context limits. Codexa Native also groups its PyTorch and CuPy
routes behind one provider entry with a dedicated model picker.

This release makes terminal-render tests deterministic and prepares the scoped
package for publication through GitHub Packages.

## v1.0.16 — 2026-08-16

Codexa now saves conversations per workspace and lets you reopen them with
`/resume`. Restored chats keep their user and assistant messages and continue
with bounded history for the selected provider. The Local file-import panel is
also more compact: long home paths are shortened, its actions remain visible,
and Import/Cancel navigation follows the horizontal Left/Right layout.
This patch also removes the duplicate root documentation file and keeps the
package metadata aligned at version `1.0.16`.

## v1.0.15 — 2026-08-15

Long responses from Local models such as Qwen now keep their LM Studio
connection alive while the model reasons. Codexa also reconstructs streamed
tool calls correctly, while models that explicitly do not support streaming
continue using the compatible non-streaming path.
## v1.0.14 — 2026-08-15

This maintenance release simplifies the repository landing page and refreshes
the public release documentation. Runtime behavior is unchanged from v1.0.13.

## v1.0.13 — 2026-08-15

After Codexa installs an update, the success panel now includes a focused
Restart now button. Press Enter to close the current Codexa process cleanly,
then launch Codexa again to use the newly installed version. Press Esc to stay
in the current session.

## v1.0.12 — 2026-08-15

This patch restores the complete Codexa home screen after closing the startup
update prompt. The selected update action now has a visible pointer, and more
terminal Left/Right arrow encodings are supported.

## v1.0.11 — 2026-08-15

This patch makes the update prompt match its horizontal layout. Use Left and
Right to move between Update now and Later, then press Enter to confirm.
Update checks now finish before chat input becomes available, so an update
prompt cannot suddenly interrupt text entered just after Codexa opens.
## v1.0.10 — 2026-08-15

Large pastes now stay readable as compact content markers while the full text
still reaches the model. Outside-file imports have clear, keyboard-navigable
one-time consent.

Codex, Claude, Mistral, Antigravity, and Local now share the full Plan review
workflow. Shift+Tab rotates Plan, Read-only, Auto, and Full Access directly in
the composer footer without opening a mode panel or adding notices to chat.
Planning is read-only, and local writes, patches, and shell commands obey the
configured approval policy with an interactive permission prompt.

## v1.0.9 — 2026-08-14

This was the previous patch release.

### Easier terminal panels

Provider, model, theme, settings, and authentication panels now adapt to the
available terminal space. Short terminals show more of the available options,
while longer lists scroll continuously and keep the selected item visible.

### More reliable themes and startup

Theme previews update immediately. Compact terminals keep their choices
readable, and the local development launcher no longer prints an unnecessary
startup block after launch or `/clear`.

### Safer provider behavior

Codexa Native is clearly limited to the local `codexa-dev` channel. Published
Codexa installations continue to use supported external provider routes.

### Security and dependency maintenance

Process argument handling, Windows command validation, workspace checks, and
Cargo diagnostic matching were hardened. The release also updates the
validated Ink, React, TypeScript, and Node type-definition dependencies.

## v1.0.8 — 2026-07-14

This was a packaging-only release. It corrected the published `codexa` binary
metadata without changing the runtime.

## v1.0.7 — 2026-07-14

Provider settings, attachments, and diagnostic logs moved out of project
directories and into user data. Existing `.codexa` files remain available as a
legacy fallback and are not removed automatically.

## v1.0.6 — 2026-07-14

Codexa began checking for newer releases on each interactive startup. Update
messages wait until Codexa is idle, and the suggested command matches the
package manager that installed Codexa.

## v1.0.4 and earlier

Earlier releases introduced the update checker, package-ready startup UI,
provider routing, responsive terminal branding, and the initial Codexa command
line experience. See [CHANGELOG.md](CHANGELOG.md) for the complete history.

## Release policy

- Published npm versions are immutable.
- The `latest` npm tag points to the current public release.
- Local development builds use the separate `codexa-dev` channel.
