/**
 * Applies the result of a parsed slash command.
 *
 * `commands/handler.ts` parses `/command args` into a `CommandResult`
 * (`action`, optional `value` and `message`) without side effects. This module
 * maps each action to its effect in the app: changing a setting, opening a
 * panel, or posting the command's message to the transcript.
 *
 * Most setting commands share one shape: with a value they apply it, and
 * without one they post the handler's message (usually the current value or
 * usage text). {@link dispatchCommand} builds those handlers with
 * `applyOrNotify`.
 *
 * Handlers return nothing except `update`, whose promise `handleSubmit`
 * awaits; long-running work inside other handlers is started with `void` so
 * submission is not held up.
 */

import {
  formatGithubDiagnostics,
  formatProviderDiagnostics,
} from "../../commands/diagnosticsFormat.js";
import type { handleCommand } from "../../commands/handler.js";
import type {
  RuntimeApprovalPolicy,
  RuntimeNetworkAccess,
  RuntimePersonality,
  RuntimeSandboxMode,
  RuntimeServiceTier,
} from "../../config/runtimeConfig.js";
import type {
  AuthPreference,
  AvailableMode,
  AvailableModel,
  ReasoningLevel,
  TerminalTitleMode,
  WorkspaceDisplayMode,
} from "../../config/settings.js";
import { getLoginGuidance, getLogoutGuidance } from "../../core/codex/codexAuth.js";
import type { CodexModelCapabilities } from "../../core/models/codexModelCapabilities.js";
import {
  checkGhCli,
  checkLocalGitRemote,
  checkLocalGitWrite,
  classifyDiagnostics,
  type DiagnosticResult,
  getLocalGitRemoteUrl,
  parseRepoIdentity,
} from "../../core/shared/githubDiagnostics.js";
import { isLocalDevChannel } from "../../core/version/channel.js";
import type { GlobalPackageManager } from "../../core/version/packageManager.js";
import { getUpdateCommand } from "../../core/version/packageManager.js";
import {
  formatLocalDevUpdateStatus,
  formatUpdateInstructions,
  type UpdateCheckResult,
} from "../../core/version/updateCheck.js";
import type { Screen } from "../../session/types.js";

type CommandResult = NonNullable<ReturnType<typeof handleCommand>>;
type CommandAction = CommandResult["action"];
type CommandHandler = () => void | Promise<void>;

interface CommandDispatchContext {
  commandResult: CommandResult;
  handleQuit: () => void;
  handleClear: () => Promise<void>;
  openResumePicker: () => void;
  setModelWithNotice: (nextModel: AvailableModel) => Promise<void>;
  setModeWithNotice: (nextMode: AvailableMode) => void;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  setReasoningWithNotice: (nextReasoningLevel: ReasoningLevel) => void;
  setPlanModeWithNotice: (nextEnabled: boolean) => void;
  setProjectTrustWithNotice: (trusted: boolean) => void;
  setApprovalPolicyWithNotice: (nextValue: RuntimeApprovalPolicy) => void;
  setSandboxModeWithNotice: (nextValue: RuntimeSandboxMode) => void;
  setNetworkAccessWithNotice: (nextValue: RuntimeNetworkAccess) => void;
  addWritableRootWithNotice: (pathValue: string) => void;
  removeWritableRootWithNotice: (pathValue: string) => void;
  clearWritableRootsWithNotice: () => void;
  setServiceTierWithNotice: (nextValue: RuntimeServiceTier) => void;
  setPersonalityWithNotice: (nextValue: RuntimePersonality) => void;
  setAuthPreferenceWithNotice: (nextPreference: AuthPreference) => void;
  providerDiagnosticsRef: React.RefObject<
    Record<string, Record<string, string | number | boolean | null>>
  >;
  setWorkspaceDisplayModeWithNotice: (nextMode: WorkspaceDisplayMode) => void;
  setTerminalTitleModeWithNotice: (nextMode: TerminalTitleMode) => void;
  setShowBusyLoader: React.Dispatch<React.SetStateAction<boolean>>;
  repaintCommittedTheme: (themeName: string) => void;
  refreshAuthStatus: (announce: boolean) => Promise<void>;
  openProviderPicker: () => void;
  openModelPicker: () => void;
  openModePicker: () => void;
  openReasoningPicker: () => void;
  openSettingsPanel: () => void;
  openThemePicker: () => void;
  openPermissionsPanel: () => void;
  openAuthPanel: () => void;
  openUsagePanel: () => void;
  setVerboseMode: React.Dispatch<React.SetStateAction<boolean>>;
  verboseMode: boolean;
  handleCopy: () => Promise<void>;
  handlePasteImage: (replaceCommand?: boolean) => Promise<void>;
  handleWorkspaceRelaunch: (targetPath: string) => void;
  modelCapabilities: CodexModelCapabilities | null;
  refreshModelCapabilities: (
    forceRefresh?: boolean,
    announce?: boolean,
  ) => Promise<CodexModelCapabilities>;
  updateCheckResult: UpdateCheckResult | null;
  requestUpdateCheck: () => Promise<UpdateCheckResult>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  globalPackageManager: GlobalPackageManager;
}

/** Summarizes GitHub access paths. The TUI cannot probe MCP connectors itself. */
function buildGithubDiagnostics(): string {
  const remoteUrl = getLocalGitRemoteUrl();
  const repo = parseRepoIdentity(remoteUrl);
  const ghCli = checkGhCli();
  const localGit = checkLocalGitRemote();
  const localGitWrite = checkLocalGitWrite();
  const connector: DiagnosticResult = {
    path: "GitHub connector/MCP",
    status: "FAIL",
    evidence: "TUI cannot directly probe MCP",
    blocker: "Run /diagnose through the agent for a full probe",
    recommendedUse: false,
  };
  const recommendedFlow = classifyDiagnostics(repo, ghCli, localGit, localGitWrite, connector);
  return formatGithubDiagnostics(repo, ghCli, localGit, localGitWrite, connector, recommendedFlow);
}

export function dispatchCommand(context: CommandDispatchContext): void | Promise<void> {
  const { commandResult, appendEvent } = context;
  const { value, message } = commandResult;

  /** Posts the command's message, if any, as a system event titled `title`. */
  const notify = (title: string) => {
    if (message) {
      appendEvent("system", title, message);
    }
  };

  /**
   * A handler that applies the command's value through `apply`. Without a
   * value it posts the command's message under `noticeTitle`, or does
   * nothing when no title is given.
   */
  const applyOrNotify =
    <T extends string>(apply: (value: T) => unknown, noticeTitle?: string): CommandHandler =>
    () => {
      if (value) {
        apply(value as T);
      } else if (noticeTitle) {
        notify(noticeTitle);
      }
    };

  /** A handler that only posts the command's message. */
  const notifyOnly =
    (title: string): CommandHandler =>
    () =>
      notify(title);

  /** A handler that calls `action` and ignores its result. */
  const run =
    (action: () => unknown): CommandHandler =>
    () => {
      void action();
    };

  const handlers: Partial<Record<CommandAction, CommandHandler>> = {
    // --- Session ------------------------------------------------------------
    exit: run(context.handleQuit),
    clear: run(context.handleClear),
    resume: run(context.openResumePicker),
    copy: run(context.handleCopy),
    paste_image: run(() => context.handlePasteImage(true)),
    workspace_relaunch: applyOrNotify(context.handleWorkspaceRelaunch),
    status: notifyOnly("Runtime status"),
    workspace: notifyOnly("Command"),
    help: notifyOnly("Command"),

    // --- Model, mode and reasoning -------------------------------------------
    model: applyOrNotify<AvailableModel>(context.setModelWithNotice),
    mode: applyOrNotify<AvailableMode>(context.setModeWithNotice, "Mode"),
    reasoning: applyOrNotify<ReasoningLevel>(context.setReasoningWithNotice),
    plan_mode: applyOrNotify((next) => context.setPlanModeWithNotice(next === "on"), "Plan mode"),
    models: () => {
      if (!context.modelCapabilities) {
        void context.refreshModelCapabilities(false, true);
      }
      notify("Command");
    },
    backends: notifyOnly("Command"),

    // --- Runtime policy -------------------------------------------------------
    runtime_approval_policy: applyOrNotify<RuntimeApprovalPolicy>(
      context.setApprovalPolicyWithNotice,
      "Runtime policy",
    ),
    runtime_sandbox_mode: applyOrNotify<RuntimeSandboxMode>(
      context.setSandboxModeWithNotice,
      "Runtime policy",
    ),
    runtime_network_access: applyOrNotify<RuntimeNetworkAccess>(
      context.setNetworkAccessWithNotice,
      "Runtime policy",
    ),
    runtime_service_tier: applyOrNotify<RuntimeServiceTier>(
      context.setServiceTierWithNotice,
      "Runtime policy",
    ),
    runtime_personality: applyOrNotify<RuntimePersonality>(
      context.setPersonalityWithNotice,
      "Runtime policy",
    ),
    runtime_writable_roots_list: notifyOnly("Runtime status"),
    runtime_writable_roots_add: applyOrNotify(context.addWritableRootWithNotice),
    runtime_writable_roots_remove: applyOrNotify(context.removeWritableRootWithNotice),
    runtime_writable_roots_clear: run(context.clearWritableRootsWithNotice),
    permissions_status: notifyOnly("Permissions"),

    // --- Config and trust ------------------------------------------------------
    route_status: notifyOnly("Route status"),
    config_status: notifyOnly("Config"),
    config_trust_status: notifyOnly("Config trust"),
    config_trust_set: applyOrNotify((next) => context.setProjectTrustWithNotice(next === "on")),

    // --- UI settings -------------------------------------------------------------
    setting_status: notifyOnly("Settings"),
    setting_workspace_display: applyOrNotify<WorkspaceDisplayMode>(
      context.setWorkspaceDisplayModeWithNotice,
      "Settings",
    ),
    setting_terminal_title: applyOrNotify<TerminalTitleMode>(
      context.setTerminalTitleModeWithNotice,
      "Settings",
    ),
    setting_busy_loader: applyOrNotify((next) => {
      const showBusyLoader = next === "true";
      context.setShowBusyLoader(showBusyLoader);
      appendEvent("system", "Settings", `Busy loader ${showBusyLoader ? "enabled" : "disabled"}.`);
    }, "Settings"),
    theme: applyOrNotify(context.repaintCommittedTheme),
    themes: notifyOnly("Themes"),
    verbose_toggle: () => {
      if (message) {
        appendEvent("system", "Debug", message);
        return;
      }
      context.setVerboseMode((current) => !current);
      appendEvent(
        "system",
        "Verbose mode",
        context.verboseMode
          ? "Verbose mode disabled — showing concise output."
          : "Verbose mode enabled — showing detailed processing info.",
      );
    },

    // --- Authentication ------------------------------------------------------------
    auth: applyOrNotify<AuthPreference>(context.setAuthPreferenceWithNotice),
    auth_status: run(() => context.refreshAuthStatus(true)),
    login: () => appendEvent("system", "Login guidance", getLoginGuidance()),
    logout: () => appendEvent("system", "Logout guidance", getLogoutGuidance()),

    // --- Panels and pickers ----------------------------------------------------------
    open_provider_picker: run(context.openProviderPicker),
    open_model_picker: run(context.openModelPicker),
    open_mode_picker: run(context.openModePicker),
    open_reasoning_picker: run(context.openReasoningPicker),
    open_settings_panel: run(context.openSettingsPanel),
    open_theme_picker: run(context.openThemePicker),
    open_permissions_panel: run(context.openPermissionsPanel),
    open_auth_panel: run(context.openAuthPanel),
    open_usage_panel: run(context.openUsagePanel),

    // --- Diagnostics -------------------------------------------------------------------
    diagnose_github: () => appendEvent("system", "GitHub Diagnostics", buildGithubDiagnostics()),
    diagnose_providers: () =>
      appendEvent(
        "system",
        "Provider diagnostics",
        formatProviderDiagnostics(context.providerDiagnosticsRef.current),
      ),

    // --- Updates --------------------------------------------------------------------------
    update: async () => {
      const mode = value ?? "status";
      if (isLocalDevChannel() && mode !== "check") {
        appendEvent("system", "Update", formatLocalDevUpdateStatus());
        return;
      }
      void (async () => {
        let result = context.updateCheckResult;
        if (mode === "check" || result === null) {
          try {
            // Shares the background checker's in-flight request and state rules:
            // a failed check is reported here but never clears a detected update.
            result = await context.requestUpdateCheck();
          } catch {
            result = null;
          }
        }
        if (result?.status === "update-available" && result.latestVersion) {
          context.setScreen("update-prompt");
          return;
        }
        const updateCommand = getUpdateCommand(context.globalPackageManager).displayCommand;
        appendEvent("system", "Update", formatUpdateInstructions(result, updateCommand));
      })();
    },

    unknown: notifyOnly("Command"),
  };

  return handlers[commandResult.action]?.();
}
