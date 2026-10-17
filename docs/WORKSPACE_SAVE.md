# Codexa Native workspace save

The workspace changes were saved in commit `6c14bbb` on
`feat/save-codexa-native-workspace`. The snapshot includes all 26 staged files:
the native runtime and configuration, provider registration and persistence,
conversation metadata, prompt/replay handling, settings panel, display labels,
configuration and smoke scripts, documentation, and regression tests.

PR #305 also included this integration and was merged before this save was
published. This branch incorporates that merged architecture, keeping the hooks
in their domain folders. The saved integration is already present on `main`;
this record documents the snapshot without duplicating or reverting its code.

See [CODEXA_NATIVE.md](CODEXA_NATIVE.md) for setup, behavior, and limitations.
Real checkpoint inference requires the separately configured local model files.

Verification after incorporating `main`:

- `bun run test`: 2,303 passed, 0 failed, across 209 files.
- `bun run typecheck`, `bun run format`, and `bun run check`: passed.
- `git diff --check`: passed.
