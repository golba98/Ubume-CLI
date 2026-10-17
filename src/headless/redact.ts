/**
 * Secret redaction for everything the headless commands print.
 *
 * Every JSON envelope, human-readable result and redirected stderr stream passes through
 * {@link redact} before it reaches the terminal, so configuration dumps and provider
 * diagnostics can be pasted into bug reports safely.
 */
import type { ProviderWorkspaceConfig } from "../core/providerLauncher/types.js";
import { sanitizeTerminalOutput } from "../core/terminal/terminalSanitize.js";

const SECRET_ENV_NAME = /(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)/i;
const SECRET_FIELD_NAME =
  /api[_-]?key|authorization|cookie|password|secret|credential|(?:access|refresh|auth)[_-]?token|^token$/i;
const URL_CREDENTIALS = /(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi;
const SECRET_QUERY_PARAM = /([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi;
/** Shorter values are too likely to collide with ordinary text to replace blindly. */
const MIN_SECRET_LENGTH = 4;

/**
 * Returns a deep copy of `value` with secrets replaced by `[redacted]`.
 *
 * - Object fields whose *name* looks secret (`apiKey`, `authorization`, …) are replaced.
 * - Strings are terminal-sanitised, then URL credentials and secret query parameters are
 *   masked, and any occurrence of a known secret value is replaced.
 * - Known secret values are `extraSecrets` plus the values of environment variables whose
 *   names contain KEY/TOKEN/PASSWORD/SECRET/CREDENTIAL. The environment is read on every
 *   call, so redaction tracks the current process.
 *
 * Non-string primitives are returned unchanged. The input is never mutated.
 */
export function redact(value: unknown, extraSecrets: readonly string[] = []): unknown {
  const secrets = [
    ...extraSecrets,
    ...Object.entries(process.env)
      .filter(([key]) => SECRET_ENV_NAME.test(key))
      .map(([, val]) => val ?? ""),
  ].filter((text) => text.length >= MIN_SECRET_LENGTH);

  const redactString = (text: string): string => {
    let result = sanitizeTerminalOutput(text)
      .replace(URL_CREDENTIALS, "$1[redacted]@")
      .replace(SECRET_QUERY_PARAM, "$1[redacted]");
    for (const secret of secrets) result = result.split(secret).join("[redacted]");
    return result;
  };

  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return redactString(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([key, val]) => [
          key,
          SECRET_FIELD_NAME.test(key) ? "[redacted]" : walk(val),
        ]),
      );
    }
    return item;
  };

  return walk(value);
}

/** API keys configured in `providers.json`, which are passed to {@link redact} as extra secrets. */
export function providerSecrets(config: ProviderWorkspaceConfig): string[] {
  return Object.values(config.providers ?? {}).flatMap((provider) =>
    provider?.apiKey ? [provider.apiKey] : [],
  );
}
