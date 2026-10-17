/**
 * @fileoverview Legacy Environment Variable Aliasing
 *
 * Provides backward compatibility for pre-rename environment variables.
 * Any environment variable prefixed with `CODEXA_*` is copied to its `UBUME_*`
 * counterpart unless the `UBUME_*` variable is already explicitly defined.
 *
 * Variables belonging to the Codexa model family (`CODEXA_NATIVE_*`, `CODEXA_CUPY_*`,
 * `CODEXA_NUMPY_*`) are deliberately exempted and preserved without aliasing.
 */

const LEGACY_ENV_PREFIX = "CODEXA_";
const TARGET_ENV_PREFIX = "UBUME_";

/** Pattern matching model-family specific variables that should not be aliased */
const MODEL_FAMILY_ENV_PATTERN = /^CODEXA_(NATIVE|CUPY|NUMPY)_/;

/**
 * Copies legacy `CODEXA_*` environment variables to their equivalent `UBUME_*`
 * names unless the target variable is already set.
 *
 * @param env - The environment object to process (defaults to `process.env`).
 *              Mutates `env` in-place.
 */
export function applyLegacyEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [legacyKey, value] of Object.entries(env)) {
    if (!legacyKey.startsWith(LEGACY_ENV_PREFIX) || MODEL_FAMILY_ENV_PATTERN.test(legacyKey)) {
      continue;
    }

    const aliasedKey = `${TARGET_ENV_PREFIX}${legacyKey.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[aliasedKey] === undefined) {
      env[aliasedKey] = value;
    }
  }
}

// Automatically apply aliases on module import to ensure seamless runtime startup.
applyLegacyEnvAliases();
