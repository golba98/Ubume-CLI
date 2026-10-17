/**
 * Resolves the Codex executable and verifies usable command candidates.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { runCommand } from "../process/commandRunner.js";
import { buildSpawnSpec, resolveExecutable } from "./executableResolver.js";

type CommandRunner = typeof runCommand;

let cachedExecutable: string | null = null;
let resolveInFlight: Promise<string> | null = null;

interface SpawnOptions {
  detached?: boolean;
  stdio: ["ignore" | "pipe", "pipe", "pipe"];
}

interface CapturedProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Clears the default executable cache for tests without canceling an in-flight resolution.
 */
export function resetCodexExecutableCacheForTests(): void {
  cachedExecutable = null;
}

/**
 * Resolves explicit overrides independently; default resolution shares an in-flight request and
 * caches the resulting command.
 */
export async function resolveCodexExecutable(options?: {
  runCommandImpl?: CommandRunner;
  cwd?: string;
  configuredPath?: string | null;
}): Promise<string> {
  if (!options?.configuredPath && !options?.runCommandImpl && cachedExecutable !== null) {
    return cachedExecutable;
  }

  if (!options?.configuredPath && !options?.runCommandImpl) {
    if (resolveInFlight) return resolveInFlight;

    resolveInFlight = (async () => {
      const result = await doResolveCodexExecutable(options);
      cachedExecutable = result;
      return result;
    })();

    try {
      return await resolveInFlight;
    } finally {
      resolveInFlight = null;
    }
  }

  return doResolveCodexExecutable(options);
}

async function doResolveCodexExecutable(options?: {
  runCommandImpl?: CommandRunner;
  cwd?: string;
  configuredPath?: string | null;
}): Promise<string> {
  const knownFilePaths: string[] = [];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    knownFilePaths.push(join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "codex.exe"));
  }

  return resolveExecutable({
    runCommandImpl: options?.runCommandImpl,
    cwd: options?.cwd,
    configuredPath: options?.configuredPath,
    envOverrides: ["CODEX_EXECUTABLE"],
    commandNames: process.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"],
    knownFilePaths,
    label: "codex",
  });
}

/** Adds installation or permission recovery guidance to a Codex spawn error. */
export function formatCodexLaunchError(err: NodeJS.ErrnoException): string {
  const detail = err.message ? `\n\nDetails: ${err.message}` : "";

  if (err.code === "ENOENT") {
    return (
      [
        "Codex executable was not found in PATH.",
        "Set CODEX_EXECUTABLE to your working command/path, then restart Ubume.",
        "Alternative: install CLI with `npm install -g @openai/codex`.",
      ].join("\n") + detail
    );
  }

  if (err.code === "EACCES" || err.code === "EPERM") {
    return (
      [
        "Codex appears installed but this process cannot launch it (permission blocked).",
        "Set CODEX_EXECUTABLE to a working CLI command/path and restart Ubume.",
        "Windows note: Codex docs recommend WSL for the best CLI experience.",
      ].join("\n") + detail
    );
  }

  return err.message;
}

/**
 * Spawns Codex without shell expansion, wrapping Windows batch commands through the shared
 * validated spawn specification.
 */
export function spawnCodexProcess(
  executable: string,
  args: string[],
  options: SpawnOptions,
): ReturnType<typeof spawn> {
  const spec = buildSpawnSpec(executable, args);
  if (!spec.executable) throw new Error("Codex executable path is empty.");
  return spawn(spec.executable, spec.args, { ...options, shell: false });
}

/**
 * Captures both streams until close. Spawn errors and timeout reject; timeout requests child
 * termination, while nonzero exits remain ordinary results.
 */
export function captureCodexProcessOutput(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<CapturedProcessOutput> {
  return new Promise<CapturedProcessOutput>((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawnCodexProcess(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      proc.kill();
      const error = new Error(
        `Timed out waiting for Codex command: ${args.join(" ")}`,
      ) as NodeJS.ErrnoException;
      error.code = "ETIME";
      finish(() => reject(error));
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      finish(() => reject(error));
    });

    proc.on("close", (exitCode) => {
      finish(() =>
        resolve({
          exitCode,
          stdout,
          stderr,
        }),
      );
    });
  });
}
