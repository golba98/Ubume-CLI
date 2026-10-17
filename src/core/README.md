# Core subsystem

Core code owns provider integration, processes, filesystem state, and terminal boundaries. It must not import UI components. The production file catalog is in [SOURCE_GUIDE](../../docs/SOURCE_GUIDE.md).

| Folder | Responsibility |
| --- | --- |
| `providers/` | Codex subprocess I/O, JSON stream/transcript parsing, backend registry, and shared run contracts. |
| `providerRuntime/` | Provider runtimes, routing/execution registry, discovery, models/reasoning, capability/context metadata, and local backend detection. |
| `providerRuntime/localHarness/` | Persistent local agent harness; config/environment/fingerprints, profiles, explicit notification handlers, pure tool policy, messages, and process lifecycle. Preserve child and active-run ownership checks. |
| `providerLauncher/` | Workspace provider config, provider-picker records, and external CLI launch/resume boundaries. |
| `codex/` | Codex launch/prompt assembly, capability detection, and authentication probes. |
| `models/` | Shared model catalog, connection identities, session selection evidence, reasoning reconciliation, Codex capabilities, and cache/seed persistence. |
| `executables/` | Shared cached executable resolvers and the distinct Codex resolver. |
| `process/` | `commandRunner.ts`, subprocess control, and executable path validation. |
| `terminal/` | Sanitization, raw input, title/control sequences, capability detection, and atomic clear/resize/overlay frame ownership. `clearFrameBoundary.ts` is intentionally protected from simplification. |
| `workspace/` | Roots/guards, project instructions, attachments, app-data paths, plan storage, conversations, ownership, checkpoints, and file recovery. |
| `externalSessions/` | Native session listing/readers, shared store I/O, transcript imports, and native resume launch plans. |
| `usage/` | Provider usage adapters for `/usage`: normalised snapshot contract, route-to-adapter registry, cooldown/in-flight/stale service, and passive Local/API observations. Adapters read usage only through each CLI's supported structured interface. |
| `version/` | Build channels, package version branding, and update checking/cache compatibility. |
| `shared/` | Values/record/error guards, text wrapping and width, line normalization, clipboard/image handling, and GitHub diagnostics. |
| `perf/` | Shared debug log factory, input/model/local stream tracing, render diagnostics, and profiling. |
| `computerUse/` | Browser capabilities, approval scope, worker transport, and browser session lifecycle. |

## Dependencies and provider boundaries

`providerLauncher/` selects workspace routes and launches external CLIs. `providerRuntime/` discovers and executes a provider route. `providers/` owns the low-level Codex subprocess and stream parsing. These layers have different responsibilities. Both the interactive app and headless commands consume them; provider adapters emit normalized callbacks rather than updating application state.

Core depends on configuration, shared session contracts/history formatting, packaged `bin/` bridges, and platform libraries. It does not import app orchestration or Ink UI components. `perf/renderDebug.ts` exposes React instrumentation hooks, but does not own presentation. Keep `shared/values.ts` import-free and `version/channel.ts` independent of settings to avoid initialization cycles.

Home and CODEX_HOME resolution come from `config/settings.ts`; platform app-data paths come from `workspace/appData.ts`. Preserve user-visible Codexa environment aliases and legacy data/config migrations.

## Debug instrumentation

- `perf/debugLog.ts` shares a writer while retaining each caller's flags, filenames, redaction, and failure handling. Input tracing uses `UBUME_DEBUG_INPUT=1`; local stream tracing uses `UBUME_DEBUG_LOCAL_STREAM=1` and the separate content opt-in.
- `perf/renderDebug.ts` owns render/flicker tracing (`UBUME_RENDER_DEBUG=1`).
- `perf/profiler.ts` records performance sessions.
- `scripts/claudeCodeDiscoveryDebug.ts` is the standalone `bun run debug:claude-models` entry point.

## Initialization, execution and shutdown

There is no single core service container or global initialize/dispose API. Ownership is distributed across the existing entry points and callers:

1. `src/index.tsx` owns interactive TTY checks, terminal modes, the stdout frame wrapper and entry-point cleanup. `src/app/` composes configuration, workspace, provider/model selection and run state. `src/cli.ts` dispatches to `src/headless/`, which reuses core services without rendering Ink.
2. Provider registry construction supplies saved Local/native configuration to their process-local runtimes. Synchronous discovery reads current/configured/cached views; explicit refreshes perform CLI or HTTP work. Merely finding a model in a seed does not verify its availability.
3. A backend `run` returns cancellation and can publish `ProviderRunControl` through `onRunControl`. `onFinalAnswerObserved` and `onResponse` describe response progress, while `stopped` describes registered work/cleanup. Await the latter before releasing execution ownership or beginning conflicting work. The app/headless layer owns callback generation checks and serializes requests.
4. Local execution resolves the connection/capabilities before delegating to `localHarness/`. Its shared owner reuses a compatible child and resumes saved state only when Harness version, route fingerprint, transcript hash and message count agree. A fresh session can replay visible dialogue, but cannot restore ephemeral tool/browser state. Successful completion requires a durable session flush.
5. Cancellation/failure invalidates the affected Local session and drains its cleanup. Explicit `closeLocalHarnessSession` closes a conversation's ephemeral state; `shutdownLocalHarness` stops the shared child and browser work. Native PyTorch unloading is a separate `unloadCodexaNative` operation. These operations are wired by app lifecycle/run owners, not a universal core shutdown hook.
6. The browser backend runs Playwright in a Node worker because the Bun transport is unsuitable for that integration. Browser calls are session/call scoped, approvals bind to target identity, and worker generations own descendant/temp cleanup. Browser state is not persisted with conversations.

External CLI hand-off is a separate path: `providerLauncher/launcher.ts` suspends raw mode around inherited-stdio launches, then restores it in `finally`. It does not become the in-app streaming runtime.

## State, persistence and recovery

- **Model discovery:** `models/modelCatalog.ts` coalesces pending refreshes for a connection, applies freshness/backoff and uses entry/generation identity to prevent late results publishing over a replacement. Connection changes invalidate the previous inventory. Failed refreshes retain prior data as unverified. `providerConnectionKey` and `resolveLocalBackend` are shared identity/precedence rules; do not rebuild them independently in callers.
- **Model selection:** session-owned `SelectionCoordinator` keeps provisional/validated/unavailable evidence, navigation ownership, revision checks and retry delays. It does not persist a blacklist or substitute another model. Only verified, complete inventory absence or explicit model evidence establishes unavailability; authentication/network failures must not reject the model.
- **Provider preferences:** pure workspace setters merge values without saving. The app's update orchestration owns applying updates to the latest configuration. Saving uses a temporary JSON file and rename; this is not cross-process merge locking. Preserve legacy identities, aliases, migration blocks and native selector strings.
- **Conversation storage:** `ConversationStore` writes an authoritative versioned `snapshot.json`; `summary.json` is an optional revision-checked listing cache. Legacy files are read-only inputs. Ownership is optional at construction; enabled stores retain their acquired conversation lease until `release` or another acquisition. The execution lease is separate.
- **Workspace leases:** exclusive lock directories carry host/PID/token identity. Reclaim only a provably dead same-host owner; missing/remote owner evidence is not permission to steal a lease. Release checks the token so an old owner cannot remove a replacement lock.
- **File recovery:** `CheckpointStore` stores exact bytes/modes in content-addressed blobs. Display activity snapshots are bounded summaries and cannot restore files. Restore verifies complete coverage and later edits, journals changes, and attempts rollback after failure. Pending journals block new execution until recovery; conflicting manual edits are retained for explicit resolution.
- **Paths and scratch:** most path helpers only name locations, but writable workspace-data resolution can trigger a best-effort legacy copy. Use supported `readOnly` options for inspection. Session scratch is workspace-local, lazy and self-ignored; chat artifacts live in app data. Native session readers leave other CLIs' stores unchanged and native resume requires the recorded original directory.
- **Usage and updates:** usage caches coalesce requests per scope, throttle active adapters and retain the last good snapshot after temporary failure. Passive adapters observe existing traffic and bypass cooldown. Unknown quota is not zero or unlimited. Update scheduling owns single-flight requests and retry timers; its creator must dispose it to abort in-flight work and suppress late publication.

## Errors and diagnostics

Executable syntax validation can throw before spawning; command execution reports structured spawn, exit, timeout and cancellation outcomes. Some provider APIs return structured readiness/discovery failures rather than throwing. Preserve these distinctions and pass `ProviderFailure` evidence through routing so setup, authentication, transient and model-specific recovery remain separate.

Optional caches, legacy migration, summary caches and diagnostics deliberately tolerate I/O failures. Canonical conversation saves, lease acquisition and guarded recovery have stricter failure boundaries. Do not broaden catches or infer successful cleanup from a delivered answer. Local Harness disconnection fails the current turn; it is not automatically replayed, and the next request starts fresh as needed. Existing CLI compatibility retries remain provider-specific.

Debug output is opt-in and uses each channel's existing flags. Local content logging requires `UBUME_DEBUG_LOCAL_STREAM_CONTENT=1` in addition to its trace flag. General diagnostic helpers do not automatically redact arbitrary caller fields: avoid credentials, raw prompts, tool arguments and response bodies unless that channel explicitly supports them. Child-only Harness environments contain credentials and must not be logged verbatim.

## Terminal invariants

`terminalControl.ts` owns guarded control writes. Main chat uses normal-buffer scrollback; overlays and explicit transcript clear/resize operations coordinate with `clearFrameBoundary.ts`. The boundary uses render generations and current layout dimensions to commit authoritative frames atomically. Its complexity protects content from stale frames and competing clears; do not simplify its ordering as part of routine cleanup.

The stdout frame wrapper deduplicates output and resets its cache on resize. Stream parsers/title strippers own chunk-boundary state and must be flushed where their API provides it. `terminalSanitize.ts` strips escape sequences; it has no SGR-preserving diff mode. `TerminalModeController.resetModes` resets remembered mode state, not the physical terminal: lifecycle callers still perform restoration.

## Modifying core safely

- Trace the exported function's app/headless callers, provider contracts and colocated tests before changing it. Keep parser state per stream/run and preserve exact native identifiers.
- Retain the distinction between setup readiness, discovery freshness, request success and cleanup completion. For asynchronous changes, test cancellation, obsolete generations and resource ownership, not just the happy path.
- Keep runtime logic below the app/UI layer. Use the existing provider, process, workspace and shared helpers rather than recreating removed modules or adding another service layer.
- Add comments for decisions, limits, side effects and ownership. Do not document guarantees stronger than the implementation, or add remote probes to synchronous lookups.
- Format only touched TypeScript files using the repository's installed Biome settings. Inspect generated build metadata and exclude unrelated changes.

The [core audit report](../../docs/CORE_AUDIT.md) records reviewed files, targeted corrections and verification. The [architecture guide](../../docs/ARCHITECTURE.md), [model recovery notes](../../docs/PROVIDER_MODEL_RECOVERY.md) and [browser guide](../../docs/LOCAL_BROWSER.md) provide wider integration context.

## Validation commands

Run from the repository root with installed dependencies:

```sh
bun test --max-concurrency=1 src/core/codex/codexAuth.test.ts src/core/providerLauncher/workspaceConfig.test.ts src/core/shared/text.test.ts
bun test --max-concurrency=1 src/core
bun run test
bun run typecheck
bun run check
bun run build
bun run audit:ubume-gap
node bin/ubume.js --help
node bin/ubume.js --version
```

`bun run test` uses the package-defined single-concurrency suite and includes app/headless integration coverage. `bun run build` regenerates tracked `src/config/buildInfo.ts`, then runs type checking and Biome; inspect that diff separately. `bun run format` writes across `src/`, so prefer targeted Biome formatting during a scoped pass.

Browser integration tests use real Chromium with deterministic local fixtures and mock model endpoints. They skip when Chromium is absent unless `UBUME_REQUIRE_BROWSER_TESTS=1` requires it. `bun run smoke:terminal-bench` is a separate live-provider execution: it inherits the selected workspace/provider/authentication and can save conversation state. Run it only with an available configured provider; it is not a replacement for the deterministic suite.
