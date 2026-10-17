/**
 * Parses the interactive app's slash commands.
 *
 * `handleCommand` turns a line like `/mode auto-edit` into a
 * {@link CommandResult} — the action the app should perform, an optional value
 * to apply, and an optional message to show — without any side effects of its
 * own. `app/input/commandDispatch.ts` owns applying those results; this
 * module stays free of state changes, I/O and provider calls so command
 * parsing remains synchronous and testable.
 *
 * Commands live in `COMMAND_HANDLERS`, a map from command name to a handler
 * receiving the raw argument, its lowercased form, and the shared
 * {@link CommandContext}. Aliases (e.g. `/quit`, `/provider`, `/settings`)
 * reuse the same handler as their canonical command.
 */

import { formatLayeredConfigStatus, type LayeredConfigResult } from "../config/layeredConfig.js";
import {
  AVAILABLE_APPROVAL_POLICIES,
  AVAILABLE_PERSONALITIES,
  AVAILABLE_SANDBOX_MODES,
  AVAILABLE_SERVICE_TIERS,
  formatApprovalPolicyLabel,
  formatNetworkAccessLabel,
  formatPermissionsStatus,
  formatPersonalityLabel,
  formatRuntimeStatus,
  formatSandboxModeLabel,
  formatServiceTierLabel,
  type ResolvedRuntimeConfig,
  type RuntimeConfig,
  type RuntimeNetworkAccess,
} from "../config/runtimeConfig.js";
import {
  AUTH_PREFERENCES,
  AVAILABLE_THEMES,
  BUSY_LOADER_SETTING_VALUES,
  formatAuthPreferenceLabel,
  formatModeCommandHelp,
  formatModeLabel,
  formatReasoningLabel,
  formatThemeLabel,
  formatWorkspaceDisplayModeLabel,
  LEGACY_FALLBACK_MODELS,
  normalizeLegacyDirectoryDisplayMode,
  resolveModeCommand,
  type TerminalTitleMode,
  WORKSPACE_DISPLAY_MODES,
  type WorkspaceDisplayMode,
} from "../config/settings.js";
import {
  type CodexModelCapabilities,
  findModelCapability,
  getSelectableModelCapabilities,
} from "../core/models/codexModelCapabilities.js";
import { dumpRenderCounts } from "../core/perf/renderDebug.js";
import type { WorkspaceCommandContext } from "../core/workspace/launchContext.js";
import type { ProjectInstructionsLoadResult } from "../core/workspace/projectInstructions.js";

/** What the app must perform after a command was parsed. */
type CommandAction =
  | "exit"
  | "clear"
  | "resume"
  | "queue"
  | "transcript"
  | "diff"
  | "rewind"
  | "send_now"
  | "login"
  | "logout"
  | "auth_status"
  | "backend"
  | "open_provider_picker"
  | "route_status"
  | "model"
  | "mode"
  | "auth"
  | "open_backend_picker"
  | "open_model_picker"
  | "open_mode_picker"
  | "reasoning"
  | "open_reasoning_picker"
  | "plan_mode"
  | "open_settings_panel"
  | "setting_status"
  | "setting_workspace_display"
  | "setting_terminal_title"
  | "setting_busy_loader"
  | "theme"
  | "help"
  | "copy"
  | "paste_image"
  | "backends"
  | "models"
  | "workspace"
  | "workspace_relaunch"
  | "config_status"
  | "config_trust_status"
  | "config_trust_set"
  | "open_auth_panel"
  | "open_theme_picker"
  | "open_permissions_panel"
  | "themes"
  | "verbose_toggle"
  | "status"
  | "permissions_status"
  | "runtime_approval_policy"
  | "runtime_sandbox_mode"
  | "runtime_network_access"
  | "runtime_writable_roots_add"
  | "runtime_writable_roots_remove"
  | "runtime_writable_roots_clear"
  | "runtime_writable_roots_list"
  | "runtime_service_tier"
  | "runtime_personality"
  | "diagnose_github"
  | "diagnose_providers"
  | "update"
  | "open_usage_panel"
  | "unknown";

/** A parsed command: what the app should do, plus what to apply and show. */
interface CommandResult {
  action: CommandAction;
  /** Value to apply (new setting value, model id, path, ...). */
  value?: string;
  /** Message to show the user: status text, confirmation, or a usage hint. */
  message?: string;
}

export interface CommandContext {
  // Effective layered configuration
  config: LayeredConfigResult;
  runtime: RuntimeConfig;
  resolvedRuntime: ResolvedRuntimeConfig;

  // Persisted UI settings
  settings: {
    workspaceDisplayMode: WorkspaceDisplayMode;
    terminalTitleMode: TerminalTitleMode;
    showBusyLoader: boolean;
  };

  // Workspace locked for this session
  workspace: WorkspaceCommandContext;

  // Approximate token usage of the active conversation
  tokensUsed?: number;

  // Route and model discovery, present once the app has run it
  modelCapabilities?: CodexModelCapabilities | null;
  routeStatusMessage?: string;
  activeRouteProviderLabel?: string;
  projectInstructions?: ProjectInstructionsLoadResult | null;
}

// Mirrors AVAILABLE_APPROVAL_POLICIES[].id from runtimeConfig.ts
const APPROVAL_POLICY_VALUES = AVAILABLE_APPROVAL_POLICIES.map((option) => option.id);
// Mirrors AVAILABLE_SANDBOX_MODES[].id from runtimeConfig.ts
const SANDBOX_MODE_VALUES = AVAILABLE_SANDBOX_MODES.map((option) => option.id);
// Input aliases — "on"/"off" are mapped to "enabled"/"disabled" in the network case below
const NETWORK_ACCESS_VALUES = ["inherit", "on", "off"] as const;
// Mirrors AVAILABLE_SERVICE_TIERS[].id from runtimeConfig.ts
const SERVICE_TIER_VALUES = AVAILABLE_SERVICE_TIERS.map((option) => option.id);
// Mirrors AVAILABLE_PERSONALITIES[].id from runtimeConfig.ts
const PERSONALITY_VALUES = AVAILABLE_PERSONALITIES.map((option) => option.id);

/** Type-guard check for whether `value` is one of the known option ids. */
function isOneOf<T extends string>(value: string, list: readonly T[]): value is T {
  return (list as readonly string[]).includes(value);
}

/** Formats writable roots for a status message; an empty list shows "none". */
export function formatWritableRoots(roots: readonly string[]): string {
  return roots.length > 0 ? roots.map((root) => `  - ${root}`).join("\n") : "  - none";
}

/** Maps user reasoning input to the canonical level id. */
function expandReasoningAliases(arg: string): string {
  const normalized = arg.toLowerCase();
  // "extra high" is a user-facing alias for "xhigh"
  return normalized === "extra high" ? "xhigh" : normalized;
}

/**
 * A runtime policy control that only supports `<control>`, `<control> status`
 * and `<control> <value>`. Used by approval-policy, sandbox, service-tier and
 * personality; network and writable-roots need custom handling.
 */
interface SimplePolicySpec<TValue extends string> {
  /** Result action for both the status and the set form. */
  action: CommandAction;
  /** Values accepted by the set form. */
  values: readonly TValue[];
  /** Message for the status form (and for a bare `<control>`). */
  statusMessage: string;
  /** Confirmation message for a value the control accepted. */
  appliedMessage: (value: TValue) => string;
  /** Usage hint for any other input. */
  usageMessage: string;
}

/** Parses a simple policy control request into a status, set or usage result. */
function runSimplePolicyCommand<TValue extends string>(
  rest: string,
  normalizedRest: string,
  spec: SimplePolicySpec<TValue>,
): CommandResult {
  if (!rest || normalizedRest === "status") {
    return { action: spec.action, message: spec.statusMessage };
  }

  if (isOneOf(normalizedRest, spec.values)) {
    return {
      action: spec.action,
      value: normalizedRest,
      message: spec.appliedMessage(normalizedRest),
    };
  }

  return { action: "unknown", message: spec.usageMessage };
}

/** Maps accepted network input, including the "on"/"off" aliases, to config values. */
function toNetworkAccessValue(normalizedValue: string): RuntimeNetworkAccess {
  if (normalizedValue === "on") {
    return "enabled";
  }
  if (normalizedValue === "off") {
    return "disabled";
  }
  return "inherit";
}

/**
 * Handles the policy subcommands shared by `/runtime` and `/permissions`.
 *
 * `commandPrefix` names the command in usage messages. When
 * `includeExtendedControls` is false (the `/permissions` surface), the
 * service-tier and personality controls report as unknown so each command
 * keeps its documented surface.
 */
function handlePolicyCommand(
  commandPrefix: "/runtime" | "/permissions",
  arg: string,
  context: CommandContext,
  includeExtendedControls = true,
): CommandResult {
  const [subcommandRaw, ...restTokens] = arg.split(/\s+/);
  const subcommand = subcommandRaw?.toLowerCase() ?? "";
  const rest = restTokens.join(" ").trim();
  const normalizedRest = rest.toLowerCase();

  switch (subcommand) {
    case "approval-policy": {
      return runSimplePolicyCommand(rest, normalizedRest, {
        action: "runtime_approval_policy",
        values: APPROVAL_POLICY_VALUES,
        statusMessage: `Approval policy: configured ${formatApprovalPolicyLabel(context.runtime.policy.approvalPolicy)}; effective ${formatApprovalPolicyLabel(context.resolvedRuntime.policy.approvalPolicy)}.`,
        appliedMessage: (value) => `Approval policy set to ${formatApprovalPolicyLabel(value)}.`,
        usageMessage: `Usage: ${commandPrefix} approval-policy [status|inherit|untrusted|on-request|never]`,
      });
    }

    case "sandbox": {
      return runSimplePolicyCommand(rest, normalizedRest, {
        action: "runtime_sandbox_mode",
        values: SANDBOX_MODE_VALUES,
        statusMessage: `Sandbox mode: configured ${formatSandboxModeLabel(context.runtime.policy.sandboxMode)}; effective ${formatSandboxModeLabel(context.resolvedRuntime.policy.sandboxMode)}.`,
        appliedMessage: (value) => `Sandbox mode set to ${formatSandboxModeLabel(value)}.`,
        usageMessage: `Usage: ${commandPrefix} sandbox [status|inherit|read-only|workspace-write|danger-full-access]`,
      });
    }

    case "network": {
      if (!rest || normalizedRest === "status") {
        return {
          action: "runtime_network_access",
          message: `Network access: configured ${formatNetworkAccessLabel(context.runtime.policy.networkAccess)}; effective ${formatNetworkAccessLabel(context.resolvedRuntime.policy.networkAccess)}.`,
        };
      }

      if (isOneOf(normalizedRest, NETWORK_ACCESS_VALUES)) {
        const value = toNetworkAccessValue(normalizedRest);
        return {
          action: "runtime_network_access",
          value,
          message: `Network access set to ${formatNetworkAccessLabel(value)}.`,
        };
      }

      return {
        action: "unknown",
        message: `Usage: ${commandPrefix} network [status|inherit|on|off]`,
      };
    }

    case "writable-roots": {
      // A bare control, "list" or "status" shows the current roots.
      if (!rest || normalizedRest === "list" || normalizedRest === "status") {
        return {
          action: "runtime_writable_roots_list",
          message: `Writable roots:\n${formatWritableRoots(context.runtime.policy.writableRoots)}`,
        };
      }

      if (normalizedRest === "clear") {
        return {
          action: "runtime_writable_roots_clear",
          message: "Writable roots cleared.",
        };
      }

      // "add"/"remove" carry the raw (non-normalized) path in `value`.
      if (normalizedRest.startsWith("add ")) {
        const pathValue = rest.slice("add".length).trim();
        if (!pathValue) {
          return {
            action: "unknown",
            message: `Usage: ${commandPrefix} writable-roots add <path>`,
          };
        }
        return {
          action: "runtime_writable_roots_add",
          value: pathValue,
          message: `Writable root added: ${pathValue}`,
        };
      }

      if (normalizedRest.startsWith("remove ")) {
        const pathValue = rest.slice("remove".length).trim();
        if (!pathValue) {
          return {
            action: "unknown",
            message: `Usage: ${commandPrefix} writable-roots remove <path>`,
          };
        }
        return {
          action: "runtime_writable_roots_remove",
          value: pathValue,
          message: `Writable root removed: ${pathValue}`,
        };
      }

      return {
        action: "unknown",
        message: `Usage: ${commandPrefix} writable-roots [list|add <path>|remove <path>|clear]`,
      };
    }

    case "service-tier": {
      if (!includeExtendedControls) {
        return {
          action: "unknown",
          message: `Unknown ${commandPrefix.slice(1)} command. Use ${commandPrefix} <approval-policy|sandbox|network|writable-roots>.`,
        };
      }
      return runSimplePolicyCommand(rest, normalizedRest, {
        action: "runtime_service_tier",
        values: SERVICE_TIER_VALUES,
        statusMessage: `Service tier: ${formatServiceTierLabel(context.runtime.policy.serviceTier)}.`,
        appliedMessage: (value) => `Service tier set to ${formatServiceTierLabel(value)}.`,
        usageMessage: `Usage: ${commandPrefix} service-tier [status|flex|fast]`,
      });
    }

    case "personality": {
      if (!includeExtendedControls) {
        return {
          action: "unknown",
          message: `Unknown ${commandPrefix.slice(1)} command. Use ${commandPrefix} <approval-policy|sandbox|network|writable-roots>.`,
        };
      }
      return runSimplePolicyCommand(rest, normalizedRest, {
        action: "runtime_personality",
        values: PERSONALITY_VALUES,
        statusMessage: `Personality: ${formatPersonalityLabel(context.runtime.policy.personality)}.`,
        appliedMessage: (value) => `Personality set to ${formatPersonalityLabel(value)}.`,
        usageMessage: `Usage: ${commandPrefix} personality [status|none|friendly|pragmatic]`,
      });
    }

    default:
      return {
        action: "unknown",
        message: includeExtendedControls
          ? `Unknown ${commandPrefix.slice(1)} command. Use /status or ${commandPrefix} <approval-policy|sandbox|network|writable-roots|service-tier|personality>.`
          : `Unknown ${commandPrefix.slice(1)} command. Use /permissions <approval-policy|sandbox|network|writable-roots>.`,
      };
  }
}

/** Formats recorded render counts; explains how to enable them when empty. */
function formatRenderCounts(): string {
  const counts = dumpRenderCounts();
  const lines = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `  ${name}: ${count}`);

  return lines.length > 0
    ? `Render counts:\n${lines.join("\n")}`
    : "No render counts recorded. Set UBUME_RENDER_DEBUG=1 to enable.";
}

/** Builds the `/help` text from the current runtime state. */
function buildHelpMessage(context: CommandContext): string {
  return [
    "Shell execution:",
    "  !<command>         Run any shell command directly  e.g. !ls -la",
    "                     Output streams live in a terminal block",
    "                     Esc cancels a running command",
    "",
    "Commands:",
    "  /exit, /quit       Quit the application and cancel active run",
    "  /clear             Clear the chat window and cancel the active run",
    "  /resume [id]       Resume a conversation; ←/→ browse Claude Code, Codex, Google and Mistral Vibe sessions",
    "  /queue             Inspect, edit, reorder, or continue queued prompts",
    "  /transcript        Inspect detailed tool activity",
    "  /diff              Review session or turn changes",
    "  /rewind            Preview conversation/file recovery",
    "  /send-now          Interrupt and send queued instructions",
    "  /diagnose github|providers   Run diagnostics",
    "  /providers         Open provider picker (/provider alias)",
    "  /route             Show workspace default and active chat route",
    "  /model [name]      Switch model (no arg opens picker)",
    `  /mode [name]       Switch execution mode (${formatModeCommandHelp()})`,
    "                     suggest = read-only-style prompting, auto-edit = file edits, full-auto = strongest autonomy",
    "  /reasoning [level] Set reasoning level (no arg opens picker)",
    "  /plan [on|off]     Show or toggle session plan mode",
    "  /setting, /settings Open the settings picker",
    "  /setting workspace [dir|name|simple] Control the header workspace label",
    "  /setting terminal-title [dir|name|simple] Control the terminal tab title",
    "  /setting busy-loader [true|false] Control the busy footer animation",
    "  /status            Show the effective runtime configuration",
    "  /usage             Show account usage limits for the active provider",
    "  /config            Show layered config sources and winning values",
    "  /config trust [status|on|off] Manage whether project config is allowed to load",
    "  /permissions       Open or update permissions and sandbox controls",
    "  /permissions status",
    "  /permissions approval-policy [status|inherit|untrusted|on-request|never]",
    "  /permissions sandbox [status|inherit|read-only|workspace-write|danger-full-access]",
    "  /permissions network [status|inherit|on|off]",
    "  /permissions writable-roots [list|add <path>|remove <path>|clear]",
    "  /runtime ...       Inspect or update runtime policy controls",
    "                     Compatibility surface; /permissions is the primary entry point",
    "  /runtime approval-policy [status|inherit|untrusted|on-request|never]",
    "  /runtime sandbox [status|inherit|read-only|workspace-write|danger-full-access]",
    "  /runtime network [status|inherit|on|off]",
    "  /runtime writable-roots [list|add <path>|remove <path>|clear]",
    "  /runtime service-tier [status|flex|fast]",
    "  /runtime personality [status|none|friendly|pragmatic]",
    "  /theme [name]      Switch theme directly (no arg opens picker)",
    "  /themes            Open visual theme picker (Up/Down + Enter)",
    "  /verbose           Toggle verbose mode (shows detailed processing info)",
    "  /auth [option]     Open auth panel or set auth preference",
    "  /auth status       Probe Ubume auth status",
    "  /login             Show guided ChatGPT subscription login steps",
    "  /logout            Show guided logout steps",
    "  /models            Open model picker",
    "  /workspace         Show the locked workspace for this session",
    "  /workspace relaunch <path> Restart the app in another workspace folder",
    `  Current reasoning: ${formatReasoningLabel(context.runtime.reasoningLevel)}`,
    `  Current plan mode: ${context.runtime.planMode ? "Enabled" : "Disabled"}`,
    "  /copy              Copy last response to clipboard",
    "  /paste-image       Attach the image currently on the clipboard",
    "  /update [status]   Check for updates and install the latest Ubume (status: cached result only)",
    "  /help              Show this help",
    "",
    "Local development:",
    "  npm run install:dev-bin  Install the ubume-dev command",
    "  ubume-dev                Run this repo without replacing ubume",
    "",
    "Shortcuts:",
    "  Ctrl+B/F  Move cursor left/right",
    "  Ctrl+O    Open model picker · Alt+P also works",
    "  Ctrl+T    Inspect transcript (/transcript)",
    "  Shift+Tab Rotate Plan → Read-only → Auto → Full Access",
    "  Ctrl+Alt+P Open provider picker",
    "  Ctrl+A/E  Move to line start/end",
    "  Ctrl+V    Attach clipboard image (when forwarded by the terminal)",
    "  Ctrl+L    Redraw screen without clearing history",
    "  Esc       Cancel active run or shell command",
    "  Ctrl+Y    Restore deleted text · Shift+Tab cycle mode",
    "  Ctrl+C    Stop run or clear draft · twice to exit · Ctrl+Q quit",
    "  ↑ / ↓    Move within prompt, then navigate history",
    "  Ctrl+R    Search history · Ctrl+_ undo input",
    "  Ctrl+G    Edit prompt in VISUAL/EDITOR",
    "  Ctrl+X Ctrl+S Send queued instructions now",
  ].join("\n");
}

// ─── Command handlers ──────────────────────────────────────────────────────────

/** `/exit` and `/quit`: leave the app, cancelling the active run. */
function handleExit(): CommandResult {
  return { action: "exit" };
}

/** `/providers` and `/provider`: open the provider picker. */
function handleOpenProviderPicker(): CommandResult {
  return { action: "open_provider_picker" };
}

/**
 * `/route`: shows the workspace default and the active chat route.
 *
 * `context.routeStatusMessage` (built by the app with live route data) wins
 * over the static fallback below.
 */
function handleRouteCommand(
  __arg: string,
  __normalizedArg: string,
  context: CommandContext,
): CommandResult {
  return {
    action: "route_status",
    message:
      context.routeStatusMessage ??
      [
        "Route status:",
        "  Workspace default: OpenAI",
        `  Active chat route: OpenAI / ${context.runtime.model}`,
        `  Active model: ${context.runtime.model}`,
        "  Active provider mode: Usable inside Ubume",
      ].join("\n"),
  };
}

/**
 * `/model`: without an argument opens the model picker. With one, accepts a
 * model from the active capabilities snapshot; the static legacy list is only
 * consulted when no snapshot exists at all, so it never overrides live
 * discovery.
 */
function handleModelCommand(
  arg: string,
  __normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg) {
    return { action: "open_model_picker" };
  }

  const availableModels = context.modelCapabilities
    ? getSelectableModelCapabilities(context.modelCapabilities)
    : [];
  const requestedModel = availableModels.find((model) => model.model === arg || model.id === arg);

  if (requestedModel) {
    return {
      action: "model",
      value: requestedModel.model,
      message: `Model switched to ${requestedModel.model}`,
    };
  }

  // Without a capabilities snapshot, a static fallback list keeps /model usable.
  if (!context.modelCapabilities && isOneOf(arg, LEGACY_FALLBACK_MODELS)) {
    return { action: "model", value: arg, message: `Model switched to ${arg}` };
  }

  return {
    action: "unknown",
    message: `Unknown model: ${arg}. Use /models to list available models.`,
  };
}

/**
 * `/mode`: without an argument reports the current mode. `/mode plan` enables
 * plan mode; any other value must resolve to a known execution mode.
 */
function handleModeCommand(
  arg: string,
  normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg) {
    return {
      action: "mode",
      message: `Mode: ${context.runtime.planMode ? "Plan" : formatModeLabel(context.runtime.mode)}. Use Shift+Tab to rotate modes.`,
    };
  }

  if (normalizedArg === "plan") {
    return {
      action: "plan_mode",
      value: "on",
      message: "Plan mode enabled.",
    };
  }

  const resolvedMode = resolveModeCommand(arg);
  if (resolvedMode) {
    return {
      action: "mode",
      value: resolvedMode,
      message: `Mode switched to ${formatModeLabel(resolvedMode)}`,
    };
  }

  return {
    action: "unknown",
    message: `Unknown mode: ${arg}. Valid: ${formatModeCommandHelp()}`,
  };
}

/**
 * `/reasoning`: without an argument opens the reasoning picker. With one, the
 * level must be advertised by the active model's metadata; when no metadata
 * is available the level is still accepted, but flagged as unverified.
 */
function handleReasoningCommand(
  arg: string,
  __normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg) {
    return { action: "open_reasoning_picker" };
  }

  const requestedLevel = expandReasoningAliases(arg);
  const modelCapability = findModelCapability(context.modelCapabilities, context.runtime.model);
  const detectedLevels = modelCapability?.supportedReasoningLevels;

  if (detectedLevels && detectedLevels.some((item) => item.id === requestedLevel)) {
    return {
      action: "reasoning",
      value: requestedLevel,
      message: `Reasoning level switched to ${formatReasoningLabel(requestedLevel)}`,
    };
  }

  if (detectedLevels) {
    const validLevels = detectedLevels.map((item) => item.id).join(", ");
    return {
      action: "unknown",
      message: `Unknown reasoning level for ${context.runtime.model}: ${arg}. Valid: ${validLevels}`,
    };
  }

  return {
    action: "reasoning",
    value: requestedLevel,
    message: `Reasoning level switched to ${formatReasoningLabel(requestedLevel)} (runtime metadata unavailable; unverified until runtime)`,
  };
}

/** `/plan`: shows the plan mode status, or toggles it with `on`/`off`. */
function handlePlanCommand(
  arg: string,
  normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg || normalizedArg === "status") {
    return {
      action: "plan_mode",
      message: `Plan mode: ${context.runtime.planMode ? "Enabled" : "Disabled"}.`,
    };
  }

  if (normalizedArg === "on" || normalizedArg === "off") {
    return {
      action: "plan_mode",
      value: normalizedArg,
      message: `Plan mode ${normalizedArg === "on" ? "enabled" : "disabled"}.`,
    };
  }

  return {
    action: "unknown",
    message: "Usage: /plan [on|off]",
  };
}

/** Usage help shared by the workspace-display and terminal-title settings. */
const DISPLAY_MODE_ALLOWED_VALUES = [
  "Allowed values: dir, name, simple",
  "dir = show the current workspace folder name",
  "name = show Ubume",
  "simple = show only the final folder name",
] as const;

/** Status text for a display-mode setting: current value plus allowed values. */
function displayModeStatusMessage(settingLabel: string, mode: WorkspaceDisplayMode): string {
  return [
    `${settingLabel}: ${formatWorkspaceDisplayModeLabel(mode)} (${mode})`,
    ...DISPLAY_MODE_ALLOWED_VALUES,
  ].join("\n");
}

/**
 * `/setting workspace` (aliases: `workspace-display`, `directory`): shows or
 * sets how the workspace is labelled in the header. The legacy value "normal"
 * maps to "dir". Returns null for other settings' arguments.
 */
function handleWorkspaceDisplaySetting(
  normalizedArg: string,
  context: CommandContext,
): CommandResult | null {
  const statusAliases = ["workspace", "workspace-display", "directory"];
  if (statusAliases.includes(normalizedArg)) {
    return {
      action: "setting_workspace_display",
      message: displayModeStatusMessage("Workspace display", context.settings.workspaceDisplayMode),
    };
  }

  const setPrefix = ["workspace ", "workspace-display ", "directory "].find((prefix) =>
    normalizedArg.startsWith(prefix),
  );
  if (!setPrefix) {
    return null;
  }

  const requestedValue = normalizedArg.slice(setPrefix.length).trim();
  // "normal" was the legacy default label before "dir" was introduced
  const mappedValue =
    requestedValue === "normal" ? normalizeLegacyDirectoryDisplayMode("normal") : requestedValue;

  if (isOneOf(mappedValue, WORKSPACE_DISPLAY_MODES)) {
    return {
      action: "setting_workspace_display",
      value: mappedValue,
      message: `Workspace display set to ${formatWorkspaceDisplayModeLabel(mappedValue)} (${mappedValue}).`,
    };
  }

  return {
    action: "unknown",
    message: "Usage: /setting workspace [dir|name|simple]",
  };
}

/**
 * `/setting terminal-title` (alias: `terminal`): shows or sets the terminal
 * tab title. Returns null for other settings' arguments.
 */
function handleTerminalTitleSetting(
  normalizedArg: string,
  context: CommandContext,
): CommandResult | null {
  if (normalizedArg === "terminal-title" || normalizedArg === "terminal") {
    return {
      action: "setting_terminal_title",
      message: displayModeStatusMessage("Terminal title", context.settings.terminalTitleMode),
    };
  }

  const setPrefix = ["terminal-title ", "terminal "].find((prefix) =>
    normalizedArg.startsWith(prefix),
  );
  if (!setPrefix) {
    return null;
  }

  const requestedValue = normalizedArg.slice(setPrefix.length).trim();
  if (isOneOf(requestedValue, WORKSPACE_DISPLAY_MODES)) {
    return {
      action: "setting_terminal_title",
      value: requestedValue,
      message: `Terminal title set to ${formatWorkspaceDisplayModeLabel(requestedValue)} (${requestedValue}).`,
    };
  }

  return {
    action: "unknown",
    message: "Usage: /setting terminal-title [dir|name|simple]",
  };
}

/**
 * `/setting busy-loader`: shows or toggles the busy footer animation.
 * Returns null for other settings' arguments.
 */
function handleBusyLoaderSetting(
  normalizedArg: string,
  context: CommandContext,
): CommandResult | null {
  if (normalizedArg === "busy-loader") {
    return {
      action: "setting_busy_loader",
      message: `Busy loader: ${context.settings.showBusyLoader ? "true" : "false"}`,
    };
  }

  if (!normalizedArg.startsWith("busy-loader ")) {
    return null;
  }

  const requestedValue = normalizedArg.slice("busy-loader ".length).trim();
  if (isOneOf(requestedValue, BUSY_LOADER_SETTING_VALUES)) {
    return {
      action: "setting_busy_loader",
      value: requestedValue,
      message: `Busy loader ${requestedValue === "true" ? "enabled" : "disabled"}.`,
    };
  }

  return {
    action: "unknown",
    message: "Usage: /setting busy-loader [true|false]",
  };
}

/**
 * `/setting` (alias: `/settings`): without an argument opens the settings
 * panel; otherwise the matching setting reports its status or applies a new
 * value.
 */
function handleSettingCommand(
  arg: string,
  normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg) {
    return { action: "open_settings_panel" };
  }

  return (
    handleWorkspaceDisplaySetting(normalizedArg, context) ??
    handleTerminalTitleSetting(normalizedArg, context) ??
    handleBusyLoaderSetting(normalizedArg, context) ?? {
      action: "unknown",
      message:
        "Usage: /setting, /setting workspace [dir|name|simple], /setting terminal-title [dir|name|simple], or /setting busy-loader [true|false]",
    }
  );
}

/** `/theme`: without an argument opens the theme picker; otherwise switches themes. */
function handleThemeCommand(
  arg: string,
  __normalizedArg: string,
  __context: CommandContext,
): CommandResult {
  if (!arg) {
    return { action: "open_theme_picker" };
  }

  if (AVAILABLE_THEMES.some((item) => item.id === arg)) {
    return {
      action: "theme",
      value: arg,
      message: `Theme switched to ${formatThemeLabel(arg)}`,
    };
  }

  return {
    action: "unknown",
    message: `Unknown theme: ${arg}. Use /themes to list available themes.`,
  };
}

/** `/workspace`: shows the locked workspace, or relaunches into another folder. */
function handleWorkspaceCommand(
  arg: string,
  normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg) {
    return {
      action: "workspace",
      message: context.workspace.summaryMessage,
    };
  }

  if (normalizedArg === "relaunch") {
    return {
      action: "unknown",
      message: "Usage: /workspace relaunch <path>",
    };
  }

  if (normalizedArg.startsWith("relaunch ")) {
    return {
      action: "workspace_relaunch",
      value: arg.slice("relaunch".length).trim(),
    };
  }

  return {
    action: "unknown",
    message: "Unknown workspace command. Use /workspace or /workspace relaunch <path>.",
  };
}

/**
 * `/config`: shows the layered config sources. `/config trust` reports
 * whether the project config may load, and `trust on|off` changes it.
 */
function handleConfigCommand(
  arg: string,
  normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg || normalizedArg === "status") {
    return {
      action: "config_status",
      message: formatLayeredConfigStatus(context.config),
    };
  }

  if (normalizedArg === "trust" || normalizedArg === "trust status") {
    return {
      action: "config_trust_status",
      message: [
        "Project trust:",
        `  Root: ${context.config.diagnostics.projectRoot}`,
        `  Status: ${context.config.diagnostics.projectTrusted ? "Trusted" : "Untrusted"}`,
      ].join("\n"),
    };
  }

  if (normalizedArg === "trust on" || normalizedArg === "trust off") {
    const enable = normalizedArg === "trust on";
    return {
      action: "config_trust_set",
      value: enable ? "on" : "off",
      message: `Project trust ${enable ? "enabled" : "disabled"}.`,
    };
  }

  return {
    action: "unknown",
    message:
      "Unknown config command. Use /config, /config status, or /config trust [status|on|off].",
  };
}

/** `/auth`: opens the auth panel, probes status, or sets the auth preference. */
function handleAuthCommand(
  arg: string,
  __normalizedArg: string,
  __context: CommandContext,
): CommandResult {
  if (!arg) {
    return { action: "open_auth_panel" };
  }

  if (arg === "status") {
    return { action: "auth_status" };
  }

  if (AUTH_PREFERENCES.some((item) => item.id === arg)) {
    return {
      action: "auth",
      value: arg,
      message: `Auth preference set to ${formatAuthPreferenceLabel(arg)}`,
    };
  }

  return {
    action: "unknown",
    message:
      "Unknown auth option. Use /auth, /auth status, or one of the documented preference ids.",
  };
}

/** `/status`: shows the effective runtime configuration and route status. */
function handleStatusCommand(
  __arg: string,
  __normalizedArg: string,
  context: CommandContext,
): CommandResult {
  return {
    action: "status",
    message: [
      formatRuntimeStatus(context.resolvedRuntime, {
        workspaceRoot: context.workspace.root,
        tokensUsed: context.tokensUsed,
        projectInstructions: context.projectInstructions ?? null,
      }),
      context.routeStatusMessage,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n"),
  };
}

/**
 * `/permissions`: opens the permissions panel, reports its status, or applies
 * a policy change. The service-tier and personality controls are
 * `/runtime`-only and report as unknown here.
 */
function handlePermissionsCommand(
  arg: string,
  normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg) {
    return { action: "open_permissions_panel" };
  }

  if (normalizedArg === "status") {
    return {
      action: "permissions_status",
      message: formatPermissionsStatus(
        context.runtime,
        context.resolvedRuntime,
        context.workspace.root,
      ),
    };
  }

  return handlePolicyCommand("/permissions", arg, context, false);
}

/**
 * `/runtime`: compatibility surface for policy controls — without an argument
 * reports the effective runtime status; otherwise behaves like
 * `/permissions` but also accepts service-tier and personality.
 */
function handleRuntimeCommand(
  arg: string,
  __normalizedArg: string,
  context: CommandContext,
): CommandResult {
  if (!arg) {
    return {
      action: "status",
      message: formatRuntimeStatus(context.resolvedRuntime, {
        workspaceRoot: context.workspace.root,
        tokensUsed: context.tokensUsed,
      }),
    };
  }

  return handlePolicyCommand("/runtime", arg, context, true);
}

/** `/debug`: toggles verbose mode; `renders` also reports recorded render counts. */
function handleDebugCommand(__arg: string, normalizedArg: string): CommandResult {
  if (normalizedArg === "renders") {
    return {
      action: "verbose_toggle",
      message: formatRenderCounts(),
    };
  }

  return { action: "verbose_toggle" };
}

/** `/diagnose`: launches GitHub connectivity or provider diagnostics. */
function handleDiagnoseCommand(__arg: string, normalizedArg: string): CommandResult {
  if (normalizedArg === "github") {
    return {
      action: "diagnose_github",
      message: "Running GitHub connectivity diagnostics...",
    };
  }

  if (normalizedArg === "providers") {
    return {
      action: "diagnose_providers",
      message: "Collecting provider diagnostics...",
    };
  }

  return {
    action: "unknown",
    message: "Usage: /diagnose github|providers",
  };
}

/** `/help`: shows the command reference built from the current state. */
function handleHelpCommand(
  __arg: string,
  __normalizedArg: string,
  context: CommandContext,
): CommandResult {
  return { action: "help", message: buildHelpMessage(context) };
}

/**
 * `/update`: checks for updates. Bare or `check` forces a fresh check;
 * `status` reuses the cached result.
 */
function handleUpdateCommand(__arg: string, normalizedArg: string): CommandResult {
  return { action: "update", value: normalizedArg || "check" };
}

/**
 * A single command's implementation: the raw argument, its lowercased form,
 * and the shared context.
 */
type CommandHandler = (
  arg: string,
  normalizedArg: string,
  context: CommandContext,
) => CommandResult;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  exit: handleExit,
  quit: handleExit,
  clear: () => ({ action: "clear" }),
  resume: () => ({ action: "resume" }),
  queue: () => ({ action: "queue" }),
  transcript: () => ({ action: "transcript" }),
  diff: () => ({ action: "diff" }),
  rewind: () => ({ action: "rewind" }),
  "send-now": () => ({ action: "send_now" }),

  login: () => ({ action: "login" }),
  logout: () => ({ action: "logout" }),
  copy: () => ({ action: "copy" }),
  "paste-image": () => ({ action: "paste_image" }),

  providers: handleOpenProviderPicker,
  provider: handleOpenProviderPicker,
  route: handleRouteCommand,
  model: handleModelCommand,
  models: () => ({ action: "open_model_picker" }),
  mode: handleModeCommand,
  reasoning: handleReasoningCommand,
  plan: handlePlanCommand,

  setting: handleSettingCommand,
  settings: handleSettingCommand,
  theme: handleThemeCommand,
  themes: () => ({ action: "open_theme_picker" }),
  workspace: handleWorkspaceCommand,
  config: handleConfigCommand,
  auth: handleAuthCommand,

  status: handleStatusCommand,
  permissions: handlePermissionsCommand,
  runtime: handleRuntimeCommand,

  verbose: () => ({ action: "verbose_toggle" }),
  debug: handleDebugCommand,
  diagnose: handleDiagnoseCommand,
  help: handleHelpCommand,
  update: handleUpdateCommand,
  usage: () => ({ action: "open_usage_panel" }),
};

/**
 * Parses `text` as a slash command and returns the action the app should
 * perform, without executing it.
 *
 * Returns null for ordinary (non-command) input, and an `unknown` result with
 * a suggestion for the common "?cmd" mistype of "/cmd".
 */
export function handleCommand(text: string, context: CommandContext): CommandResult | null {
  if (text.startsWith("/")) {
    const [rawCmd, ...argTokens] = text.slice(1).trim().split(/\s+/);
    const cmd = rawCmd?.toLowerCase() ?? "";
    const arg = argTokens.join(" ").trim();
    const normalizedArg = arg.toLowerCase();

    const handler = Object.hasOwn(COMMAND_HANDLERS, cmd) ? COMMAND_HANDLERS[cmd] : undefined;

    return handler
      ? handler(arg, normalizedArg, context)
      : {
          action: "unknown",
          message: `Unknown command: /${cmd}. Type /help for available commands.`,
        };
  }

  // "?cmd" is a common mistype of "/cmd" — suggest the corrected form
  if (text.startsWith("?")) {
    const potentialCmd = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return {
      action: "unknown",
      message: `Invalid command syntax: ${text}. Use /help for available commands. Did you mean /${potentialCmd}?`,
    };
  }

  return null;
}
