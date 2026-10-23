#!/usr/bin/env node
/**
 * Read-only static capability audit for Ubume.
 *
 * Walks a fixed list of capability checks; each check verifies that expected
 * source files exist and that the implementation evidence (regexes over file
 * contents) is still present. Prints a PASS/MISSING report and exits 0 when
 * every check passes, 1 otherwise.
 *
 * Usage: node scripts/maintenance/audit-capabilities.mjs   (or: bun run audit:ubume-gap)
 *
 * Maintenance notes:
 *   - The audit is evidence, not proof. A failing check means "the expected
 *     code moved or changed shape" — update the evidence path together with
 *     `audit-capabilities.test.ts` in the same change; do not treat a
 *     failure as automatic proof the feature is absent.
 *   - Every check must stay read-only: this script only reads files under the
 *     repository root and runs git-free; it contacts nothing.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT as repoRoot } from "../lib/repo-root.mjs";

// ---------------------------------------------------------------------------
// Shared evidence helpers
// ---------------------------------------------------------------------------

/** Concatenated source of every TS/TSX file under src/app (implementation evidence). */
function readAppSources() {
  const root = join(repoRoot, "src", "app");
  return readdirSync(root, { recursive: true })
    .filter((file) => /\.tsx?$/.test(file))
    .sort()
    .map((file) => readFileSync(join(root, file), "utf-8"))
    .join("\n");
}

/** File content, or empty string when the file is missing. */
function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/** The subset of `paths` that exists on disk. */
function existingPaths(paths) {
  return paths.filter((path) => existsSync(path));
}

/** Human-readable list of failed evidence labels ("a, b, c"). */
function missingEvidence(labels) {
  return labels.filter(Boolean).join(", ");
}

/** Common check shape: pass flag, evidence file list, and a reason string. */
function result(pass, evidence, reason) {
  return { pass, evidence, reason };
}

// ---------------------------------------------------------------------------
// Capability checks
// ---------------------------------------------------------------------------

const checks = {
  entrypoint() {
    const path = join(repoRoot, "bin", "ubume.js");
    const exists = existsSync(path);
    return result(
      exists,
      exists ? [path] : [],
      exists ? "Entry wrapper spawns Bun runtime to execute app" : "Entry wrapper not found",
    );
  },

  cliHelpVersion() {
    const launchArgsPath = join(repoRoot, "src", "config", "launchArgs.ts");
    const launcherPath = join(repoRoot, "bin", "ubume.js");
    if (!existsSync(launchArgsPath) || !existsSync(launcherPath)) {
      return result(false, [], "launch arg parser or launcher not found");
    }

    const launchArgsContent = readText(launchArgsPath);
    const launcherContent = readText(launcherPath);
    const combined = `${launchArgsContent}\n${launcherContent}`;
    const hasHelp = /--help/.test(combined) && /["']-h["']/.test(combined);
    const hasVersion = /--version/.test(combined) && /["']-v["']/.test(combined);
    const exitsBeforeInk = /process\.exit\(0\)/.test(launcherContent) && !/render\(/.test(launcherContent);
    const readsPackageVersion = /package\.json/.test(launcherContent) && /version/.test(launcherContent);

    const pass = hasHelp && hasVersion && exitsBeforeInk && readsPackageVersion;
    return result(
      pass,
      [launchArgsPath, launcherPath],
      pass
        ? "--help/-h and --version/-v exit from launcher before Ink and version reads package.json"
        : `Missing evidence: ${missingEvidence([
          hasHelp ? null : "help flags",
          hasVersion ? null : "version flags",
          exitsBeforeInk ? null : "early exit before Ink",
          readsPackageVersion ? null : "package.json version read",
        ])}`,
    );
  },

  initialPromptArgument() {
    const path = join(repoRoot, "src", "config", "launchArgs.ts");
    const appPath = join(repoRoot, "src", "app", "App.tsx");

    if (!existsSync(path) || !existsSync(appPath)) {
      return result(false, [], "Required files not found");
    }

    const launchContent = readText(path);
    const appContent = readAppSources();
    const hasExtraction = /initialPrompt/.test(launchContent) && /promptArgs/.test(launchContent);
    const hasUsage = /launchArgs\.initialPrompt/.test(appContent)
      && /initialPromptSubmittedRef/.test(appContent)
      && /startPromptRun\(initialPrompt,\s*initialPrompt,/.test(appContent);

    return result(
      hasExtraction && hasUsage,
      [path, appPath],
      hasExtraction && hasUsage
        ? "Initial prompt support present"
        : "Passthrough args stored but not used for initial prompt",
    );
  },

  interactiveMode() {
    const indexPath = join(repoRoot, "src", "index.tsx");
    if (!existsSync(indexPath)) {
      return result(false, [], "src/index.tsx not found");
    }

    const content = readText(indexPath);
    const hasTTY = /isTTY|TTY|isatty/.test(content);
    const hasInk = /render\(|<App/.test(content);

    return result(
      hasTTY && hasInk,
      [indexPath],
      hasTTY && hasInk ? "Interactive mode with TTY detection and Ink UI present" : "TTY or UI setup missing",
    );
  },

  modelPicker() {
    const paths = [
      join(repoRoot, "src", "ui", "panels", "ModelPickerScreen.tsx"),
      join(repoRoot, "src", "config", "settings.ts"),
    ];

    const exist = existingPaths(paths);
    const hasModels = exist.some((path) => /LEGACY_FALLBACK_MODELS/.test(readText(path)));

    return result(
      exist.length === 2 && hasModels,
      exist,
      exist.length === 2 && hasModels
        ? "Model picker UI and model enumeration present"
        : `Missing components: ${exist.length}/2`,
    );
  },

  configLoading() {
    const paths = [
      join(repoRoot, "src", "config", "layeredConfig.ts"),
      join(repoRoot, "src", "config", "persistence.ts"),
      join(repoRoot, "src", "config", "runtimeConfig.ts"),
    ];

    const exist = existingPaths(paths);
    return result(
      exist.length === paths.length,
      exist,
      exist.length === 3
        ? "Layered config resolution, persistence, and runtime config present"
        : `Found ${exist.length}/3 config modules`,
    );
  },

  agentsmdSupport() {
    const loaderPath = join(repoRoot, "src", "core", "workspace", "projectInstructions.ts");
    const appPath = join(repoRoot, "src", "app", "App.tsx");
    const promptPath = join(repoRoot, "src", "core", "codex", "codexPrompt.ts");
    const providerPath = join(repoRoot, "src", "core", "providers", "codexSubprocess.ts");

    const paths = [loaderPath, appPath, promptPath, providerPath];
    const existing = existingPaths(paths);
    if (existing.length !== paths.length) {
      return result(false, existing, `Found ${existing.length}/4 AGENTS.md support files`);
    }

    const loaderContent = readText(loaderPath);
    const appContent = readAppSources();
    const promptContent = readText(promptPath);
    const providerContent = readText(providerPath);
    const discoversAgents = /AGENTS\.md/.test(loaderContent) && /\.codex/.test(loaderContent);
    const appLoadsAgents = /loadProjectInstructions/.test(appContent) && /projectInstructions/.test(appContent);
    const promptInjectsAgents = /Project instructions:/.test(promptContent) && /projectInstructions/.test(promptContent);
    const providerPassesAgents = /projectInstructions/.test(providerContent) && /buildCodexPrompt/.test(providerContent);

    const pass = discoversAgents && appLoadsAgents && promptInjectsAgents && providerPassesAgents;
    return result(
      pass,
      paths,
      pass
        ? "AGENTS.md/.codex/AGENTS.md discovery, app loading, and prompt injection present"
        : `Missing evidence: ${missingEvidence([
          discoversAgents ? null : "discovery",
          appLoadsAgents ? null : "app loading",
          promptInjectsAgents ? null : "prompt injection",
          providerPassesAgents ? null : "provider pass-through",
        ])}`,
    );
  },

  commandExecution() {
    const path = join(repoRoot, "src", "core", "process", "commandRunner.ts");
    if (!existsSync(path)) {
      return result(false, [], "commandRunner.ts not found");
    }

    const content = readText(path);
    const hasRun = /runCommand|spawn/.test(content);
    const hasOutput = /stdout|stderr/.test(content);

    return result(
      hasRun && hasOutput,
      [path],
      hasRun && hasOutput ? "Shell command execution with output capture present" : "Command execution incomplete",
    );
  },

  fileEditingLayer() {
    const paths = [
      join(repoRoot, "src", "core", "workspace", "workspaceActivity.ts"),
      join(repoRoot, "src", "core", "workspace", "workspaceGuard.ts"),
    ];

    const exist = existingPaths(paths);
    const content = exist.map((path) => readText(path)).join("");
    const hasTracking = /createWorkspaceActivityTracker|modified|created|deleted/.test(content);
    const hasGuard = /isPathInsideWorkspace|workspaceGuard/.test(content);

    return result(
      exist.length === 2 && hasTracking && hasGuard,
      exist,
      hasTracking && hasGuard
        ? "File activity tracking and workspace guard present"
        : exist.length < 2 ? "Activity or guard module missing" : "Tracking/guard logic incomplete",
    );
  },

  diffRenderer() {
    const rendererPath = join(repoRoot, "src", "ui", "render", "diffRenderer.ts");
    const testPath = join(repoRoot, "src", "ui", "render", "diffRenderer.test.ts");
    const markdownPath = join(repoRoot, "src", "ui", "render", "Markdown.tsx");
    const timelinePath = join(repoRoot, "src", "ui", "timeline", "measure", "markdownRows.ts");
    const paths = [rendererPath, testPath, markdownPath, timelinePath];
    const existing = existingPaths(paths);

    if (existing.length !== paths.length) {
      return result(false, existing, `Found ${existing.length}/4 diff renderer files/integrations`);
    }

    const rendererContent = readText(rendererPath);
    const testContent = readText(testPath);
    const markdownContent = readText(markdownPath);
    const timelineContent = readText(timelinePath);
    const exportsUtility = /export\s+function\s+isUnifiedDiff/.test(rendererContent)
      && /export\s+function\s+renderUnifiedDiff/.test(rendererContent)
      && /export\s+function\s+maybeRenderDiff/.test(rendererContent)
      && /DiffRenderLine/.test(rendererContent);
    const detectsUnifiedDiff = /DIFF_GIT_HEADER_PATTERN/.test(rendererContent)
      && /HUNK_HEADER_PATTERN/.test(rendererContent)
      && /OLD_FILE_HEADER_PATTERN/.test(rendererContent)
      && /NEW_FILE_HEADER_PATTERN/.test(rendererContent);
    const hasFocusedTests = /isUnifiedDiff/.test(testContent)
      && /renderUnifiedDiff/.test(testContent)
      && /ANSI|control/i.test(testContent)
      && /normal text|normal prose/i.test(testContent);
    const markdownIntegrated = /measure\/markdownRows/.test(markdownContent)
      && /buildMarkdownRows/.test(markdownContent);
    const timelineIntegrated = /diffRenderer/.test(timelineContent) && /maybeRenderDiff/.test(timelineContent);

    const pass = exportsUtility && detectsUnifiedDiff && hasFocusedTests && markdownIntegrated && timelineIntegrated;
    return result(
      pass,
      paths,
      pass
        ? "Unified diff renderer utility, tests, and UI integrations present"
        : `Missing evidence: ${missingEvidence([
          exportsUtility ? null : "utility exports",
          detectsUnifiedDiff ? null : "unified diff detection",
          hasFocusedTests ? null : "focused tests",
          markdownIntegrated ? null : "Markdown integration",
          timelineIntegrated ? null : "timeline integration",
        ])}`,
    );
  },

  approvalSandboxLogic() {
    const paths = [
      join(repoRoot, "src", "core", "workspace", "workspaceGuard.ts"),
      join(repoRoot, "src", "config", "runtimeConfig.ts"),
    ];

    const exist = existingPaths(paths);
    const content = exist.map((path) => readText(path)).join("");
    const hasSandbox = /sandbox|approval|permission|writable.*root/.test(content);

    return result(
      exist.length === 2 && hasSandbox,
      exist,
      hasSandbox ? "Sandbox configuration and approval logic present" : "Approval or sandbox logic missing",
    );
  },

  sessionHistoryPersistence() {
    const paths = [
      join(repoRoot, "src", "session", "types.ts"),
      join(repoRoot, "src", "session", "appSession.ts"),
      join(repoRoot, "src", "config", "persistence.ts"),
    ];

    const exist = existingPaths(paths);
    return result(
      exist.length === 3,
      exist,
      exist.length === 3
        ? "Session event types, state management, and persistence present"
        : `Found ${exist.length}/3 session modules`,
    );
  },

  debugLogging() {
    const debugPath = join(repoRoot, "src", "core", "perf", "debugLog.ts");
    const envPath = join(repoRoot, "bin", "ubume.js");

    const debugExists = existsSync(debugPath);
    const envContent = readText(envPath);
    const hasEnvDebug = /UBUME_DEBUG|debug/.test(envContent);

    return result(
      debugExists || hasEnvDebug,
      [debugExists ? debugPath : envPath].filter((path) => existsSync(path)),
      debugExists && hasEnvDebug
        ? "Debug logging module and environment variable support present"
        : debugExists || hasEnvDebug
          ? "Partial debug support"
          : "Debug logging not found",
    );
  },

  windowsPowerShellHandling() {
    const launcherPath = join(repoRoot, "bin", "ubume.js");
    if (!existsSync(launcherPath)) {
      return result(false, [], "Launcher not found");
    }

    const content = readText(launcherPath);
    const hasWinDetect = /win32|platform|windows/i.test(content);
    const hasExeResolution = /bun\.exe|bun\.cmd|shell|spawn/.test(content);

    return result(
      hasWinDetect && hasExeResolution,
      [launcherPath],
      hasWinDetect && hasExeResolution
        ? "Windows platform detection and executable resolution present"
        : "Windows-specific handling incomplete",
    );
  },

  resizeHandling() {
    const indexPath = join(repoRoot, "src", "index.tsx");
    if (!existsSync(indexPath)) {
      return result(false, [], "src/index.tsx not found");
    }

    const content = readText(indexPath);
    const hasResize = /resize|onResize|RESIZE/.test(content);
    const hasRepaint = /repaint|recalculate|calculateLayout/.test(content);

    return result(
      hasResize && hasRepaint,
      [indexPath],
      hasResize && hasRepaint
        ? "Terminal resize event handling and UI recalculation present"
        : "Resize handling incomplete",
    );
  },

  streamingHandler() {
    const paths = [
      join(repoRoot, "src", "core", "providers", "codexSubprocess.ts"),
      join(repoRoot, "src", "core", "providers", "codexJsonStream.ts"),
      join(repoRoot, "src", "core", "providers", "codexTranscript.ts"),
    ];

    const exist = existingPaths(paths);
    const content = exist.map((path) => readText(path)).join("");
    const hasStreaming = /stream|emit|chunk|line|onLine/.test(content);

    return result(
      exist.length === paths.length && hasStreaming,
      exist,
      exist.length === paths.length && hasStreaming
        ? "Streaming response handler present"
        : `Streaming implementation incomplete: found ${exist.length}/${paths.length} modules`,
    );
  },

  interruptCancelHandling() {
    const indexPath = join(repoRoot, "src", "index.tsx");
    const appPath = join(repoRoot, "src", "app", "App.tsx");

    const paths = [indexPath, appPath].filter((path) => existsSync(path));
    const content = paths.map((path) => (path === appPath ? readAppSources() : readText(path))).join("");
    const hasSignals = /SIGINT|SIGTERM|signal|cancel/.test(content);
    const hasCancel = /cancel|abort|kill/.test(content);

    return result(
      hasSignals && hasCancel,
      paths,
      hasSignals && hasCancel
        ? "Signal handling and cancellation logic present"
        : "Interrupt/cancel handling incomplete",
    );
  },
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function statusSymbol(pass) {
  return pass ? "✓" : "✗";
}

function statusLabel(pass) {
  return pass ? "PASS" : "MISSING";
}

function formatName(name) {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase());
}

function printCheck(name, result) {
  const symbol = statusSymbol(result.pass);
  const status = statusLabel(result.pass);
  const formattedName = formatName(name);

  console.log(`${symbol} ${status.padEnd(8)} | ${formattedName}`);
  console.log(`           ${result.reason}`);
  if (result.evidence.length > 0) {
    console.log(`           Evidence: ${result.evidence.map((entry) => entry.replace(repoRoot, ".")).join(", ")}`);
  }
  console.log();
}

function runAudit() {
  console.log("\n" + "=".repeat(80));
  console.log("UBUME CAPABILITY AUDIT REPORT");
  console.log("=".repeat(80));
  console.log(`Repository: ${repoRoot}\n`);

  const results = [];
  for (const [name, checkFn] of Object.entries(checks)) {
    const checkResult = checkFn();
    results.push({ name, ...checkResult });
    printCheck(name, checkResult);
  }

  const total = results.length;
  const passed = results.filter((entry) => entry.pass).length;
  const missing = total - passed;
  const pctComplete = Math.round((passed / total) * 100);

  console.log("=".repeat(80));
  console.log("CAPABILITY SUMMARY");
  console.log("=".repeat(80));
  console.log(`Total checks:        ${total}`);
  console.log(`Passed:              ${passed} (${pctComplete}%)`);
  console.log(`Missing/Partial:     ${missing} (${100 - pctComplete}%)`);
  console.log();

  const missingFeatures = results.filter((entry) => !entry.pass).map((entry) => formatName(entry.name));

  if (missingFeatures.length > 0) {
    console.log("TOP MISSING FEATURES:");
    missingFeatures.forEach((feature, index) => {
      console.log(`  ${index + 1}. ${feature}`);
    });
    console.log();
  }

  console.log("=".repeat(80));
  console.log();

  process.exit(passed === total ? 0 : 1);
}

runAudit();
