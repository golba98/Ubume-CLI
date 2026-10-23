# Getting started

## Requirements

- Node.js runs the launchers.
- Bun runs the application and the tests.
- Development uses Node.js 22 and Bun 1.3.
- Python 3 is needed only for the opt-in terminal checks and some benchmarks.
- Provider CLIs (`codex`, `claude`, `agy`, `vibe`) are needed only to use those providers.

```bash
bun install
```

## Run this checkout

| Command | What runs |
|---|---|
| `bun run start` | `src/index.tsx` once, from the repository directory. |
| `bun run dev` | The same, restarted by Bun watch mode when sources change. |
| `bun run dev:run [-- args]` | The local launcher: the same routing as the installed `ubume`, with the caller's directory as the workspace. |
| `ubume-dev [args]` / `ubd [args]` | The local launcher from any directory, after `bun run install:dev-bin`. |

`ubume-dev` never touches the published `ubume` command, and it runs this checkout's sources,
not an installed release. Examples:

```bash
cd ~/some-project && ubd                     # interactive, workspace = ~/some-project
ubd exec "print the current directory"       # headless exec
ubd doctor --json                            # headless status commands
ubd --version                                # prints "<version>-dev local"
```

See the [scripts guide](scripts.md#developmentrun-local-devmjs) for environment overrides and
the `native`/`numpy` model chats.

## Build and checks

| Command | Checks |
|---|---|
| `bun run typecheck` | `tsc --noEmit` over `src/`. |
| `bun run typecheck:utilities` | The TypeScript utilities in `scripts/`. |
| `bun run check` | Biome formatting and lint over `src/` (CI mode, no writes). |
| `bun run format` | Applies Biome formatting to `src/`. |
| `bun test` | The whole test suite, offline. |
| `bun run build` | Regenerates `src/config/buildInfo.ts`, then runs both typechecks and `check`. There is no bundling step. |

`bun run build` rewrites the tracked `src/config/buildInfo.ts` (commit and version), so review
that diff before committing unrelated work.

## Next

- [Testing](testing.md): what each test layer covers and which checks are opt-in.
- [Scripts guide](scripts.md): every script, its safety class, and how to add one.
- [Release guide](../releasing/release-guide.md): the npm release flow.
- [Architecture overview](../architecture/overview.md): how the application is built.
