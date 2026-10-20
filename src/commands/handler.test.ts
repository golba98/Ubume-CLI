import assert from "node:assert/strict";
import test from "node:test";
import type { LayeredConfigResult } from "../config/layeredConfig.js";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../config/runtimeConfig.js";
import { normalizeCodexModelListResponses } from "../core/models/codexModelCapabilities.js";
import { type CommandContext, handleCommand } from "./handler.js";

const baseRuntime = normalizeRuntimeConfig({
  provider: "codex-subprocess",
  model: "gpt-5.4",
  mode: "suggest",
  reasoningLevel: "high",
});

const baseConfig: LayeredConfigResult = {
  runtime: baseRuntime,
  diagnostics: {
    projectRoot: "C:\\Workspace",
    projectTrusted: false,
    selectedProfile: null,
    selectedProfileSource: null,
    cliOverrides: [],
    layers: [
      { label: "Built-in defaults", status: "loaded" as const },
      {
        label: "User config",
        status: "missing" as const,
        path: "C:\\Users\\Test\\.codex\\config.toml",
      },
    ],
    ignoredEntries: [],
    fieldSources: {
      provider: "Built-in defaults",
      model: "Built-in defaults",
      reasoningLevel: "Built-in defaults",
      mode: "Built-in defaults",
      planMode: "Built-in defaults",
      antigravityCommandPath: "Built-in defaults",
      codexCommandPath: "Built-in defaults",
      "policy.approvalPolicy": "Built-in defaults",
      "policy.sandboxMode": "Built-in defaults",
      "policy.networkAccess": "Built-in defaults",
      "policy.writableRoots": "Built-in defaults",
      "policy.serviceTier": "Built-in defaults",
      "policy.personality": "Built-in defaults",
    },
  },
};

const baseContext: CommandContext = {
  config: baseConfig,
  runtime: baseRuntime,
  resolvedRuntime: resolveRuntimeConfig(baseRuntime),
  settings: {
    workspaceDisplayMode: "dir",
    terminalTitleMode: "dir",
    showBusyLoader: true,
  },
  workspace: {
    root: "C:\\Workspace",
    summaryMessage: [
      "Active workspace:",
      "  C:\\Workspace",
      "",
      "Launch mode: installed ubume",
    ].join("\n"),
  },
  tokensUsed: 1200,
};

function runCommand(command: string, context: Partial<CommandContext> = {}) {
  return handleCommand(command, {
    ...baseContext,
    ...context,
  });
}

const dynamicCapabilities = normalizeCodexModelListResponses([
  {
    data: [
      {
        id: "dynamic-four",
        model: "dynamic-four",
        displayName: "Dynamic Four",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Low" },
          { reasoningEffort: "medium", description: "Medium" },
          { reasoningEffort: "high", description: "High" },
          { reasoningEffort: "xhigh", description: "Extra" },
        ],
      },
      {
        id: "dynamic-two",
        model: "dynamic-two",
        displayName: "Dynamic Two",
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Medium" },
          { reasoningEffort: "high", description: "High" },
        ],
      },
    ],
  },
]);

test("parses /login command", () => {
  const result = runCommand("/login");
  assert.equal(result?.action, "login");
});

test("parses /logout command", () => {
  const result = runCommand("/logout");
  assert.equal(result?.action, "logout");
});

test("parses /auth status as auth_status action", () => {
  const result = runCommand("/auth status");
  assert.equal(result?.action, "auth_status");
});

test("keeps existing /model command behavior", () => {
  const result = runCommand("/model gpt-5.4-mini");
  assert.equal(result?.action, "model");
  assert.equal(result?.value, "gpt-5.4-mini");
});

test("accepts dynamically detected model ids", () => {
  const result = runCommand("/model dynamic-two", {
    modelCapabilities: dynamicCapabilities,
  });

  assert.equal(result?.action, "model");
  assert.equal(result?.value, "dynamic-two");
});

test("resolves canonical and aliased /mode commands", () => {
  const cases = [
    ["/mode suggest", "suggest"],
    ["/mode auto-edit", "auto-edit"],
    ["/mode full-auto", "full-auto"],
    ["/mode default", "full-auto"],
    ["/mode ask", "suggest"],
    ["/mode auto", "auto-edit"],
  ] as const;

  for (const [command, expectedValue] of cases) {
    const result = runCommand(command);
    assert.equal(result?.action, "mode", command);
    assert.equal(result?.value, expectedValue, command);
  }
});

test("uses /mode without an overlay and supports plan directly", () => {
  const status = runCommand("/mode");
  assert.equal(status?.action, "mode");
  assert.match(status?.message ?? "", /Shift\+Tab to rotate modes/);

  const plan = runCommand("/mode plan");
  assert.equal(plan?.action, "plan_mode");
  assert.equal(plan?.value, "on");
});

test("opens the reasoning picker when /reasoning has no argument", () => {
  const result = runCommand("/reasoning");
  assert.equal(result?.action, "open_reasoning_picker");
});

test("accepts explicit reasoning levels", () => {
  const result = runCommand("/reasoning medium");
  assert.equal(result?.action, "reasoning");
  assert.equal(result?.value, "medium");
});

test("accepts extra high reasoning aliases", () => {
  const result = runCommand("/reasoning extra high");
  assert.equal(result?.action, "reasoning");
  assert.equal(result?.value, "xhigh");
});

test("validates reasoning against detected levels for the active model", () => {
  const runtime = normalizeRuntimeConfig({
    model: "dynamic-two",
    reasoningLevel: "medium",
  });

  const accepted = runCommand("/reasoning high", {
    runtime,
    resolvedRuntime: resolveRuntimeConfig(runtime),
    modelCapabilities: dynamicCapabilities,
  });
  assert.equal(accepted?.action, "reasoning");
  assert.equal(accepted?.value, "high");

  const rejected = runCommand("/reasoning xhigh", {
    runtime,
    resolvedRuntime: resolveRuntimeConfig(runtime),
    modelCapabilities: dynamicCapabilities,
  });
  assert.equal(rejected?.action, "unknown");
  assert.match(rejected?.message ?? "", /Valid: medium, high/i);
});

test("validates ultra from the active model's real metadata", () => {
  const capabilities = normalizeCodexModelListResponses([
    {
      data: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(
            (reasoningEffort) => ({ reasoningEffort }),
          ),
        },
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({
            reasoningEffort,
          })),
        },
      ],
    },
  ]);
  const solRuntime = normalizeRuntimeConfig({ model: "gpt-5.6-sol" });
  assert.equal(
    runCommand("/reasoning ultra", {
      runtime: solRuntime,
      resolvedRuntime: resolveRuntimeConfig(solRuntime),
      modelCapabilities: capabilities,
    })?.action,
    "reasoning",
  );
  const gpt55Runtime = normalizeRuntimeConfig({ model: "gpt-5.5" });
  const rejected = runCommand("/reasoning ultra", {
    runtime: gpt55Runtime,
    resolvedRuntime: resolveRuntimeConfig(gpt55Runtime),
    modelCapabilities: capabilities,
  });
  assert.equal(rejected?.action, "unknown");
  assert.match(rejected?.message ?? "", /Valid: low, medium, high, xhigh/);
});

test("accepts unverified reasoning ids when runtime metadata is unavailable", () => {
  const result = runCommand("/reasoning ultra", { modelCapabilities: undefined });
  assert.equal(result?.action, "reasoning");
  assert.equal(result?.value, "ultra");
  assert.match(result?.message ?? "", /metadata unavailable; unverified/i);
});

test("shows and toggles plan mode", () => {
  const statusResult = runCommand("/plan");
  assert.equal(statusResult?.action, "plan_mode");
  assert.equal(statusResult?.message, "Plan mode: Disabled.");

  const explicitStatusResult = runCommand("/plan status", {
    runtime: normalizeRuntimeConfig({ planMode: true }),
  });
  assert.equal(explicitStatusResult?.action, "plan_mode");
  assert.equal(explicitStatusResult?.message, "Plan mode: Enabled.");

  const enableResult = runCommand("/plan on");
  assert.equal(enableResult?.action, "plan_mode");
  assert.equal(enableResult?.value, "on");

  const disableResult = runCommand("/plan off");
  assert.equal(disableResult?.action, "plan_mode");
  assert.equal(disableResult?.value, "off");
});

test("rejects invalid /plan usage with a short hint", () => {
  const result = runCommand("/plan maybe");
  assert.equal(result?.action, "unknown");
  assert.equal(result?.message, "Usage: /plan [on|off]");
});

test("opens the settings panel and updates workspace and busy loader settings", () => {
  const statusResult = runCommand("/setting");
  assert.equal(statusResult?.action, "open_settings_panel");
  assert.equal(statusResult?.message, undefined);

  const pluralStatusResult = runCommand("/settings");
  assert.equal(pluralStatusResult?.action, "open_settings_panel");
  assert.equal(pluralStatusResult?.message, undefined);

  const workspaceResult = runCommand("/setting workspace", {
    settings: {
      workspaceDisplayMode: "simple",
      terminalTitleMode: "name",
      showBusyLoader: true,
    },
  });
  assert.equal(workspaceResult?.action, "setting_workspace_display");
  assert.match(workspaceResult?.message ?? "", /Simple \(simple\)/i);
  assert.match(workspaceResult?.message ?? "", /Allowed values: dir, name, simple/i);

  const setResult = runCommand("/setting workspace name");
  assert.equal(setResult?.action, "setting_workspace_display");
  assert.equal(setResult?.value, "name");

  const terminalResult = runCommand("/setting terminal-title", {
    settings: {
      workspaceDisplayMode: "dir",
      terminalTitleMode: "simple",
      showBusyLoader: true,
    },
  });
  assert.equal(terminalResult?.action, "setting_terminal_title");
  assert.match(terminalResult?.message ?? "", /Simple \(simple\)/i);

  const setTerminalResult = runCommand("/setting terminal-title name");
  assert.equal(setTerminalResult?.action, "setting_terminal_title");
  assert.equal(setTerminalResult?.value, "name");

  const legacyResult = runCommand("/setting directory normal");
  assert.equal(legacyResult?.action, "setting_workspace_display");
  assert.equal(legacyResult?.value, "dir");

  const busyResult = runCommand("/setting busy-loader false");
  assert.equal(busyResult?.action, "setting_busy_loader");
  assert.equal(busyResult?.value, "false");
});

test("recognizes /settings without falling through to unknown command handling", () => {
  const result = runCommand("/settings");

  assert.equal(result?.action, "open_settings_panel");
  assert.notEqual(result?.action, "unknown");
  assert.doesNotMatch(result?.message ?? "", /Unknown command/i);
});

test("shows busy loader setting status", () => {
  const result = runCommand("/setting busy-loader", {
    settings: {
      workspaceDisplayMode: "dir",
      terminalTitleMode: "dir",
      showBusyLoader: false,
    },
  });
  assert.equal(result?.action, "setting_busy_loader");
  assert.equal(result?.message, "Busy loader: false");
});

test("rejects invalid /setting usage with a short hint", () => {
  const invalidValue = runCommand("/setting directory compact");
  assert.equal(invalidValue?.action, "unknown");
  assert.equal(invalidValue?.message, "Usage: /setting workspace [dir|name|simple]");

  const invalidTerminalValue = runCommand("/setting terminal-title compact");
  assert.equal(invalidTerminalValue?.action, "unknown");
  assert.equal(invalidTerminalValue?.message, "Usage: /setting terminal-title [dir|name|simple]");

  const invalidBusyLoader = runCommand("/setting busy-loader maybe");
  assert.equal(invalidBusyLoader?.action, "unknown");
  assert.equal(invalidBusyLoader?.message, "Usage: /setting busy-loader [true|false]");

  const invalidSetting = runCommand("/setting theme");
  assert.equal(invalidSetting?.action, "unknown");
  assert.equal(
    invalidSetting?.message,
    "Usage: /setting, /setting workspace [dir|name|simple], /setting terminal-title [dir|name|simple], or /setting busy-loader [true|false]",
  );
});

test("shows effective runtime status", () => {
  const result = runCommand("/status");
  assert.equal(result?.action, "status");
  assert.match(result?.message ?? "", /Plan mode: Disabled/i);
  assert.match(result?.message ?? "", /Approval policy: On request/i);
  assert.match(result?.message ?? "", /Sandbox mode: Read only/i);
  assert.match(result?.message ?? "", /Tokens used: ~1,200/i);
});

test("/status includes active provider route status when supplied", () => {
  const result = runCommand("/status", {
    routeStatusMessage: [
      "Route status:",
      "  Active chat route: Google / gemini-3.5-flash",
      "  Backend kind: antigravity-cli-auth",
    ].join("\n"),
  });

  assert.equal(result?.action, "status");
  assert.match(result?.message ?? "", /Active chat route: Google \/ gemini-3.5-flash/);
  assert.match(result?.message ?? "", /Backend kind: antigravity-cli-auth/);
});

test("/status includes project instructions status when supplied", () => {
  const result = runCommand("/status", {
    projectInstructions: {
      status: "loaded",
      instructions: { path: "C:\\Workspace\\AGENTS.md", content: "" },
    },
  });

  assert.equal(result?.action, "status");
  assert.match(result?.message ?? "", /Project instructions: loaded/);
  assert.match(result?.message ?? "", /AGENTS\.md/);
});

test("/models opens the model picker", () => {
  const result = runCommand("/models", {
    modelCapabilities: dynamicCapabilities,
  });

  assert.equal(result?.action, "open_model_picker");
});

test("shows layered config status", () => {
  const result = runCommand("/config");
  assert.equal(result?.action, "config_status");
  assert.match(result?.message ?? "", /Config status:/i);
  assert.match(result?.message ?? "", /Project trust: Untrusted/i);
});

test("parses config trust commands", () => {
  const statusResult = runCommand("/config trust");
  assert.equal(statusResult?.action, "config_trust_status");
  assert.match(statusResult?.message ?? "", /Status: Untrusted/i);

  const setResult = runCommand("/config trust on");
  assert.equal(setResult?.action, "config_trust_set");
  assert.equal(setResult?.value, "on");
});

test("opens the permissions panel when /permissions has no arguments", () => {
  const result = runCommand("/permissions");
  assert.equal(result?.action, "open_permissions_panel");
});

test("reports configured and effective permissions status", () => {
  const result = runCommand("/permissions status");
  assert.equal(result?.action, "permissions_status");
  assert.match(result?.message ?? "", /Permissions status:/i);
  assert.match(result?.message ?? "", /configured Inherit; effective On request/i);
  assert.match(result?.message ?? "", /Network access: configured Inherit; effective Disabled/i);
});

test("parses runtime approval policy setters and status", () => {
  const setResult = runCommand("/runtime approval-policy never");
  assert.equal(setResult?.action, "runtime_approval_policy");
  assert.equal(setResult?.value, "never");

  const statusResult = runCommand("/runtime approval-policy status");
  assert.equal(statusResult?.action, "runtime_approval_policy");
  assert.match(statusResult?.message ?? "", /configured Inherit; effective On request/i);
});

test("parses runtime sandbox setters and status", () => {
  const setResult = runCommand("/runtime sandbox danger-full-access");
  assert.equal(setResult?.action, "runtime_sandbox_mode");
  assert.equal(setResult?.value, "danger-full-access");

  const statusResult = runCommand("/runtime sandbox status");
  assert.equal(statusResult?.action, "runtime_sandbox_mode");
  assert.match(statusResult?.message ?? "", /configured Inherit; effective Read only/i);
});

test("parses runtime network setters including inherit resets", () => {
  const setResult = runCommand("/runtime network on");
  assert.equal(setResult?.action, "runtime_network_access");
  assert.equal(setResult?.value, "enabled");

  const inheritResult = runCommand("/runtime network inherit");
  assert.equal(inheritResult?.action, "runtime_network_access");
  assert.equal(inheritResult?.value, "inherit");
});

test("parses permissions command setters through the runtime action path", () => {
  const approvalResult = runCommand("/permissions approval-policy never");
  assert.equal(approvalResult?.action, "runtime_approval_policy");
  assert.equal(approvalResult?.value, "never");

  const sandboxResult = runCommand("/permissions sandbox workspace-write");
  assert.equal(sandboxResult?.action, "runtime_sandbox_mode");
  assert.equal(sandboxResult?.value, "workspace-write");

  const networkResult = runCommand("/permissions network on");
  assert.equal(networkResult?.action, "runtime_network_access");
  assert.equal(networkResult?.value, "enabled");

  const rootsResult = runCommand("/permissions writable-roots add .\\tmp");
  assert.equal(rootsResult?.action, "runtime_writable_roots_add");
  assert.equal(rootsResult?.value, ".\\tmp");
});

test("status reports resolved overrides rather than raw inherit values", () => {
  const runtime = normalizeRuntimeConfig({
    mode: "suggest",
    policy: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccess: "enabled",
      writableRoots: ["C:\\Extra\\"],
    },
  });
  const result = runCommand("/status", {
    runtime,
    resolvedRuntime: resolveRuntimeConfig(runtime),
  });

  assert.equal(result?.action, "status");
  assert.match(result?.message ?? "", /Approval policy: Never/i);
  assert.match(result?.message ?? "", /Sandbox mode: Workspace write/i);
  assert.match(result?.message ?? "", /Network access: Enabled/i);
  assert.match(result?.message ?? "", /C:\\Extra/i);
});

test("parses writable root list add remove and clear commands", () => {
  const listResult = runCommand("/runtime writable-roots list");
  assert.equal(listResult?.action, "runtime_writable_roots_list");
  assert.match(listResult?.message ?? "", /none/i);

  const addResult = runCommand("/runtime writable-roots add .\\tmp");
  assert.equal(addResult?.action, "runtime_writable_roots_add");
  assert.equal(addResult?.value, ".\\tmp");

  const removeResult = runCommand("/runtime writable-roots remove .\\tmp");
  assert.equal(removeResult?.action, "runtime_writable_roots_remove");
  assert.equal(removeResult?.value, ".\\tmp");

  const clearResult = runCommand("/runtime writable-roots clear");
  assert.equal(clearResult?.action, "runtime_writable_roots_clear");
});

test("parses runtime service tier and personality setters", () => {
  const tierResult = runCommand("/runtime service-tier fast");
  assert.equal(tierResult?.action, "runtime_service_tier");
  assert.equal(tierResult?.value, "fast");

  const personalityResult = runCommand("/runtime personality pragmatic");
  assert.equal(personalityResult?.action, "runtime_personality");
  assert.equal(personalityResult?.value, "pragmatic");
});

test("documents runtime commands in help", () => {
  const result = runCommand("/help");
  assert.equal(result?.action, "help");
  assert.match(result?.message ?? "", /\/status\s+Show the effective runtime configuration/i);
  assert.match(result?.message ?? "", /\/config\s+Show layered config sources/i);
  assert.match(
    result?.message ?? "",
    /\/permissions\s+Open or update permissions and sandbox controls/i,
  );
  assert.match(result?.message ?? "", /\/permissions approval-policy/i);
  assert.match(result?.message ?? "", /\/runtime approval-policy/i);
  assert.match(result?.message ?? "", /\/runtime writable-roots/i);
  assert.match(result?.message ?? "", /\/plan \[on\|off\]\s+Show or toggle session plan mode/i);
  assert.match(result?.message ?? "", /\/setting, \/settings Open the settings picker/i);
  assert.match(result?.message ?? "", /\/setting workspace \[dir\|name\|simple\]/i);
  assert.match(result?.message ?? "", /\/setting busy-loader \[true\|false\]/i);
  assert.doesNotMatch(result?.message ?? "", /\/mouse/);
  assert.match(result?.message ?? "", /Current plan mode: Disabled/i);
  assert.match(result?.message ?? "", /Shift\+Tab\s+Rotate Plan.*Read-only.*Auto.*Full Access/i);
  assert.match(result?.message ?? "", /Ctrl\+Y\s+Restore deleted text/i);
  assert.match(result?.message ?? "", /Ctrl\+Alt\+P\s+Open provider picker/i);
});

test("shows the active locked workspace", () => {
  const result = runCommand("/workspace");
  assert.equal(result?.action, "workspace");
  assert.equal(result?.message, baseContext.workspace.summaryMessage);
});

test("parses workspace relaunch commands", () => {
  const result = runCommand("/workspace relaunch C:\\Next Workspace");
  assert.equal(result?.action, "workspace_relaunch");
  assert.equal(result?.value, "C:\\Next Workspace");
});

test("requires a target path for workspace relaunch", () => {
  const result = runCommand("/workspace relaunch");
  assert.equal(result?.action, "unknown");
  assert.match(result?.message ?? "", /Usage: \/workspace relaunch <path>/i);
});

test("parses /theme and /themes commands", () => {
  const themeResult = runCommand("/theme mono");
  assert.equal(themeResult?.action, "theme");
  assert.equal(themeResult?.value, "mono");

  const themesResult = runCommand("/themes");
  assert.equal(themesResult?.action, "open_theme_picker");
});

test("parses /clear command", () => {
  const result = runCommand("/clear");
  assert.equal(result?.action, "clear");
});

test("parses /resume command", () => {
  const result = runCommand("/resume");
  assert.equal(result?.action, "resume");
});

test("parses /model without args as open_model_picker", () => {
  const result = runCommand("/model");
  assert.equal(result?.action, "open_model_picker");
});

test("parses /providers as open_provider_picker", () => {
  const result = runCommand("/providers");
  assert.equal(result?.action, "open_provider_picker");
});

test("parses /provider alias as open_provider_picker", () => {
  const result = runCommand("/provider");
  assert.equal(result?.action, "open_provider_picker");
});

test("parses /route as distinct route status", () => {
  const result = runCommand("/route", {
    routeStatusMessage: [
      "Route status:",
      "  Workspace default: Anthropic",
      "  Active chat route: OpenAI / gpt-5.4",
      "  Active model: gpt-5.4",
      "  Active provider mode: Usable inside Ubume",
      "  Anthropic in-Ubume routing: not configured yet",
    ].join("\n"),
  });

  assert.equal(result?.action, "route_status");
  assert.match(result?.message ?? "", /Workspace default: Anthropic/);
  assert.match(result?.message ?? "", /Active chat route: OpenAI \/ gpt-5\.4/);
});

test("/models is a model picker alias", () => {
  const result = runCommand("/models", {
    modelCapabilities: dynamicCapabilities,
    activeRouteProviderLabel: "OpenAI",
  });

  assert.equal(result?.action, "open_model_picker");
});

test("parses /reasoning without args as open_reasoning_picker", () => {
  const result = runCommand("/reasoning");
  assert.equal(result?.action, "open_reasoning_picker");
});

test("parses /diagnose github command", () => {
  const result = runCommand("/diagnose github");
  assert.equal(result?.action, "diagnose_github");
});

test("parses /diagnose providers command", () => {
  const result = runCommand("/diagnose providers");
  assert.equal(result?.action, "diagnose_providers");
});

test("parses /paste-image as a clipboard image attachment action", () => {
  assert.equal(runCommand("/paste-image")?.action, "paste_image");
});

test("unknown commands show /help suggestion", () => {
  const result = runCommand("/unknown-cmd-123");
  assert.equal(result?.action, "unknown");
  assert.match(result?.message ?? "", /Type \/help for available commands/i);
});

test("every command documented in help is recognized by the parser", () => {
  const helpResult = runCommand("/help");
  assert.equal(helpResult?.action, "help");
  const helpText = helpResult?.message ?? "";

  // Capture commands from line-start entries ("  /cmd ...") and comma-listed aliases (", /alias")
  // so that lines like "  /exit, /quit  Quit..." contribute both "exit" and "quit"
  const fromLineStart = [...helpText.matchAll(/^\s{2}\/([a-z][a-z0-9-]+)/gm)].map((m) => m[1]!);
  const fromCommaAlias = [...helpText.matchAll(/,\s*\/([a-z][a-z0-9-]+)/g)].map((m) => m[1]!);
  const documentedCommands = new Set([...fromLineStart, ...fromCommaAlias]);

  // /diagnose requires the "github" subcommand; bare /diagnose returns unknown by design
  const requiresSubcommand = new Set(["diagnose"]);

  for (const cmd of documentedCommands) {
    if (requiresSubcommand.has(cmd)) continue;
    const result = runCommand(`/${cmd}`);
    assert.notEqual(
      result?.action,
      "unknown",
      `Command /${cmd} documented in /help but handler returned 'unknown'`,
    );
  }

  // Verify specific multi-word commands mentioned in help
  const multiWord = [
    ["diagnose github", "diagnose_github"],
    ["diagnose providers", "diagnose_providers"],
    ["config trust", "config_trust_status"],
    ["auth status", "auth_status"],
    ["workspace relaunch .", "workspace_relaunch"],
    ["providers", "open_provider_picker"],
    ["route", "route_status"],
    ["update check", "update"],
  ] as const;
  for (const [cmd, expectedAction] of multiWord) {
    const result = runCommand(`/${cmd}`);
    assert.equal(
      result?.action,
      expectedAction,
      `Multi-word command /${cmd} mentioned in help but returned action ${result?.action} instead of ${expectedAction}`,
    );
  }
});

test("?-prefixed command-like input is treated as invalid command error", () => {
  const result = runCommand("?clear");
  assert.equal(result?.action, "unknown");
  assert.match(result?.message ?? "", /Invalid command syntax.*\?clear/i);
  assert.match(result?.message ?? "", /Did you mean \/clear/i);
});

test("?model shows command error not model picker", () => {
  const result = runCommand("?model");
  assert.equal(result?.action, "unknown");
  assert.match(result?.message ?? "", /Invalid command syntax/i);
});

test("non-command text without / or ? prefix returns null", () => {
  const result = runCommand("hello world");
  assert.equal(result, null);
});

test("parses /update, /update check, and /update status commands", () => {
  // Bare /update defaults to a forced fresh check.
  const resultBare = runCommand("/update");
  assert.equal(resultBare?.action, "update");
  assert.equal(resultBare?.value, "check");

  const resultCheck = runCommand("/update check");
  assert.equal(resultCheck?.action, "update");
  assert.equal(resultCheck?.value, "check");

  const resultStatus = runCommand("/update status");
  assert.equal(resultStatus?.action, "update");
  assert.equal(resultStatus?.value, "status");
});

test("/usage opens the usage panel locally and ignores arguments", () => {
  assert.deepEqual(handleCommand("/usage", baseContext), { action: "open_usage_panel" });
  assert.deepEqual(handleCommand("/USAGE now", baseContext), { action: "open_usage_panel" });
});

test("/help lists /usage", () => {
  const help = handleCommand("/help", baseContext);
  assert.match(help?.message ?? "", /\/usage\s+Show account usage limits for the active provider/);
});

test("parses /exit and /quit as exit actions", () => {
  assert.equal(runCommand("/exit")?.action, "exit");
  assert.equal(runCommand("/quit")?.action, "exit");
});

test("rejects an unknown model and points to /models", () => {
  const withoutCapabilities = runCommand("/model not-a-real-model");
  assert.equal(withoutCapabilities?.action, "unknown");
  assert.match(withoutCapabilities?.message ?? "", /Unknown model: not-a-real-model/);
  assert.match(withoutCapabilities?.message ?? "", /Use \/models to list available models/);

  // A capabilities snapshot is authoritative: its absence decides whether the
  // static fallback list may accept the model at all.
  const withCapabilities = runCommand("/model not-a-real-model", {
    modelCapabilities: dynamicCapabilities,
  });
  assert.equal(withCapabilities?.action, "unknown");
});

test("keeps /permissions limited to its documented controls", () => {
  // service-tier and personality are /runtime-only surfaces.
  const serviceTier = runCommand("/permissions service-tier fast");
  assert.equal(serviceTier?.action, "unknown");
  assert.match(
    serviceTier?.message ?? "",
    /Use \/permissions <approval-policy\|sandbox\|network\|writable-roots>/,
  );

  const personality = runCommand("/permissions personality friendly");
  assert.equal(personality?.action, "unknown");

  const unknownSubcommand = runCommand("/permissions frobnicate");
  assert.equal(unknownSubcommand?.action, "unknown");
  assert.match(
    unknownSubcommand?.message ?? "",
    /Unknown permissions command\. Use \/permissions <approval-policy\|sandbox\|network\|writable-roots>\./,
  );
});

test("/runtime without arguments reports the effective status", () => {
  const result = runCommand("/runtime");
  assert.equal(result?.action, "status");
  assert.match(result?.message ?? "", /Approval policy: On request/i);
});

test("reports status for every /runtime policy control", () => {
  const serviceTier = runCommand("/runtime service-tier status");
  assert.equal(serviceTier?.action, "runtime_service_tier");
  assert.match(serviceTier?.message ?? "", /Service tier:/);

  const personality = runCommand("/runtime personality status");
  assert.equal(personality?.action, "runtime_personality");
  assert.match(personality?.message ?? "", /Personality:/);
});

test("rejects invalid runtime policy values with usage hints", () => {
  const approvalPolicy = runCommand("/runtime approval-policy maybe");
  assert.equal(approvalPolicy?.action, "unknown");
  assert.match(
    approvalPolicy?.message ?? "",
    /Usage: \/runtime approval-policy \[status\|inherit\|untrusted\|on-request\|never\]/,
  );
});

test("maps /runtime network off to the disabled value", () => {
  const result = runCommand("/runtime network off");
  assert.equal(result?.action, "runtime_network_access");
  assert.equal(result?.value, "disabled");
});

test("requires a path for writable-roots add and remove", () => {
  // The dispatcher trims and collapses whitespace, so a bare "add" never
  // reaches the add-specific hint; both report the general usage.
  const addResult = runCommand("/runtime writable-roots add");
  assert.equal(addResult?.action, "unknown");
  assert.match(
    addResult?.message ?? "",
    /Usage: \/runtime writable-roots \[list\|add <path>\|remove <path>\|clear\]/,
  );

  const removeResult = runCommand("/runtime writable-roots remove");
  assert.equal(removeResult?.action, "unknown");
  assert.match(
    removeResult?.message ?? "",
    /Usage: \/runtime writable-roots \[list\|add <path>\|remove <path>\|clear\]/,
  );
});

test("requires a target for /diagnose", () => {
  const result = runCommand("/diagnose");
  assert.equal(result?.action, "unknown");
  assert.equal(result?.message, "Usage: /diagnose github|providers");
});

test("/debug renders reports render counts as a verbose toggle", () => {
  const result = runCommand("/debug renders");
  assert.equal(result?.action, "verbose_toggle");
  assert.match(result?.message ?? "", /Render counts:|No render counts recorded/);

  const bare = runCommand("/debug");
  assert.equal(bare?.action, "verbose_toggle");
  assert.equal(bare?.message, undefined);
});

test("disables project trust with /config trust off", () => {
  const result = runCommand("/config trust off");
  assert.equal(result?.action, "config_trust_set");
  assert.equal(result?.value, "off");
  assert.equal(result?.message, "Project trust disabled.");
});

test("enables the busy loader with /setting busy-loader true", () => {
  const result = runCommand("/setting busy-loader true");
  assert.equal(result?.action, "setting_busy_loader");
  assert.equal(result?.value, "true");
  assert.equal(result?.message, "Busy loader enabled.");
});

test("parses simple panel and action commands", () => {
  const cases = [
    ["/copy", "copy"],
    ["/paste-image", "paste_image"],
    ["/queue", "queue"],
    ["/transcript", "transcript"],
    ["/diff", "diff"],
    ["/rewind", "rewind"],
    ["/send-now", "send_now"],
    ["/verbose", "verbose_toggle"],
    ["/themes", "open_theme_picker"],
    ["/models", "open_model_picker"],
    ["/preferences", "open_preferences_panel"],
  ] as const;

  for (const [command, expectedAction] of cases) {
    assert.equal(runCommand(command)?.action, expectedAction, command);
  }
});

test("/route falls back to a static OpenAI route summary", () => {
  const result = runCommand("/route");
  assert.equal(result?.action, "route_status");
  assert.match(result?.message ?? "", /Workspace default: OpenAI/);
  assert.match(result?.message ?? "", /Active chat route: OpenAI \/ gpt-5\.4/);
});

test("parses a known auth preference id", () => {
  const result = runCommand("/auth chatgpt-login-goal");
  assert.equal(result?.action, "auth");
  assert.equal(result?.value, "chatgpt-login-goal");
  assert.match(result?.message ?? "", /Auth preference set to/);
});

test("rejects an unknown theme and points to /themes", () => {
  const result = runCommand("/theme unknown-theme-xyz");
  assert.equal(result?.action, "unknown");
  assert.match(
    result?.message ?? "",
    /Unknown theme: unknown-theme-xyz\. Use \/themes to list available themes\./,
  );
});

test("rejects unknown /workspace subcommands", () => {
  const result = runCommand("/workspace frobnicate");
  assert.equal(result?.action, "unknown");
  assert.match(
    result?.message ?? "",
    /Unknown workspace command\. Use \/workspace or \/workspace relaunch <path>\./,
  );
});
