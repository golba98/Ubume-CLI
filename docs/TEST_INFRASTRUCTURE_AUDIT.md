# Shared test infrastructure refactor — 2026-10-17

## Architecture and scope

Reviewed all nine original files under `src/test/`, their direct consumers, test commands,
configuration, recent history and relevant current production contracts. Bun 1.3.14 runs
colocated Bun and Node-style suites. `bunfig.toml` and the package test script retain serial
execution. No global preload, custom runner, dependencies, production implementation changes,
file moves or renamed fixture entrypoints were introduced.

The original three helpers and six fixtures remain in place. Three focused helper modules
now provide environment isolation, asynchronous synchronization and owned Ink terminals.
Eight colocated test modules cover these helpers and fixture protocols. The directory README
explains ownership and extension conventions. Consumer migration follows the selected scope:
direct consumers and verified isolation defects, rather than repository-wide test rewrites.

Relevant history reviewed included `0618f8a` (injected update scheduler clock), `16fc8fd`
(typed App hooks), `884d403` (durable local resume), `e6ad26b` (browser fixtures), `8b13cf2`
(usage providers), and `271f136` (model recovery scenarios). Historical cancellation, privacy,
provider-switching, native protocol and restart coverage was retained.

The working tree already contained substantial app/core/config/command/headless changes and
continued changing in session modules during this task. Those edits were preserved. Production
changes visible in the overall Git diff belong to those other workstreams, not this refactor.
No commit or push was made.

## Quality and reliability changes

- **Environment isolation:** `createTestEnvironment` returns independent environments with
  both home variables, provider homes and platform data/config/cache locations under the
  parent-owned root. It removes inherited credentials, provider configuration, executable
  overrides, preload hooks and proxy URLs; explicit synthetic fixture settings apply last.
  Default missing provider executables prevent installed-CLI fallback in process fixtures.
- **Restoration:** `withEnvironment` restores missing, empty and populated values after
  synchronous throws or asynchronous rejection. Overlapping process-global patches remain
  serial; production cache resets remain the caller's responsibility.
- **Verified home defect:** catalog persistence changed only `HOME`, while settings prefer
  `USERPROFILE`. It failed with inherited `USERPROFILE` and passed without it. The test now
  patches both variables and retains its exact timestamp/disk-content assertions.
- **Compiler artifacts:** isolated XDG caches exposed Bun's runtime transpiler writes in
  existing read-only command disk assertions. Setting `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`
  for child fixtures removes that unrelated filesystem effect; no disk assertions were filtered.
- **Clock ownership:** `pending()` now returns detached timer records. Previously, changing
  an inspection result changed its deadline/callback. Explicit types clarify the injected
  timer contract while keeping existing exports, ordering and advancement behavior.
- **Executable fixtures:** serialization occurs before allocating resources; failed writes
  remove the allocated directory. Malformed logs identify the physical line and retain the
  parse cause. Cleanup remains idempotent and does not claim child-process ownership.
- **Verified UTF-8 defect:** JSON-line input concatenated raw buffers, replacing a character
  split across reads with replacement characters. Setting stdin's UTF-8 encoding preserves
  decoder state. A real subprocess regression forces the split with acknowledgements.
- **Runtime fixtures:** `createTestRuntime` accepts production partial configuration types
  and returns independent normalized policy/array state. The existing read-only shared
  `TEST_RUNTIME` remains compatible with unchanged consumers.
- **Asynchronous tests:** shared monotonic-deadline polling reports caller diagnostics and
  propagates predicate exceptions immediately. `settle` retains compatibility but now documents
  bounded yielding accurately. Observable initial App frames replace fixed startup sleeps.
- **Terminal ownership:** App fixtures share in-memory streams, whole-frame/history capture
  and awaited idempotent disposal. Real stream flow control is retained. Special raw-mode
  regression doubles were not replaced. Workbench scenarios are named functions; normal
  cleanup releases the terminal/store, while the deliberate crash-style save still exits abruptly.
- **Fixture errors:** Local resume validates backend/turn values, diagnoses missing saved
  conversations and releases its store even if Harness shutdown fails. CLI fixtures reject
  missing prompt arguments without altering valid response protocols.
- **Browser lifecycle:** listener errors reject startup; repeated cleanup shares an awaited
  shutdown promise and drains connections. Loopback-only binding, ephemeral ports, routes and
  privacy-sensitive HTML remain unchanged.

No global fixture cache, broad assertion wrapper, new test retry, permissive error suppression
or automatic provider/browser installation was added.

## Assertion and coverage preservation

All original fixture and consumer assertion-call expressions remain present after normalizing
formatting. Existing test names, matcher chains, expected values, edge cases and intentional
error scenarios were reviewed in the diff. No existing test was deleted, skipped or weakened.
New argument validations and helper tests add coverage; production behavior is exercised
through the same App, provider routing, persistence and Local Harness boundaries.

Added **31 tests** across eight modules: five asynchronous synchronization cases, four
clock cases, six executable/protocol cases, four environment cases, two runtime factory
cases, two terminal cases, three browser server cases and five invalid fixture invocations.

Effectiveness checks:

- A disposable clock copy returning live pending records produced **3 pass / 1 fail**.
- A disposable environment copy retaining inherited `USERPROFILE` produced **3 pass / 1 fail**.
- The Unicode regression produced **5 pass / 1 fail** before enabling UTF-8 decoding,
  then **6 pass / 0 fail**. Child acknowledgements force separate reads; no timing sleep is used.

Focused Bun coverage was executed for the helper tests. It includes imported production
configuration modules and is not a whole-project coverage measurement. No threshold was
added and coverage percentages are not used as a substitute for regression effectiveness.

## Documentation

[Shared test README](../src/test/README.md) documents every module, fixture entrypoint and
resource owner, unit/integration patterns, production types, credential-free provider doubles,
setup/restoration, real versus injected timers, terminal cleanup, browser prerequisites,
commands, optional coverage and seeded flake investigation. TSDoc and module comments cover
reusable helpers and non-obvious lifecycle/compatibility constraints.

Existing fixture paths referenced by the App architecture and provider-recovery guides remain
valid. No Source Guide restructuring was needed: that guide intentionally omits test files.

## Validation

### Baseline

Checks ran before implementation without altering tracked state:

| Check | Result |
| --- | --- |
| Focused scheduler/update-hook/usage consumer tests | **67 passed**, 5 files; 2.52 s. |
| Full `bun run test` under isolated homes/data and runtime-only executable search | **2,372 passed, 4 skipped, 1 failed**, 214 files; 148.24 s. The catalog home-variable defect is described above. |
| `bun run typecheck` | Passed initially; transient failures appeared during concurrent session work. |
| `bun run check` | Passed initially; later concurrent session formatting/import diagnostics were recorded separately. |
| `bunx biome ci src/test` | Passed all 9 original files. |
| `bun run build` | Identified as tracked metadata generation plus type/Biome checks; deferred during Plan Mode. |

An earlier isolation probe forced nonexistent executable overrides in the outer suite and
bypassed injected CLI discovery mocks; its 34 failures also included an in-progress missing
session import and the home defect. It was discarded as a comparison baseline. The corrected
outer environment leaves those overrides unset; child fixtures use explicit missing defaults.
The four baseline skips were browser integrations whose binary was not visible from the
isolated home, not removed tests.

### Final results

| Command / scope | Final result |
| --- | --- |
| `bun run test` — isolated outer environment, full suite | **2,416 passed, 0 failed, no skips**, 220 files; 156.76 s, 707 Bun expect calls. Includes all four real browser integrations. |
| `bun test --max-concurrency=1 src/test src/session/workbenchApp.test.ts src/app/models/modelRecoveryApp.test.ts` | **51 passed**, 10 files; 33.44 s, before the additional Unicode regression. |
| `bun test --max-concurrency=1` with environment helpers and six migrated consumer suites | **53 passed**, 7 files; 69.73 s. Includes unchanged headless exact-disk assertions, catalog persistence and both Local backends. |
| `bun test --max-concurrency=1 src/core/computerUse/browser.test.ts src/core/providerRuntime/localHarness/browserIntegration.test.ts` | **7 passed**, 2 files; 15.48 s, no browser skips. |
| `bun test --max-concurrency=1 --randomize --seed=42 src/test` | **31 passed**, 8 files; 802 ms, 113 assertions. |
| `bun test --max-concurrency=1 --coverage --coverage-reporter=text src/test` | **31 passed**, 8 files; 861 ms. Shared helpers/browser site report 100% line coverage; terminal reports 91.67% function / 100% line coverage. Imported production modules are also present in the report. |
| `bun run typecheck` | Passed. Earlier concurrent session test errors were resolved by their owner before final verification. |
| `bun run lint` | Passed; 497 files. |
| `bun run check` | Passed; 497 files, no fixes. |
| `bunx biome ci src/test` | Passed; all 20 TypeScript/TSX/MJS files. |
| `bunx biome format --write <touched files>` | Applied only to owned files; final formatter verification is included in `check`. |
| `bun run build` | Passed: build-info generation, type checking and Biome CI. This invocation's generated metadata was conditionally restored afterward. |
| `node --check src/test/fixtures/antigravityProvider.mjs` and `node --check src/test/fixtures/headlessProvider.mjs` | Passed. |
| `git diff --check` and documentation link checks | Passed. |

The final suite includes all **31** tests added by this task; its size also reflects concurrent
session-suite changes. Counts are actual executions, not an assertion of identical snapshots
across workstreams. The baseline catalog failure and all browser skips are resolved in final
validation. No remaining task validation failure is known.

Validation launches used temporary outer homes/data roots, removed provider credentials and
settings, and a runtime-only `PATH`. Existing Chromium binaries were reused with temporary
profiles. `PLAYWRIGHT_BROWSERS_PATH` was explicitly set to the installed binary registry,
so capability tests using default resolution and browser tests using an explicit executable
agreed. An intermediate validation attempt had one capability assertion fail because those
paths differed; the assertion and production code were left unchanged.

Build metadata was restored only when the post-build bytes exactly matched that invocation's
expected generator output; pre-existing metadata changes were preserved. No dependency
installation or live credentialed smoke was performed.

## File inventory

### Existing files modified (all original files inspected)

| Path under `src/test/` | Change |
| --- | --- |
| `fakeClock.ts` | Typed API, detached snapshots, shared-yield compatibility export and contracts. |
| `fakeExecutable.ts` | Failure cleanup, log diagnostics, stateful UTF-8 decoding and ownership docs. |
| `runtimeTestUtils.ts` | Exported independent factory, existing baseline retained. |
| `fixtures/antigravityProvider.mjs` | Protocol ownership documentation and missing-value diagnostics. |
| `fixtures/browserPage.ts` | Startup rejection, shared awaited cleanup, module/function contracts. |
| `fixtures/headlessProvider.mjs` | Protocol ownership documentation and missing-prompt diagnostics. |
| `fixtures/localResume.ts` | Argument/load diagnostics and failure-safe store ownership. |
| `fixtures/modelRecoveryApp.tsx` | Shared terminal/polling, validated scenario, startup readiness and recording separation. |
| `fixtures/workbenchApp.tsx` | Shared terminal/polling, named scenarios, network/update isolation and owned teardown. |

### Files added

| Path under `src/test/` | Purpose |
| --- | --- |
| `README.md` | Developer testing guide. |
| `async.ts` | Event-loop yielding and condition polling. |
| `async.test.ts` | Yield/poll success, timeout, invalid limits and exception cases. |
| `environment.ts` | Isolated child environments and reversible patches. |
| `environment.test.ts` | Sanitization, overrides and exact restoration. |
| `fakeClock.test.ts` | Ordering, cancellation, snapshots and callback-created timers. |
| `fakeExecutable.test.ts` | Logging, framing/UTF-8, malformed input and failed creation cleanup. |
| `runtimeTestUtils.test.ts` | Independent state and partial policy normalization. |
| `terminal.tsx` | Shared owned Ink terminal. |
| `terminal.test.tsx` | Real input, frame/history, isolated instances and disposal. |
| `fixtures/browserPage.test.ts` | Listener errors, routes, independent ports and cleanup. |
| `fixtures/providerFixtures.test.ts` | Invalid resume/CLI invocation diagnostics. |

### Outside-directory changes

Only test consumers changed: `src/app/models/modelRecoveryApp.test.ts`,
`src/session/workbenchApp.test.ts`, `src/headless/commands.test.ts`,
`src/headless/googleRegression.test.ts`, `src/core/providerRuntime/localHarness/restart.test.ts`,
and `src/core/models/catalogPersistence.test.ts`. The first five adopt child environment
construction; the sixth fixes the verified home-precedence defect. Existing independent
changes in those files were preserved. This report is the only additional developer document.
No files were moved or removed. No original `src/test` file was left uninspected.

## Remaining limitations

- The checkpoint-preparation interruption scenario still uses a short interruption window
  and a large fixture. Eliminating that timing dependency would need an explicit observable
  preparation barrier; no production test seam was introduced in this pass.
- Environment patching and module/cache mutation require serial tests. The environment
  constructor is a configuration-isolation helper, not a network/process security sandbox.
- `settle` is bounded event-loop yielding, not arbitrary async completion. The injected clock
  expects finite nonnegative advances and callbacks that do not endlessly reschedule themselves.
- Specialized UI stream harnesses and duplicated setup outside the agreed direct-consumer
  scope remain local. Further adoption should preserve their behavior-specific instrumentation.
- Real browser prerequisites vary by machine. Preserve explicit skip/failure reporting rather
  than weakening integration assertions or loading a personal profile.
