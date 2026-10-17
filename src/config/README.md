# Ubume CLI — Configuration Subsystem (`src/config/`)

## 1. Overview & Architecture

The `src/config/` subsystem manages all application preferences, runtime policies, CLI flags, security boundaries, and persistence for Ubume CLI. It provides deterministic, type-safe resolution across user, project, profile, and command-line configuration sources.

```
+-----------------------------------------------------------------------------------+
|                                 5-Layer Precedence                                |
|                                                                                   |
|  [5. CLI Overrides]        (-c / --config key=value flags, --model, --profile)    |
|          ^                                                                        |
|  [4. Profile Patches]      ([profiles.<name>] from loaded user/project configs)   |
|          ^                                                                        |
|  [3. Project Config]       (.codex/config.toml, strictly guarded by Trust Store)  |
|          ^                                                                        |
|  [2. User Config]          (~/.codex/config.toml)                                 |
|          ^                                                                        |
|  [1. Built-in Defaults]    (DEFAULT_RUNTIME_CONFIG)                               |
+-----------------------------------------------------------------------------------+
```

---

## 2. Module Directory & Responsibilities

| Module | Primary Responsibility | Key Exports |
| :--- | :--- | :--- |
| `index.ts` | Unified public facade re-exporting the configuration API. | All public functions, types, and constants. |
| `atomicFile.ts` | Safe atomic file persistence with `.tmp` write and rename. | `writeTextFileAtomic`, `writeJsonFileAtomic` |
| `buildInfo.ts` | Committed version and Git commit hash fallback. | `BUILD_INFO`, `BUILD_VERSION`, `BUILD_COMMIT` |
| `legacyEnv.ts` | Aliases `CODEXA_*` env vars to unset `UBUME_*` variables. | `applyLegacyEnvAliases` |
| `launchArgs.ts` | Parses interactive CLI startup flags (`-c`, `--profile`, `-m`, `--no-clear`, `--resume`, `--import-session`). | `parseLaunchArgs`, `LaunchArgs` |
| `layeredConfig.ts` | Executes 5-layer resolution and provenance diagnostic tracking. | `resolveLayeredConfig`, `applyLayeredRuntimeOverride`, `formatLayeredConfigStatus`, `mergeRuntimeIntoTomlConfig` |
| `persistence.ts` | Manages `~/.ubume-settings.json` and TOML runtime mode storage. | `loadSettings`, `saveSettings`, `saveRuntimeModePreference` |
| `runtimeConfig.ts` | Policy schemas, mode inheritance, sandbox modes, and status formatters. | `resolveRuntimeConfig`, `normalizeRuntimeConfig`, `diffRuntimeConfig`, `buildRuntimeSummary` |
| `settings.ts` | App identity, filesystem paths, themes, UI schemas, and display formatters. | `getCodexHome`, `getCodexConfigFile`, `formatModeLabel`, `USER_SETTING_DEFINITIONS` |
| `tomlSerialize.ts` | Serializes records and arrays into TOML documents. | `formatTomlKey`, `formatTomlPath`, `serializeTomlDocument` |
| `trustStore.ts` | Persists and queries user-trusted project roots (`ubume-trust.json`). | `isProjectTrusted`, `setProjectTrust` |

---

## 3. The 5-Layer Configuration Lifecycle

Configuration resolution proceeds strictly in ascending order of precedence:

1. **Layer 1: Built-in Defaults (`DEFAULT_RUNTIME_CONFIG`)**:
   - Provider: `codex-subprocess`
   - Model: `gpt-5.4`
   - Reasoning Level: `high`
   - Mode: `full-auto`
   - Policy: `inherit` for sandbox and approval; service tier: `flex`; personality: `none`.

2. **Layer 2: User Config (`~/.codex/config.toml`)**:
   - Machine-wide user preferences loaded via `getCodexConfigFile()`.
   - Supports top-level values as well as named profiles in `[profiles.<name>]`.

3. **Layer 3: Project Config (`.codex/config.toml`)**:
   - Located by walking upward from the current workspace root until reaching `.git`.
   - **Security Guarantee**: Only applied if the detected project root is recorded as trusted in `ubume-trust.json`. If untrusted, the file is blocked and recorded in diagnostics.

4. **Layer 4: Profile Patches (`[profiles.<name>]`)**:
   - Active profile is selected via CLI `--profile <name>`, or the `profile = "<name>"` key in loaded config files.
   - Profile tables from user and project configs are merged sequentially onto the runtime.

5. **Layer 5: CLI Overrides (`--config` / `-c` / `--model`)**:
   - Specific flag overrides passed directly on invocation (e.g. `-c sandbox_mode="read-only"`).
   - Wins over all file-based configuration.

---

## 4. Security & The Project Trust Store

Project repositories can contain arbitrary instructions, sandbox configurations, and tool overrides. To prevent malicious repositories from executing unsafe actions automatically upon opening:

- Every repository root must be explicitly approved by the user.
- Trust decisions are stored in `~/.codex/ubume-trust.json` via `trustStore.ts`.
- When an untrusted repository is loaded, `layeredConfig.ts` reports the project layer status as `blocked (project is untrusted)`.
- Legacy `codexa-trust.json` is automatically migrated to `ubume-trust.json` non-destructively.

---

## 5. Persistence & Atomic File Guarantees

All file writes to user settings (`~/.ubume-settings.json`), trust stores (`~/.codex/ubume-trust.json`), and TOML configs (`~/.codex/config.toml`) are mediated through `atomicFile.ts`:

1. Destination directory is created recursively (`mkdirSync`).
2. Data is written to a unique temporary file (`<destination>.<pid>.<timestamp>.tmp`).
3. Atomic swap occurs using `renameSync(tmp, destination)`.
4. If an error occurs, the temporary file is deleted in a best-effort `rmSync` block.

---

## 6. Legacy Migration & Compatibility

Ubume CLI provides seamless backward compatibility for existing configurations:

- **Environment Variables (`legacyEnv.ts`)**: Legacy `CODEXA_*` variables are copied into `UBUME_*` unless explicitly defined, preserving model family variables (`CODEXA_NATIVE_*`).
- **Settings File (`persistence.ts`)**: Migrates `~/.codexa-settings.json` to `~/.ubume-settings.json`.
- **Flat TOML Runtime (`persistence.ts`)**: Migrates pre-renamed flat keys (`backend`, `model`, `mode`) into standard `[ubume]` TOML tables.
- **Directory Display Modes (`settings.ts`)**: Automatically maps legacy `"normal"` mode to modern `"dir"`.

---

## 7. How to Add a New Configuration Key

1. **Define Schema**: Add the field to `RuntimePolicyConfig` or `RuntimeConfig` in `src/config/runtimeConfig.ts`.
2. **Set Defaults**: Update `DEFAULT_RUNTIME_POLICY` or `DEFAULT_RUNTIME_CONFIG`.
3. **Add Spec in `layeredConfig.ts`**: Add an entry to `FIELD_SPECS` handling TOML deserialization, validation, and diagnostic tracking.
4. **Update TOML Merge**: Add the path to `entries` in `mergeRuntimeIntoTomlConfig`.
5. **Add Tests**: Write tests verifying defaults, overrides, and serialization in `runtimeConfig.test.ts` and `layeredConfig.test.ts`.

---

## 8. Development & Testing Commands

```bash
# Run all configuration tests
bun test src/config/

# Run type checking
bun run typecheck

# Run Biome linting and formatting check
bun run check

# Format source files
bun run format

# Run full project build
bun run build
```
