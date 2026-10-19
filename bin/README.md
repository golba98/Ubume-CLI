# Installed Launchers and Harness Modules (`bin/`)

This directory is shipped verbatim in the npm package (`files: ["bin/", ...]`)
and holds every executable entry point plus the JavaScript modules that run
inside provider processes. File names are part of the public interface — they
are referenced by `package.json` (`bin`), by `src/` imports, by packaging
smoke checks, and by colocated `.d.ts` declarations. Do not rename or move
them; refactor within the existing files instead.

## Files

| File | Role | Invoked by |
| --- | --- | --- |
| `ubume.js` | The installed CLI launcher: `--cwd` parsing, `browser install`, `--help`/`--version`, headless-vs-interactive routing, Bun child spawn, signal forwarding, exit mirroring. Deliberately one file — it is on the measured startup path (`UBUME_STARTUP_TRACE`) and every extra ESM import adds wall-clock time. | `package.json` `bin`, packaging smoke checks |
| `ubume-local-harness-bridge.js` | cordis plugin (loaded by the Local Harness host) serving the Local provider: JSON-RPC request handling, event projection, tool policy and approvals, session lifecycle, output and RAM safety limits. | `src/core/providerRuntime/localHarness/profile.ts` (plugin path), `bridge.test.ts` |
| `ubume-local-browser-tools.js` | Browser tool schemas, strict argument validation, display descriptions, and tool registration for one agent context. | The bridge, `src/core/providerRuntime/localHarness/`, `src/core/computerUse/browser.test.ts` |
| `ubume-browser-url.js` | URL admission policy: HTTP(S)-only, no embedded credentials, loopback-only without network access. | Backend, `src/core/computerUse/browser.ts` |
| `ubume-browser-backend.js` | `BrowserManager`: Chromium session lifecycle, layered network policy (proxy + route + post-action redirect check), inspection, actions, screenshots, secrets scrubbing, cancellation and cleanup. | `src/core/computerUse/browser.ts` (through `BrowserManager`), the worker |
| `ubume-browser-proxy.js` | Loopback-only HTTP/CONNECT/WebSocket proxy enforcing the network policy for every request, including redirected ones. | Backend at context creation |
| `ubume-browser-worker.js` | Private Node process hosting the backend over stdio JSON-RPC; per-call deadlines, cancellation, pid reporting, single shutdown path. | `src/core/computerUse/browser.ts` (spawn) |
| `*.d.ts` | Hand-written declarations for the plain-JS modules above (they are imported by TypeScript in `src/`). Keep them in sync with the implementation when signatures change. | `tsc` via `src/` imports |

## Dependency structure

```text
ubume.js                      (standalone; spawns Bun: src/index.tsx or src/cli.ts)

ubume-local-harness-bridge.js ─► ubume-local-browser-tools.js
        │
        └─ (JSON-RPC over stdio, tools/policy + approvals to Ubume)

ubume-browser-worker.js ─► ubume-browser-backend.js ─► ubume-browser-proxy.js
                              │                        ubume-browser-url.js
                              └─► ubume-local-browser-tools.js (validation/descriptions)
```

The bridge and the worker are separate processes: the bridge runs inside the
Local Harness host with the model loop; the worker owns Chromium so a browser
crash can never take the Harness down.

## Contracts to preserve when editing

- **Launcher routing** (`ubume.js`): `exec`, `--headless-benchmark`, `doctor`,
  `status`, `config`, `providers`, `models`, `sessions` go to `src/cli.ts`;
  everything else to `src/index.tsx`. Exit codes and stdout/stderr separation
  are contractual for the terminal commands; `--json` errors use the
  `{ schemaVersion: 1, ok: false, error: { code, message } }` shape.
- **Bridge protocol**: request methods (`session/*`, `initialize`, `shutdown`),
  notification names and the projection limits (4k error text, 2k tool results,
  16 MiB pending-stdout budget, RSS guard) are consumed by
  `src/core/providerRuntime/localHarness/`. Browser arguments travel only on
  private policy/execution RPCs, never on display events.
- **Browser security invariants**: URL admission (`ubume-browser-url.js`),
  layered network enforcement (proxy + `context.route` + post-action final-URL
  check), secret scrubbing and screenshot masking, context isolation, 30 s
  deadline ceiling, per-session serialization, and sandboxed Chromium launch
  (no `--no-sandbox` fallback). See the module headers for details.
- **Types**: update the colocated `.d.ts` in the same change as any signature
  change; `bun run typecheck` covers them through `src/` imports.

## Adding a module

Avoid it if a change fits an existing file. If a genuinely new module is
required: keep it in `bin/` (packaging includes the whole directory), add a
`.d.ts` if `src/` will import it, wire the consumer, and update this guide in
the same change. Executable entry points must keep their shebang and be listed
in `package.json` only when they are meant to be installed commands.
