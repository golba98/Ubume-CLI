# scripts/

Standalone development, build, release, diagnostic, test and benchmark utilities for Ubume.
Nothing here is published. The full reference (every script, its safety class, arguments and
exit behavior, and how to add one) is the [scripts guide](../docs/development/scripts.md).

| Directory | Responsibility |
|---|---|
| `development/` | `ubume-dev` / `ubd` launcher and shim installer |
| `build/` | Build metadata (`src/config/buildInfo.ts`) |
| `release/` | npm lockfile sync and installed-package verification |
| `providers/` | Provider diagnostics, setup and live smokes (some contact real providers) |
| `testing/` | Opt-in PTY, end-to-end and browser checks, plus their fixtures |
| `maintenance/` | Capability audit and documentation recordings |
| `bench/` | Offline benchmarks and the shared Python PTY harness |
| `lib/` | Helpers shared by the Node scripts |

`run-local-dev.mjs` and `pty-terminal-check.py` at this level are compatibility entry points;
`check-resize-pty.py` and `check-permission-pty.py` move to `testing/` in the next bench pass.
