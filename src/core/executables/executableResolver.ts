/**
 * Resolves Claude Code and Antigravity (`agy`) executables with platform and override handling.
 * Provides shared cross-platform executable-name, PATH, override, and resolution utilities.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { type CommandResult, runCommand, runShellCommand } from "../process/commandRunner.js";
import {
  normalizeExecutableValue,
  validateWindowsBatchArgumentForCmd,
  validateWindowsBatchExecutableForCmd,
} from "../process/processValidation.js";

type CommandRunner = typeof runCommand;

interface ExecutableResolverOptions {
  runCommandImpl?: CommandRunner;
  cwd?: string;
  configuredPath?: string | null;
  envOverrides?: string[];
  commandNames: string[];
  knownPathDirectories?: string[];
  knownFilePaths?: string[];
  label: string;
  allowBareFallback?: boolean;
  requireResolvedFile?: boolean;
}

function validateConfiguredExecutable(value: string, label: string, cwd: string): string {
  return normalizeExecutableValue(value, {
    label,
    cwd,
    requireExistingPath: /[\\/]/.test(value) || /^[\s"']*[A-Za-z]:/.test(value),
    allowBareExecutable: true,
  });
}

function validateResolvedExecutable(value: string, label: string, cwd: string): string {
  return normalizeExecutableValue(value, {
    label,
    cwd,
    requireExistingPath: false,
    allowBareExecutable: true,
  });
}

async function resolveWithWhere(
  runCommandImpl: CommandRunner,
  cwd: string,
  query: string,
  requireResolvedFile: boolean,
): Promise<string | null> {
  const whereRunner = runCommandImpl({
    executable: "where.exe",
    args: [query],
    cwd,
    timeoutMs: 5000,
  });
  const whereResult = await whereRunner.result;
  if (whereResult.status !== "completed" || whereResult.exitCode !== 0) return null;
  const lines = whereResult.stdout
    .trim()
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    let candidate: string;
    try {
      candidate = validateResolvedExecutable(line, "where.exe result", cwd);
    } catch {
      continue;
    }
    if (!requireResolvedFile || existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves an executable's location.
 *
 * Priority:
 *   1. Configured path override
 *   2. Environment variable overrides (in order)
 *   3. Windows PATH lookup by explicit command names (using where.exe)
 *   4. Windows known-path fallbacks (e.g. %APPDATA%\npm)
 *   5. Explicit known file fallbacks
 *   6. Bare name fallback, unless disabled
 */
export async function resolveExecutable(options: ExecutableResolverOptions): Promise<string> {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const cwd = options.cwd ?? process.cwd();

  // 1. Configured path override
  if (options.configuredPath?.trim()) {
    return validateConfiguredExecutable(options.configuredPath, `${options.label}CommandPath`, cwd);
  }

  // 2. Environment variable overrides
  if (options.envOverrides) {
    for (const envVar of options.envOverrides) {
      const envOverride = process.env[envVar]?.trim();
      if (envOverride) {
        return validateConfiguredExecutable(envOverride, envVar, cwd);
      }
    }
  }

  // 3. Windows PATH lookup by explicit command names (where.exe returns null on non-Windows gracefully)
  for (const candidate of options.commandNames) {
    const resolved = await resolveWithWhere(
      runCommandImpl,
      cwd,
      candidate,
      options.requireResolvedFile === true,
    );
    if (resolved) return resolved;
  }

  // 4. Windows known-path fallbacks (existsSync returns false for non-existent paths on any platform)
  if (options.knownPathDirectories) {
    const knownCandidates: string[] = [];
    for (const dir of options.knownPathDirectories) {
      for (const candidate of options.commandNames) {
        knownCandidates.push(join(dir, candidate));
      }
    }

    for (const candidate of knownCandidates) {
      const validated = validateResolvedExecutable(
        candidate,
        `${options.label} known executable`,
        cwd,
      );
      if (existsSync(validated)) return validated;
    }
  }

  // 5. Explicit known file fallbacks
  for (const candidate of options.knownFilePaths ?? []) {
    const validated = validateResolvedExecutable(
      candidate,
      `${options.label} known executable`,
      cwd,
    );
    if (existsSync(validated)) return validated;
  }

  if (options.allowBareFallback === false) {
    throw new Error(`${options.label} executable was not found.`);
  }

  // 6. Bare name fallback — prefer the name without an extension (works on Unix).
  const bareName = options.commandNames.find((c) => !c.includes(".")) ?? options.commandNames[0];
  return validateResolvedExecutable(bareName!, `${options.label} executable`, cwd);
}

/**
 * Builds the spawn spec for a resolved executable.
 * .cmd and .bat files must be invoked via `cmd.exe /d /s /c` on Windows.
 *
 * `platform` defaults to the host platform; it is injectable so the Windows
 * wrapping branch can be unit-tested from any OS.
 */
export function buildSpawnSpec(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] } {
  const validatedExecutable = validateResolvedExecutable(executable, "Executable", process.cwd());
  if (platform === "win32") {
    const lower = validatedExecutable.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      validateWindowsBatchExecutableForCmd(validatedExecutable, "Windows batch executable");
      for (const argument of args) {
        validateWindowsBatchArgumentForCmd(argument, "Windows batch argument");
      }
      return {
        executable: "cmd.exe",
        args: ["/d", "/s", "/c", "call", validatedExecutable, ...args],
      };
    }
  }
  return { executable: validatedExecutable, args };
}

/**
 * Returns the resolved Claude CLI executable (full path or bare name).
 *
 * Priority:
 *   1. CLAUDE_EXECUTABLE env var (if set)
 *   2. where.exe lookup on Windows — finds the real .exe/.cmd/.bat even when "claude"
 *      is shadowed by a PowerShell function (Invoke-Claude @args)
 *   3. Windows known-path fallbacks: %USERPROFILE%\.local\bin and %USERPROFILE%\bin
 *   4. Bare "claude" fallback (works on Unix; Windows fallback if nothing else found)
 */
export const { resolve: resolveClaudeExecutable, reset: resetClaudeExecutableCacheForTests } =
  createCachedExecutableResolver((options) => {
    const knownPathDirectories: string[] = [];
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      knownPathDirectories.push(join(userProfile, ".local", "bin"));
      knownPathDirectories.push(join(userProfile, "bin"));
    }

    return {
      runCommandImpl: options?.runCommandImpl,
      cwd: options?.cwd,
      configuredPath: options?.configuredPath,
      envOverrides: ["CLAUDE_EXECUTABLE"],
      commandNames: ["claude.exe", "claude.cmd", "claude.bat", "claude"],
      knownPathDirectories,
      label: "claude",
    };
  });

/**
 * Builds the spawn spec for a resolved Claude executable.
 */
export function buildClaudeSpawnSpec(
  executable: string,
  args: string[],
): { executable: string; args: string[] } {
  return buildSpawnSpec(executable, args);
}

/**
 * Returns the resolved Antigravity CLI executable (full path or bare name).
 *
 * Priority:
 *   1. Configured path override (antigravityCommandPath)
 *   2. AGY_EXECUTABLE env var
 *   3. Windows PATH lookup for real files: agy.exe, agy.cmd, agy.bat, agy
 *   4. Bare name fallback "agy" (Unix PATH resolution)
 */
export async function resolveAgyExecutable(options?: {
  cwd?: string;
  configuredPath?: string | null;
  runCommandImpl?: CommandRunner;
}): Promise<string> {
  const executable = await resolveExecutable({
    ...options,
    envOverrides: ["AGY_EXECUTABLE"],
    commandNames: process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat", "agy"] : ["agy"],
    knownPathDirectories: [],
    knownFilePaths: [],
    label: "antigravity",
    allowBareFallback: true,
  });
  if (/^gemini(?:\.(?:exe|cmd|bat))?$/i.test(executable.split(/[\\/]/).at(-1) ?? ""))
    throw new Error(
      "Google uses Antigravity (agy); the removed Gemini CLI cannot be configured as its executable.",
    );
  return executable;
}

/** AGY resolution is context-sensitive and has no process-global executable cache. */
export function resetAgyExecutableCacheForTests(): void {}

/**
 * Searches an explicit path or PATH for an executable; invalid syntax or inaccessible candidates
 * return null.
 */
export function findExecutable(command: string, cwd: string): string | null {
  try {
    command = normalizeExecutableValue(command, {
      label: "Provider executable",
      cwd,
      requireExistingPath: false,
      allowBareExecutable: true,
    });
  } catch {
    return null;
  }
  const candidates = /[\\/]/.test(command)
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (process.env.PATH ?? "").split(delimiter).flatMap((dir) =>
        process.platform === "win32"
          ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
              .split(";")
              .map((ext) => join(dir, `${command}${ext.toLowerCase()}`))
              .concat(join(dir, command))
          : [join(dir, command)],
      );
  for (const path of candidates) {
    try {
      accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return path;
    } catch {
      /* Next candidate. */
    }
  }
  return null;
}

export const VIBE_LOOKUP_TIMEOUT_MS = 5_000;

export type CommandResultSubset = Pick<CommandResult, "status" | "exitCode" | "stdout">;

export type ShellCommandRunner = (
  command: string,
  options: { cwd: string; timeoutMs?: number },
) => { result: Promise<CommandResultSubset> };

export type DirectCommandRunner = (spec: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}) => { result: Promise<CommandResultSubset> };

/** Returns the first nonempty output line only for a successful command result. */
export function firstOutputLine(result: CommandResultSubset): string | null {
  if (result.status !== "completed" || result.exitCode !== 0) return null;
  return (
    result.stdout
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

/**
 * Respects VIBE_EXECUTABLE, otherwise performs a bounded platform lookup. Missing lookup results
 * return null; invalid explicit overrides throw.
 */
export async function resolveVibeExecutable(
  options: {
    cwd?: string;
    platform?: NodeJS.Platform;
    runShellCommandImpl?: ShellCommandRunner;
    runCommandImpl?: DirectCommandRunner;
  } = {},
): Promise<string | null> {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  let candidate: string | null;
  const configured = process.env.VIBE_EXECUTABLE?.trim();
  if (configured)
    return normalizeExecutableValue(configured, {
      label: "Mistral Vibe executable",
      cwd,
      allowBareExecutable: true,
    });

  if (platform === "win32") {
    const runner = (options.runCommandImpl ?? (runCommand as DirectCommandRunner))({
      executable: "where.exe",
      args: ["vibe"],
      cwd,
      timeoutMs: VIBE_LOOKUP_TIMEOUT_MS,
    });
    candidate = firstOutputLine(await runner.result);
  } else {
    const runner = (options.runShellCommandImpl ?? (runShellCommand as ShellCommandRunner))(
      "command -v vibe",
      { cwd, timeoutMs: VIBE_LOOKUP_TIMEOUT_MS },
    );
    candidate = firstOutputLine(await runner.result);
  }

  if (!candidate) return null;
  try {
    return normalizeExecutableValue(candidate, {
      label: "Mistral Vibe executable",
      cwd,
      allowBareExecutable: true,
    });
  } catch {
    return null;
  }
}

interface CachedExecutableOptions {
  runCommandImpl?: CommandRunner;
  cwd?: string;
  configuredPath?: string | null;
}
function createCachedExecutableResolver(
  spec: (options?: CachedExecutableOptions) => ExecutableResolverOptions,
) {
  let cached: { key: string; executable: string } | null = null;
  return {
    reset: () => {
      cached = null;
    },
    resolve: async (options?: CachedExecutableOptions): Promise<string> => {
      const cacheable = !options?.configuredPath && !options?.runCommandImpl;
      const resolution = spec(options);
      const key = JSON.stringify([
        resolution.cwd ?? process.cwd(),
        process.env.PATH,
        process.env.PATHEXT,
        resolution.envOverrides?.map((name) => process.env[name]),
        resolution.knownPathDirectories,
        resolution.knownFilePaths,
      ]);
      if (cacheable && cached?.key === key) return cached.executable;
      const result = await resolveExecutable(resolution);
      if (cacheable) cached = { key, executable: result };
      return result;
    },
  };
}
