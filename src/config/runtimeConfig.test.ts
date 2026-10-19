import assert from "node:assert/strict";
import test from "node:test";
import {
  addWritableRoot,
  buildCodexConfigOverrides,
  buildRuntimeSummary,
  DEFAULT_RUNTIME_CONFIG,
  diffRuntimeConfig,
  formatPermissionsStatus,
  formatRuntimeStatus,
  mergeRuntimeConfig,
  normalizeRuntimeConfig,
  removeWritableRoot,
  resolveRuntimeConfig,
} from "./runtimeConfig.js";

test("defaults resolve into a concrete runtime config", () => {
  const resolved = resolveRuntimeConfig(DEFAULT_RUNTIME_CONFIG);

  assert.equal(resolved.model, DEFAULT_RUNTIME_CONFIG.model);
  assert.equal(resolved.mode, DEFAULT_RUNTIME_CONFIG.mode);
  assert.equal(resolved.planMode, false);
  assert.equal(resolved.policy.approvalPolicy, "on-request");
  assert.equal(resolved.policy.sandboxMode, "workspace-write");
  assert.equal(resolved.policy.networkAccess, false);
  assert.equal(resolved.policy.serviceTier, "flex");
  assert.equal(resolved.policy.personality, "none");
});

test("mode inheritance resolves to expected approval and sandbox policies", () => {
  const suggest = resolveRuntimeConfig(normalizeRuntimeConfig({ mode: "suggest" }));
  const autoEdit = resolveRuntimeConfig(normalizeRuntimeConfig({ mode: "auto-edit" }));
  const fullAuto = resolveRuntimeConfig(normalizeRuntimeConfig({ mode: "full-auto" }));

  assert.equal(suggest.policy.sandboxMode, "read-only");
  assert.equal(suggest.policy.approvalPolicy, "on-request");
  assert.equal(autoEdit.policy.sandboxMode, "workspace-write");
  assert.equal(fullAuto.policy.sandboxMode, "workspace-write");
});

test("explicit policy overrides beat inherited mode defaults", () => {
  const resolved = resolveRuntimeConfig(
    normalizeRuntimeConfig({
      mode: "suggest",
      policy: {
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
      },
    }),
  );

  assert.equal(resolved.policy.approvalPolicy, "never");
  assert.equal(resolved.policy.sandboxMode, "danger-full-access");
  assert.equal(resolved.policy.networkAccess, true);
});

test("writable roots normalize and dedupe", () => {
  const withRoots = addWritableRoot(
    addWritableRoot(DEFAULT_RUNTIME_CONFIG, "C:/Repo"),
    "C:\\Repo\\",
  );
  assert.equal(withRoots.policy.writableRoots.length, 1);

  const removed = removeWritableRoot(withRoots, "c:/repo");
  assert.equal(removed.policy.writableRoots.length, 0);
});

test("writable root normalization strips redundant trailing separators", () => {
  const normalized = normalizeRuntimeConfig({
    policy: {
      writableRoots: ["C:\\Repo\\", "C:\\Repo", "C:\\Repo\\\\nested\\..\\"],
    },
  });

  assert.deepEqual(normalized.policy.writableRoots, ["C:\\Repo"]);
});

test("merges runtime overrides onto a canonical base", () => {
  const merged = mergeRuntimeConfig(DEFAULT_RUNTIME_CONFIG, {
    model: "gpt-5.4-mini",
    planMode: true,
    policy: {
      writableRoots: ["C:/Repo/extra"],
      serviceTier: "fast",
    },
  });

  assert.equal(merged.model, "gpt-5.4-mini");
  assert.equal(merged.planMode, true);
  assert.deepEqual(merged.policy.writableRoots, ["C:\\Repo\\extra"]);
  assert.equal(merged.policy.serviceTier, "fast");
});

test("diffRuntimeConfig emits only fields that differ from the base", () => {
  const target = normalizeRuntimeConfig({
    model: "gpt-5.4-mini",
    planMode: true,
    policy: {
      networkAccess: "enabled",
      personality: "pragmatic",
    },
  });

  assert.deepEqual(diffRuntimeConfig(DEFAULT_RUNTIME_CONFIG, target), {
    model: "gpt-5.4-mini",
    planMode: true,
    policy: {
      networkAccess: "enabled",
      personality: "pragmatic",
    },
  });
});

test("builds deterministic codex config overrides", () => {
  const resolved = resolveRuntimeConfig(
    normalizeRuntimeConfig({
      model: "gpt-5.4-mini",
      mode: "suggest",
      reasoningLevel: "medium",
      policy: {
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        networkAccess: "enabled",
        writableRoots: ["C:/Repo/extra"],
        serviceTier: "fast",
        personality: "pragmatic",
      },
    }),
  );
  const writableRoot = resolved.policy.writableRoots[0];

  assert.deepEqual(buildCodexConfigOverrides(resolved), [
    "model_reasoning_effort=medium",
    "approval_policy=never",
    "sandbox_workspace_write.network_access=true",
    `sandbox_workspace_write.writable_roots=${JSON.stringify([writableRoot])}`,
    "service_tier=fast",
    "personality=pragmatic",
  ]);
});

test("builds runtime summary with network and writable-root indicators", () => {
  const summary = buildRuntimeSummary(
    resolveRuntimeConfig(
      normalizeRuntimeConfig({
        policy: {
          networkAccess: "enabled",
          writableRoots: ["C:/Repo/extra"],
        },
      }),
    ),
  );

  assert.equal(summary.networkLabel, "Net: on");
  assert.equal(summary.writableRootsLabel, "Roots: 1");
});

test("formats permissions status with configured and effective policy", () => {
  const runtime = normalizeRuntimeConfig({
    mode: "suggest",
    policy: {
      approvalPolicy: "inherit",
      sandboxMode: "inherit",
      networkAccess: "enabled",
      writableRoots: ["C:/Repo/extra"],
    },
  });
  const status = formatPermissionsStatus(runtime, resolveRuntimeConfig(runtime), "C:\\Workspace");

  assert.match(status, /Permissions status:/);
  assert.match(status, /Approval policy: configured Inherit; effective On request/);
  assert.match(status, /Network access: configured Enabled; effective Enabled/);
  assert.match(status, /Configured:/);
  assert.match(status, /Effective:/);
});

test("formats runtime status with effective policy details", () => {
  const resolved = resolveRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  const status = formatRuntimeStatus(resolved, {
    workspaceRoot: "C:\\Workspace",
    tokensUsed: 512,
  });

  assert.match(status, /Provider:/);
  assert.match(status, /Plan mode: Disabled/);
  assert.match(status, /Approval policy:/);
  assert.match(status, /Sandbox mode:/);
  assert.match(status, /Tokens used: ~512/);
});

test("formats runtime status with loaded project instructions", () => {
  const resolved = resolveRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  const status = formatRuntimeStatus(resolved, {
    workspaceRoot: "C:\\Workspace",
    projectInstructions: {
      status: "loaded",
      instructions: { path: "C:\\Workspace\\AGENTS.md", content: "# Instructions" },
    },
  });

  assert.match(status, /Project instructions: loaded/);
  assert.match(status, /Source: C:\\Workspace\\AGENTS\.md/);
});

test("formats runtime status with project instructions error", () => {
  const resolved = resolveRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  const status = formatRuntimeStatus(resolved, {
    workspaceRoot: "C:\\Workspace",
    projectInstructions: {
      status: "error",
      path: "C:\\Workspace\\AGENTS.md",
      message: "ENOENT: file not found",
    },
  });

  assert.match(status, /Project instructions: error/);
  assert.match(status, /ENOENT/);
});

test("formats runtime status with missing project instructions", () => {
  const resolved = resolveRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  const status = formatRuntimeStatus(resolved, {
    workspaceRoot: "C:\\Workspace",
    projectInstructions: { status: "missing" },
  });

  assert.match(status, /Project instructions: none/);
});

test("executable paths survive normalize, merge, diff and resolve", () => {
  const base = normalizeRuntimeConfig({
    codexCommandPath: " /opt/codex ",
    antigravityCommandPath: "/opt/agy",
  });
  assert.equal(base.codexCommandPath, "/opt/codex");
  assert.equal(mergeRuntimeConfig(base, { model: "gpt-x" }).codexCommandPath, "/opt/codex");
  assert.equal(resolveRuntimeConfig(base).codexCommandPath, "/opt/codex");
  assert.equal(resolveRuntimeConfig(base).antigravityCommandPath, "/opt/agy");
  assert.deepEqual(
    diffRuntimeConfig(base, mergeRuntimeConfig(base, { codexCommandPath: "/opt/other" })),
    { codexCommandPath: "/opt/other" },
  );
  assert.equal(normalizeRuntimeConfig({ codexCommandPath: "   " }).codexCommandPath, undefined);
});
