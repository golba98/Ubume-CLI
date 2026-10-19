# Ubume CLI

Ubume is a terminal coding workspace for provider CLIs and local
OpenAI-compatible models.

*Ubume* (IsiXhosa) conveys structure, form, embodiment, and configuration — reflecting how Ubume coordinates external provider engines and local models into a unified, stateful CLI environment.

## Install

```bash
npm install -g ubume
ubume
```

Requires Node.js and one supported provider CLI, unless you use a local model.

Update Ubume with:

```bash
npm install -g ubume@latest
ubume --version
```

## Providers

Ubume can use these routes:

| Provider | Setup |
| --- | --- |
| OpenAI / Codex | Install and authenticate the `codex` CLI. |
| Anthropic / Claude | Install and authenticate the `claude` CLI. |
| Google | Install and authenticate the Antigravity CLI (`agy`). |
| Mistral Vibe | Install and authenticate the `vibe` CLI. |
| Local model | Open Local, choose LM Studio or Unsloth, and use a model loaded in that server. |
| Codexa Native | Available only from the local `ubume-dev` channel. |

Credentials remain with the provider CLI or local server.

Mistral's picker separates configured Vibe models from API-discovered custom models. Configured routes retain their model settings and provider; API custom routes require a verified catalogue refresh and say "Custom via Vibe (request unverified)." "Vibe current/default" follows Vibe's saved active/default selection and inherited environment overrides. Catalogue availability does not prove successful inference; Mistral Large 4 execution remains unverified.

## Usage

```bash
ubume --version
ubume exec "summarize this project"
ubume --model gpt-5.4
```

Useful commands inside Ubume:

```text
/help       Show commands
/model       Choose a model
/providers   Choose a provider
/permissions Configure safety
/settings    Open settings
/update      Check for updates
/queue       Manage instructions queued during runs
/transcript  Inspect commands and tool output
/diff        Review file changes
/rewind      Preview recovery or branch a conversation
/resume      Browse all providers and restore a saved session
```

Press Shift+Tab to rotate Plan, Read-only, Auto, and Full Access without
opening a panel. Large pastes are displayed as `[Pasted Content … chars]`
while their complete content is sent to the model. You can keep typing during
runs; Enter queues the next instruction. Ctrl+C interrupts or clears the draft;
on an empty prompt, press it twice to exit. Ctrl+L redraws.
See the [terminal workbench guide](docs/terminal/workbench.md) for editing keys,
file attachments, change review, recovery, and resume behavior.

For upgrades from the former application identity, see the [identity migration guide](docs/development/identity-migration.md). Genuine Codexa models retain their names and controls.

## Development

```bash
bun install
bun run dev
bun test
bun run build
```

Install the separate local development launcher with:

```bash
bun run install:dev-bin
ubume-dev
```

Developer references:

- [Documentation index](docs/README.md)
- [Architecture overview](docs/architecture/overview.md)
- [Source guide](docs/architecture/source-guide.md)
- [Release guide](docs/releasing/release-guide.md)

## Versions

Read [VERSIONS.md](VERSIONS.md) for a plain-language explanation of each
release. [CHANGELOG.md](CHANGELOG.md) contains the detailed technical record.

### Terminal commands without the TUI

Use `ubume doctor`, `ubume status --json`, `ubume providers`, and `ubume sessions list` to diagnose and inspect Ubume from a shell. `ubume exec "prompt"` saves a session by default; continue it with `ubume exec --resume <id> "next instruction"`, or use `--no-save` for a transient run. Pipe prompts with `ubume exec --stdin`. See [terminal command usage](docs/terminal/headless-commands.md) for JSON output, file attachments, diagnostics, and session diffs.

Saved chats, including LM Studio and Unsloth conversations, live in Ubume's user data folder under `chats/`. `/resume` includes provider sections and Local backend/model filters. See [resume and storage details](docs/terminal/workbench.md).

Local models can use integrated structured browser tools through the DeepSeek Harness. See [browser setup and usage](docs/providers/local-browser.md). Install Chromium with `ubume browser install`.

### Google backend compatibility

Google runs the Antigravity CLI (`agy`), never Gemini CLI. Models come from `agy models`; native model identifiers are passed unchanged to `agy -p ... --model ...`. Set `AGY_EXECUTABLE` or `providers.google.antigravity_command_path` for a custom executable. Authentication and native tool permissions remain managed by AGY.

Saved `antigravity` selections and native sessions remain available as Google. Proven Antigravity settings take precedence; removed Google CLI settings are retained as inactive migration data. Ambiguous old Google routes require explicit Google/model selection. Credentials and native session stores are not rewritten.

The recovered adapter buffers responses until AGY completes and supplies saved Ubume history in the prompt. It does not expose structured tool events, token streaming, or image input. Native conversations can be resumed through AGY’s `--conversation` handoff. Discovery failures retain a clearly unverified AGY cache for display, but execution requires live validation and never substitutes another model.

### Mistral model discovery

Ubume reads the installed Vibe effective configuration, including its built-in models, configured aliases and cached model-routing assignments. The picker retains Vibe’s labels and current Default entry. API-only model inventories are not added to the native picker. The reader skips Vibe configuration migrations and emits only model settings, never credentials. If the installed Vibe configuration API cannot be read, Ubume shows configured models with an unverified discovery notice. Remote routing changes appear when Vibe updates its own assignment cache.
