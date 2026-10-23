# Testing

Ubume's tests are layered by cost and by how much of the real system they touch. Only the first
layer runs by default.

| Layer | Command | Runs by default | Touches |
|---|---|---|---|
| Unit and integration suites | `bun test` | Yes | Nothing outside temporary directories |
| Script tests | `bun test scripts` | Yes (part of `bun test`) | Temporary directories; spawns `node` and fake executables |
| Opt-in terminal checks | `bun run check:pty`, `check:resume`, `check:e2e`, `check:resize` | No | A real pseudo-terminal, fake providers |
| Offline benchmarks | `bun run bench:*` | No | Real PTYs and synthetic repositories; results under `docs/_reports/` |
| Live provider smokes | `bun run smoke:terminal-bench` and others in `scripts/providers/` | No; only on purpose | **Real providers and quota** |

## `bun test`

- **Discovery.** Bun finds colocated `*.test.ts` and `*.test.tsx` files under `src/` and
  `scripts/`.
- **Isolation.** Every suite runs offline: `src/test/offlinePreload.ts` isolates home
  directories and credentials and blocks external fetches. Provider behavior is tested with fake
  executables (`src/test/fakeExecutable.ts`) that speak each CLI's real protocol.
- **Concurrency.** Tests run one file at a time (`--max-concurrency=1`), because several suites
  patch process state.
- **Helpers.** [`src/test/README.md`](../../src/test/README.md) describes the shared test
  helpers and fixtures.

Run one file or directory:

```bash
bun test src/ui/layout.test.ts
bun test scripts/development
```

The script tests guard contracts that tooling and people depend on:

- `development/run-local-dev.test.ts`: entry routing; `ubume-dev` matches the installed
  launcher for every command; the shim contents.
- `development/install-dev-shims.test.ts`: the bin directory; the published command is left
  alone; both the old and new launcher paths answer `--version`.
- `lib/*.test.ts`: repository-root resolution, exit-code and signal forwarding, spawn failures.
- `maintenance/audit-capabilities.test.ts`: the capability audit still finds every
  implementation.
- `providers/configure-codexa-native.test.ts`: the native-model registry is generated without
  overwriting a different one.

## Opt-in terminal checks

These start the real app in a pseudo-terminal with a temporary home, a provider-free `PATH` and
fake provider executables. They print PASS/FAIL lines and exit non-zero on any failure. Run them
when you change terminal rendering, input, resize, resume or provider wiring.

```bash
bun run check:e2e        # full offline workflow: pickers, streaming, resume, provider switch, cancel
bun run check:pty        # Unicode/paste input, resize, overlays, Ctrl+C, terminal restoration
bun run check:resume     # /resume and relocation
bun run check:resize     # resize matrix and color-depth replay
python3 scripts/testing/smoke-workbench.py /tmp/workbench.cast   # records a cast and checks it
```

`scripts/testing/check-kitty-responsive.py` needs a real Kitty window and an X11 display; see
the [scripts guide](scripts.md#testing-checks).

## Benchmarks

The offline benchmark suites, their isolation guarantees and how to compare runs are described
in the [scripts guide](scripts.md#offline-benchmarks-scriptsbench).

## Live provider checks

`bun run smoke:terminal-bench`, `scripts/providers/smoke-codexa-native.ts`, and any run of the
app with a configured provider use real accounts. They are never part of `bun test`. Run them
deliberately, from a disposable workspace, and report their results separately from mocked
tests.
