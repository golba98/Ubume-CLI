# Ubume Architecture

This document explains what Ubume does, how the application is assembled, how a prompt moves through the system, and which architectural boundaries maintainers must preserve. For the purpose and maintenance notes for every file under `src/`, see [Source Guide](SOURCE_GUIDE.md).

## What Ubume is

Ubume is a terminal user interface around coding-agent command-line tools. It gives those tools a shared workspace-oriented experience with:

- an Ink/React terminal UI with native terminal scrollback;
- interactive and headless execution modes;
- layered configuration and per-workspace provider selection;
- model, reasoning, permission, theme, and runtime controls;
- streamed reasoning, tool activity, file activity, and assistant output;
- workspace trust, project-instruction loading, file-activity tracking, and path guards;
- provider discovery and routing for Codex, Claude Code, Google (Antigravity CLI), Mistral Vibe, and local OpenAI-compatible servers.

Ubume does not replace provider authentication. External provider CLIs remain responsible for their own installation and sign-in state.

## Technology and runtime

| Area | Technology | Responsibility |
| --- | --- | --- |
| Launcher | Node.js ESM | Installed `ubume` command, argument dispatch, child-process environment, and terminal hand-off. |
| Application runtime | Bun + TypeScript | Executes the interactive or headless TypeScript entry point. |
| Terminal UI | Ink 7 + React 19 | Declarative terminal components, input, focus, panels, and rendering. |
| Provider integration | Child processes, JSON streams, HTTP | Runs provider CLIs, parses events, and talks to local OpenAI-compatible endpoints. |
| Configuration | TOML + JSON caches | Resolves defaults, user/project config, profiles, CLI overrides, settings, trust, and provider state. |
| Tests | Bun test | Colocated unit, reducer, parser, integration, and terminal-rendering contracts. |

## Developer automation

Repository scripts sit outside the application runtime and provide local launching, shim installation, build metadata, static capability auditing, and an authenticated headless smoke. Their full command and side-effect reference is the [Developer Scripts guide](../scripts/README.md).

```mermaid
flowchart LR
  Package[package.json commands] --> Dev[run-local-dev.mjs]
  Package --> Install[install-local-dev-bin.mjs]
  Package --> Build[gen-build-info.mjs]
  Package --> Audit[audit-ubume-capabilities.mjs]
  Package --> Smoke[smoke-terminal-bench.mjs]

  Install --> Shims[ubume-dev and cxd]
  Shims --> Dev
  Dev --> Interactive[src/index.tsx]
  Dev --> Headless[src/cli.ts]
  Build --> BuildInfo[src/config/buildInfo.ts]
  Audit --> Source[Read-only src inspection]
  Smoke --> Launcher[bin/ubume.js exec]
  Launcher --> Headless
```

Only build-info generation intentionally rewrites a tracked source file. The capability audit is read-only. The terminal smoke is an external integration command that inherits the caller's workspace and provider authentication, so it is not part of the default unit-test suite.

## System context

```mermaid
flowchart LR
  User[User in a terminal] --> Launcher[bin/ubume.js]
  Launcher -->|interactive| Entry[src/index.tsx]
  Launcher -->|exec / benchmark| Exec[src/cli.ts]

  Entry --> App[src/app/App.tsx]
  App --> Session[src/session]
  App --> UI[src/ui]
  App --> Config[src/config]
  App --> Core[src/core]

  Exec --> Headless[src/headless]
  Headless --> Config
  Headless --> Core

  Core --> ProviderCLIs[Codex / Claude / Vibe CLIs]
  Core --> LocalServer[Local OpenAI-compatible server]
  Core --> Workspace[Workspace files and project instructions]
  UI --> Terminal[Terminal screen and native scrollback]
```

The launcher chooses a mode but does not own application state. `src/index.tsx` owns interactive startup and terminal cleanup. `src/cli.ts` owns the headless command surface (dispatching through `src/headless/commands.ts`). Both paths reuse configuration and backend services from `src/`.

## Major source boundaries

```mermaid
flowchart TD
  Entrypoints[Entrypoints<br/>index.tsx / cli.ts] --> Orchestrator[App orchestration<br/>app/App.tsx]
  Entrypoints --> Headless[Headless runner<br/>headless/]
  Orchestrator --> Session[Session state and reducers<br/>session/]
  Orchestrator --> Commands[Slash-command parsing<br/>commands/]
  Orchestrator --> UI[Ink presentation<br/>ui/]
  Orchestrator --> Core[Runtime services<br/>core/]
  Orchestrator --> Config[Configuration<br/>config/]
  Headless --> Core
  Headless --> Config
  UI --> Session
  UI --> Config
  Core --> Config

  classDef owner fill:#20364d,color:#fff,stroke:#77b7ff
  class Orchestrator owner
```

The intended ownership rules are:

- `app/App.tsx` coordinates subsystems by composing the domain hooks under `src/app/` (`state/`, `lifecycle/`, `settings/`, `providers/`, `models/`, `run/`, `conversation/`, `input/`, `overlays/`). Reusable domain logic belongs in those folders or lower layers. See [src/app architecture](architecture/app.md).
- `session/` owns serializable chat/timeline state, lifecycle reducers, streaming schedules, and plan flow. It must not render Ink components.
- `ui/` owns terminal presentation and input behavior. It consumes session/config types but should not launch providers or persist workspace state.
- `core/` owns non-UI runtime behavior: processes, providers, terminal control, workspace services, model discovery, and diagnostics.
- `config/` owns configuration parsing, defaults, persistence, trust, and effective runtime policy.
- `commands/` converts slash-command text into actions; `app/input/commandDispatch.ts` performs those actions.
- `headless/` adapts the shared backend contracts to stdout, stderr, and process exit codes without constructing the Ink UI.

## Interactive startup and prompt flow

```mermaid
sequenceDiagram
  participant L as bin/ubume.js
  participant I as src/index.tsx
  participant A as src/app/App.tsx
  participant S as src/session
  participant P as Provider backend
  participant U as src/ui
  participant T as Terminal

  L->>I: Spawn Bun interactive entry
  I->>I: Validate TTY and configure terminal modes
  I->>A: Render App with launch arguments
  A->>A: Resolve workspace, config, provider, and project instructions
  A->>U: Render shell, timeline, panels, and composer
  U->>T: Commit initial frame
  T->>A: User submits prompt
  A->>S: Create user event and running RunEvent
  A->>P: Start provider with runtime and workspace context
  P-->>A: Reasoning, tool activity, and assistant deltas
  A->>S: Batch and reduce live updates
  S-->>U: Updated static and active timeline events
  U-->>T: Stable terminal frames
  P-->>A: Final response or error
  A->>S: Finalize run and lifecycle state
  S-->>U: Completed turn
```

Important details:

1. `src/index.tsx` wraps stdout with frame locking, configures terminal modes, installs resize and failure cleanup, and renders one `App` root.
2. `src/app/state/useAppState.ts` resolves the workspace, project instructions, settings and layered runtime once; `providers/useActiveProviderRoute.ts` and `models/useActiveModelMetadata.ts` derive the provider route and model metadata. Submissions flow through `input/useAppInput.ts` into `run/usePromptRun.ts`.
3. A submission creates linked user/run events with stable `turnId` and `runId` values.
4. Provider callbacks are sanitized and batched by the live-render scheduler before entering the session reducer.
5. The UI derives rows from session events. It does not directly parse provider output.
6. Finalization flushes pending updates, records workspace activity, completes the run, and returns the UI lifecycle to an idle or awaiting-user state.

## Headless execution flow

```mermaid
flowchart LR
  CLI[ubume exec] --> Launcher[bin/ubume.js]
  Launcher --> Entry[src/cli.ts]
  Entry --> Commands[headless/commands.ts]
  Commands --> Parse[headless/execArgs.ts]
  Parse --> Resolve[Layered config + workspace]
  Resolve --> Runner[headless/execRunner.ts]
  Runner --> Backend[core/providers backend]
  Backend --> Child[Provider process]
  Child -->|assistant content| Stdout[stdout]
  Child -->|diagnostics / tools| Stderr[stderr]
  Child --> Exit[Stable exit code]
```

Headless mode deliberately bypasses Ink, panels, and session rendering. It shares launch arguments, layered configuration, project-instruction loading, terminal sanitization, provider contracts, and Codex subprocess parsing with the interactive application.

## Provider architecture

Three similarly named folders represent different layers and must remain distinct.

```mermaid
flowchart TD
  App[app/App.tsx] --> LauncherLayer[providerLauncher/<br/>selection, workspace config, native CLI launch]
  App --> RuntimeLayer[providerRuntime/<br/>route validation, discovery, metadata, provider runtimes]
  RuntimeLayer --> ProviderLayer[providers/<br/>low-level Codex subprocess and stream parsing]

  LauncherLayer --> NativeCLI[Externally launched provider CLI]
  RuntimeLayer --> Claude[Claude Code runtime]
  RuntimeLayer --> Vibe[Mistral Vibe runtime]
  RuntimeLayer --> Local[Local HTTP runtime]
  ProviderLayer --> Codex[Codex CLI process]
```

| Layer | Owns | Must not pretend to own |
| --- | --- | --- |
| `providerLauncher/` | Provider picker records, per-workspace defaults/routes, command resolution, and inherited-terminal launches. | In-app response parsing or model capability semantics. |
| `providerRuntime/` | Provider availability, validation, model discovery, capability/context metadata, reasoning options, and routed execution. | Generic terminal rendering or persistent chat state. |
| `providers/` | Backend interface and low-level Codex subprocess/JSON/transcript handling. | Workspace provider-picker state. |

Provider truthfulness is an invariant: selectable routes must match actual `routeAvailable` and configuration state. A provider that can only be launched externally must not be presented as though Ubume can route an in-app conversation through it.

### Local OpenAI-compatible model profiles

The `local` runtime owns compatibility for models served by LM Studio and Unsloth Studio through their OpenAI-compatible APIs. The provider picker keeps Local as one top-level route and opens a backend child page for LM Studio and Unsloth. The selected backend is stored per workspace and in conversation metadata. Unsloth discovery accepts only models marked as loaded and authenticates with `UNSLOTH_API_KEY` or a same-user agent key after verifying the loopback server identity. Model-family detection remains capability metadata only; the Local runtime always routes through the same generic DeepSeek Harness adapter regardless of whether the model is Qwen, Ornith, Llama, Gemma, GLM, DeepSeek, or another compatible family.

Local capability fields resolve independently: authoritative server metadata wins, explicit per-model configuration fills missing fields, detected-family defaults fill only remaining compatibility gaps, and unknown models retain the generic Local behavior. Context length remains owned by the separate context-metadata resolver, and detected families do not invent context or output-token limits.

Ubume lazily starts the official DeepSeek Harness in a workspace-scoped child process and configures its generic `dsh-llm-pi-ai` OpenAI-compatible route from the existing Local base URL, key, model, context, and output settings. Harness owns tool calling, the agent loop, shell/filesystem execution, context compaction, subagents, and durable model sessions. A thin stdio bridge maps Harness session events into Ubume assistant, reasoning, tool, usage, and lifecycle events and routes pre-execution policy through Ubume's existing permission UI. The bridge does not parse model tool syntax or execute tools itself.

Each writable Local Harness session is assigned a scratch folder at `.ubume/scratch/<session>` (see `src/core/workspace/scratchDir.ts`). The persona and a per-prompt note tell the model to keep throwaway test harnesses, probe scripts, logs, and browser profiles there instead of the project root. The folder lives inside the workspace rather than the OS temp dir because Harness's `workspace-write` sandbox (bwrap on Linux) mounts a fresh tmpfs over `/tmp` for every confined command, so only the workspace is a persistent writable location. Ubume never creates it up front: the folder and its own `*` `.gitignore` are created only when a mutating tool call's path or command targets `.ubume/scratch`, and when the run ends an empty session folder is removed together with any `.ubume/scratch` and `.ubume` folders it leaves empty. It is excluded from workspace activity snapshots, and session folders older than seven days are pruned when a new session opens.

Before each Local turn, Ubume resolves an ephemeral execution connection for the selected backend. This is especially important for Unsloth: its verified loopback URL and agent-cache credential are resolved through the existing Unsloth security adapter and passed to Harness in memory, rather than persisted in workspace configuration or replaced by the LM Studio default.

Ubume conversation metadata stores the opaque Harness session id and a non-secret route/transcript fingerprint. `/resume` reconnects only when those fingerprints match; a legacy or divergent visible transcript is explicitly restored into a fresh Harness session rather than silently mixing two histories. `/clear` cancels active work and starts a new Ubume conversation, while the saved prior conversation remains resumable.

## Provider usage (`/usage`)

`/usage` is a local slash command: it is parsed in `commands/handler.ts`, never enters conversation history, and never reaches a model. `app/providers/useProviderUsage.ts` resolves the active route through `core/usage/registry.ts`, which picks the adapter for the account that route really executes with and a credential-free scope key. `core/usage/usageService.ts` keeps one cache entry per scope, applies a refresh cooldown (default 30 s, `UBUME_USAGE_COOLDOWN_SECONDS`), shares one in-flight request per scope, and keeps the last good snapshot (labelled stale) when a later attempt fails. Results for a scope the user has left are cached but never rendered.

| Route | Source | Reports |
| --- | --- | --- |
| OpenAI / Codex | `codex app-server`: `account/read`, `account/rateLimits/read` | Plan, account, primary/secondary windows per metered bucket, reset times, credits; API-key accounts reported as not applicable. |
| Claude Code | `claude auth status` + `get_usage` control request on a stream-json host with no tools, MCP servers, hooks or session persistence | Plan, 5-hour and weekly windows, per-model weekly buckets, extra-usage state. `get_usage` is marked experimental by Claude Code, so unknown shapes degrade to unavailable. |
| Anthropic API key | `anthropic-ratelimit-*` headers on responses Ubume already received | Observed request/token limits; spend is not readable with standard keys. |
| Google (Antigravity) | `agy -p /usage` and `/credits` with `--output-format json` (print-mode local commands; replies that ran a turn are rejected) | Per-model-group weekly and 5-hour quotas, reset times, G1 credits. |
| Mistral Vibe | None — Vibe exposes only plan metadata through a session-scoped whoami call | Reported as unsupported; never as unlimited. |
| Local | Ubume's own harness token counts and context metadata | Context use (percentage only with verified/configured context size), per-conversation token totals; quota N/A on loopback, unavailable on remote endpoints. |

Adding a provider means adding one adapter and one registry case; the command, dispatcher and panel do not change.

## Session and UI state

The session stores timeline events separately from the visual lifecycle state. Static events are completed transcript content; active events contain the currently changing run. `UIState` drives composer availability, activity styling, and action-required presentation.

```mermaid
stateDiagram-v2
  [*] --> IDLE
  IDLE --> THINKING: submit prompt
  THINKING --> RESPONDING: first assistant delta
  THINKING --> ERROR: provider failure
  RESPONDING --> ANSWER_VISIBLE: final answer observed
  RESPONDING --> AWAITING_USER_ACTION: provider asks a question
  ANSWER_VISIBLE --> IDLE: run finalized
  AWAITING_USER_ACTION --> THINKING: answer submitted
  AWAITING_USER_ACTION --> IDLE: dismissed
  ERROR --> IDLE: dismissed or new run
  IDLE --> SHELL_RUNNING: shell command
  SHELL_RUNNING --> IDLE: command finalized
```

Reducers in `session/` are the source of truth for lifecycle transitions and event reconciliation. UI components should derive presentation from state instead of maintaining a competing run lifecycle.

## Terminal rendering model

Ubume uses two terminal presentation modes:

- Main chat stays in the normal screen buffer. The intro, completed turns, and live output participate in native terminal scrollback.
- Modal/picker screens temporarily use overlay behavior and may enter alternate-screen mode. Returning to main chat restores the normal buffer.

The rendering pipeline is:

```mermaid
flowchart LR
  Events[Session timeline events] --> Measure[timelineMeasure.ts]
  Measure --> Rows[Stable semantic rows]
  Rows --> Timeline[Timeline]
  Timeline --> Transcript[TranscriptShell<br/>main chat and native scrollback]
  Timeline -.-> Overlay[AppShell<br/>overlay composition]
  Transcript --> Ink[Ink renderer]
  Overlay --> Ink
  Ink --> Lock[frameLock.ts]
  Lock --> Terminal[Terminal output]
```

Maintenance invariants:

- The logo and completed conversation are transcript content and may scroll away; do not make them sticky to fix visibility.
- The composer and runtime/context status have one owner at the bottom of the live tail.
- `/clear` is an atomic state and frame-boundary reset, not an appended transcript message.
- Resize handling must preserve the last valid frame and avoid competing resize owners.
- All provider and shell text crosses terminal-sanitization boundaries before rendering.
- Terminal mode changes must have paired cleanup so crashes do not leave mouse, paste, cursor, title, or alternate-screen state behind.
- Ink's raw-mode refcount must never reach zero while the app runs; `useStdinRawModeLease` in `App` owns that lease. Components still hold their own via `useFocus`/`useInput`, but a root-level lease prevents composer remounts (overlay exit) from detaching Ink's stdin `readable` listener, which otherwise flips stdin into flowing mode and silently kills all input.

## Configuration and persisted state

Runtime configuration uses explicit precedence, where each later layer wins:

```mermaid
flowchart LR
  Defaults[Built-in defaults] --> User[User config]
  User --> Project[Trusted project config]
  Project --> Profile[Selected profile]
  Profile --> CLI[CLI overrides]
  CLI --> Effective[Effective runtime config]
```

Untrusted project configuration is reported but not applied. User settings, trust state, update caches, provider model caches, plans, attachments, workspace provider state, and workspace-scoped conversations use the platform-specific Ubume data directory. Legacy project-local provider state may be read for migration, but new state must not dirty the user's project.

Conversation history lives in the user-level Ubume data directory, below `chats/<workspace-key>/conversations/<conversation-id>/snapshot.json`. The workspace key retains the existing SHA-256 path identity. `chats/<workspace-key>/workspace.json` records the original folder; `local-harness/v-<version>/` beside the conversations stores durable agent sessions. Projects do not receive chat files. Existing `workspaces/<workspace-key>/conversations/` stores remain read-only migration inputs until a conversation is saved into the new layout. IDs, checkpoints, attachments, drafts and queues retain their existing identities and locations.

The version 2 snapshot is authoritative and atomically replaced with file and directory flushes. A derived `summary.json` cache is used only when its inode/size/timestamp revision matches the snapshot. Missing or stale summaries fall back to the snapshot; cache failures cannot invalidate a successful save. Corrupt canonical snapshots are reported and preserved rather than replaced with an older generation. Conversations are created by the first sent prompt, and histories without messages remain hidden from the picker.

`src/session/sessionCatalog.ts` combines owned conversations and native Claude Code, Codex, Google (Antigravity) and Mistral Vibe CLI histories. Native adapters in `src/core/externalSessions/` only read provider stores. Discovery failures are isolated by source. Explicit saved native references and import provenance deduplicate matching source/session/workspace identities; standalone programmatic CLI sessions remain visible. Provider IDs and Local backend/model filters are independent of the native transcript format.

`src/session/resumeCoordinator.ts` handles saved-route assessment, workspace handoff and idempotent imports. The picker has All, OpenAI, Anthropic, Mistral and Local sections, with development provider sections when relevant. Other projects are reopened through the installed/dev Ubume launcher with `--resume ID` or `--import-session source:ID`. Missing or unknown folders remain viewable; owned chats require the original path identity before writing. Saved routes stay pinned while viewing, and an unavailable provider/backend/model requires an explicit validated choice before another prompt can run.

Native terminal handoff uses `claude --resume`, `codex resume`, `agy --conversation`, or `vibe --resume`, always in the recorded original folder. Continuing inside Ubume imports a transcript once and reuses the owned conversation on later imports. Vibe continuation references belong to individual conversations and include model, message watermark and transcript hash; there is no workspace-global active Vibe session.

Local completion explicitly flushes the Harness session journal before publishing its completed continuation watermark. Restart checks harness version, route fingerprint and dialogue hash. Missing or unsupported saved state recovers the saved dialogue into a fresh session without deleting original artifacts; permission, corruption and persistence failures are reported as errors. Backend changes cannot silently redirect an Unsloth chat to LM Studio.

## Workspace and safety boundaries

- `workspaceRoot.ts` establishes the normalized workspace used throughout a run.
- `launchContext.ts` describes installed/dev launches and controlled workspace relaunches.
- `projectInstructions.ts` loads repository instructions with explicit status reporting.
- `workspaceGuard.ts` recognizes paths outside the workspace and dependency paths before commands or diagnostics are accepted.
- `workspaceActivity.ts` snapshots and diffs files so the timeline can report what a run changed.
- `appData.ts` centralizes platform-specific data paths; new persistent state, including workspace-scoped conversation history, should use it rather than inventing project-local folders.

## Maintenance playbooks

### Adding or changing a provider

1. Define or update its runtime and provider types.
2. Keep discovery, route configuration, route validation, and launch availability separate.
3. Register it in the runtime and launcher registries only for capabilities it actually supports, and add a `core/usage/` adapter (or let it fall back to unsupported).
4. Add executable resolution when an external CLI is involved.
5. Update model, reasoning, context, and capability metadata where applicable.
6. Test discovery, routing, persisted workspace migration, command arguments, and failure messages.
7. Update this document and the affected entries in the source guide.

### Adding a slash command or panel

1. Parse the command into a typed action in `commands/handler.ts` and expose discoverability through `ui/input/slashCommands.ts`.
2. Perform side effects in `app/input/commandDispatch.ts` (or `input/submitSteps.ts` for commands that bypass the parser); keep the parser deterministic.
3. Put new panels under `ui/panels/` and shared screen chrome under `ui/chrome/`.
4. Add keyboard/focus tests and small-terminal layout coverage when the screen changes row usage.

### Changing session or streaming behavior

1. Change event types and reducer logic together.
2. Preserve `turnId`, `runId`, and stream ordering contracts.
3. Keep live batching in `liveRenderScheduler.ts`; do not dispatch every provider byte directly into Ink.
4. Test partial chunks, final-response reconciliation, cancel/error paths, action ordering, and final-frame stability.

### Changing terminal rendering

1. Identify the single owner of the affected row or terminal mode.
2. Update measurement logic and rendering components together.
3. Test exact narrow/normal/tall dimensions, scroll anchoring, clear boundaries, and resize transitions.
4. Use env-gated debug instrumentation for diagnosis and perform a real terminal smoke test for claims about VTE, mouse, selection, or native scrollback.

### Adding configuration or persisted state

1. Add parsing, validation, defaults, serialization, and diagnostic source reporting.
2. Preserve configuration precedence and trust gating.
3. Store mutable application state through `core/workspace/appData.ts` unless the data is intentional project configuration.
4. Test invalid values, missing files, migration/fallback behavior, and round-trip persistence.

## Documentation maintenance

Update `docs/ARCHITECTURE.md` when a subsystem boundary, entry point, data flow, provider layer, persistence rule, or terminal invariant changes. Update `docs/SOURCE_GUIDE.md` whenever a file under `src/` is added, removed, renamed, or changes responsibility. Architectural descriptions must be verified against the current code rather than inferred from historical behavior or filenames.

## Local browser computer use

Local uses the DeepSeek Harness as the generic agent runtime for compatible local models. Agent-scoped structured browser tools join its existing tool registry; the same loop handles streaming calls, reasoning, approvals, results and sessions. `src/core/computerUse/` supervises a private Node/Playwright worker under `bin/`; this worker executes browser commands and owns no model client or agent loop. Browser environment availability is independent of model capability. Existing hosted search/fetch guards remain in place.

The browser backend reuses an ephemeral context per live Harness session, provides bounded semantic snapshots and references, and supplies screenshots through Harness attachments. Session cleanup closes browsers; the supervisor also reaps owned processes after worker failure. See [Local browser setup, tools, permissions and lifecycle](LOCAL_BROWSER.md).

### App and rendering ownership after cleanup

`src/app/App.tsx` composes the hooks in `src/app/` while retaining clear-frame wiring and the first dispose/sync effects inline. Hooks split out of larger ones are called at their original positions so effect order is unchanged. Run refs have a stable owner (`state/useRunRefs.ts`); render-time assignments and synchronous composer value/cursor updates remain in render/input handlers. `overlays/OverlayPanels.tsx` stays un-memoized because AppShell does not compare panel closures. [docs/architecture/app.md](architecture/app.md) documents the provider, model, run and conversation lifecycles and these invariants.

Timeline measurement lives in `ui/timeline/measure/`; its facade owns the public cache reset API. Viewport calculation, item construction, row rendering, and viewport effects have separate modules. Composer input/model/keymap logic lives in `ui/chrome/composer/`. Local harness configuration, profiles, event routing, policy decisions, and messages stay within its runtime folder; process and active-run identity guards remain at each asynchronous boundary.
