# Repository files and local cleanup

Keep the root configuration files in place. They support development,
reproducible dependency installation, and release preparation.

| File | Purpose |
| --- | --- |
| `package.json` | Dependencies, CLI entry points, and development commands. |
| `bun.lock` | Dependency graph used by Bun and the npm lock synchronization script. |
| `package-lock.json` | npm dependency lock, maintained by `bun run sync:npm-lock`. |
| `npm-shrinkwrap.json` | Consumer dependency lock included in published packages. |
| `biome.json` | Formatting and lint rules used by build and check commands. |
| `bunfig.toml` | Serial test concurrency configuration. |
| `tsconfig.json` | TypeScript compiler settings. |
| `.gitignore` | Excludes dependencies, temporary output, secrets, and local state. |
| `.gitattributes` | Text and line-ending normalization. |
| `.git-blame-ignore-revs` | Allows Git blame to skip bulk formatting commits. |
| `README.md`, `SECURITY.md` | User documentation and security reporting policy. |
| `CHANGELOG.md`, `VERSIONS.md` | Release history and user-facing version notes. |

`AGENTS.md` and `CLAUDE.md` are local assistant instructions. They are ignored
by Git in this repository and can be removed if those instructions are no longer
wanted. Keep them when using the associated assistants.

The `bin/`, `src/`, `scripts/`, and `docs/` directories contain maintained project
files. Do not remove them as temporary output. The exception is `docs/_reports/`:
agent-generated reports live there, are ignored by Git, and stay on the machine that
produced them (see [`docs/REPORTING.md`](../REPORTING.md)).

## Disposable local artifacts

- Old `ubume-*.tgz` archives can be removed once they are no longer needed for
  package inspection or installation.
- Empty `tmp/` directories can be removed. Inspect nonempty directories first.
- `.ubume/scratch/` holds generated session scratch files. After runs finish,
  inspect its contents before removing anything worth retaining. Empty session
  directories and the generated scratch `.gitignore` can be removed; Ubume
  recreates scratch storage when needed. Other `.ubume/` files may contain
  intentional local configuration and should be reviewed separately.
- `node_modules/` can be regenerated with `bun install --frozen-lockfile`.
  Removing it requires reinstalling dependencies before running local commands.

The 2026-10-17 cleanup removed `ubume-0.1.10.tgz`, empty `tmp/`, and the empty
generated `.ubume/scratch/` tree. It retained dependencies, configuration,
documentation, and assistant instructions. These removed artifacts were ignored
by Git, so their deletion does not produce a tracked repository change.

Type checking and Biome checks passed after cleanup.
