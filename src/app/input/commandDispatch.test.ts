import assert from "node:assert/strict";
import test from "node:test";
import { dispatchCommand } from "./commandDispatch.js";

type DispatchContext = Parameters<typeof dispatchCommand>[0];
type CommandResult = DispatchContext["commandResult"];

function recordingContext(commandResult: CommandResult, overrides: Partial<DispatchContext> = {}) {
  const calls: string[] = [];
  const base = {
    commandResult,
    verboseMode: false,
    modelCapabilities: null,
    updateCheckResult: null,
    providerDiagnosticsRef: { current: {} },
    ...overrides,
  } as DispatchContext;
  const context = new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property as keyof DispatchContext];
      return (...args: unknown[]) => {
        const rendered = args.map((arg) =>
          typeof arg === "function" ? "<fn>" : JSON.stringify(arg),
        );
        calls.push(`${String(property)}(${rendered.join(",")})`);
        return Promise.resolve();
      };
    },
  });
  return { context, calls };
}

function dispatch(commandResult: CommandResult, overrides: Partial<DispatchContext> = {}) {
  const { context, calls } = recordingContext(commandResult, overrides);
  dispatchCommand(context);
  return calls;
}

test("open_usage_panel opens the panel without appending transcript events", () => {
  assert.deepEqual(dispatch({ action: "open_usage_panel" }), ["openUsagePanel()"]);
});

// Setter-or-notice handlers: a value applies the setting; without a value the
// handler's message (if any) is posted under a fixed title.
const setterOrNotice: Array<[CommandResult["action"], string, string, string, string | null]> = [
  ["mode", "auto-edit", "setModeWithNotice", '"auto-edit"', "Mode"],
  ["plan_mode", "on", "setPlanModeWithNotice", "true", "Plan mode"],
  ["runtime_approval_policy", "never", "setApprovalPolicyWithNotice", '"never"', "Runtime policy"],
  [
    "runtime_sandbox_mode",
    "read-only",
    "setSandboxModeWithNotice",
    '"read-only"',
    "Runtime policy",
  ],
  [
    "runtime_network_access",
    "enabled",
    "setNetworkAccessWithNotice",
    '"enabled"',
    "Runtime policy",
  ],
  ["runtime_service_tier", "flex", "setServiceTierWithNotice", '"flex"', "Runtime policy"],
  ["runtime_personality", "none", "setPersonalityWithNotice", '"none"', "Runtime policy"],
  ["setting_workspace_display", "full", "setWorkspaceDisplayModeWithNotice", '"full"', "Settings"],
  ["setting_terminal_title", "off", "setTerminalTitleModeWithNotice", '"off"', "Settings"],
  ["model", "gpt-x", "setModelWithNotice", '"gpt-x"', null],
  ["reasoning", "high", "setReasoningWithNotice", '"high"', null],
  ["config_trust_set", "off", "setProjectTrustWithNotice", "false", null],
  ["auth", "api-key", "setAuthPreferenceWithNotice", '"api-key"', null],
  ["theme", "dark", "repaintCommittedTheme", '"dark"', null],
  ["runtime_writable_roots_add", "/tmp/a", "addWritableRootWithNotice", '"/tmp/a"', null],
  ["runtime_writable_roots_remove", "/tmp/a", "removeWritableRootWithNotice", '"/tmp/a"', null],
  ["workspace_relaunch", "/tmp/w", "handleWorkspaceRelaunch", '"/tmp/w"', null],
];

for (const [action, value, setter, renderedValue, noticeTitle] of setterOrNotice) {
  test(`${action} applies its value through ${setter}`, () => {
    assert.deepEqual(dispatch({ action, value, message: "ignored" } as CommandResult), [
      `${setter}(${renderedValue})`,
    ]);
  });

  test(`${action} without a value ${noticeTitle ? "posts its message" : "does nothing"}`, () => {
    const expected = noticeTitle
      ? [`appendEvent("system",${JSON.stringify(noticeTitle)},"m")`]
      : [];
    assert.deepEqual(dispatch({ action, message: "m" } as CommandResult), expected);
  });
}

const messageOnly: Array<[CommandResult["action"], string]> = [
  ["runtime_writable_roots_list", "Runtime status"],
  ["route_status", "Route status"],
  ["config_status", "Config"],
  ["config_trust_status", "Config trust"],
  ["permissions_status", "Permissions"],
  ["setting_status", "Settings"],
  ["themes", "Themes"],
  ["backends", "Command"],
  ["unknown", "Command"],
];

for (const [action, title] of messageOnly) {
  test(`${action} posts its message under "${title}" and is silent without one`, () => {
    assert.deepEqual(dispatch({ action, message: "m" } as CommandResult), [
      `appendEvent("system",${JSON.stringify(title)},"m")`,
    ]);
    assert.deepEqual(dispatch({ action } as CommandResult), []);
  });
}

const directActions: Array<[CommandResult["action"], string]> = [
  ["exit", "handleQuit()"],
  ["clear", "handleClear()"],
  ["resume", "openResumePicker()"],
  ["runtime_writable_roots_clear", "clearWritableRootsWithNotice()"],
  ["auth_status", "refreshAuthStatus(true)"],
  ["open_provider_picker", "openProviderPicker()"],
  ["open_model_picker", "openModelPicker()"],
  ["open_mode_picker", "openModePicker()"],
  ["open_reasoning_picker", "openReasoningPicker()"],
  ["open_settings_panel", "openSettingsPanel()"],
  ["open_theme_picker", "openThemePicker()"],
  ["open_permissions_panel", "openPermissionsPanel()"],
  ["open_auth_panel", "openAuthPanel()"],
  ["copy", "handleCopy()"],
  ["paste_image", "handlePasteImage(true)"],
];

for (const [action, call] of directActions) {
  test(`${action} calls ${call}`, () => {
    assert.deepEqual(dispatch({ action } as CommandResult), [call]);
  });
}

for (const action of ["status", "workspace", "help"] as const) {
  test(`${action} is handled elsewhere and dispatches nothing`, () => {
    assert.deepEqual(dispatch({ action, message: "m" } as CommandResult), []);
  });
}

test("setting_busy_loader applies the flag and announces it", () => {
  assert.deepEqual(dispatch({ action: "setting_busy_loader", value: "false" } as CommandResult), [
    "setShowBusyLoader(false)",
    'appendEvent("system","Settings","Busy loader disabled.")',
  ]);
  assert.deepEqual(dispatch({ action: "setting_busy_loader", message: "m" } as CommandResult), [
    'appendEvent("system","Settings","m")',
  ]);
});

test("verbose_toggle flips the flag and describes the new state", () => {
  assert.deepEqual(dispatch({ action: "verbose_toggle" } as CommandResult), [
    "setVerboseMode(<fn>)",
    'appendEvent("system","Verbose mode","Verbose mode enabled — showing detailed processing info.")',
  ]);
  assert.deepEqual(dispatch({ action: "verbose_toggle" } as CommandResult, { verboseMode: true }), [
    "setVerboseMode(<fn>)",
    'appendEvent("system","Verbose mode","Verbose mode disabled — showing concise output.")',
  ]);
  assert.deepEqual(dispatch({ action: "verbose_toggle", message: "dbg" } as CommandResult), [
    'appendEvent("system","Debug","dbg")',
  ]);
});

test("models refreshes capabilities only when none are loaded", () => {
  assert.deepEqual(dispatch({ action: "models", message: "m" } as CommandResult), [
    "refreshModelCapabilities(false,true)",
    'appendEvent("system","Command","m")',
  ]);
  const loaded = { models: [] } as unknown as DispatchContext["modelCapabilities"];
  assert.deepEqual(
    dispatch({ action: "models", message: "m" } as CommandResult, { modelCapabilities: loaded }),
    ['appendEvent("system","Command","m")'],
  );
});

test("diagnose_providers formats the recorded provider diagnostics", () => {
  const calls = dispatch({ action: "diagnose_providers" } as CommandResult);
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /^appendEvent\("system","Provider diagnostics",/);
});
