/**
 * @fileoverview CLI Launch Arguments Parser
 *
 * Parses interactive CLI arguments passed to `ubume`, including profile selection,
 * config key-value overrides, model overrides, session resume/import targets,
 * help/version flags, and initial startup prompts.
 */

import {
  EXTERNAL_SESSION_SOURCES,
  type ExternalSessionSource,
} from "../core/externalSessions/types.js";

const FLAG_HELP = "--help";
const FLAG_HELP_SHORT = "-h";
const FLAG_VERSION = "--version";
const FLAG_VERSION_SHORT = "-v";
const FLAG_PROFILE = "--profile";
const FLAG_CONFIG = "--config";
const FLAG_CONFIG_SHORT = "-c";
const FLAG_MODEL = "--model";
const FLAG_MODEL_SHORT = "-m";
const FLAG_NO_CLEAR = "--no-clear";

export interface LaunchArgs {
  help: boolean;
  version: boolean;
  initialPrompt: string | null;
  profile: string | null;
  configOverrides: string[];
  passthroughArgs: string[];
  /** Explicitly set when --model / -m was passed on the command line. Null when no model flag was given. */
  modelOverride: string | null;
  /** True when --no-clear was passed. Suppresses the startup terminal clear. */
  noClear: boolean;
  resumeId?: string;
  importSession?: { source: ExternalSessionSource; sessionId: string };
}

export type LaunchArgsParseResult = { ok: true; value: LaunchArgs } | { ok: false; error: string };

function normalizeProfileValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseConfigFlagValue(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }

  // Require non-empty key and non-empty value on both sides of "="
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }

  return trimmed;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

interface FlagExtraction {
  name: string;
  value: string | undefined;
  consumedNext: boolean;
}

function extractFlagValue(
  arg: string,
  prefix: string,
  nextArg: string | undefined,
): FlagExtraction | null {
  if (arg === prefix) {
    return { name: prefix, value: nextArg, consumedNext: true };
  }
  if (arg.startsWith(`${prefix}=`)) {
    return { name: prefix, value: arg.slice(prefix.length + 1), consumedNext: false };
  }
  return null;
}

function validateResumeTarget(
  value: string | undefined,
): { ok: true; resumeId: string } | { ok: false; error: string } {
  if (!value || value.startsWith("--")) {
    return { ok: false, error: "Missing value for --resume." };
  }
  if (!/^chat_[A-Za-z0-9-]+$/.test(value)) {
    return { ok: false, error: "Invalid conversation ID for --resume." };
  }
  return { ok: true, resumeId: value };
}

function validateImportSessionTarget(
  value: string | undefined,
):
  | { ok: true; importSession: { source: ExternalSessionSource; sessionId: string } }
  | { ok: false; error: string } {
  if (!value || value.startsWith("--")) {
    return { ok: false, error: "Missing value for --import-session." };
  }
  const separator = value.indexOf(":");
  let source = value.slice(0, separator) as ExternalSessionSource;
  const sessionId = value.slice(separator + 1);
  if (source === "antigravity") {
    source = "google";
  }
  if (
    separator < 0 ||
    !EXTERNAL_SESSION_SOURCES.includes(source) ||
    !/^[A-Za-z0-9_-]+$/.test(sessionId)
  ) {
    return {
      ok: false,
      error: "Use --import-session source:session-id (claude, codex, google, vibe).",
    };
  }
  return { ok: true, importSession: { source, sessionId } };
}

/**
 * Parses command-line arguments for interactive Ubume startup.
 *
 * @param argv - Argument tokens (excluding node and script paths).
 * @returns Parse result with strongly typed LaunchArgs or an error message.
 */
export function parseLaunchArgs(argv: readonly string[]): LaunchArgsParseResult {
  const passthroughArgs: string[] = [];
  const configOverrides: string[] = [];
  const promptArgs: string[] = [];
  let help = false;
  let version = false;
  let noClear = false;
  let profile: string | null = null;
  let modelOverride: string | null = null;
  let resumeId: string | undefined;
  let importSession: LaunchArgs["importSession"];

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }

    if (arg === "--provider" || arg.startsWith("--provider=")) {
      return {
        ok: false,
        error:
          "--provider is supported by ubume exec. For interactive startup, select the provider in /model or resume a saved conversation.",
      };
    }

    // Handle --resume
    const resumeFlag = extractFlagValue(arg, "--resume", argv[index + 1]);
    if (resumeFlag) {
      if (resumeId || importSession) {
        return { ok: false, error: "Choose only one --resume or --import-session target." };
      }
      const validated = validateResumeTarget(resumeFlag.value);
      if (!validated.ok) {
        return validated;
      }
      resumeId = validated.resumeId;
      if (resumeFlag.consumedNext) {
        index += 1;
      }
      index += 1;
      continue;
    }

    // Handle --import-session
    const importFlag = extractFlagValue(arg, "--import-session", argv[index + 1]);
    if (importFlag) {
      if (resumeId || importSession) {
        return { ok: false, error: "Choose only one --resume or --import-session target." };
      }
      const validated = validateImportSessionTarget(importFlag.value);
      if (!validated.ok) {
        return validated;
      }
      importSession = validated.importSession;
      if (importFlag.consumedNext) {
        index += 1;
      }
      index += 1;
      continue;
    }

    // End-of-flags delimiter: all subsequent arguments belong to the initial prompt
    if (arg === "--") {
      promptArgs.push(...argv.slice(index + 1));
      break;
    }

    if (arg === FLAG_HELP || arg === FLAG_HELP_SHORT) {
      help = true;
      index += 1;
      continue;
    }

    if (arg === FLAG_VERSION || arg === FLAG_VERSION_SHORT) {
      version = true;
      index += 1;
      continue;
    }

    if (arg === FLAG_NO_CLEAR) {
      noClear = true;
      index += 1;
      continue;
    }

    // --profile <value> and --profile=<value>
    const profileFlag = extractFlagValue(arg, FLAG_PROFILE, argv[index + 1]);
    if (profileFlag) {
      const value = normalizeProfileValue(profileFlag.value);
      if (!value) {
        return { ok: false, error: `Missing value for ${FLAG_PROFILE}.` };
      }
      profile = value;
      if (profileFlag.consumedNext) {
        passthroughArgs.push(arg, value);
        index += 1;
      } else {
        passthroughArgs.push(`${FLAG_PROFILE}=${value}`);
      }
      index += 1;
      continue;
    }

    // --config <value>, --config=<value>, -c <value>, -c=<value>
    const configLongFlag = extractFlagValue(arg, FLAG_CONFIG, argv[index + 1]);
    const configShortFlag = extractFlagValue(arg, FLAG_CONFIG_SHORT, argv[index + 1]);
    const configFlag = configLongFlag ?? configShortFlag;
    if (configFlag) {
      const value = parseConfigFlagValue(configFlag.value);
      if (!value) {
        const flagName = configFlag.consumedNext ? arg : configFlag.name;
        return { ok: false, error: `Missing key=value payload for ${flagName}.` };
      }
      configOverrides.push(value);
      if (configFlag.consumedNext) {
        passthroughArgs.push(arg, value);
        index += 1;
      } else {
        passthroughArgs.push(`${configFlag.name}=${value}`);
      }
      index += 1;
      continue;
    }

    // --model <value>, --model=<value>, -m <value>, -m=<value>
    const modelLongFlag = extractFlagValue(arg, FLAG_MODEL, argv[index + 1]);
    const modelShortFlag = extractFlagValue(arg, FLAG_MODEL_SHORT, argv[index + 1]);
    const modelFlag = modelLongFlag ?? modelShortFlag;
    if (modelFlag) {
      const value = normalizeProfileValue(modelFlag.value);
      if (!value) {
        const flagName = modelFlag.consumedNext ? arg : modelFlag.name;
        return { ok: false, error: `Missing value for ${flagName}.` };
      }
      configOverrides.push(`model=${quoteTomlString(value)}`);
      if (modelFlag.consumedNext) {
        passthroughArgs.push(arg, value);
        index += 1;
      } else {
        passthroughArgs.push(`${modelFlag.name}=${value}`);
      }
      modelOverride = value;
      index += 1;
      continue;
    }

    // Non-flag arguments are positional and interpreted as the start of an initial prompt
    if (!arg.startsWith("-")) {
      promptArgs.push(arg, ...argv.slice(index + 1));
      break;
    }

    passthroughArgs.push(arg);
    index += 1;
  }

  const initialPrompt =
    promptArgs
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ")
      .trim() || null;

  if ((resumeId || importSession) && initialPrompt) {
    return {
      ok: false,
      error: "Resume/import opens a conversation without running a startup prompt.",
    };
  }

  return {
    ok: true,
    value: {
      help,
      version,
      initialPrompt,
      profile,
      configOverrides,
      passthroughArgs,
      modelOverride,
      noClear,
      ...(resumeId ? { resumeId } : {}),
      ...(importSession ? { importSession } : {}),
    },
  };
}
