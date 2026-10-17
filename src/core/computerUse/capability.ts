/**
 * Resolves browser enablement and capability policy from runtime configuration.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const nodeAvailability = new Map<string, boolean>();
function hasNode(env: NodeJS.ProcessEnv): boolean {
  const executable = env.UBUME_NODE_PATH?.trim() || "node";
  const key = `${executable}:${env.PATH ?? process.env.PATH}`;
  if (!nodeAvailability.has(key)) {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, ...env },
    });
    nodeAvailability.set(
      key,
      result.status === 0 && /^v(?:1[89]|[2-9]\d)\./.test(result.stdout ?? ""),
    );
  }
  return nodeAvailability.get(key)!;
}

export type BrowserMode = "auto" | "headed" | "headless";
export interface ComputerUseCapability {
  kind: "browser";
  status: "available" | "unavailable";
  reason: string;
  executablePath?: string;
  mode: BrowserMode;
  headedSupported: boolean;
}

/**
 * Detects a likely local desktop session; CI and SSH remain headless even when display variables
 * are present.
 */
export function hasDesktopDisplay(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): boolean {
  if (env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  return platform === "linux"
    ? Boolean(env.WAYLAND_DISPLAY || env.DISPLAY)
    : platform === "darwin" || platform === "win32";
}

/**
 * Checks browser configuration, executable presence and Node availability without starting
 * Chromium or installing dependencies.
 */
export function resolveBrowserCapability(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseCapability {
  const mode = env.UBUME_BROWSER_MODE ?? "auto";
  const base = {
    kind: "browser" as const,
    mode: (["auto", "headed", "headless"].includes(mode) ? mode : "auto") as BrowserMode,
    headedSupported: hasDesktopDisplay(env),
  };
  if (!["auto", "headed", "headless"].includes(mode))
    return {
      ...base,
      status: "unavailable",
      reason: "UBUME_BROWSER_MODE must be auto, headed, or headless.",
    };
  if (env.UBUME_BROWSER_ENABLED === "0" || env.UBUME_BROWSER_ENABLED === "false")
    return {
      ...base,
      status: "unavailable",
      reason: "Browser tools disabled by UBUME_BROWSER_ENABLED.",
    };
  try {
    const require = createRequire(import.meta.url);
    const { chromium } = require("playwright") as typeof import("playwright");
    const executablePath = env.UBUME_BROWSER_EXECUTABLE_PATH?.trim() || chromium.executablePath();
    if (existsSync(executablePath) && !hasNode(env))
      return {
        ...base,
        status: "unavailable",
        reason: "Node 18+ is required for browser execution. Install Node or set UBUME_NODE_PATH.",
      };
    return existsSync(executablePath)
      ? {
          ...base,
          status: "available",
          executablePath,
          reason:
            "Chromium executable found; launch verifies host dependencies and sandbox support.",
        }
      : {
          ...base,
          status: "unavailable",
          reason:
            "Chromium executable missing. Run ubume browser install, or set UBUME_BROWSER_EXECUTABLE_PATH.",
        };
  } catch {
    return {
      ...base,
      status: "unavailable",
      reason: "Playwright unavailable. Reinstall Ubume, then run ubume browser install.",
    };
  }
}
