# Source guide

This is the maintenance catalog for production TypeScript files under `src/`. It describes ownership and purpose; [Architecture overview](overview.md) explains how the subsystems work together, [Developer Scripts](../../scripts/README.md) documents repository automation outside `src/`, [Installed Launchers](../../bin/README.md) documents the `bin/` entry points and Harness modules, and [`src/core/README.md`](../../src/core/README.md) maps the core folders.

## How to use this guide

- Find the owning directory before adding or moving code.
- Change the source file and its focused tests together.
- Update this catalog whenever a file is added, removed, renamed, or changes responsibility.
- Update the architecture document when a dependency boundary, entry point, data flow, persistence rule, provider layer, or terminal invariant changes.
- Treat names as navigation aids, not proof: verify behavior in the current implementation before editing it.

## Cross-cutting maintenance rules

1. **Keep dependencies directional.** Entrypoints and `app/App.tsx` may compose lower layers; core and session modules must not import UI components.
2. **Keep side effects at boundaries.** Parsers, reducers, measurement, and formatting helpers should remain deterministic. Process, filesystem, terminal, and persistence effects belong in their named boundary modules.
3. **Preserve runtime truth.** Provider availability, discovered models, reasoning choices, context metadata, and launch support must reflect what the runtime can actually do.
4. **Protect terminal ownership.** A terminal row, mode, resize path, or clear boundary should have one owner with paired cleanup.
5. **Keep app state out of projects.** Mutable caches, plans, attachments, provider state, and debug output belong in platform app data unless a file is intentional project configuration.
6. **Test contracts, not filenames.** Colocated tests should cover public behavior, edge cases, migrations, cleanup, and regression-prone terminal dimensions.
7. **Do not hand-edit generated metadata.** `src/config/buildInfo.ts` is written by `scripts/gen-build-info.mjs` and may change during `bun run build`.

## Production file catalog

Tests and shared test fixtures are colocated or under `src/test/` and are intentionally omitted. Generated build metadata is marked in its existing entry.

### `src/`

| File | Purpose |
| --- | --- |
| `src/cli.ts` | Headless entry point for `ubume exec`, `--headless-benchmark` and the other terminal commands; dispatches to `headless/commands.ts` with interrupt handling. |
| `src/index.tsx` | Bootstraps the Ink application, validates the terminal, owns terminal-mode setup/cleanup, frame locking, resize handling, and the single App render root. |

### `src/app/`

Start with [`docs/architecture/app.md`](app.md) for lifecycles and invariants.

| File | Purpose |
| --- | --- |
| `src/app/App.tsx` | Root component: composes the app hooks in a fixed order, keeps the terminal/clear-frame wiring inline, and renders `TranscriptShell` or `AppShell` with `OverlayPanels`. See [`docs/architecture/app.md`](app.md). |
| `src/app/conversation/conversationContext.ts` | The shared context type for `useConversation` and its sub-hooks. |
| `src/app/conversation/conversationMetadata.ts` | Pure conversation transforms: route metadata, interrupted-run notes, restored prompt history, run assistant messages, rewind checkpoints. |
| `src/app/conversation/conversationPersistence.ts` | Shared conversation save, conversation-switch completion (`finishRecovery`) and scratch-state reset/restore. |
| `src/app/conversation/useActiveConversation.ts` | Owns the active conversation record: creation on the first prompt, autosave, final checkpoint capture, run messages. |
| `src/app/conversation/useClearConversation.ts` | `/clear`: cancels the run, saves and detaches the conversation, and swaps in the home screen through the clear-frame boundary. |
| `src/app/conversation/useConversation.ts` | Composes `useActiveConversation`, `useResumeFlows` and `useStartupNotices` in effect order; defines the shared conversation context type. |
| `src/app/conversation/useResumeFlows.ts` | Every conversation switch: resume picker, saved and imported sessions, native CLI resume, workspace relaunch, startup `--resume`/`--import`. |
| `src/app/conversation/useStartupNotices.ts` | Provider migration and project-instruction notices after startup. |
| `src/app/input/appInputContext.ts` | The context type shared by `useAppInput` and `submitSteps.ts`. |
| `src/app/input/commandDispatch.ts` | Applies parsed slash-command results (`CommandResult`) through a handler table grouped by domain. |
| `src/app/input/submitSteps.ts` | Submission steps: direct commands, `!shell`, slash-command routing, attachment expansion, outside-workspace interception. |
| `src/app/input/useAppComposer.tsx` | Memoizes the composer element: plan action picker, plan feedback entry, or the prompt composer. |
| `src/app/input/useAppInput.ts` | `handleSubmit`: the ordered submission pipeline from composer text to command, shell, queue, plan or run. |
| `src/app/input/useComposerEditing.ts` | Composer edits, pasted-content registration, clipboard images and prompt-history navigation. |
| `src/app/input/useInterruptKeys.ts` | Ctrl+C interrupt/two-press exit, and Ctrl+Q/Ctrl+L outside the composer. |
| `src/app/input/useWorkbenchActions.ts` | Queue actions, `/send-now`, external editor drafts, rewind, redraw, and outside-workspace import confirmation. |
| `src/app/lifecycle/useAppDebugTracing.ts` | Debug-only render, layout and UI-state tracing. |
| `src/app/lifecycle/useAppLifecycleEffects.ts` | Base runtime config sync, settings autosave, and unmount cleanup. |
| `src/app/lifecycle/useFocusRouting.ts` | Routes keyboard focus per screen, preserves an open model picker's focus, and builds input debug snapshots. |
| `src/app/lifecycle/useTerminalUiState.ts` | Publishes the UI state to the terminal controller and title lifecycle. |
| `src/app/lifecycle/useUpdateCheck.ts` | Owns the update-check scheduler: the startup check behind the initial overlay gate, background checks, and the shared check used by `/update`. |
| `src/app/models/catalogLogic.ts` | Pure conversion of an OpenAI catalog snapshot into Codex capabilities. |
| `src/app/models/selectionLogic.ts` | Pure selection rules: candidate routes, reasoning checks, validation-failure classification, Google reasoning selectors. |
| `src/app/models/useActiveModelMetadata.ts` | Capabilities and context-window metadata for the active route's model. |
| `src/app/models/useModelCatalog.ts` | Catalog subscription, Codex model discovery, per-provider refresh, auth and startup availability probes. |
| `src/app/models/useModelPickerModel.ts` | Everything the model picker shows for the pending or active provider. |
| `src/app/models/useModelSelection.ts` | Mode, plan-mode and reasoning setters, and the single model activation path (validate, persist, commit or recover). |
| `src/app/models/useOpenAiModelReconcile.ts` | Blocks prompts for an unavailable configured OpenAI model and normalizes reasoning for an available one. |
| `src/app/overlays/OverlayPanels.tsx` | Renders the overlay for the current screen (un-memoized) with named handlers. |
| `src/app/overlays/useOverlayRouting.ts` | Opens overlays and routes permissions-panel actions. |
| `src/app/providers/providerActions.ts` | Pure provider-picker decisions: saved-model reuse, Local status badges, notices, setup commands. |
| `src/app/providers/routeStatus.ts` | Builds the `/status` route report (`formatRouteStatus`). |
| `src/app/providers/useActiveProviderRoute.ts` | Resolves the active route and provider registry; closes Local harness sessions and resets CLI readiness on route changes. |
| `src/app/providers/useProviderRoute.ts` | Provider picker actions, Local backend probes, diagnostics, CLI launch preflight and setup. |
| `src/app/providers/useProviderUsage.ts` | `/usage` panel state for the active route through the shared usage service. |
| `src/app/run/promptGates.ts` | Pure pre-flight checks that decide whether a prompt may start a run. |
| `src/app/run/promptRunPrep.ts` | Per-turn runtime config, provider history selection, final response choice, live flush timing. |
| `src/app/run/providerRunSession.ts` | One provider run (React-free): scheduling, workspace preparation, stream handlers, completion and cleanup. |
| `src/app/run/runFinalize.ts` | Pure response parsing and queue-pause rules for finished runs. |
| `src/app/run/shellLineBatcher.ts` | Batches shell output lines into flush-interval updates. |
| `src/app/run/usePlanFlow.ts` | Plan generation, review, approved execution, the startup `--prompt`, and prompt queue draining. |
| `src/app/run/usePromptExecution.ts` | `!shell` execution with the execution lease, and workspace relaunch. |
| `src/app/run/usePromptRun.ts` | `startPromptRun`: gates, turn bootstrap, then the provider run session. |
| `src/app/run/useRunLifecycle.ts` | Finalizes and cancels runs, Esc handling, quit, transcript copy, plan files. |
| `src/app/settings/useRuntimeSettings.ts` | Session runtime overrides and every `providers.json` write (`updateProviderWorkspaceConfig`, `persistActiveRoute`). |
| `src/app/settings/useSettings.ts` | UI preference and runtime-policy setters, and the settings save payload. |
| `src/app/settings/useThemeCommit.ts` | Commits a theme choice, saves it synchronously, shows the header notice, and requests the atomic home repaint. |
| `src/app/settings/useStartupLogoCommit.ts` | Commits a startup-logo-style choice through the same payload and repaint flow as the theme commit. |
| `src/app/state/useAppState.ts` | Startup initialization (disk reads once) and every shared state slot and ref. |
| `src/app/state/useRunRefs.ts` | Stable refs for the active run and background work (stopping promises, submission/recovery guards). |

### `src/commands/`

| File | Purpose |
| --- | --- |
| `src/commands/diagnosticsFormat.ts` | Formats GitHub, provider CLI, and provider route diagnostics consistently. |
| `src/commands/handler.ts` | Parses slash commands into typed actions and formats deterministic help, status, configuration, and validation messages. |

### `src/config/`

| File | Purpose |
| --- | --- |
| `src/config/index.ts` | Public entrypoint facade re-exporting the complete configuration subsystem API. |
| `src/config/atomicFile.ts` | Provides safe atomic file reading and writing utilities using temporary files and destination renaming. |
| `src/config/buildInfo.ts` | Generated build metadata containing the packaged version and Git revision; regenerated by scripts/gen-build-info.mjs. |
| `src/config/launchArgs.ts` | Parses interactive launch flags, profiles, models, prompts, and runtime overrides into the shared LaunchArgs shape. |
| `src/config/layeredConfig.ts` | Loads, validates, merges, and diagnoses built-in, user, trusted-project, profile, and CLI configuration layers. |
| `src/config/persistence.ts` | Loads and saves user-facing Ubume settings with normalization and safe fallback behavior. |
| `src/config/runtimeConfig.ts` | Defines runtime policy types, defaults, resolution, labels, writable-root operations, and effective configuration summaries. |
| `src/config/settings.ts` | Defines application constants, selectable models/modes/backends/themes, user-setting schemas, labels, and display helpers. |
| `src/config/tomlSerialize.ts` | Serializes supported configuration objects to stable TOML while preserving valid scalar and nested structures. |
| `src/config/trustStore.ts` | Persists and queries whether project roots are trusted before project configuration is applied. |

### `src/core/codex/`

| File | Purpose |
| --- | --- |
| `src/core/codex/codexAppServerClient.ts` | Short-lived initialized Codex app-server sessions for model discovery and usage, with id-correlated responses, timeout/abort and best-effort child termination. |
| `src/core/codex/codexAuth.ts` | Probes Codex authentication and converts results into run gating, labels, guidance, and likely-auth-failure classification. |
| `src/core/codex/codexCapabilities.ts` | Detects supported Codex exec flags from cached CLI help probes; distinct from model capability discovery. |
| `src/core/codex/codexExecArgs.ts` | Builds the exact Codex CLI exec argument vector from effective runtime configuration and launch context. |
| `src/core/codex/codexLaunch.ts` | Prepares executable resolution, capability selection, argv and optional diagnostics without spawning the prompt process. |
| `src/core/codex/codexPrompt.ts` | Builds planning/execution prompts and detects execution intent, safe cleanup requests, and hollow responses. Recognizes blocked fast-cleanup tool failures so runs can stop with an actionable message. Formats warnings and recovery guidance when a write-intent run returns a hollow response. |

### `src/core/computerUse/`

| File | Purpose |
| --- | --- |
| `src/core/computerUse/browser.ts` | Owns browser workers, sessions, tool transport, cancellation, and cleanup. |
| `src/core/computerUse/capability.ts` | Resolves browser enablement and capability policy from runtime configuration. |
| `src/core/computerUse/types.ts` | Defines browser requests, results, session state, and tool contracts. |

### `src/core/executables/`

| File | Purpose |
| --- | --- |
| `src/core/executables/antigravityExecutable.ts` | Verifies the configured Google command exposes the AGY interface without submitting a model prompt. |
| `src/core/executables/codexExecutable.ts` | Resolves the Codex executable and verifies usable command candidates. |
| `src/core/executables/executableResolver.ts` | Resolves Claude Code and Antigravity (`agy`) executables with platform and override handling. Provides shared cross-platform executable-name, PATH, override, and resolution utilities. |

### `src/core/externalSessions/`

| File | Purpose |
| --- | --- |
| `src/core/externalSessions/antigravitySessions.ts` | Lists Antigravity sessions from SQLite and reads session protobuf state. |
| `src/core/externalSessions/claudeSessions.ts` | Lists Claude Code sessions from `~/.claude/projects` (head/tail reads) and streams a session JSONL into transcript entries. |
| `src/core/externalSessions/codexSessions.ts` | Lists Codex threads from `state_*.sqlite` (rollout scan fallback) and parses rollout JSONL into transcript entries. |
| `src/core/externalSessions/index.ts` | Converts a native transcript into Ubume conversation messages for "continue in Ubume". Routes listing and transcript reads to the store for each source. Builds the `claude --resume` / `codex resume` / `agy --conversation` / `vibe --resume` launch in the session's folder. |
| `src/core/externalSessions/storeIo.ts` | Walks protobuf wire format without a schema and returns its text fields. Shared JSONL head/tail/stream readers, bounded-concurrency mapping, and title helpers. Opens another tool's SQLite store read-only (with an immutable fallback for WAL databases). |
| `src/core/externalSessions/types.ts` | Session source, scope, summary, and transcript types plus display labels. |
| `src/core/externalSessions/vibeSessions.ts` | Lists and reads native Mistral Vibe session transcripts. |

### `src/core/models/`

| File | Purpose |
| --- | --- |
| `src/core/models/reasoningControl.ts` | Validates advertised reasoning levels/budgets and reconciles preferences without inventing support. |
| `src/core/models/selectionCoordinator.ts` | Session-owned selection ordering, navigation ownership and revision-guarded model validation/rejection evidence. |
| `src/core/models/modelSelection.ts` | Resolves exact/advertised aliases and rejects absence only from complete verified inventory. |
| `src/core/models/modelCatalog.ts` | Owns connection identities, generation-guarded model refresh, TTL/backoff and unverified last-good fallback. |
| `src/core/models/codexModelCapabilities.ts` | Normalizes selectable Codex models, reasoning levels, defaults, lookup, and display formatting. |
| `src/core/models/modelCache.ts` | Seeds startup model capabilities from Codex and Ubume last-good cache files without blocking live discovery. Persists and loads last-good model discovery results per provider. |

### `src/core/perf/`

| File | Purpose |
| --- | --- |
| `src/core/perf/debugLog.ts` | Emits environment-gated stdin, focus, paste, and terminal-input diagnostics. Emits privacy-aware Local streaming diagnostics when explicitly enabled. Emits environment-gated model/provider state snapshots for picker and routing diagnosis. Emits environment-gated update-check scheduling and result diagnostics. |
| `src/core/perf/benchTrace.ts` | Records opt-in offline startup, stream, frame and memory measurement stages. |
| `src/core/perf/profiler.ts` | Collects opt-in prompt/run phase timings, counters, and session performance summaries. |
| `src/core/perf/renderDebug.ts` | Provides opt-in render counts, lifecycle traces, frame diagnostics, and React render instrumentation. |

### `src/core/process/`

| File | Purpose |
| --- | --- |
| `src/core/process/commandRunner.ts` | Runs shell commands with streamed output, cancellation, summaries, and platform-aware process cleanup; `capture` selects full or bounded retention of the result output. |
| `src/core/process/outputCapture.ts` | Output retention policy: full capture, or a bounded head/tail buffer with an explicit omission marker. |
| `src/core/process/processValidation.ts` | Validates executable paths and process-launch inputs before spawning commands. |

### `src/core/providerLauncher/`

| File | Purpose |
| --- | --- |
| `src/core/providerLauncher/providerIdentity.ts` | Normalizes compatible saved provider identities while keeping legacy Gemini selection explicitly blocked. |
| `src/core/providerLauncher/localBackend.ts` | Shares route-backend, saved-preference, LM Studio precedence across persistence, discovery and connection keys. |
| `src/core/providerLauncher/launcher.ts` | Builds and launches external provider CLI commands (and arbitrary resume commands via `launchCliCommand`) in the inherited terminal with safe hand-off and restoration. |
| `src/core/providerLauncher/registry.ts` | Builds provider-picker records from runtime truth, workspace overrides, discovery, and active/default route state. |
| `src/core/providerLauncher/types.ts` | Defines provider IDs, workspace configuration, launch commands, picker actions, and persisted route types. |
| `src/core/providerLauncher/workspaceConfig.ts` | Loads, migrates, normalizes, and saves per-workspace provider configuration in Ubume app data. |

### `src/core/providerRuntime/`

| File | Purpose |
| --- | --- |
| `src/core/providerRuntime/vibeEffectiveModels.ts` | Reads installed Vibe effective model assignments through its Python environment with migrations disabled. |
| `src/core/providerRuntime/mistralDiscovery.ts` | Resolves Vibe configuration/credentials and reads Mistral API model metadata without claiming native execution verification. |
| `src/core/providerRuntime/failures.ts` | Retains structured API error evidence and conservatively distinguishes model failures from authentication, setup and transient failures. |
| `src/core/providerRuntime/deployment.ts` | Classifies execution locality using explicit deployment preferences and loopback endpoint detection. |
| `src/core/providerRuntime/codexaNativeConfig.ts` | Validates development-only native generation options and resolves registry/checkpoint/tokenizer paths with explicit configuration errors. |
| `src/core/providerRuntime/anthropicDiscovery.ts` | Reads paginated direct Anthropic API inventory, keeping API authentication/discovery separate from Claude Code. |
| `src/core/providerRuntime/registry.ts` | Registers provider runtimes and resolves discovery, activation validation, migrations, defaults, and active routes. Formats provider labels and chooses provider setup commands. |
| `src/core/providerRuntime/anthropic.ts` | Implements Claude Code route validation, model discovery, process execution, and streamed event adaptation. |
| `src/core/providerRuntime/capabilityProfile.ts` | Resolves cached provider model feature profiles such as tools, vision, and reasoning support. |
| `src/core/providerRuntime/claudeCodeDiscovery.ts` | Discovers Claude models/efforts from native commands, installed package metadata, settings and fallbacks. |
| `src/core/providerRuntime/codexaNative.ts` | Implements the Codexa Native route and its CuPy accelerated execution support. |
| `src/core/providerRuntime/contextMetadata.ts` | Resolves, caches, and formats model context-window metadata from provider config, discovery, and known registries. |
| `src/core/providerRuntime/antigravity.ts` | Implements Google provider runtime backed by Antigravity CLI (`agy`), route validation, model discovery, process execution, buffered response adaptation, and cancellation. |
| `src/core/providerRuntime/local.ts` | Checks local-server readiness, discovers models, resolves configuration, delegates active Local requests to the Harness adapter, and reports diagnostics. |
| `src/core/providerRuntime/localBackends.ts` | Defines LM Studio/OpenAI-compatible request and response helpers used by the local runtime. Verifies a local Unsloth Studio instance, resolves secure API authentication, and parses loaded models. |
| `src/core/providerRuntime/mistralVibe.ts` | Discovers Vibe configuration/models, resolves and launches the CLI, manages sessions, and adapts routed output. |
| `src/core/providerRuntime/models.ts` | Defines shared provider model fallbacks, aliases, normalization, and conversion to Codex-style capabilities. Normalizes provider reasoning levels and selects valid defaults for discovered models. |
| `src/core/providerRuntime/types.ts` | Defines the multi-provider runtime, route, discovery, model, validation, and chat request contracts, including restored conversation history. |

### `src/core/providerRuntime/localHarness/`

| File | Purpose |
| --- | --- |
| `src/core/providerRuntime/localHarness/bridgePolicy.ts` | Pure workspace and approval decisions for harness tool requests. |
| `src/core/providerRuntime/localHarness/config.ts` | Harness configuration, fingerprints, reasoning, output budgets, and subprocess environment. |
| `src/core/providerRuntime/localHarness/messages.ts` | Harness route descriptions, redaction, cancellation, hashing, and failure messages. |
| `src/core/providerRuntime/localHarness/notifications.ts` | Harness event handlers with explicit process and active-run ownership context. |
| `src/core/providerRuntime/localHarness/profile.ts` | Harness profile YAML and session scratch directory preparation. |
| `src/core/providerRuntime/localHarness/lazyRuntime.ts` | Lazy entry points (run, shutdown, session close) that load the Harness runtime on the first Local run instead of at startup. |
| `src/core/providerRuntime/localHarness/runtime.ts` | Owns the persistent Harness child, active runs, durable resume/flush, tool/browser approvals, continuation and cleanup; policy and notifications stay in extracted modules. |

### `src/core/providers/`

| File | Purpose |
| --- | --- |
| `src/core/providers/codexJsonStream.ts` | Incrementally parses Codex JSONL events into assistant, reasoning, tool, and lifecycle callbacks. |
| `src/core/providers/codexSubprocess.ts` | Implements the runnable Codex backend, spawning the CLI and adapting its streams to BackendRunHandlers. |
| `src/core/providers/codexTranscript.ts` | Parses human/legacy Codex transcript output and filters noise while preserving response and activity ordering. |
| `src/core/providers/registry.ts` | Looks up the low-level backend with configured-default and Codex fallback; does not select provider routes. |
| `src/core/providers/runControl.ts` | Tracks stopped process promises and cancellation ownership for active runs. |
| `src/core/providers/types.ts` | Defines BackendProvider, run options, conversation history, progress updates, callbacks, and benchmark lifecycle hooks. |

### `src/core/shared/`

| File | Purpose |
| --- | --- |
| `src/core/shared/clipboard.ts` | Copies text through platform-specific clipboard commands with explicit success/failure reporting. |
| `src/core/shared/githubDiagnostics.ts` | Checks Git/GitHub CLI, remote identity, and local write readiness and classifies diagnostic results. |
| `src/core/shared/startupLogoDimensions.ts` | The `LogoCellSize` type, the four-columns-per-row aspect and the 12×3 base region shared by core graphics transport and UI layout. |
| `src/core/shared/text.ts` | Unicode width and grapheme-based wrapping/input helpers, line normalization, duration/title formatting and truncation. |
| `src/core/shared/values.ts` | Import-free value guards: isRecord, errorMessage and clampIndex. |

### `src/core/terminal/`

| File | Purpose |
| --- | --- |
| `src/core/terminal/clearFrameBoundary.ts` | Coordinates atomic transcript clearing across session state, Ink caches, terminal output, and repaint boundaries. |
| `src/core/terminal/externalEditor.ts` | Suspends terminal ownership for an external editor and restores the draft. |
| `src/core/terminal/frameLock.ts` | Serializes and normalizes Ink stdout frames to prevent interleaving, duplicates, width residue, and resize corruption. |
| `src/core/terminal/inkRenderReset.ts` | Locates Ink internals and resets render caches when a deliberately fresh frame is required. |
| `src/core/terminal/terminalCapabilities.ts` | Detects supported TTY environments and reports blocking errors or compatibility warnings. |
| `src/core/terminal/terminalControl.ts` | Provides the single controller for terminal writes, mouse, paste, cursor, alternate-screen, and reset sequences. |
| `src/core/terminal/terminalSanitize.ts` | Removes unsafe terminal control characters while preserving explicitly allowed text layout. |
| `src/core/terminal/terminalTitle.ts` | Tracks intended terminal titles and applies/restores title sequences across lifecycle changes. |

### `src/core/usage/`

| File | Purpose |
| --- | --- |
| `src/core/usage/types.ts` | Normalised usage contract: snapshot status, billing mode, limits (unknown ≠ zero), facts, links, adapter and request context. |
| `src/core/usage/normalize.ts` | Pure helpers: percentage/fraction validation, reset-time parsing (epoch s/ms, ISO), window labels, provider-text sanitising, and credential-free usage scope keys. |
| `src/core/usage/registry.ts` | Maps the active route to the adapter for the account it actually executes with (Claude Code vs direct API) and its scope key; unsupported fallback. |
| `src/core/usage/usageService.ts` | Per-scope cache, refresh cooldown (`UBUME_USAGE_COOLDOWN_SECONDS`), single in-flight request, and stale fallback that keeps the last good snapshot. |
| `src/core/usage/codexUsage.ts` | Codex adapter: `account/read` and `account/rateLimits/read` over the app-server; maps windows, buckets, credits and API-key/signed-out states. |
| `src/core/usage/claudeCodeUsage.ts` | Claude Code adapter: `claude auth status` plus the experimental `get_usage` SDK control request on a hook-free, tool-free, non-persisted stream-json host. |
| `src/core/usage/antigravityUsage.ts` | Google (Antigravity) adapter: print-mode `agy -p /usage` and `/credits` JSON with per-model-group quota buckets; rejects replies that ran a turn. |
| `src/core/usage/anthropicApiUsage.ts` | Direct Anthropic API adapter built only from observed `anthropic-ratelimit-*` headers. |
| `src/core/usage/observedRateLimits.ts` | Parses and stores rate-limit response headers that runtimes already receive; makes no requests. |
| `src/core/usage/mistralVibeUsage.ts` | Reports that Mistral Vibe exposes no programmatic usage, budget or rate-limit interface. |
| `src/core/usage/localUsage.ts` | Local adapter: model, context window (percentage only when verified/configured), harness token counts, and N/A vs remote-endpoint quota. |
| `src/core/usage/localUsageTracker.ts` | Records exact Local harness token usage per scope for the current conversation; ignores compaction re-emits. |

### `src/core/version/`

| File | Purpose |
| --- | --- |
| `src/core/version/channel.ts` | Reads and normalizes the package version through a leaf module that avoids configuration/version import cycles. Formats version and build-channel labels from package and generated build metadata. |
| `src/core/version/packageManager.ts` | Detects how Ubume was installed and derives the appropriate update command. |
| `src/core/version/updateCheck.ts` | Caches update-check results in app data with expiry and corruption-tolerant reads. Checks npm `dist-tags` for newer versions with an abortable timeout and SemVer-precedence comparison. |
| `src/core/version/updateScheduler.ts` | Schedules update checks with injected timers: single-flight requests, a periodic interval after successes, jittered exponential backoff after failures, and disposal that aborts in-flight requests. Classifies only completed comparisons as verified results. |

### `src/core/workspace/`

| File | Purpose |
| --- | --- |
| `src/core/workspace/appData.ts` | Resolves platform-specific Ubume data, workspace, conversation, cache, attachment, and debug paths. |
| `src/core/workspace/legacyDataMigration.ts` | Resumable, non-overwriting legacy artifact import with private staging, receipts and complete conversation records. |
| `src/core/workspace/attachments.ts` | Imports external attachments into app data, identifies images, and rewrites prompts to safe workspace-visible paths. |
| `src/core/workspace/checkpoints.ts` | Captures file checkpoints (reads/hashes in bounded parallel batches, limits applied in listing order) and journals guarded file restore operations. |
| `src/core/workspace/conversationStore.ts` | Persists workspace-scoped conversation metadata and canonical messages (with optional per-reply activity summaries) with atomic JSON writes. |
| `src/core/workspace/launchContext.ts` | Describes installed/dev launch context and builds guarded workspace relaunch commands. |
| `src/core/workspace/ownership.ts` | Acquires and releases workspace execution and conversation ownership leases. |
| `src/core/workspace/planStorage.ts` | Normalizes, saves, and reads reviewed plans from Ubume workspace data. |
| `src/core/workspace/projectInstructions.ts` | Finds and loads AGENTS.md/project instructions with explicit missing, loaded, and error states. |
| `src/core/workspace/scratchDir.ts` | Describes, lazily creates, removes when unused, and prunes per-session `.ubume/scratch/<session>` folders where the Local agent keeps throwaway test/debug files. |
| `src/core/workspace/workspaceActivity.ts` | Snapshots workspace files (sync and bounded-concurrency async, with a stat-validated content cache), detects changes, aggregates activity, and tracks modifications during runs with non-overlapping adaptive polls. |
| `src/core/workspace/workspaceFiles.ts` | Resolves, reads, and guards workspace file selections; `createContainedFileResolver` shares root/directory checks across one multi-file operation. |
| `src/core/workspace/workspaceGuard.ts` | Normalizes diagnostic paths, blocks or explains paths and commands outside the active workspace (strict for shell commands, context-classified for prompt text), and classifies destructive shell commands. |
| `src/core/workspace/workspaceRoot.ts` | Resolves, normalizes, and compares the active workspace root across platforms and launch modes. |

### `src/headless/`

Subsystem guide: [src/headless/README.md](../../src/headless/README.md).

| File | Purpose |
| --- | --- |
| `src/headless/commands.ts` | Public entry (`runTerminalCommand`, `terminalHelp`): selects the command, prints help, writes the versioned JSON envelope or human output, redacts output, and maps errors to exit codes. |
| `src/headless/commandResult.ts` | Shared handler vocabulary: `EXIT_CODE`, `CommandError`/`usageError`, `CommandOutcome`, `CommandEnv`, and `--cwd` workspace resolution. |
| `src/headless/context.ts` | Resolves the provider route (provider/model/reasoning precedence) and runtime for headless commands, with execution-readiness checks that are skipped in inspect mode. |
| `src/headless/diagnostics.ts` | Provider availability listing, provider executable resolution, and the `doctor` checks (local probes only; never a model prompt). |
| `src/headless/execArgs.ts` | Pure parser for `ubume exec` arguments, prompt sources, prompt policy, timing flags, and provider passthrough options. |
| `src/headless/execCommand.ts` | `exec`/`--headless-benchmark` handler: prompt from argv or strict UTF-8 stdin, output-mode selection, and the saved run. |
| `src/headless/execOutput.ts` | Stream filtering and formatting: assistant-text sanitising, protocol/teardown noise suppression, and `[ubume exec]` diagnostics. |
| `src/headless/execRunner.ts` | Runs one provider turn without Ink: streams assistant text to stdout and diagnostics to stderr, settles once, cancels on abort or denied approval, and waits for provider teardown. |
| `src/headless/execTiming.ts` | Opt-in `[ubume exec timing]` phase marks shared with the launcher's timeline. |
| `src/headless/inspectCommands.ts` | Inspection argument parsing and the read-only `config`, `providers`, `status`, `doctor` and `models` commands. |
| `src/headless/redact.ts` | Redacts secret fields, URL credentials, secret query parameters, secret environment values and configured API keys from all headless output. |
| `src/headless/savedExec.ts` | Wraps a run with session persistence: resume, execution/session locks, attachments, turn events, debounced saves, and before/after file checkpoints. |
| `src/headless/sessionCommands.ts` | `sessions list/show/transcript/diff` over saved conversations and file checkpoints. |

### `src/session/`

| File | Purpose |
| --- | --- |
| `src/session/appSession.ts` | Defines the aggregate session reducer and hook for transcript events, input history, active runs, clear epochs, and UI lifecycle. |
| `src/session/chatLifecycle.ts` | Implements pure lifecycle/event reducers for progress, thinking, tools, response segments, plans, completion, failure, and cancellation. |
| `src/session/conversation.ts` | Converts durable dialogue into timeline events (including saved activity summaries) and plain role/content provider request history. |
| `src/session/eventIds.ts` | Allocates event/turn IDs, advances them past restored events, and creates startup/auth state. |
| `src/session/liveRenderScheduler.ts` | Batches provider deltas and progress updates at separate cadences before session dispatch. Schedules provider start after the submitted prompt frame has had an opportunity to render. |
| `src/session/persistedResponse.ts` | Builds the assistant message saved for each run (completed, canceled, failed) with a compact files-changed / commands-run summary for `/resume`. |
| `src/session/planFlow.ts` | Models plan-mode transitions, approval/revision decisions, and execution hand-off. |
| `src/session/sessionCatalog.ts` | Builds local/native resume catalogs and resolves saved-workspace relaunch plans. |
| `src/session/transcriptExport.ts` | Pairs chronological prompt/reply turns and copies their readable transcript. |
| `src/session/types.ts` | Defines screens, UI lifecycle states, timeline events, run stream items, tool activity, and shared session helpers. |
| `src/session/workbench.ts` | Owns prompt queues, snapshots, tool-output inspection, and persisted workbench state. |

### `src/ui/`

Subsystem guide: [src/ui/README.md](../../src/ui/README.md).

| File | Purpose |
| --- | --- |
| `src/ui/layout.ts` | Calculates responsive terminal dimensions, layout modes, row budgets, panel space, and viewport state; `resolvePickerPanelGeometry`/`usePickerPanelGeometry` size the model and provider pickers. |
| `src/ui/theme.tsx` | Defines theme palettes, the React theme provider, and the useTheme hook. Normalizes theme changes and determines persisted/current theme transitions. |

### `src/ui/chrome/`

| File | Purpose |
| --- | --- |
| `src/ui/chrome/AppShell.tsx` | Owns responsive overlay and panel composition plus reusable shell row budgeting; TranscriptShell remains the main-chat/native-scrollback owner. |
| `src/ui/chrome/BottomComposer.tsx` | Renders the single prompt composer and its provider/model/context status area. |
| `src/ui/chrome/TopHeader.tsx` | Renders responsive Ubume branding and workspace/auth/provider header content. |
| `src/ui/chrome/UpdateAvailableCard.tsx` | Renders an actionable notice when a newer Ubume version is available. |
| `src/ui/chrome/statusIndicators.tsx` | Displays width-aware animated status text without destabilizing surrounding rows. Provides the shared spinner animation primitive. Calculates deterministic frames and labels for busy-state animations. |

### `src/ui/chrome/composer/`

| File | Purpose |
| --- | --- |
| `src/ui/chrome/composer/composerKeymap.ts` | Pure composer key classification and raw terminal key sequences. |
| `src/ui/chrome/composer/composerModel.ts` | Composer props, measurement, status labels, and suggestion helpers. |
| `src/ui/chrome/composer/useComposerInput.ts` | Composer input controller: raw-key signals, keymap dispatch (shortcuts → chord → edits), file mentions, history, focus, and timers; delegates edits, search and paste assembly to the modules below. |
| `src/ui/chrome/composer/composerEditing.ts` | Pure draft transitions: token-aware moves and deletes, readline kill, file-token insertion, and Enter resolution (line continuation, slash-command completion, submit). |
| `src/ui/chrome/composer/historySearch.ts` | Pure Ctrl+R reverse history search transition. |
| `src/ui/chrome/composer/pasteAssembler.ts` | Reassembles bracketed pastes and unbracketed paste bursts into single insertions (injected timers). |

### `src/ui/input/`

| File | Purpose |
| --- | --- |
| `src/ui/input/focus.ts` | Defines focus identifiers and helpers shared by composer and overlay controls. |
| `src/ui/input/rawStdinSignals.ts` | Raw-stdin hold windows for sequences Ink mis-parses (mouse reports, CSI-u shortcuts, Shift+Tab variants); shared by the composer and plan picker. |
| `src/ui/input/inputBuffer.ts` | Implements cursor-aware Unicode editing, history movement, paste, deletion, and buffer updates. |
| `src/ui/input/pastedContent.ts` | Registers pasted text and image tokens and rewrites submitted attachment content. |
| `src/ui/input/rawArrowKeys.ts` | Resolves arrow keys from raw stdin chunks so panels survive split escape sequences. |
| `src/ui/input/slashCommands.ts` | Defines discoverable slash-command metadata, aliases, filtering, and completion behavior. |
| `src/ui/input/useStdinRawModeLease.ts` | Holds Ink's raw-mode refcount above zero for the App lifetime so shell swaps never detach the stdin readable listener. |

### `src/ui/panels/`

| File | Purpose |
| --- | --- |
| `src/ui/panels/AttachmentImportPanel.tsx` | Confirms external attachment import and shows source/destination safety information. |
| `src/ui/panels/AuthPanel.tsx` | Displays authentication state and login/logout guidance. |
| `src/ui/panels/ExternalSessionViewer.tsx` | Read-only, scrollable transcript of a native Claude Code / Codex / Mistral Vibe session with open-natively and continue-in-Ubume actions. |
| `src/ui/panels/ModelPickerScreen.tsx` | Renders the model picker (loading/empty states, model rows, reasoning slider or budget) and maps keys to selection actions; models are discovered by `src/app`. |
| `src/ui/panels/modelPickerModel.ts` | Pure model-picker logic: model identity and names, Gemini effort-variant grouping, reasoning normalisation, the draft-selection reducer (including recovery when the list changes), and the responsive window. |
| `src/ui/panels/PermissionsPanel.tsx` | Displays and edits approval, sandbox, network, writable-root, service-tier, and personality settings. |
| `src/ui/panels/PlanActionPicker.tsx` | Plan review prompt in the composer slot: implement or redo the plan, Esc cancels; reassembles split arrow keys. |
| `src/ui/panels/ProviderPicker.tsx` | Renders the provider picker and its Codexa Native / Local drill-ins and applies key commands; provider changes are performed by `src/app` via `onAction`. |
| `src/ui/panels/providerPickerModel.ts` | Pure provider-picker logic: Codexa Native grouping, Local backend rows, the responsive window, table column layout, and the key → command resolver. |
| `src/ui/panels/ProviderSetupPrompt.tsx` | Explains provider setup and routes install/login choices. |
| `src/ui/panels/ResumePicker.tsx` | Tabbed `/resume` picker: Ubume conversations plus Claude Code, Codex, and Mistral Vibe sessions for this folder or all projects. |
| `src/ui/panels/SelectionPanel.tsx` | Provides the reusable keyboard-driven selection list with visible-window management. |
| `src/ui/panels/PreferencesPanel.tsx` | The `/preferences` overlay: categorized appearance entries (Startup Logo, Color Theme) with their current values, opening each setting's picker. |
| `src/ui/panels/SettingsPanel.tsx` | Displays and edits persistent user interface settings. |
| `src/ui/panels/SimplePickers.tsx` | Selects execution mode and explains its behavior. Selects Codex reasoning effort for the active model. Previews and selects a persisted color theme. |
| `src/ui/panels/TextEntryPanel.tsx` | Provides a reusable focused text-entry overlay. |
| `src/ui/panels/ToolApprovalPanel.tsx` | Displays a tool request and collects allow/deny/cancel decisions. |
| `src/ui/panels/UpdatePromptPanel.tsx` | Presents detected update information and the install command. |
| `src/ui/panels/UsagePanel.tsx` | `/usage` overlay: provider usage rows with R refresh (respecting cooldown/in-flight), Esc/q close, and arrow-key scrolling on short terminals. |
| `src/ui/panels/WorkbenchPanel.tsx` | Displays transcript, queue, diff, and checkpoint recovery views. |
| `src/ui/panels/responsivePickerViewport.ts` | Calculates picker rows and viewport windows for terminal dimensions. |
| `src/ui/panels/resumePickerRows.ts` | Pure row/label formatting and section types for the resume picker. |
| `src/ui/panels/usagePanelRows.ts` | Pure, width-bounded row builder for the usage panel: bars only for reported percentages, extreme-value rounding, local-time resets, and live/cached/stale/observed labels. |

### `src/ui/render/`

| File | Purpose |
| --- | --- |
| `src/ui/render/Markdown.tsx` | Provides common bordered panel layout and hint treatment. Parses and renders terminal-safe Markdown blocks, inline styles, lists, links, tables, and code. |
| `src/ui/render/diffRenderer.ts` | Parses unified diffs and emits width-aware colored terminal rows. |
| `src/ui/render/logoVariants.ts` | Chooses full, compact, or tiny Ubume branding for the available terminal dimensions. |
| `src/ui/render/startupLogoAsset.ts` | Original SVG paths and solid half-cell geometry shared by both compact styles. |
| `src/ui/render/useStartupLogoGraphic.ts` | Bounded, asynchronous Sharp rasterization with stale-result cancellation. |
| `src/core/terminal/startupGraphics.ts` | Positive capability negotiation, Kitty cell placeholders and frame-owned inline graphics transport. |
| `src/core/terminal/terminalQueryInput.ts` | Filters correlated terminal probe replies without discarding concurrent keyboard input. |
| `src/ui/render/startupAnimation.ts` | Theme-neutral assembly frames, memoized solid developer glyphs per responsive size and frame, and the interactive-startup gate for Minimal and Simple. |
| `src/ui/render/startupLogoLayout.ts` | Pure sizing for the compact mark: fixed 12×3 base region, hard fit constraints, metadata offset and alignment. |
| `src/ui/render/responsiveHeader.ts` | One pure startup-header allocation (logo kind, size, beside/stacked arrangement, metadata and spacing rows) shared by measurement, row building and graphics. |
| `src/ui/render/wordmarkArt.ts` | Native-size classic wordmark art and its theme tone bands. |
| `src/ui/render/useStartupLogoAnimation.ts` | Cancellable, one-shot React playback owned above transcript repaint remounts; no terminal writes. |
| `src/ui/render/outputPipeline.ts` | Normalizes provider output before it reaches higher-level terminal rendering. |
| `src/ui/render/runtimeDisplay.ts` | Formats execution-mode labels and descriptions for terminal display. Formats runtime policy and provider/model metadata into compact display values. |
| `src/ui/render/terminalAnswerFormat.ts` | Normalizes assistant answer conventions, especially local file references, for terminal presentation. |

### `src/ui/timeline/`

| File | Purpose |
| --- | --- |
| `src/ui/timeline/ActionRequiredBlock.tsx` | Component form of a question card; rendered only by `TurnGroup` (test-only), production uses measured rows. |
| `src/ui/timeline/AgentBlock.tsx` | Component form of an agent response; rendered only by `TurnGroup` (test-only), production uses measured rows. |
| `src/ui/timeline/DashCard.tsx` | Dashed-border card used by the component-form transcript (`TurnGroup`, `AgentBlock`); not mounted in production. |
| `src/ui/timeline/Timeline.tsx` | Builds turn/event items, manages scroll/follow-tail navigation, and renders the measured transcript viewport. |
| `src/ui/timeline/TimelineRows.tsx` | Timeline row rendering and memo comparators. |
| `src/ui/timeline/TranscriptShell.tsx` | Commits static transcript rows and live-tail rows while preserving native terminal scrollback behavior. |
| `src/ui/timeline/TurnGroup.tsx` | Exports `TurnOpacity`/`TurnRunPhase` and `resolveTurnRunPhase`, used by the measured-row pipeline; its `TurnGroup` component is rendered only by tests. |
| `src/ui/timeline/liveViewportWindow.ts` | Tail-windows a running turn's live rows to the conversation viewport so Ink never clears the terminal and scrollback mid-stream. |
| `src/ui/timeline/progressEntries.ts` | Normalizes provider progress entries into stable visible thinking blocks. |
| `src/ui/timeline/runActivityView.ts` | Normalizes terminal commands and paths into friendly activity labels. Aggregates and formats changed-file and tool activity for timeline display. Merges consecutive reasoning stream events so contiguous thought renders under one header. |
| `src/ui/timeline/staticTranscriptCache.ts` | Incrementally builds native rows for finalized turns keyed by event identity and opacity, and retains row objects only for the newest turns. |
| `src/ui/timeline/timelineItems.ts` | Pure transcript item construction and turn presentation state. |
| `src/ui/timeline/timelineMeasure.ts` | Converts timeline items into stable semantic rows, caches measurements, and builds viewport snapshots. |
| `src/ui/timeline/timelineViewport.ts` | Pure viewport anchoring, scrolling, reflow, and row selection. |
| `src/ui/timeline/useTimelineViewport.ts` | Viewport state and effects, preserving finalize transition ordering. |

### `src/ui/timeline/measure/`

| File | Purpose |
| --- | --- |
| `src/ui/timeline/measure/caches.ts` | Timeline row cache ownership and reset entry point. |
| `src/ui/timeline/measure/cards.ts` | Timeline bordered cards, user input, and impact summaries. |
| `src/ui/timeline/measure/eventRows.ts` | Standalone, introductory, and action-required event rows. |
| `src/ui/timeline/measure/markdownRows.ts` | Markdown and code-block row measurement. |
| `src/ui/timeline/measure/nativeTranscript.ts` | Native scrollback transcript parts and turn build instrumentation. |
| `src/ui/timeline/measure/rows.ts` | Styled row wrapping, width, padding, and snapshot assembly. |
| `src/ui/timeline/measure/startupBrandingRows.ts` | Compact startup branding renderers for the `minimal` and `simple` logo styles, built around the `</>` mark. Theme-neutral, width-clamped rows. |
| `src/ui/timeline/measure/stableSnapshot.ts` | Stable and live snapshot construction with frozen row groups. |
| `src/ui/timeline/measure/streamRows.ts` | Stream event rendering, coalescing, live indicators, and turn rows. |
| `src/ui/timeline/measure/types.ts` | Timeline measurement and render-item types without a component dependency. |
