/**
 * Builds and launches external provider CLI commands (and arbitrary resume commands via
 * `launchCliCommand`) in the inherited terminal with safe hand-off and restoration.
 */

import { type ChildProcess, spawn } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { delimiter, join } from "path";
import { verifyAgyExecutable } from "../executables/antigravityExecutable.js";
import { buildSpawnSpec } from "../executables/executableResolver.js";
import { normalizeExecutableValue } from "../process/processValidation.js";
import { errorMessage } from "../shared/values.js";
import type { ProviderConfig } from "./types.js";

interface ProviderLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
}

export type ProviderLaunchResult =
  | { status: "completed"; exitCode: number | null; signal: NodeJS.Signals | null; message: string }
  | { status: "disabled"; message: string }
  | { status: "missing-command"; message: string }
  | { status: "spawn-error"; message: string; errorCode?: string };

interface RawModeStream {
  isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
}

export interface LaunchProviderCliOptions {
  cwd: string;
  stdin?: RawModeStream | null;
  beforeLaunch?: () => void;
  afterLaunch?: () => void;
  spawnImpl?: typeof spawn;
  commandExists?: (executable: string) => Promise<boolean> | boolean;
}

/** Builds a validated launch specification; platform-specific wrapping happens at spawn time. */
export function buildProviderLaunchSpec(
  provider: ProviderConfig,
  cwd: string,
): ProviderLaunchSpec | ProviderLaunchResult {
  if (!provider.enabled) {
    return {
      status: "disabled",
      message: `${provider.displayName} is disabled. Configure a command in Ubume's provider settings before launching it.`,
    };
  }

  if (!provider.launchCommand?.executable.trim()) {
    return {
      status: "missing-command",
      message: `${provider.displayName} does not have a launch command configured.`,
    };
  }

  try {
    return {
      executable: normalizeExecutableValue(provider.launchCommand.executable, {
        label: `${provider.displayName} launch command`,
        cwd,
      }),
      args: provider.launchCommand.args,
      cwd,
    };
  } catch (error) {
    const message = errorMessage(error, "Invalid launch command.");
    return {
      status: "spawn-error",
      message: `${provider.displayName} has an unsafe launch command. ${message}`,
    };
  }
}

function setRawMode(stdin: RawModeStream | null | undefined, enabled: boolean): void {
  try {
    stdin?.setRawMode?.(enabled);
  } catch {
    // Some test streams and redirected terminals do not support raw-mode changes.
  }
}

function executableLooksLikePath(executable: string): boolean {
  return /[\\/]/.test(executable) || /^[A-Za-z]:/.test(executable);
}

function canAccessExecutable(path: string): boolean {
  try {
    if (process.platform === "win32") {
      return existsSync(path);
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getPathExecutableCandidates(executable: string): string[] {
  if (process.platform !== "win32" || /\.[A-Za-z0-9_-]+$/.test(executable)) {
    return [executable];
  }

  const pathExt = process.env.PATHEXT?.split(";").filter(Boolean) ?? [
    ".COM",
    ".EXE",
    ".BAT",
    ".CMD",
  ];
  return [executable, ...pathExt.map((ext) => `${executable}${ext.toLowerCase()}`)];
}

/** Checks executable availability without launching a provider prompt. */
export async function commandExistsOnPath(executable: string): Promise<boolean> {
  let candidate: string;
  try {
    candidate = normalizeExecutableValue(executable, {
      label: "Provider launch command",
      allowBareExecutable: true,
    });
  } catch {
    return false;
  }

  const trimmed = candidate.trim();
  if (executableLooksLikePath(trimmed)) {
    return canAccessExecutable(trimmed);
  }

  const pathEntries = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
  for (const dir of pathEntries) {
    for (const name of getPathExecutableCandidates(trimmed)) {
      if (canAccessExecutable(join(dir, name))) return true;
    }
  }
  return false;
}

function formatSpawnError(
  displayName: string,
  executable: string,
  error: NodeJS.ErrnoException,
): ProviderLaunchResult {
  if (error.code === "ENOENT") {
    return {
      status: "missing-command",
      message: `${displayName} could not be launched because \`${executable}\` is not installed or not available on PATH.`,
    };
  }

  if (error.code === "EACCES" || error.code === "EPERM") {
    return {
      status: "spawn-error",
      errorCode: error.code,
      message: `${displayName} could not be launched because permission was denied for \`${executable}\`.`,
    };
  }

  return {
    status: "spawn-error",
    errorCode: error.code,
    message: `${displayName} could not be launched. ${error.message}`,
  };
}

/**
 * Builds a provider launch and hands the inherited terminal to it; returns setup/launch failures
 * as structured results.
 */
export async function launchProviderCli(
  provider: ProviderConfig,
  options: LaunchProviderCliOptions,
): Promise<ProviderLaunchResult> {
  const spec = buildProviderLaunchSpec(provider, options.cwd);
  if ("status" in spec) return spec;
  if (provider.id === "google") {
    try {
      await verifyAgyExecutable(spec.executable, { cwd: options.cwd });
    } catch (error) {
      return {
        status: "missing-command",
        message: error instanceof Error ? error.message : "Antigravity CLI is unavailable.",
      };
    }
  }
  return launchCliCommand(provider.displayName, spec, options);
}

/**
 * Suspends raw mode and gives the terminal to `spec` until it exits. Used for
 * provider launches and for resuming native Claude Code / Codex / Vibe sessions.
 */
export async function launchCliCommand(
  displayName: string,
  spec: ProviderLaunchSpec,
  options: Omit<LaunchProviderCliOptions, "cwd">,
): Promise<ProviderLaunchResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const commandExists = options.commandExists ?? commandExistsOnPath;
  const available = await commandExists(spec.executable);
  if (!available) {
    return {
      status: "missing-command",
      message: `${displayName} could not be launched because \`${spec.executable}\` is not installed or not available on PATH.`,
    };
  }

  const wasRaw = Boolean(options.stdin?.isRaw);
  options.beforeLaunch?.();
  setRawMode(options.stdin, false);

  try {
    return await new Promise<ProviderLaunchResult>((resolve) => {
      let child: ChildProcess;
      try {
        const spawnSpec = buildSpawnSpec(spec.executable, spec.args);
        if (!spawnSpec.executable) {
          resolve({ status: "spawn-error", message: "Executable path is empty after resolution." });
          return;
        }
        child = spawnImpl(spawnSpec.executable, spawnSpec.args, {
          cwd: spec.cwd,
          shell: false,
          stdio: "inherit",
        });
      } catch (error) {
        resolve(formatSpawnError(displayName, spec.executable, error as NodeJS.ErrnoException));
        return;
      }

      child.once("error", (error: NodeJS.ErrnoException) => {
        resolve(formatSpawnError(displayName, spec.executable, error));
      });

      child.once("close", (exitCode, signal) => {
        resolve({
          status: "completed",
          exitCode,
          signal,
          message: `${displayName} launch finished${exitCode === null ? "" : ` with exit code ${exitCode}`}.`,
        });
      });
    });
  } finally {
    if (wasRaw) {
      setRawMode(options.stdin, true);
    }
    options.afterLaunch?.();
  }
}
