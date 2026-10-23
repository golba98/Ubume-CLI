<div align="center">

<h1>Ubume</h1>

<p><strong>One terminal workspace for coding agents.</strong><br>
Codex, Claude Code, Antigravity, Mistral Vibe and local models in a single, stateful TUI.</p>

<p>
  <a href="https://www.npmjs.com/package/ubume"><img alt="npm" src="https://img.shields.io/npm/v/ubume?color=cb3837&logo=npm"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white">
  <img alt="Bun 1.3+" src="https://img.shields.io/badge/bun-%E2%89%A51.3-000000?logo=bun&logoColor=white">
</p>

<p>
  <a href="#install">Install</a> ·
  <a href="#providers">Providers</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#commands-and-keys">Commands</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#development">Development</a>
</p>

</div>

Ubume wraps the coding-agent CLIs you already use, plus local OpenAI-compatible models, in one
terminal UI. You can switch providers and models without leaving your session. Every agent gets
the same planning, permissions, change review and recovery workflow.

> *Ubume* (IsiXhosa) conveys structure, form, embodiment, and configuration — reflecting how
> Ubume coordinates external provider engines and local models into a unified, stateful CLI
> environment.

## Features

- **Many providers, one interface.** Codex, Claude Code, Antigravity, Mistral Vibe, the direct
  Anthropic API, and local LM Studio or Unsloth models.
- **Plan, review, execute.** Rotate between Plan, Read-only, Auto and Full Access with
  <kbd>Shift</kbd>+<kbd>Tab</kbd>. Plans are reviewed in Ubume before anything runs.
- **Keep typing during runs.** <kbd>Enter</kbd> queues the next instruction. Use `/queue` to edit
  queued instructions or `/send-now` to steer the current run.
- **See and undo changes.** `/diff` reviews file changes, `/rewind` previews recovery or branches
  a conversation, and `/transcript` shows commands and tool output.
- **Resume anything.** `/resume` browses saved sessions from Ubume, Claude Code, Codex and
  Mistral Vibe.
- **Rich input.** Attach files with `@`, paste images, and paste large text, which is shown as
  `[Pasted Content … chars]` while the full text is sent.
- **Headless mode.** `ubume exec`, `doctor`, `status --json` and `sessions` support scripts and CI.
- **Browser tools for local models** through the DeepSeek Harness.

## Install

```bash
npm install -g ubume
ubume
```

**Requirements**

- [Node.js](https://nodejs.org) 22+ runs the `ubume` launcher.
- [Bun](https://bun.sh) 1.3+ on `PATH` runs the application. Set `UBUME_BUN_EXECUTABLE` to use a
  specific Bun binary.
- At least one supported provider CLI, unless you use a local model or an Anthropic API key.

**Update**

```bash
npm install -g ubume@latest
ubume --version
```

Or run `/update` inside Ubume.

## Providers

| Provider | Setup |
| --- | --- |
| **OpenAI / Codex** | Install and authenticate the `codex` CLI. |
| **Anthropic / Claude** | Install and authenticate the `claude` CLI, or set `ANTHROPIC_API_KEY` (or `providers.anthropic.apiKey`) for the direct Messages API. |
| **Google** | Install and authenticate the Antigravity CLI (`agy`). |
| **Mistral Vibe** | Install and authenticate the `vibe` CLI. |
| **Local model** | Open Local, choose LM Studio or Unsloth, and use a model loaded in that server. |
| **Codexa Native** | Available only from the local `ubume-dev` channel. |

Credentials stay with each provider CLI. Direct API keys are read from the environment or from
Ubume's private provider configuration. For provider-specific behavior, such as the Anthropic API
timeout, the Antigravity adapter and Mistral model discovery, see
[Provider setup and compatibility](docs/providers/provider-setup.md).

## Usage

### Interactive

```bash
ubume                     # open the workspace in the current directory
ubume --model gpt-5.4     # start with a specific model
```

### Headless

```bash
ubume exec "summarize this project"                  # run once; the session is saved
ubume exec --resume <id> "next instruction"          # continue a saved session
ubume exec --no-save "quick question"                # transient run
printf 'Explain the failing test\n' | ubume exec --stdin   # pipe a prompt
ubume exec --file src/app.ts "Review this file"      # attach a file

ubume doctor                                         # diagnose your setup
ubume status --json                                  # effective configuration
ubume providers                                      # list providers
ubume sessions list                                  # saved sessions
```

See [terminal command usage](docs/terminal/headless-commands.md) for JSON output, file
attachments, diagnostics and session diffs.

## Commands and keys

| Command | Description |
| --- | --- |
| `/help` | Show commands |
| `/model` · `/providers` | Choose a model or provider |
| `/mode` · `/plan` | Change execution mode or toggle plan mode |
| `/permissions` | Configure safety and sandbox controls |
| `/settings` · `/preferences` | Open settings, startup logo and color theme |
| `/queue` · `/send-now` | Manage instructions queued during runs |
| `/transcript` | Inspect commands and tool output |
| `/diff` | Review file changes |
| `/rewind` | Preview recovery or branch a conversation |
| `/resume` | Browse all providers and restore a saved session |
| `/usage` | Show account usage limits for the active provider |
| `/update` | Check for updates |

| Key | Action |
| --- | --- |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> | Rotate Plan → Read-only → Auto → Full Access |
| <kbd>Enter</kbd> during a run | Queue the next instruction |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Model picker |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> | Inspect tool activity |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Interrupt or clear the draft; press twice on an empty prompt to exit |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Redraw |

The [terminal workbench guide](docs/terminal/workbench.md) covers every editing key, file
attachments, change review, recovery and resume behavior.

## Data and sessions

Saved chats, including LM Studio and Unsloth conversations, live under `chats/` in Ubume's user
data folder. `/resume` includes provider sections and Local backend/model filters.

Local models can use structured browser tools through the DeepSeek Harness. Install Chromium with
`ubume browser install`, then see [browser setup and usage](docs/providers/local-browser.md).

Upgrading from the former application identity? See the
[identity migration guide](docs/development/identity-migration.md). Genuine Codexa models keep
their names and controls.

## Documentation

- [Terminal workbench](docs/terminal/workbench.md): editing, queueing, review, recovery
- [Headless commands](docs/terminal/headless-commands.md): `exec`, `doctor`, `status`, `sessions`
- [Plan mode and permissions](docs/providers/planning-and-permissions.md): how each provider plans and asks for approval
- [Provider setup and compatibility](docs/providers/provider-setup.md)
- [Local browser tools](docs/providers/local-browser.md)
- [Codexa Native](docs/providers/codexa-native.md)
- [Full documentation index](docs/README.md)

## Development

```bash
bun install
bun run dev      # interactive TUI with file watching
bun test         # run the test suite
bun run build    # build info + typecheck + lint
```

Install a separate local launcher (`ubume-dev` / `ubd`) that runs this checkout:

```bash
bun run install:dev-bin
ubume-dev
```

Start with [Getting started](docs/development/getting-started.md), the
[architecture overview](docs/architecture/overview.md), the
[source guide](docs/architecture/source-guide.md) and the
[release guide](docs/releasing/release-guide.md).

## Releases

[VERSIONS.md](VERSIONS.md) explains each release in plain language.
[CHANGELOG.md](CHANGELOG.md) has the detailed technical record.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
