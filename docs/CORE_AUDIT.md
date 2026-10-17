# Core quality audit — 2026-10-17

## Assessment and baseline

The existing subsystem has clear domain ownership, strict TypeScript/unused-code checks, and substantial parser, provider, persistence, terminal and application integration coverage. The recent refactor is a sound baseline. This pass found two reproducible correctness defects, one localized readability issue, and broad gaps in API/lifecycle documentation; it did not justify reorganizing modules or replacing readable implementations.

Scope: all **107 production TypeScript files**, **101 core test files** and the core README. Import/export surfaces, dependencies, implementation responsibilities, error/resource boundaries and test scenarios were inspected across all 15 top-level core domains, including nested Local Harness modules. Significant app/headless/config callers and existing architecture/source/recovery guides were also inspected for integration context. The inventory below distinguishes implementation corrections, documentation-only changes and unchanged files.

Inspection began on `main` at `7063419`. Relevant history:

- `a87d879`: grouped core into domain directories and removed superseded code; established the three provider layers.
- `125653d`: consolidated shared helpers and module ownership; removed obsolete helper modules.
- `21e6471`: extracted Harness policy, configuration, notifications, messages and profiles from its process owner.
- `590e801`: unified connection keys/Local backend precedence and applied workspace updates to current saved configuration.

The initial working tree already contained 38 app edits and generated build metadata. During implementation, separate config/headless edits appeared and changed repository-wide validation. They were preserved; they are not part of this audit's diff. No credentials, user configuration, dependencies, provider/model contracts, directories or filenames were changed by this task. No commit or push was made.

## Code corrections

| File / function | Finding and change | Evidence |
| --- | --- | --- |
| `codex/codexAuth.ts` — `inferAuthStateFromJson` | `unauthenticated` contains `auth`; the positive substring check ran first and admitted a signed-out JSON status as authenticated. Check explicit signed-out evidence first. Successful-exit compatibility and unknown-state recovery remain unchanged. | New regression failed before correction (12 passed / 1 failed), then passed; covers mixed case, signed-out status, authenticated status and run gating. |
| `shared/text.ts` — `wrapCommandText` | A wide grapheme that could not fit after the two-column continuation indent left the token unchanged, causing an infinite loop. Emit that grapheme without indentation, preserving any preceding text and ensuring progress. | The original `wrapCommandText("界界", 3)` timed out in a bounded subprocess (exit 124). The regression uses an isolated subprocess so a future synchronous hang cannot block the test runner; checks CJK, joined emoji, preceding ASCII, no text loss and width limits. |
| `providerLauncher/workspaceConfig.ts` — `setProviderDefaultReasoning` | Repeated the same current-model check and nested lookups/non-null assertions. Narrow provider/model once and merge one conditional model override. | Existing configuration round trips pass; two additional cases protect reasoning before model selection, existing capabilities, other models and input immutability. |

No tests were deleted, assertions weakened or errors suppressed. The three modified production implementations are the only files with different transpiled runtime code. Runtime export names are unchanged across all 107 production files; source diffs preserve TypeScript signatures and shared interfaces.

## Documentation improvements

- Added responsibility/ownership headers to significant modules and concise TSDoc to exported functions, with detailed contracts for catalog/selection, process, browser/Harness, persistence and recovery methods. All 483 exported function declarations now have adjacent documentation; existing accurate TSDoc was retained.
- Explained cancellation versus response delivery, single-flight request ownership, stale generations, cache provenance, model rejection evidence, native resume compatibility, durable Harness flush and child/worker teardown.
- Documented configuration/path side effects, atomic-write limits, lease ownership, restore conflicts, read-only native stores and deliberate best-effort failure boundaries.
- Clarified callback contracts, including native CLI references versus Local Harness metadata. Added parameter/return/error details at the app-server and ownership boundaries.
- Removed the stale `sanitizeDiffOutput`/SGR-preserving-mode description: that API no longer exists. Corrected `isRecord` documentation (it accepts non-null/non-array objects, not only plain objects) and stale source-guide descriptions of CLI flag probing, launch preparation, shared helpers and Harness runtime ownership.
- Expanded [core README](../src/core/README.md) with dependencies, initialization/run/shutdown ownership, state/persistence/recovery, diagnostics, terminal invariants, safe changes and actual validation commands. There is no invented global service lifecycle.
- Updated [Source Guide](SOURCE_GUIDE.md) to cover every current production core file, adding 13 missing entries and repairing the misplaced runtime-registry table row.

## Validation

Baseline checks ran in the original shared workspace before task edits:

| Command | Baseline result |
| --- | --- |
| `bun run test` | **2,303 passed, 0 failed**, 209 files; 167.05 s. |
| `bun run typecheck` | Passed. |
| `bun run check` | Passed; 471 files, no fixes. |
| `bun run audit:ubume-gap` | **17/17 passed**. |
| `node bin/ubume.js --help` / `--version` | Passed; version 0.1.18. |
| `git diff --check` | Passed. |
| `bun run build` | Deferred during Plan Mode because it writes tracked build metadata. |

Focused checks in the shared workspace after corrections:

- `bun test src/core/codex/codexAuth.test.ts src/core/providerLauncher/workspaceConfig.test.ts`: **47 passed, 0 failed**.
- `bun test src/core/shared/text.test.ts`: **11 passed, 0 failed**.
- `bunx biome format --write <changed core TypeScript files>`: targeted formatting only; no unrelated files formatted.
- `bunx biome ci src/core`: passed across all **208** core TypeScript files.

### Final validation results

| Command | Final result |
| --- | --- |
| `bun run test` — isolated baseline plus audit | **2,307 passed, 0 failed**, 209 files; 167.50 s. Four new regression tests account for the baseline increase. |
| `bun run test` — shared workspace | **2,365 passed, 0 failed**, 211 files; 167.60 s. Includes concurrently added tests outside this task. |
| `bun run build` — isolated | Passed, including `bun run typecheck` and `bun run check` (471 files). |
| `bun run audit:ubume-gap` — isolated | **17/17 passed**. |
| `bun run typecheck` — shared, final attempt | Failed: concurrent headless edits import `CommandEnv` from `commands.js`, which no longer exports it (`execCommand.ts`, `inspectCommands.ts`). No core diagnostics. |
| `bun run check` — shared, final attempt | Failed: four formatting/import-order diagnostics in concurrent `headless/context.ts`, `execCommand.ts`, `execRunner.ts`, `savedExec.ts`; 482 files checked. No core diagnostics. |
| `bun run build` — shared | Failed on unrelated in-progress headless/config checks; isolated build succeeds. Generated metadata from this invocation was restored conditionally. |
| `node bin/ubume.js --help` / `--version` — shared | Passed in the final smoke attempt; version 0.1.18. Earlier attempts during concurrent headless edits temporarily failed with missing exports. |
| `bun run smoke:terminal-bench` — isolated | Exit 1 after completing the requested listing: existing Codex user-config compatibility issue, detailed below. |
| `git diff --check` | Passed for the audit changes. |

The original baseline had no failing test/type/lint checks. Shared-workspace static-check failures appeared during concurrent work outside `src/core`; the isolated checkout verifies that this audit preserves the original passing gates.

### Isolation and environment notes

A temporary detached checkout of original commit `7063419` received this task's core changes and developer documentation, using the existing installed dependencies without installation. This separates core regression evidence from the concurrent config/headless edits. Its build regenerates metadata only inside that checkout. The shared build's generated metadata change was restored only when its bytes matched that invocation's expected generator output, preserving the previously observed content.

The live `bun run smoke:terminal-bench` in the isolated checkout reached the authenticated Codex provider and successfully printed its directory and file listing. It then exited **1** when Codex reported an unrecognized `codexa` setting in the existing user config; startup also reported an ignored `service_tier` setting. These settings were left unchanged. This is an environment/configuration limitation, not a passing smoke. The smoke saved its normal conversation state in app data; it did not edit project source.

## Architectural integrity

Preserved the `providerLauncher` → native hand-off/configuration, `providerRuntime` → route/discovery/execution, and `providers` → low-level Codex I/O boundaries. Shared connection-key and Local-backend rules remain in place. Harness policy/notification/profile modules remain extracted, with the process owner retaining active-run and child-generation checks. Model selection evidence remains session-owned and distinct from provider readiness/persisted preferences.

There were no public signature, dependency, provider/model contract, retry policy, persistence schema or terminal-ordering changes. Terminal clear/resize/overlay implementation, provider streaming adapters and session/resource lifecycle implementations remain unchanged. The two explicit bug corrections change only misclassified signed-out JSON evidence and previously nonterminating narrow text wrapping; the configuration cleanup preserves behavior.

## Remaining recommendations

- **Development-only CuPy worker lifecycle:** `codexaCupyStopBridge` uses the current global bridge, and old child `error`/`close` handlers call it without a generation identity. Cancellation also requests termination without awaiting child close. A cancel/immediate-restart sequence deserves dedicated worker fixtures and serialized teardown/generation checks. It was left unchanged because this would extend the legacy worker's lifecycle behavior beyond this stabilization pass; it is not evidence that the PyTorch or Local Harness owners need to be redesigned.
- Re-run shared-workspace release gates after the concurrent config/headless work settles, and repeat the live smoke after the provider/user-config compatibility issue is resolved. No provider installation, login or user-setting changes were attempted here.
- No general module splitting, dependency additions or speculative performance optimization is recommended from file size alone.

## Reviewed production files

Paths below are relative to `src/core/`. **Correction** includes documentation, **Docs** means comments only, and **Unchanged** means the existing implementation/documentation was retained. The complete domain map is in the core README and Source Guide.

| File | Disposition |
| --- | --- |
| `codex/codexAppServerClient.ts` | Docs |
| `codex/codexAuth.ts` | Correction |
| `codex/codexCapabilities.ts` | Docs |
| `codex/codexExecArgs.ts` | Docs |
| `codex/codexLaunch.ts` | Docs |
| `codex/codexPrompt.ts` | Docs |
| `computerUse/browser.ts` | Docs |
| `computerUse/capability.ts` | Docs |
| `computerUse/types.ts` | Docs |
| `executables/antigravityExecutable.ts` | Unchanged |
| `executables/codexExecutable.ts` | Docs |
| `executables/executableResolver.ts` | Docs |
| `externalSessions/antigravitySessions.ts` | Docs |
| `externalSessions/claudeSessions.ts` | Docs |
| `externalSessions/codexSessions.ts` | Docs |
| `externalSessions/index.ts` | Docs |
| `externalSessions/storeIo.ts` | Docs |
| `externalSessions/types.ts` | Docs |
| `externalSessions/vibeSessions.ts` | Docs |
| `models/codexModelCapabilities.ts` | Docs |
| `models/modelCache.ts` | Docs |
| `models/modelCatalog.ts` | Docs |
| `models/modelSelection.ts` | Unchanged |
| `models/reasoningControl.ts` | Docs |
| `models/selectionCoordinator.ts` | Docs |
| `perf/debugLog.ts` | Docs |
| `perf/profiler.ts` | Docs |
| `perf/renderDebug.ts` | Docs |
| `process/commandRunner.ts` | Docs |
| `process/processValidation.ts` | Docs |
| `providerLauncher/launcher.ts` | Docs |
| `providerLauncher/localBackend.ts` | Unchanged |
| `providerLauncher/providerIdentity.ts` | Unchanged |
| `providerLauncher/registry.ts` | Docs |
| `providerLauncher/types.ts` | Docs |
| `providerLauncher/workspaceConfig.ts` | Correction |
| `providerRuntime/anthropic.ts` | Docs |
| `providerRuntime/anthropicDiscovery.ts` | Docs |
| `providerRuntime/antigravity.ts` | Docs |
| `providerRuntime/capabilityProfile.ts` | Docs |
| `providerRuntime/claudeCodeDiscovery.ts` | Docs |
| `providerRuntime/codexaNative.ts` | Docs |
| `providerRuntime/codexaNativeConfig.ts` | Docs |
| `providerRuntime/contextMetadata.ts` | Docs |
| `providerRuntime/deployment.ts` | Docs |
| `providerRuntime/failures.ts` | Docs |
| `providerRuntime/local.ts` | Docs |
| `providerRuntime/localBackends.ts` | Docs |
| `providerRuntime/localHarness/bridgePolicy.ts` | Docs |
| `providerRuntime/localHarness/config.ts` | Docs |
| `providerRuntime/localHarness/messages.ts` | Docs |
| `providerRuntime/localHarness/notifications.ts` | Docs |
| `providerRuntime/localHarness/profile.ts` | Docs |
| `providerRuntime/localHarness/runtime.ts` | Docs |
| `providerRuntime/mistralDiscovery.ts` | Docs |
| `providerRuntime/mistralVibe.ts` | Docs |
| `providerRuntime/models.ts` | Docs |
| `providerRuntime/registry.ts` | Docs |
| `providerRuntime/types.ts` | Docs |
| `providerRuntime/vibeEffectiveModels.ts` | Docs |
| `providers/codexJsonStream.ts` | Docs |
| `providers/codexSubprocess.ts` | Docs |
| `providers/codexTranscript.ts` | Docs |
| `providers/registry.ts` | Docs |
| `providers/runControl.ts` | Docs |
| `providers/types.ts` | Docs |
| `shared/clipboard.ts` | Docs |
| `shared/githubDiagnostics.ts` | Docs |
| `shared/text.ts` | Correction |
| `shared/values.ts` | Docs |
| `terminal/clearFrameBoundary.ts` | Docs |
| `terminal/externalEditor.ts` | Docs |
| `terminal/frameLock.ts` | Docs |
| `terminal/inkRenderReset.ts` | Docs |
| `terminal/terminalCapabilities.ts` | Docs |
| `terminal/terminalControl.ts` | Docs |
| `terminal/terminalSanitize.ts` | Docs |
| `terminal/terminalTitle.ts` | Docs |
| `usage/anthropicApiUsage.ts` | Unchanged |
| `usage/antigravityUsage.ts` | Docs |
| `usage/claudeCodeUsage.ts` | Docs |
| `usage/codexUsage.ts` | Docs |
| `usage/localUsage.ts` | Docs |
| `usage/localUsageTracker.ts` | Docs |
| `usage/mistralVibeUsage.ts` | Unchanged |
| `usage/normalize.ts` | Docs |
| `usage/observedRateLimits.ts` | Docs |
| `usage/registry.ts` | Unchanged |
| `usage/types.ts` | Docs |
| `usage/usageService.ts` | Docs |
| `version/channel.ts` | Docs |
| `version/packageManager.ts` | Docs |
| `version/updateCheck.ts` | Docs |
| `version/updateScheduler.ts` | Docs |
| `workspace/appData.ts` | Docs |
| `workspace/attachments.ts` | Docs |
| `workspace/checkpoints.ts` | Docs |
| `workspace/conversationStore.ts` | Docs |
| `workspace/launchContext.ts` | Docs |
| `workspace/ownership.ts` | Docs |
| `workspace/planStorage.ts` | Docs |
| `workspace/projectInstructions.ts` | Docs |
| `workspace/scratchDir.ts` | Docs |
| `workspace/workspaceActivity.ts` | Docs |
| `workspace/workspaceFiles.ts` | Docs |
| `workspace/workspaceGuard.ts` | Docs |
| `workspace/workspaceRoot.ts` | Docs |

## Reviewed test files

Only `codex/codexAuth.test.ts`, `providerLauncher/workspaceConfig.test.ts` and `shared/text.test.ts` changed, adding four focused regression/compatibility cases in total. All other core tests remain unchanged. Grouped paths below are relative to `src/core/`; each listed test file was inspected for its covered scenarios and included in subsystem/full-suite validation.

| Directory | Files (unchanged unless marked **updated**) |
| --- | --- |
| `codex/` | `cleanupFastFail.test.ts`, `codexAuth.test.ts` **updated**, `codexCapabilities.test.ts`, `codexExecArgs.test.ts`, `codexLaunch.test.ts`, `codexPrompt.test.ts`, `hollowResponseFormat.test.ts` |
| `computerUse/` | `browser.test.ts` |
| `executables/` | `antigravityExecutable.test.ts`, `codexExecutable.test.ts`, `executableResolver.test.ts`, `pathSanityScan.test.ts` |
| `externalSessions/` | `antigravitySessions.test.ts`, `claudeSessions.test.ts`, `codexSessions.test.ts`, `importTranscript.test.ts`, `protobufText.test.ts`, `resumeLaunch.test.ts`, `vibeSessions.test.ts` |
| `models/` | `catalogPersistence.test.ts`, `codexModelCapabilities.test.ts`, `codexModelsCacheSeed.test.ts`, `modelCatalog.test.ts`, `modelSelection.test.ts`, `providerModelCache.test.ts`, `reasoningControl.test.ts`, `selectionCoordinator.test.ts` |
| `perf/` | `localStreamDebug.test.ts`, `renderDebug.test.ts` |
| `process/` | `CommandRunner.test.ts` |
| `providerLauncher/` | `launcher.test.ts`, `localBackend.test.ts`, `registry.test.ts`, `workspaceConfig.test.ts` **updated** |
| `providerRuntime/` | `anthropic.test.ts`, `anthropicDiscovery.test.ts`, `antigravity.test.ts`, `antigravityDiscovery.test.ts`, `capabilityProfile.test.ts`, `claudeCodeDiscovery.test.ts`, `codexaNative.test.ts`, `contextMetadata.test.ts`, `deployment.test.ts`, `failures.test.ts`, `lmstudio.test.ts`, `local.test.ts`, `localCatalog.test.ts`, `localDiscovery.test.ts`, `localOutputBudget.test.ts`, `mistralDiscovery.test.ts`, `mistralVibe.test.ts`, `providerRequests.test.ts`, `reasoning.test.ts`, `registry.test.ts`, `selectionReliability.test.ts`, `vibeEffectiveModels.test.ts` |
| `providerRuntime/localHarness/` | `bridge.test.ts`, `browserIntegration.test.ts`, `integration.test.ts`, `restart.test.ts`, `runtime.test.ts` |
| `providers/` | `codexJsonStream.test.ts`, `codexSubprocess.test.ts`, `codexTranscript.test.ts`, `runControl.test.ts` |
| `shared/` | `clipboardImage.test.ts`, `githubDiagnostics.test.ts`, `text.test.ts` **updated** |
| `terminal/` | `clearFrameBoundary.test.ts`, `externalEditor.test.ts`, `frameLock.test.ts`, `inkRenderReset.test.ts`, `terminalCapabilities.test.ts`, `terminalControl.test.ts`, `terminalSanitize.test.ts`, `terminalTitle.test.ts` |
| `usage/` | `antigravityUsage.test.ts`, `claudeCodeUsage.test.ts`, `codexUsage.test.ts`, `normalize.test.ts`, `passiveAdapters.test.ts`, `registry.test.ts`, `usageService.test.ts` |
| `version/` | `appVersion.test.ts`, `channel.test.ts`, `packageManager.test.ts`, `updateCheck.test.ts`, `updateCheckCache.test.ts`, `updateScheduler.test.ts` |
| `workspace/` | `appData.test.ts`, `attachments.test.ts`, `checkpoints.test.ts`, `conversationStore.test.ts`, `launchContext.test.ts`, `planStorage.test.ts`, `projectInstructions.test.ts`, `scratchDir.test.ts`, `workspaceActivity.test.ts`, `workspaceFiles.test.ts`, `workspaceGuard.test.ts`, `workspaceRoot.test.ts` |

The existing `src/core/README.md` was reviewed and updated. Outside core, only `docs/SOURCE_GUIDE.md` and this new report belong to the task. Unrelated working-tree files are excluded from the audit inventory and were not reverted or incorporated into the isolated regression checkout.
