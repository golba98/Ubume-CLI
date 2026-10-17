import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyLayeredRuntimeOverride,
  formatLayeredConfigStatus,
  mergeRuntimeIntoTomlConfig,
  resolveLayeredConfig,
} from "./layeredConfig.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtimeConfig.js";

test("resolves user config, trusted project config, profiles, and CLI overrides deterministically", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-layered-config-"));
  const tempHome = join(tempRoot, "home");
  const workspaceRoot = join(tempRoot, "repo", "packages", "app");
  const projectRoot = join(tempRoot, "repo");
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".codex"), { recursive: true });
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    mkdirSync(tempHome, { recursive: true });

    writeFileSync(
      join(tempHome, "config.toml"),
      [
        'model = "gpt-5.2"',
        "[ubume]",
        'backend = "openai-native"',
        "",
        "[profiles.review]",
        'service_tier = "fast"',
      ].join("\n"),
      "utf-8",
    );

    writeFileSync(
      join(projectRoot, ".codex", "config.toml"),
      [
        'model = "gpt-5.4"',
        'profile = "review"',
        "[ubume]",
        'mode = "suggest"',
        "plan_mode = true",
        "",
        "[profiles.review]",
        'approval_policy = "never"',
        "",
        "[profiles.review.sandbox_workspace_write]",
        "network_access = true",
        'writable_roots = ["./roots/project"]',
      ].join("\n"),
      "utf-8",
    );

    writeFileSync(
      join(workspaceRoot, ".codex", "config.toml"),
      [
        'personality = "pragmatic"',
        "",
        "[profiles.review]",
        'model_reasoning_effort = "high"',
      ].join("\n"),
      "utf-8",
    );

    const trustStore = await import(`./trustStore.js?layered-trust=${Date.now()}`);
    trustStore.setProjectTrust(projectRoot, true);

    const result = resolveLayeredConfig({
      workspaceRoot,
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: null,
        profile: null,
        configOverrides: ['model="gpt-5.4-mini"', 'ubume.mode="full-auto"', "mcp.enabled=true"],
        passthroughArgs: [],
        modelOverride: "gpt-5.4-mini",
        noClear: false,
      },
    });

    // The retired openai-native backend is ignored and falls back to the default.
    assert.equal(result.runtime.provider, "codex-subprocess");
    assert.ok(
      result.diagnostics.ignoredEntries.some((entry: string) => /ubume\.backend/.test(entry)),
    );
    assert.equal(result.runtime.model, "gpt-5.4-mini");
    assert.equal(result.runtime.reasoningLevel, "high");
    assert.equal(result.runtime.mode, "full-auto");
    assert.equal(result.runtime.planMode, true);
    assert.equal(result.runtime.policy.approvalPolicy, "never");
    assert.equal(result.runtime.policy.networkAccess, "enabled");
    assert.equal(result.runtime.policy.serviceTier, "fast");
    assert.equal(result.runtime.policy.personality, "pragmatic");
    assert.equal(result.diagnostics.selectedProfile, "review");
    assert.equal(result.diagnostics.selectedProfileSource, "Project config");
    assert.equal(result.diagnostics.projectTrusted, true);
    assert.match(result.runtime.policy.writableRoots[0] ?? "", /roots[\\/]project/i);
    assert.match(result.diagnostics.fieldSources.model, /CLI override/i);
    assert.match(
      result.diagnostics.fieldSources["policy.approvalPolicy"],
      /Profile review from Project config/i,
    );
    assert.ok(
      result.diagnostics.ignoredEntries.some((entry: string) => /mcp\.enabled/i.test(entry)),
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("blocks project config when the detected project root is untrusted", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-layered-untrusted-"));
  const tempHome = join(tempRoot, "home");
  const workspaceRoot = join(tempRoot, "repo", "app");
  const projectRoot = join(tempRoot, "repo");
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    mkdirSync(tempHome, { recursive: true });

    writeFileSync(join(tempHome, "config.toml"), 'model = "gpt-5.2"\n', "utf-8");
    writeFileSync(join(projectRoot, ".codex", "config.toml"), 'model = "gpt-5.4-mini"\n', "utf-8");

    const result = resolveLayeredConfig({
      workspaceRoot,
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: null,
        profile: null,
        configOverrides: [],
        passthroughArgs: [],
        modelOverride: null,
        noClear: false,
      },
    });

    assert.equal(result.runtime.model, "gpt-5.2");
    assert.equal(result.diagnostics.projectTrusted, false);
    assert.ok(
      result.diagnostics.layers.some((layer: { status: string }) => layer.status === "blocked"),
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("falls back to built-in defaults when no user or project configs exist", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-layered-defaults-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempRoot, "non-existent-home");

  try {
    const result = resolveLayeredConfig({
      workspaceRoot: tempRoot,
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: null,
        profile: null,
        configOverrides: [],
        passthroughArgs: [],
        modelOverride: null,
        noClear: false,
      },
    });

    assert.equal(result.runtime.model, DEFAULT_RUNTIME_CONFIG.model);
    assert.equal(result.runtime.mode, DEFAULT_RUNTIME_CONFIG.mode);
    assert.equal(result.diagnostics.fieldSources.model, "Built-in defaults");
    assert.equal(result.diagnostics.fieldSources.mode, "Built-in defaults");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("handles legacy codexa.* CLI override keys and translates them to ubume.*", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-layered-legacy-cli-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempRoot, "home");

  try {
    const result = resolveLayeredConfig({
      workspaceRoot: tempRoot,
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: null,
        profile: null,
        configOverrides: ['codexa.mode="suggest"'],
        passthroughArgs: [],
        modelOverride: null,
        noClear: false,
      },
    });

    assert.equal(result.runtime.mode, "suggest");
    assert.match(result.diagnostics.fieldSources.mode, /CLI override/i);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("records warning when selected profile is not found", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-layered-missing-prof-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempRoot, "home");

  try {
    const result = resolveLayeredConfig({
      workspaceRoot: tempRoot,
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: null,
        profile: "non-existent-profile",
        configOverrides: [],
        passthroughArgs: [],
        modelOverride: null,
        noClear: false,
      },
    });

    assert.equal(result.diagnostics.selectedProfile, "non-existent-profile");
    assert.ok(
      result.diagnostics.ignoredEntries.some((entry) =>
        entry.includes("Selected profile not found: non-existent-profile"),
      ),
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("applyLayeredRuntimeOverride updates runtime and diagnostic field sources", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ubume-layered-override-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tempRoot, "home");

  try {
    const initial = resolveLayeredConfig({
      workspaceRoot: tempRoot,
      launchArgs: {
        help: false,
        version: false,
        initialPrompt: null,
        profile: null,
        configOverrides: [],
        passthroughArgs: [],
        modelOverride: null,
        noClear: false,
      },
    });

    const updated = applyLayeredRuntimeOverride(
      initial,
      { model: "gpt-5.5", mode: "suggest" },
      "Interactive /model command",
    );

    assert.equal(updated.runtime.model, "gpt-5.5");
    assert.equal(updated.runtime.mode, "suggest");
    assert.equal(updated.diagnostics.fieldSources.model, "Interactive /model command");
    assert.equal(updated.diagnostics.fieldSources.mode, "Interactive /model command");

    // Formatted status outputs winning sources and layers
    const statusText = formatLayeredConfigStatus(updated);
    assert.ok(statusText.includes("Config status:"));
    assert.ok(statusText.includes("Interactive /model command"));
    assert.ok(statusText.includes("Winning sources:"));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("mergeRuntimeIntoTomlConfig preserves existing TOML tables and values", () => {
  const existingToml = {
    model: "gpt-5.4",
    custom_field: "preserve_me",
    ubume: {
      mode: "suggest",
    },
  };

  const runtime = {
    ...DEFAULT_RUNTIME_CONFIG,
    model: "gpt-5.5", // Different from default, but existingToml already has model so it shouldn't overwrite
    policy: {
      ...DEFAULT_RUNTIME_CONFIG.policy,
      personality: "friendly" as const, // Different from default, not in existingToml
    },
  };

  const merged = mergeRuntimeIntoTomlConfig(existingToml, runtime);
  assert.equal(merged.model, "gpt-5.4"); // Kept existing
  assert.equal(merged.custom_field, "preserve_me"); // Kept custom
  assert.equal(merged.personality, "friendly"); // Added new
});

test("handles antigravity_command_path override and reports gemini_command_path removal", () => {
  const result = resolveLayeredConfig({
    workspaceRoot: process.cwd(),
    launchArgs: {
      help: false,
      version: false,
      initialPrompt: null,
      profile: null,
      configOverrides: [
        'antigravity_command_path="/usr/local/bin/agy"',
        'gemini_command_path="/old/bin/gemini"',
      ],
      passthroughArgs: [],
      modelOverride: null,
      noClear: false,
    },
  });

  assert.equal(result.runtime.antigravityCommandPath, "/usr/local/bin/agy");
  assert.ok(
    result.diagnostics.ignoredEntries.some((entry) =>
      entry.includes("gemini_command_path (removed; not an Antigravity executable)"),
    ),
  );
});
