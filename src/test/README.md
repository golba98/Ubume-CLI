# Shared test infrastructure

Ubume uses Bun's test runner with colocated `*.test.ts` and `*.test.tsx` suites throughout
`src/`, plus runner-discovered tests under `scripts/`. Existing suites use both `bun:test`
and Bun's `node:test` compatibility. Keep assertions in the style of the surrounding suite.
There is no global setup/preload, custom runner, or configured coverage threshold.

`bunfig.toml` and the package test script both set concurrency to one. Several suites patch
process state or module-owned caches; do not enable concurrent execution for them.

## Module map

| Module | Responsibility |
| --- | --- |
| `async.ts` | Bounded condition polling and event-loop yielding; never installs fake global timers. |
| `environment.ts` | Pure isolated child environments and reversible in-process environment patches. |
| `fakeClock.ts` | Injected scheduler timers, time advancement, detached pending snapshots; compatibility export of `settle`. |
| `fakeExecutable.ts` | Temporary executable scripts, JSON logs and stdio JSON-line protocol source. |
| `runtimeTestUtils.ts` | Production-normalized runtime factories and the shared read-only `TEST_RUNTIME` baseline. |
| `terminal.tsx` | Owned in-memory Ink terminal, real stream flow control, frame/history capture and disposal. |
| `fixtures/browserPage.ts` | Loopback HTTP site with privacy, navigation and accessible-target edge cases. |
| `fixtures/headlessProvider.mjs` | Synthetic CLI auth/version, streamed responses, file edits and cancellation behavior. |
| `fixtures/antigravityProvider.mjs` | Synthetic AGY model, usage, credit, auth and interrupt scenarios. |
| `fixtures/localResume.ts` | Real Local Harness round trips against the parent test's loopback model server. |
| `fixtures/workbenchApp.tsx` | Real App queue, cancellation, plan, usage, draft and restart scenarios with a controllable provider. |
| `fixtures/modelRecoveryApp.tsx` | Real App provider/model recovery scenarios with child-local registry replacements. |

Helper tests live beside their helpers. Browser-site and subprocess-fixture contract tests
live under `fixtures/`. Standalone fixture programs are launched by their parent tests;
they are not self-contained commands to run against a developer workspace or home.
Existing fixture entry paths remain stable.

## Unit tests and fixtures

Test behavior through the current public boundary. Use production types and small explicit
inputs. Preserve historical regression cases even when implementations move. Prefer
specific assertions over a generic assertion wrapper.

`createTestRuntime` returns independent normalized state and accepts partial policy overrides:

```ts
import { expect, test } from "bun:test";
import { createTestRuntime } from "../test/runtimeTestUtils.js";

test("keeps writable roots local to each runtime fixture", () => {
  const first = createTestRuntime({ policy: { writableRoots: ["/fixture/project"] } });
  const second = createTestRuntime();
  first.policy.writableRoots.push("/fixture/other");
  expect(second.policy.writableRoots).toEqual([]);
});
```

Never mutate `TEST_RUNTIME`. Use the factory whenever a test or its subject may mutate a
runtime. Fixture defaults come from production normalization; they do not load user settings.

## Environment and filesystem isolation

`createTestEnvironment(root, overrides, inherited)` returns a fresh environment without
modifying `process.env` or creating directories. The parent owns the temporary root. Both
`HOME` and `USERPROFILE` are isolated because settings resolution prefers `USERPROFILE`.
Provider homes, platform configuration/cache/data roots, and Ubume/legacy app data are
redirected beneath that root. Inherited provider settings, secrets, endpoints, executable
overrides, runtime preload options and proxy credentials are removed. Execution essentials
such as `PATH` are retained; do not treat this helper as a security sandbox.

Default provider CLI paths intentionally do not exist. Pass an explicit fake executable or
loopback endpoint for the behavior under test. Overrides apply last; fixture API keys must
be synthetic. Bun's runtime transpiler cache is disabled for child fixtures so read-only
filesystem assertions measure the application rather than compiler-generated files.

For in-process configuration tests, use `withEnvironment(patch, callback)` and await it.
It restores exact previous values on success, thrown errors and rejected promises, including
the difference between an absent key and an empty value. Patch both home variables when
exercising home-dependent code. The helper restores only patched keys: callers still own
cache resets, current-directory changes and other globals. Overlapping patches must be serial.

Use `mkdtempSync` rather than shared paths. Put allocation under a cleanup boundary and
remove the directory in `finally` after child processes, streams, stores and servers stop.
Do not use real credentials, session history, user configuration or installed provider CLIs.

## Integration tests and provider doubles

Keep real application parsing, routing, persistence and lifecycle boundaries active; replace
external execution or network dependencies. The existing process-backed parent suites show
how to build environments without exposing a real account:

```ts
const root = mkdtempSync(join(tmpdir(), "ubume-example-"));
try {
  const result = spawnSync(process.execPath, [fixturePath, "recover"], {
    cwd: root,
    env: createTestEnvironment(root),
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.status, `${result.stderr}\n${result.error ?? ""}`).toBe(0);
} finally {
  rmSync(root, { recursive: true, force: true });
}
```

This is a parent-test pattern: import the Node filesystem/process APIs, Bun assertions and
`createTestEnvironment`, and resolve `fixturePath` from `import.meta.url`. Preserve one root
across restart steps within a scenario; allocate a new root for unrelated scenarios.

For arbitrary CLI protocols, `createFakeExecutable` embeds synthetic scenario JSON and
provides `path`, `dir`, `readLog()` and idempotent `cleanup()`. `FAKE_STDIO_READER` decodes
fragmented UTF-8 input, retains partial lines and rejects malformed JSON instead of hiding it. The caller must await
child termination before removing the executable directory. It does not isolate the parent
process's environment or terminate children automatically.

Provider doubles should reject unexpected operations and retain meaningful failures. Local
model integrations bind ephemeral loopback ports. Do not replace a persistence assertion
with a mocked save, or a cancellation assertion with an immediately completed run. The App
recovery fixture deliberately mutates the runtime registry only inside its own child process.

## Synchronization and teardown

Use `waitFor(predicate, { label, diagnostics })` for observable state. Its monotonic deadline
bounds a failing test; predicate exceptions propagate immediately. Include the current frame,
recorded calls or saved state in timeout diagnostics. Polling is not an assertion retry loop.

`settle(rounds)` yields a bounded number of real event-loop turns. It does not prove that an
arbitrary asynchronous operation finished. Prefer the operation's promise or an explicit
state predicate. Fake-clock advancement runs due injected callbacks in deadline order and
allows promise work between callbacks; it does not advance global timers or control Ink.
Avoid negative/nonfinite clock inputs and endlessly self-scheduling callbacks.

`createTestTerminal` uses real `PassThrough` flow control and whole-frame Ink debug output.
Use `lastFrame()` for the current screen and `output()` for historical output. Await
`dispose()` in `finally`; it unmounts, awaits exit, removes Ink's instance and releases owned
streams. It does not shut down a provider or release a conversation store. Specialized
raw-mode tests keep their instrumented streams so the helper cannot mask flow-control bugs.

Retain documented timing only when timing is the behavior: lone Escape decoding, delayed
provider cancellation/error callbacks, and checkpoint-preparation interruption. The latter
still uses an intentional small interruption window and a large checkpoint fixture; it is
not a proof of deterministic scheduling. Do not increase sleeps to conceal failures. The
workbench `save` scenario deliberately exits before normal cleanup to verify crash-style
restoration; its parent owns removal of the entire fixture root.

Browser sites require `await site.close()` in `finally`. This drains active connections and
shares one shutdown promise across cleanup calls. Browser managers and Local Harness owners
must be shut down independently before deleting their temporary state.

## Commands and validation

Run from the repository root using the existing installed dependencies:

```sh
# Helper and fixture-contract tests
bun test --max-concurrency=1 src/test
# A focused consumer; select a test by its description when investigating
bun test src/core/version/updateScheduler.test.ts
bun test src/session/workbenchApp.test.ts -t "process restart"
# All runner-discovered unit and integration tests
bun run test
# Static checks and build
bun run typecheck
bun run lint
bun run check
bun run build
# Format only the files being changed; the package format command rewrites all src/
bunx biome format --write src/test
# Optional focused coverage; no repository threshold is configured
bun test --max-concurrency=1 --coverage --coverage-reporter=text src/test
# Reproducible helper-order investigation; avoid concurrent global-state suites
bun test --max-concurrency=1 --randomize --seed=42 src/test
```

`build` regenerates tracked `src/config/buildInfo.ts` before type and Biome checks. Preserve
unrelated generated metadata when reviewing a test-only diff. There is no separate package
integration-test command; integrations are part of the full Bun suite. Do not use the live
terminal benchmark as a credential-free test substitute.

Real browser integrations require an available Chromium binary and Node. Use an explicit
`UBUME_BROWSER_EXECUTABLE_PATH` to reuse an installed binary with isolated temporary browser
profiles. Set `UBUME_REQUIRE_BROWSER_TESTS=1` to fail rather than skip missing prerequisites.
Do not load a personal browser profile or install software automatically as part of tests.

For full-suite verification on a developer machine, launch Bun under a disposable outer home
and app-data root, remove inherited provider credentials/settings, and limit executable search
to the runtime tools. Keep outer provider executable overrides unset: discovery unit tests
inject command runners and intentionally inspect default command resolution. Child-fixture
environments use the stricter missing-executable defaults described above.

## Investigating failures

1. Reproduce the exact file and test description with the same configuration and seed.
2. Compare baseline failures, runtime prerequisites and concurrent repository edits before
   attributing a failure to the refactor.
3. Inspect timeout frames, child exit errors, captured protocol logs and resource ownership.
4. Check both home variables, provider homes, environment restoration and module cache resets.
5. Repeat the focused case and vary helper order; do not introduce retries or weaker assertions.
6. For a new regression, deliberately break the relevant behavior in a disposable copy and
   verify the test fails. Keep mutation artifacts outside the repository.

See the [implementation audit](../../docs/TEST_INFRASTRUCTURE_AUDIT.md) for this pass's exact
file inventory, baseline defects, assertion review, validation results and remaining limits.
