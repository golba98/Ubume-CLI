/**
 * Detects Codex exec flags from help output, independently of model capabilities. Successful
 * probes are cached by executable; failed probes are evicted so later calls can retry.
 */

import { captureCodexProcessOutput } from "../executables/codexExecutable.js";
import { stripAnsi, stripNonPrintableControls } from "../providers/codexTranscript.js";
import { normalizeLineBreaks } from "../shared/text.js";

const HELP_TIMEOUT_MS = 5000;

export interface CodexCliCapabilities {
  askForApproval: boolean;
  sandbox: boolean;
  config: boolean;
  fullAuto: boolean;
  image?: boolean;
  resume?: { jsonFlag: "--json" | "--experimental-json"; image: boolean; skipGit: boolean };
}

const capabilityCache = new Map<string, Promise<CodexCliCapabilities>>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHelpText(text: string): string {
  return normalizeLineBreaks(stripNonPrintableControls(stripAnsi(text))).toLowerCase();
}

// Uses a hand-rolled word-boundary pattern rather than \b so that flag names
// containing hyphens (e.g. --ask-for-approval) are matched reliably.
function hasCliToken(helpText: string, token: string): boolean {
  const pattern = new RegExp(
    `(^|[^a-z0-9-])${escapeRegExp(token.toLowerCase())}(?=$|[^a-z0-9-])`,
    "m",
  );
  return pattern.test(helpText);
}

/** Reads exec-help flags only; top-level help is retained in the signature for compatibility. */
export function parseCodexCliCapabilities(
  execHelpText: string,
  _topLevelHelpText: string,
  resumeHelpText = "",
): CodexCliCapabilities {
  const execHelp = normalizeHelpText(execHelpText);
  const resumeHelp = normalizeHelpText(resumeHelpText);
  const jsonFlag = hasCliToken(resumeHelp, "--json")
    ? "--json"
    : hasCliToken(resumeHelp, "--experimental-json")
      ? "--experimental-json"
      : null;

  return {
    askForApproval: hasCliToken(execHelp, "--ask-for-approval"),
    sandbox: hasCliToken(execHelp, "--sandbox"),
    config: hasCliToken(execHelp, "--config") || hasCliToken(execHelp, "-c"),
    fullAuto: hasCliToken(execHelp, "--full-auto"),
    image: hasCliToken(execHelp, "--image") || hasCliToken(execHelp, "-i"),
    ...(jsonFlag && hasCliToken(resumeHelp, "--config") && hasCliToken(resumeHelp, "--model")
      ? {
          resume: {
            jsonFlag,
            image: hasCliToken(resumeHelp, "--image"),
            skipGit: hasCliToken(resumeHelp, "--skip-git-repo-check"),
          },
        }
      : {}),
  };
}

/**
 * Coalesces help probes per executable. Failed probes are evicted and reject; successful results
 * remain cached for this process.
 */
export async function getCodexCliCapabilities(executable: string): Promise<CodexCliCapabilities> {
  const cached = capabilityCache.get(executable);
  if (cached) {
    return cached;
  }

  const inFlight = (async () => {
    const [execHelp, topLevelHelp] = await Promise.allSettled([
      captureCodexProcessOutput(executable, ["exec", "--help"], HELP_TIMEOUT_MS),
      captureCodexProcessOutput(executable, ["--help"], HELP_TIMEOUT_MS),
    ]);

    const outputs: string[] = [];

    if (execHelp.status === "fulfilled") {
      outputs.push(execHelp.value.stdout, execHelp.value.stderr);
    }

    if (topLevelHelp.status === "fulfilled") {
      outputs.push(topLevelHelp.value.stdout, topLevelHelp.value.stderr);
    }

    if (outputs.length === 0) {
      if (execHelp.status === "rejected") {
        throw execHelp.reason;
      }

      if (topLevelHelp.status === "rejected") {
        throw topLevelHelp.reason;
      }

      throw new Error("Unable to determine Codex CLI capabilities from help output.");
    }

    let resumeHelp = "";
    if (execHelp.status === "fulfilled" && /\bresume\b/.test(execHelp.value.stdout)) {
      try {
        const result = await captureCodexProcessOutput(
          executable,
          ["exec", "resume", "--help"],
          HELP_TIMEOUT_MS,
        );
        resumeHelp = `${result.stdout}\n${result.stderr}`;
      } catch {
        /* Unsupported resume: context reconstruction remains available. */
      }
    }
    return parseCodexCliCapabilities(
      execHelp.status === "fulfilled" ? `${execHelp.value.stdout}\n${execHelp.value.stderr}` : "",
      topLevelHelp.status === "fulfilled"
        ? `${topLevelHelp.value.stdout}\n${topLevelHelp.value.stderr}`
        : "",
      resumeHelp,
    );
  })();

  capabilityCache.set(executable, inFlight);

  try {
    return await inFlight;
  } catch (error) {
    capabilityCache.delete(executable);
    throw error;
  }
}
