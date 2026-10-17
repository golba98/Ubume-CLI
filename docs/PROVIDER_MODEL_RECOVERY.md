# Provider and model selection recovery

## Reproduction and root causes

The investigation used mocked unavailable models and deferred validation responses, without paid API calls. Two hook regressions failed before the repair: returning to Google stayed on the main screen instead of opening its recovery picker, and an older Google activation overwrote a newer OpenAI selection.

The failure involved several independent defects:

1. `isUsableSavedModel` accepted every concrete saved identifier. `handleProviderAction` also attempted restoration whenever that provider was already active. Returning to a provider therefore retried its rejected preference rather than offering another model. See [useProviderRoute.ts](../src/app/useProviderRoute.ts).
2. Failed activation cleared `pendingRouteProviderId`. After switching away from Google, returning unsuccessfully left the other provider active and removed the Google recovery target. Opening the model picker then showed the other provider. The provider picker had a `select-model` handler but no keyboard action invoking it. See [useModelSelection.ts](../src/app/useModelSelection.ts), [useOverlayRouting.ts](../src/app/useOverlayRouting.ts), and [ProviderPicker.tsx](../src/ui/panels/ProviderPicker.tsx).
3. The two activation handlers used a shared boolean rather than ordered transitions. An older success could commit over a newer selection; stale completion could also change focus or clear another operation's busy state. Persistence callbacks captured older configuration snapshots, and runtime changes were published before a failed save could be detected. See [useRuntimeSettings.ts](../src/app/useRuntimeSettings.ts).
4. Request errors triggered catalog refresh through broad regular expressions, without retaining scoped rejection evidence. Model failures shared the `not-configured` validation status with setup/authentication failures. Google readiness also depended on a nonempty model list. See [registry.ts](../src/core/providerRuntime/registry.ts) and [antigravity.ts](../src/core/providerRuntime/antigravity.ts).
5. In the actual App, Enter on `/model` completed the input to `/models` instead of submitting the exact command. Request finalization could also move focus to the composer while a picker was open. See [useComposerInput.ts](../src/ui/chrome/composer/useComposerInput.ts) and [useRunLifecycle.ts](../src/app/useRunLifecycle.ts).

A request error alone did not universally prevent the picker from opening. The isolated adapter also successfully processed a mocked replacement model after rejecting another. The reproduction establishes restoration, navigation, command submission, and ordering defects rather than a permanent Google adapter crash.

## Architecture and recovery behavior

- A session-owned [SelectionCoordinator](../src/core/models/selectionCoordinator.ts) owns candidate ordering, cancellation, navigation ownership, provisional/validated model state, connection-scoped rejection evidence, and retry delays. Provider navigation, persisted preferences, catalogs, readiness diagnostics, and request/session lifecycles remain separate.
- Both model-selection entry points use one activation path. A current candidate is validated, saved, then published. A failed candidate or save preserves the previous committed route and preferences. Candidates without generation-time proof remain provisional until a successful request.
- Selecting a provider with a known rejected preference opens that provider's picker without retrying the preference. Picker selections activate the chosen provider directly. **M** opens the highlighted provider's model controls independently of initialization. Picker titles identify the provider even when the previous route remains committed.
- Failures are classified as model unavailability/configuration, authentication, rate limiting, quota, networking, temporary service failure, setup, or unknown. The optional third `onError` argument carries structured evidence while preserving existing two-argument callbacks and raw diagnostic output. Anthropic HTTP failures retain status/code and Retry-After evidence.
- Only explicit model rejection is retained as unavailable. Authentication, quota, networking, rate limiting, and temporary failures do not invalidate the model. Provider-requested retry delays block premature resubmission while allowing another model/provider to be selected.
- Model evidence is keyed by connection and model. Selection revisions prevent an old request from invalidating a reselected model. Old validations cannot commit, report errors, clear newer busy state, or close newer navigation. Request finalization preserves overlay focus.
- Discovery retains existing transports: Codex discovery, Google `agy models`, Claude API/CLI metadata, Vibe effective configuration, and Local endpoints. The optional `complete` catalog marker distinguishes complete inventories from partial alias lists. Failed/cached discovery remains unverified; absence in a partial or unverified catalog cannot reject a model.
- Google executable/readiness validation accepts a successful empty inventory. Failed inventory verification does not establish model removal. Shared selection/persistence logic contains no Gemini model-name exceptions.
- Successful replacement selection clears the composer's stale error state without deleting the failed turn or dismissing a pending question. Initial CLI model overrides yield to explicit interactive selection.

## Regression coverage

New tests exercise:

- Both required Google acceptance sequences through the actual App, real Ink input, and shared routing boundary, ending with a successful mocked replacement-model request.
- Restart after failure and recovery from an initial CLI model override.
- Nonexistent and repeated invalid candidates, failed persistence, and preservation of independent provider preferences.
- Authentication, quota, rate limits, retry delays, network outages, and temporary service failures without permanent model rejection.
- All Google models unavailable and catalog discovery failure, with working provider navigation.
- Out-of-order successes/errors, navigation during validation, connection changes during validation, old request evidence after reselection, and picker focus when a request fails. A late model error cannot initiate a catalog refresh over a newer connection snapshot.
- Shared model-state behavior across OpenAI, Anthropic, Google, Mistral, and Local.
- Complete versus partial/unverified catalogs, explicit per-model unavailability, the provider picker's M action, and safe clearing of stale errors.

The App fixture replaces provider discovery, validation, and execution with deterministic mocks and rejects network access. Subprocess tests isolate configuration and credentials under temporary directories. The [terminal recording](PROVIDER_MODEL_RECOVERY.cast) captures the failed Google request, Google recovery picker after using another provider, and successful replacement-model request. It is an asciinema v2 recording made from the Ink test terminal with synthetic provider data.

## Validation

- Investigation baseline: 2,137 tests passed; type checking and Biome checks passed.
- The two original hook reproductions failed before implementation and pass after the repair.
- Actual-App acceptance and regression tests pass, including restart, request-time errors, unavailable catalogs, and recovery without configuration edits.
- `bun run build` passed, including generated build information, type checking, and Biome checks. The generated build-info file was restored to its pre-existing workspace contents afterward.
- Final `bun run test`: **2,191 passed, 0 failed**, across 200 files (162.98 seconds). This includes **54 added regression cases** relative to the investigation baseline.
- `bun run typecheck`, `bun run check`, `bun run format`, and `git diff --check` passed. No unresolved test or build failures remain.

Intermediate verification exposed assumptions in existing tests about runtime-gated persistence and catalogs without freshness/completeness evidence. Those fixtures now state the intended authoritative discovery explicitly. Fallback picker entries remain provisionally selectable. Intermediate fallback-selection failures were corrected by preserving provisional selection. A run overlapping a picker-label edit was discarded because cached modules and updated assertions differed. Fresh complete runs were used for final verification; only the final result above represents the completed checks.

## Compatibility and limitations

The workspace configuration format, credentials, provider identities, executable routing, existing Google migration policy, and per-provider preferences are preserved. Configuration mutation no longer depends on live readiness. Selecting a replacement through another provider's picker now activates it directly instead of requiring a second “Use in Ubume” action.

Model rejection evidence is session-only: no persistent blacklist or automatic replacement model is introduced. After restart, saved preferences are re-evaluated through authoritative discovery or request-time evidence; the controls remain accessible throughout. Plain-text CLI errors require conservative classification, so ambiguous failures remain unknown. Mocked tests verify recovery architecture, not the availability or entitlement of any real Gemini model.

Existing uncommitted work, including native-provider changes, was retained. No commit, push, deployment, or real paid provider request was performed for this repair.

## Files changed by this repair

Application:

```text
src/app/App.tsx
src/app/OverlayPanels.tsx
src/app/useAppState.ts
src/app/useModelCatalog.ts
src/app/useModelSelection.ts
src/app/useOverlayRouting.ts
src/app/usePromptRun.ts
src/app/useProviderRoute.ts
src/app/useRunLifecycle.ts
src/app/useRuntimeSettings.ts
```

Core, session, and UI:

```text
src/core/models/modelSelection.ts
src/core/models/selectionCoordinator.ts
src/core/providerLauncher/workspaceConfig.ts
src/core/providerRuntime/anthropic.ts
src/core/providerRuntime/anthropicDiscovery.ts
src/core/providerRuntime/antigravity.ts
src/core/providerRuntime/failures.ts
src/core/providerRuntime/local.ts
src/core/providerRuntime/mistralVibe.ts
src/core/providerRuntime/registry.ts
src/core/providerRuntime/types.ts
src/core/providers/types.ts
src/session/chatLifecycle.ts
src/session/sessionCatalog.ts
src/ui/chrome/composer/useComposerInput.ts
src/ui/panels/ModelPickerScreen.tsx
src/ui/panels/ProviderPicker.tsx
```

Tests and fixture:

```text
src/app/modelRecovery.test.tsx
src/app/modelRecoveryApp.test.ts
src/app/useRuntimeSettings.test.tsx
src/core/models/modelSelection.test.ts
src/core/models/selectionCoordinator.test.ts
src/core/providerLauncher/registry.test.ts
src/core/providerLauncher/workspaceConfig.test.ts
src/core/providerRuntime/failures.test.ts
src/core/providerRuntime/selectionReliability.test.ts
src/session/chatLifecycle.test.ts
src/session/resumeCoordinator.test.ts
src/test/fixtures/modelRecoveryApp.tsx
src/ui/panels/ModelPickerProviderScope.test.tsx
src/ui/panels/ProviderPicker.test.tsx
```

Documentation:

```text
docs/PROVIDER_MODEL_RECOVERY.md
docs/PROVIDER_MODEL_RECOVERY.cast
```
