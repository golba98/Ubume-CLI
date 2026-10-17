# Ubume 0.1.18 local release verification

Prepared on 2026-10-17 from `4ccf8b73b6e89927cc9922f04c0bd97e4ccc0dd5`.

- `bun run test`: 2,303 passed, 0 failed across 209 files (164.71 seconds).
- `bun run build`: generated build metadata, TypeScript and Biome passed.
- `bun run format`: passed without formatting changes.
- `bun run audit:ubume-gap`: 17/17 passed.
- Manifest, both npm lockfiles and generated app version report 0.1.18.
- `node bin/ubume.js --version`: 0.1.18.
- `npm pack --dry-run --json`: 276 files, 676,462 packed bytes. CLI entry
  point, build metadata, domain hooks, native runtime configuration and consumer
  shrinkwrap are present; tests, fixtures and `.env` files are excluded.
- `git diff --check`: passed.

The dependency graph is unchanged. npm lockfiles were synchronized using the
repository script. Generated metadata identifies the source commit above and
the prepared app version.

Logs: `/tmp/ubume-0.1.18-tests.log`, `/tmp/ubume-0.1.18-audit.log` and
`/tmp/ubume-0.1.18-pack.json`.

This preparation did not publish to npm or create a release tag. Native
checkpoint inference and live paid provider requests were not performed;
Codexa Native requires separately configured local model assets.
