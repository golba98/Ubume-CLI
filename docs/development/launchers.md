# Installed launchers and Harness modules

The npm package ships `bin/` and exposes only `ubume`, mapped to
`bin/ubume.js`. Node.js runs the launcher; Bun runs the selected TypeScript
entry point. Help and version output exit before Ink starts.

The launcher sends interactive work to `src/index.tsx` and terminal commands
(`exec`, `doctor`, `status`, `config`, `providers`, `models`, `sessions`, and
`--headless-benchmark`) to `src/cli.ts`. Preserve argument forwarding,
stdout/stderr separation, exit codes, and signal forwarding when editing it.

`ubume-local-harness-bridge.js` runs inside the Local Harness host. It projects
provider events and implements tool policy, approvals and session control.
The browser modules own tool schemas, URL admission, Chromium lifecycle,
network policy, and communication with the separate browser worker. Keep their
JavaScript exports and colocated TypeScript declarations consistent.

Local development uses `scripts/development/run-local-dev.mjs` and the optional
`ubume-dev` / `ubd` shims. The shim installer leaves the installed `ubume`
command alone. Native-model shortcuts continue to target the independent
Codexa model projects.

See the [migration guide](identity-migration.md) for retired application aliases
and the [scripts guide](scripts.md) for development commands.
