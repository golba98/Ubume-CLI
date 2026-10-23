# Ubume documentation

This directory holds Ubume's maintained project documentation: how the application is built,
how to work on it, how providers and the terminal UI behave, and how releases are made. For
installing and using Ubume, start with the repository [README](../README.md).

Everything here is tracked in Git and describes the current project. Agent-generated reports
(audits, benchmarks, investigations, verification runs) do **not** belong here; they go to the
local, Git-ignored [`_reports/`](#local-reports) directory.

## Layout

| Directory | Contents |
|---|---|
| [`architecture/`](architecture/) | How the application is structured and why: subsystem boundaries, data flow, invariants, and the per-file source catalog. |
| [`development/`](development/) | Working on the repository: setup, running and building, testing, the `scripts/` utilities, root files and cleanup. |
| [`providers/`](providers/) | Provider-specific integrations that need more than the main README: Local browser tools, Codexa Native. |
| [`terminal/`](terminal/) | Terminal behavior: the interactive workbench, headless commands, responsive pickers, and reference recordings. |
| [`releasing/`](releasing/) | Preparing, validating and publishing a release. |
| `_reports/` | Local agent reports. Ignored by Git; see [REPORTING.md](REPORTING.md). |

## Documents

**Architecture**

- [Architecture overview](architecture/overview.md): what Ubume is, the runtime and entry
  points, interactive and headless flows, provider layers, terminal rendering model,
  configuration, safety boundaries, and maintenance playbooks.
- [Interactive app architecture](architecture/app.md): `src/app/` hooks, provider, model, run
  and conversation lifecycles, hook-order invariants, and how to add functionality.
- [Source guide](architecture/source-guide.md): the purpose and ownership of every file under
  `src/`.

**Development**

- [Getting started](development/getting-started.md): requirements, running this checkout
  (`dev`, `dev:run`, `ubume-dev`/`ubd`), and the build and check commands.
- [Testing](development/testing.md): the default suite, script tests, opt-in PTY checks,
  benchmarks and live provider smokes.
- [Scripts guide](development/scripts.md): the `scripts/` layout, each script's safety class,
  arguments and exit behavior, compatibility entry points, and how to add a script.
- [Repository files and local cleanup](development/repository-files.md): what each root file
  is for and which local artifacts are safe to remove.

- [Identity migration](development/identity-migration.md): retired application aliases, model-name preservation and safe legacy-data recovery.

**Providers**

- [Local browser computer use](providers/local-browser.md): browser tools for Local models
  through the DeepSeek Harness: setup, tools, permissions and lifecycle.
- [Codexa Native](providers/codexa-native.md): the development-channel local PyTorch model
  integration.
- [Plan mode and native permissions](providers/planning-and-permissions.md): how each provider
  plans, how Ubume modes map to native permission modes, and when approvals still appear.

**Terminal**

- [Terminal workbench](terminal/workbench.md): editing keys, queueing, inspection, recovery,
  persistence and resume.
- [Headless terminal commands](terminal/headless-commands.md): `ubume exec`, `doctor`, `status`,
  `models`, `sessions`, JSON output and exit codes.
- [Responsive pickers](terminal/pickers.md): how provider, model and selection panels size and
  scroll.
- [Clipboard and terminal graphics](terminal/clipboard.md): `/copy` bridges (Wayland, X11,
  OSC 52), why the Kitty logo is not copyable text, and paste handling.
- [`terminal/recordings/`](terminal/recordings/): asciinema recordings referenced by these docs
  and the changelog. Play them with `asciinema play <file>`.

**Releasing**

- [Release guide](releasing/release-guide.md): versioning, validation, pre-release checks,
  publishing and tagging.

## Documentation elsewhere in the repository

- [`README.md`](../README.md): installation, providers and everyday use.
- [`CHANGELOG.md`](../CHANGELOG.md) and [`VERSIONS.md`](../VERSIONS.md): release history.
- [Installed launchers](development/launchers.md): installed launchers and Harness modules.
- Folder guides next to the code: [`src/config`](../src/config/README.md),
  [`src/core`](../src/core/README.md), [`src/headless`](../src/headless/README.md),
  [`src/session`](../src/session/README.md), [`src/test`](../src/test/README.md),
  [`src/ui`](../src/ui/README.md).

## Local reports

`docs/_reports/` is the only place for agent-generated material: audits, performance runs,
refactoring and validation reports, investigations, and their data and recordings. Git ignores
the directory, so reports never appear in `git status` or on GitHub. A fresh clone has an empty
or missing `_reports/`. The rules, categories and naming conventions are in
[REPORTING.md](REPORTING.md).

## Where new documentation belongs

1. **Update before adding.** If an existing document covers the subject, extend it rather than
   creating a parallel one.
2. **Place by subject:**
   - structure or invariants → `architecture/`;
   - contributor workflow → `development/`;
   - a provider integration → `providers/`;
   - terminal behavior → `terminal/`;
   - release process → `releasing/`.
3. **Keep the top level minimal.** Only this index and `REPORTING.md` live directly in `docs/`.
4. **Use lowercase kebab-case filenames** (`headless-commands.md`), with one H1 title per
   document.
5. **Describe the current project.** Results of a one-off investigation go to `_reports/`.
   Fold any lasting conclusion into the relevant permanent document.
6. **Keep links working.** Use relative links, and never link permanent documentation to files
   under `_reports/`; they do not exist outside the machine that produced them.
7. **Recordings:** a recording that a permanent document or the changelog references lives in
   `terminal/recordings/`. Any other recording belongs with its report.
