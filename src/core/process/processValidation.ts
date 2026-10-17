/**
 * Validates executable paths and process-launch inputs before spawning commands.
 */

import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const BARE_EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHELL_METACHARACTER_PATTERN = /[;&|<>`$]/;
const WINDOWS_BATCH_METACHARACTER_PATTERN = /[;&|<>`$^%!]/;

interface ExecutableValidationOptions {
  label: string;
  cwd?: string;
  requireExistingPath?: boolean;
  allowBareExecutable?: boolean;
}

function stripBalancedWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function hasWindowsBatchExtension(value: string): boolean {
  return /\.(?:cmd|bat)$/i.test(value);
}

function validateCommonExecutableSyntax(value: string, label: string): void {
  if (!value) {
    throw new Error(`${label} is empty.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} contains control characters and cannot be used as an executable.`);
  }
  if (value.includes(`"`) || value.includes(`'`)) {
    throw new Error(`${label} must be a command/path only, without embedded quotes.`);
  }
  if (SHELL_METACHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} contains shell metacharacters and cannot be used as an executable.`);
  }
}

/**
 * Normalizes a command name or path without accepting shell arguments. Invalid syntax,
 * disallowed bare names or required missing paths throw.
 */
export function normalizeExecutableValue(
  rawValue: string,
  options: ExecutableValidationOptions,
): string {
  const allowBareExecutable = options.allowBareExecutable ?? true;
  const requireExistingPath = options.requireExistingPath ?? false;
  const cwd = options.cwd ?? process.cwd();
  const trimmed = stripBalancedWrappingQuotes(rawValue.trim());

  validateCommonExecutableSyntax(trimmed, options.label);

  if (!looksLikePath(trimmed)) {
    if (!allowBareExecutable) {
      throw new Error(`${options.label} must be an executable path.`);
    }
    if (!BARE_EXECUTABLE_PATTERN.test(trimmed)) {
      throw new Error(`${options.label} must be a single executable name without arguments.`);
    }
    return trimmed;
  }

  const normalized =
    isAbsolute(trimmed) || isWindowsAbsolutePath(trimmed) ? trimmed : resolve(cwd, trimmed);
  validateCommonExecutableSyntax(normalized, options.label);

  if (requireExistingPath && !existsSync(normalized)) {
    throw new Error(
      `${options.label} path does not exist: "${normalized}"\n` +
        `Check the path is correct and the file is accessible, or unset ${options.label}.`,
    );
  }

  return normalized;
}

/**
 * Validates executable syntax before direct spawn, allowing nonexistent paths unless the caller
 * requires existence.
 */
export function validateExecutableForSpawn(
  executable: string,
  options: ExecutableValidationOptions,
): string {
  return normalizeExecutableValue(executable, {
    ...options,
    requireExistingPath: options.requireExistingPath ?? false,
  });
}

/** Rejects cmd.exe metacharacters in batch executable paths before shell wrapping. */
export function validateWindowsBatchExecutableForCmd(executable: string, label: string): void {
  if (!hasWindowsBatchExtension(executable)) return;
  if (WINDOWS_BATCH_METACHARACTER_PATTERN.test(executable)) {
    throw new Error(`${label} contains characters that are unsafe for cmd.exe batch launch.`);
  }
}

/** Rejects shell metacharacters in arguments passed through the Windows batch wrapper. */
export function validateWindowsBatchArgumentForCmd(argument: string, label: string): void {
  if (WINDOWS_BATCH_METACHARACTER_PATTERN.test(argument)) {
    throw new Error(`${label} contains characters that are unsafe for cmd.exe batch launch.`);
  }
}
