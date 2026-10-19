# Upgrading from the former Codexa CLI identity

Ubume is the application name. Codexa Native, PyTorch, CuPy and NumPy identify
independent local models and keep their existing names, model IDs, protocols,
checkpoint identities and configuration values. `/codexa settings`, `/codexa unload`
and `/codexa replay` remain model controls.

## Commands and configuration

| Retired application interface | Current interface |
| --- | --- |
| `codexa` | `ubume` |
| `codexa-dev`, `cxd` | `ubume-dev`, `ubd` |
| Application `CODEXA_*` environment aliases | Corresponding `UBUME_*` settings |
| `codexa.*` command-line overrides | `ubume.*` overrides |
| `--codexa-prompt-policy` | `--ubume-prompt-policy` |

Source integrations should use `getSettingsFile()` and `getLegacySettingsFile()` instead of the former `SETTINGS_FILE` and `LEGACY_SETTINGS_FILE` constants; paths now follow the live environment rather than being fixed at module import.

Update scripts that use these interfaces before upgrading. The development-bin
installer creates the current shims; it does not delete existing global commands.
This repository migration does not uninstall packages or alter global tools.

Model variables such as `CODEXA_NATIVE_*`, `CODEXA_CUPY_*` and `CODEXA_NUMPY_*`
remain unchanged. `CODEXA_DATA_DIR` and `CODEXA_PLAN_DIR` are retained only to
locate legacy user data for import; they no longer select write destinations.
Use `UBUME_DATA_DIR` and `UBUME_PLAN_DIR` to customize current storage.

## Existing user data

- Settings are imported from `~/.codexa-settings.json` when
  `~/.ubume-settings.json` is absent. Trust decisions use the same precedence for
  `codexa-trust.json` and `ubume-trust.json` under the existing Codex configuration home.
- Persisted `[codexa]` TOML settings remain readable until `[ubume]` exists.
  Saving the interactive mode seeds `[ubume]` and retains the original table.
  The provider's own `.codex/config.toml` path is unchanged.
- Legacy model and update caches remain readable; subsequent writes use Ubume files.
- Normal workspace initialization imports missing legacy app-data artifacts into
  the current Ubume data directory. Existing Ubume files and conversations win
  conflicts. A conversation is imported as a complete record rather than combined
  with another generation. Originals are never deleted.
- Import validates structured JSON, uses private staging and non-overwriting file
  publication, and excludes transient process locks. Malformed, unreadable or unsafe
  sources remain intact and incomplete imports can be retried. Symlinked import
  paths are rejected rather than followed.
- Per-source receipts under `.identity-migration/` record progress. Completed
  imports do not recreate intentionally deleted artifacts on later startups.
  Keep these receipts with the data directory. A lock owned by a demonstrably
  dead local process can be reclaimed; active or uncertain owners are respected.
- Read-only diagnostics and history inspection retain legacy fallbacks without
  importing data. Legacy workspace scratch content is excluded from automatic pruning.

When both versions contain a record with the same identity, Ubume retains its
current record. The legacy original remains available for deliberate recovery;
the application does not merge conflicting histories or replace current credentials.

Keep a backup before moving storage manually. This migration neither publishes a
package nor changes model repositories, checkpoints or provider authentication.
