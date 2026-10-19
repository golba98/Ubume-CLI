/**
 * Argument parser for `ubume exec` and `ubume --headless-benchmark`.
 *
 * The parser is pure: it never reads stdin, the environment or the filesystem, and
 * reports problems as values rather than exceptions, so the dispatcher can turn them
 * into a `USAGE` error (exit 2).
 *
 * Options may appear before or after the prompt. Value options accept `--flag value`
 * and, except for `-m`, `--flag=value`. The `=` form is the documented escape hatch for
 * values that start with `-`. Options that also mean something to the provider CLI
 * (`--profile`, `--model`, `--reasoning`, `-c/--config`, `--skip-git-repo-check`) are
 * recorded in `launchArgs.passthroughArgs` exactly as the caller spelled them.
 */
import type { LaunchArgs } from "../config/launchArgs.js";

/** A parsed `ubume exec` invocation. */
export interface HeadlessExecArgs {
  help: boolean;
  json: boolean;
  /** Read the prompt from stdin (exclusive with a positional prompt and `--prompt`). */
  stdin: boolean;
  noSave: boolean;
  resumeId?: string;
  providerId?: string;
  cwd?: string;
  /** `--file` attachments, in order. */
  files: string[];
  /** `--benchmark-diagnostics`, which implies `timing`. */
  benchmarkDiagnostics: boolean;
  timing: boolean;
  promptPolicy: "raw" | "wrapped";
  /** The prompt text, or `""` for `--stdin` and `--help`. */
  prompt: string;
  launchArgs: LaunchArgs;
}

export type HeadlessExecArgsParseResult =
  | { ok: true; value: HeadlessExecArgs }
  | { ok: false; error: string };

/** Value options that also accept the `--flag=value` spelling. */
const INLINE_VALUE_FLAGS = new Set([
  "--prompt",
  "--profile",
  "--model",
  "--reasoning",
  "-c",
  "--config",
  "--resume",
  "--provider",
  "--cwd",
  "--file",
  "--ubume-prompt-policy",
]);

function normalizeNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A trimmed `key=value` pair with a non-empty key and value, else null. */
function parseConfigFlagValue(raw: string | undefined): string | null {
  const trimmed = normalizeNonEmpty(raw);
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null;
  return trimmed;
}

/**
 * Splits `--flag=value` for flags that accept it. Any other argument is returned whole
 * as the flag, so an unknown spelling such as `--json=1` is reported verbatim.
 */
function splitOption(arg: string): { flag: string; inlineValue?: string } {
  const separatorIndex = arg.indexOf("=");
  if (separatorIndex < 0) return { flag: arg };

  const flag = arg.slice(0, separatorIndex);
  if (!INLINE_VALUE_FLAGS.has(flag)) return { flag: arg };
  return { flag, inlineValue: arg.slice(separatorIndex + 1) };
}

const fail = (error: string): HeadlessExecArgsParseResult => ({ ok: false, error });

/**
 * Parses the arguments that follow `exec` (or `--headless-benchmark`).
 *
 * Validation, in order: unknown options and missing option values; a positional
 * prompt combined with `--prompt`; `--stdin` combined with another prompt source;
 * `--no-save` combined with `--resume`; and finally a missing prompt (skipped when
 * `--help` or `--stdin` is present).
 *
 * @param argv - Arguments after the command name.
 * @returns The parsed arguments, or the first usage error encountered.
 */
export function parseHeadlessExecArgs(argv: readonly string[]): HeadlessExecArgsParseResult {
  const configOverrides: string[] = [];
  const passthroughArgs: string[] = [];
  const positionalPromptParts: string[] = [];
  const files: string[] = [];
  let explicitPrompt: string | null = null;
  let profile: string | null = null;
  let modelOverride: string | null = null;
  let help = false;
  let json = false;
  let stdin = false;
  let noSave = false;
  let resumeId: string | undefined;
  let providerId: string | undefined;
  let cwd: string | undefined;
  let benchmarkDiagnostics = false;
  let timing = false;
  let promptPolicy: "raw" | "wrapped" = "raw";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--") {
      positionalPromptParts.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positionalPromptParts.push(arg);
      continue;
    }

    const { flag, inlineValue } = splitOption(arg);
    const inline = inlineValue !== undefined;
    /** Records a provider-visible option in the same spelling the caller used. */
    const passThrough = (value: string) => {
      if (inline) passthroughArgs.push(`${flag}=${value}`);
      else passthroughArgs.push(flag, value);
    };

    switch (flag) {
      case "--json":
        json = true;
        break;
      case "--stdin":
        stdin = true;
        break;
      case "--no-save":
        noSave = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--benchmark-diagnostics":
        benchmarkDiagnostics = true;
        timing = true;
        break;
      case "--timing":
        timing = true;
        break;
      case "--skip-git-repo-check":
        passthroughArgs.push(arg);
        break;

      case "--prompt":
      case "--profile":
      case "--model":
      case "-m":
      case "--reasoning": {
        let value: string | null;
        if (inline) {
          value = normalizeNonEmpty(inlineValue);
          if (!value) return fail(`Missing value for ${flag}.`);
        } else {
          // Never consume a following option as the value; `--flag=-x` is the escape hatch.
          const next = argv[index + 1];
          if (!next?.trim() || next.startsWith("-")) {
            return fail(`Missing value for ${flag}. Use ${flag}=VALUE for an option-like value.`);
          }
          value = next.trim();
          index += 1;
        }

        if (flag === "--prompt") {
          explicitPrompt = value;
        } else if (flag === "--profile") {
          profile = value;
          passThrough(value);
        } else if (flag === "--reasoning") {
          configOverrides.push(`model_reasoning_effort=${value}`);
          passThrough(value);
        } else {
          // A JSON string literal is also a valid TOML basic string.
          configOverrides.push(`model=${JSON.stringify(value)}`);
          passThrough(value);
          modelOverride = value;
        }
        break;
      }

      case "-c":
      case "--config": {
        const value = parseConfigFlagValue(inline ? inlineValue : argv[++index]);
        if (!value) return fail(`Missing key=value payload for ${flag}.`);
        configOverrides.push(value);
        passThrough(value);
        break;
      }

      case "--resume":
      case "--provider":
      case "--cwd":
      case "--file": {
        const value = normalizeNonEmpty(inline ? inlineValue : argv[++index]);
        if (!value || (!inline && value.startsWith("--")))
          return fail(`Missing value for ${flag}.`);
        if (flag === "--resume") resumeId = value;
        else if (flag === "--provider") providerId = value;
        else if (flag === "--cwd") cwd = value;
        else files.push(value);
        break;
      }

      case "--ubume-prompt-policy": {
        const value = normalizeNonEmpty(inline ? inlineValue : argv[++index]);
        if (value !== "raw" && value !== "wrapped") {
          return fail(
            inline
              ? "Invalid value for --ubume-prompt-policy. Use raw or wrapped."
              : "Missing or invalid value for --ubume-prompt-policy. Use raw or wrapped.",
          );
        }
        promptPolicy = value;
        break;
      }

      default:
        return fail(`Unknown option for ubume exec: ${arg}`);
    }
  }

  const positionalPrompt =
    positionalPromptParts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ")
      .trim() || null;

  if (explicitPrompt && positionalPrompt) {
    return fail("Provide a prompt either positionally or with --prompt, not both.");
  }
  if (stdin && (explicitPrompt || positionalPrompt)) {
    return fail("--stdin cannot be combined with another prompt source.");
  }
  if (noSave && resumeId) return fail("--no-save cannot be combined with --resume.");

  const prompt = explicitPrompt ?? positionalPrompt;
  if (!help && !prompt && !stdin) {
    return fail('Missing prompt. Use ubume exec "prompt" or ubume exec --prompt "prompt".');
  }

  return {
    ok: true,
    value: {
      help,
      json,
      stdin,
      noSave,
      resumeId,
      providerId,
      cwd,
      files,
      benchmarkDiagnostics,
      timing,
      promptPolicy,
      prompt: prompt ?? "",
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: prompt,
        profile,
        configOverrides,
        passthroughArgs,
        modelOverride,
        noClear: false,
      },
    },
  };
}
