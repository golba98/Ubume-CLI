import {
  formatGithubDiagnostics,
  formatProviderDiagnostics,
} from "../../commands/diagnosticsFormat.js";
import type { handleCommand } from "../../commands/handler.js";

type CommandResult = NonNullable<ReturnType<typeof handleCommand>>;

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

export function dispatchCommand(context: CommandDispatchContext): void | Promise<void> {
  const {
    commandResult,
    handleQuit,
    handleClear,
    openResumePicker,
    setModelWithNotice,
    setModeWithNotice,
    appendEvent,
    setReasoningWithNotice,
    setPlanModeWithNotice,
    setProjectTrustWithNotice,
    setApprovalPolicyWithNotice,
    setSandboxModeWithNotice,
    setNetworkAccessWithNotice,
    addWritableRootWithNotice,
    removeWritableRootWithNotice,
    clearWritableRootsWithNotice,
    setServiceTierWithNotice,
    setPersonalityWithNotice,
    setAuthPreferenceWithNotice,
    providerDiagnosticsRef,
    setWorkspaceDisplayModeWithNotice,
    setTerminalTitleModeWithNotice,
    setShowBusyLoader,
    repaintCommittedTheme,
    refreshAuthStatus,
    openProviderPicker,
    openModelPicker,
    openModePicker,
    openReasoningPicker,
    openSettingsPanel,
    openThemePicker,
    openPermissionsPanel,
    openAuthPanel,
    openUsagePanel,
    setVerboseMode,
    verboseMode,
    handleCopy,
    handlePasteImage,
    handleWorkspaceRelaunch,
    modelCapabilities,
    refreshModelCapabilities,
    updateCheckResult,
    requestUpdateCheck,
    setScreen,
    globalPackageManager,
  } = context;
  const handlers: Partial<
    Record<NonNullable<CommandResult>["action"], () => void | Promise<void>>
  > = {
    exit: () => {
      handleQuit();
      return;
    },
    clear: () => {
      handleClear();
      return;
    },
    resume: () => {
      openResumePicker();
      return;
    },
    model: () => {
      if (commandResult.value) {
        setModelWithNotice(commandResult.value as AvailableModel);
      }
      return;
    },
    mode: () => {
      if (commandResult.value) {
        setModeWithNotice(commandResult.value as AvailableMode);
      } else if (commandResult.message) {
        appendEvent("system", "Mode", commandResult.message);
      }
      return;
    },
    reasoning: () => {
      if (commandResult.value) {
        setReasoningWithNotice(commandResult.value as ReasoningLevel);
      }
      return;
    },
    plan_mode: () => {
      if (commandResult.value) {
        setPlanModeWithNotice(commandResult.value === "on");
      } else if (commandResult.message) {
        appendEvent("system", "Plan mode", commandResult.message);
      }
      return;
    },
    status: () => {},
    runtime_writable_roots_list: () => {
      if (commandResult.message) {
        appendEvent("system", "Runtime status", commandResult.message);
      }
      return;
    },
    route_status: () => {
      if (commandResult.message) {
        appendEvent("system", "Route status", commandResult.message);
      }
      return;
    },
    config_status: () => {
      if (commandResult.message) {
        appendEvent("system", "Config", commandResult.message);
      }
      return;
    },
    config_trust_status: () => {
      if (commandResult.message) {
        appendEvent("system", "Config trust", commandResult.message);
      }
      return;
    },
    config_trust_set: () => {
      if (commandResult.value) {
        setProjectTrustWithNotice(commandResult.value === "on");
      }
      return;
    },
    permissions_status: () => {
      if (commandResult.message) {
        appendEvent("system", "Permissions", commandResult.message);
      }
      return;
    },
    runtime_approval_policy: () => {
      if (commandResult.value) {
        setApprovalPolicyWithNotice(commandResult.value as RuntimeApprovalPolicy);
      } else if (commandResult.message) {
        appendEvent("system", "Runtime policy", commandResult.message);
      }
      return;
    },
    runtime_sandbox_mode: () => {
      if (commandResult.value) {
        setSandboxModeWithNotice(commandResult.value as RuntimeSandboxMode);
      } else if (commandResult.message) {
        appendEvent("system", "Runtime policy", commandResult.message);
      }
      return;
    },
    runtime_network_access: () => {
      if (commandResult.value) {
        setNetworkAccessWithNotice(commandResult.value as RuntimeNetworkAccess);
      } else if (commandResult.message) {
        appendEvent("system", "Runtime policy", commandResult.message);
      }
      return;
    },
    runtime_writable_roots_add: () => {
      if (commandResult.value) {
        addWritableRootWithNotice(commandResult.value);
      }
      return;
    },
    runtime_writable_roots_remove: () => {
      if (commandResult.value) {
        removeWritableRootWithNotice(commandResult.value);
      }
      return;
    },
    runtime_writable_roots_clear: () => {
      clearWritableRootsWithNotice();
      return;
    },
    runtime_service_tier: () => {
      if (commandResult.value) {
        setServiceTierWithNotice(commandResult.value as RuntimeServiceTier);
      } else if (commandResult.message) {
        appendEvent("system", "Runtime policy", commandResult.message);
      }
      return;
    },
    diagnose_github: () => {
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
      const summary = formatGithubDiagnostics(
        repo,
        ghCli,
        localGit,
        localGitWrite,
        connector,
        recommendedFlow,
      );
      appendEvent("system", "GitHub Diagnostics", summary);
      return;
    },
    runtime_personality: () => {
      if (commandResult.value) {
        setPersonalityWithNotice(commandResult.value as RuntimePersonality);
      } else if (commandResult.message) {
        appendEvent("system", "Runtime policy", commandResult.message);
      }
      return;
    },
    auth: () => {
      if (commandResult.value) {
        setAuthPreferenceWithNotice(commandResult.value as AuthPreference);
      }
      return;
    },
    diagnose_providers: () => {
      const message = formatProviderDiagnostics(providerDiagnosticsRef.current);
      appendEvent("system", "Provider diagnostics", message);
      return;
    },
    setting_status: () => {
      if (commandResult.message) {
        appendEvent("system", "Settings", commandResult.message);
      }
      return;
    },
    setting_workspace_display: () => {
      if (commandResult.value) {
        setWorkspaceDisplayModeWithNotice(commandResult.value as WorkspaceDisplayMode);
      } else if (commandResult.message) {
        appendEvent("system", "Settings", commandResult.message);
      }
      return;
    },
    setting_terminal_title: () => {
      if (commandResult.value) {
        setTerminalTitleModeWithNotice(commandResult.value as TerminalTitleMode);
      } else if (commandResult.message) {
        appendEvent("system", "Settings", commandResult.message);
      }
      return;
    },
    setting_busy_loader: () => {
      if (commandResult.value) {
        const nextShowBusyLoader = commandResult.value === "true";
        setShowBusyLoader(nextShowBusyLoader);
        appendEvent(
          "system",
          "Settings",
          `Busy loader ${nextShowBusyLoader ? "enabled" : "disabled"}.`,
        );
      } else if (commandResult.message) {
        appendEvent("system", "Settings", commandResult.message);
      }
      return;
    },
    theme: () => {
      if (commandResult.value) {
        repaintCommittedTheme(commandResult.value);
      }
      return;
    },
    themes: () => {
      if (commandResult.message) {
        appendEvent("system", "Themes", commandResult.message);
      }
      return;
    },
    login: () => {
      appendEvent("system", "Login guidance", getLoginGuidance());
      return;
    },
    logout: () => {
      appendEvent("system", "Logout guidance", getLogoutGuidance());
      return;
    },
    auth_status: () => {
      void refreshAuthStatus(true);
      return;
    },
    open_provider_picker: () => {
      openProviderPicker();
      return;
    },
    open_model_picker: () => {
      openModelPicker();
      return;
    },
    open_mode_picker: () => {
      openModePicker();
      return;
    },
    open_reasoning_picker: () => {
      openReasoningPicker();
      return;
    },
    open_settings_panel: () => {
      openSettingsPanel();
      return;
    },
    open_theme_picker: () => {
      openThemePicker();
      return;
    },
    open_permissions_panel: () => {
      openPermissionsPanel();
      return;
    },
    open_auth_panel: () => {
      openAuthPanel();
      return;
    },
    open_usage_panel: () => {
      openUsagePanel();
      return;
    },
    verbose_toggle: () => {
      if (commandResult.message) {
        appendEvent("system", "Debug", commandResult.message);
        return;
      }
      setVerboseMode((current) => !current);
      appendEvent(
        "system",
        "Verbose mode",
        verboseMode
          ? "Verbose mode disabled — showing concise output."
          : "Verbose mode enabled — showing detailed processing info.",
      );
      return;
    },
    copy: () => {
      void handleCopy();
      return;
    },
    paste_image: () => {
      void handlePasteImage(true);
      return;
    },
    workspace_relaunch: () => {
      if (commandResult.value) {
        handleWorkspaceRelaunch(commandResult.value);
      }
      return;
    },
    workspace: () => {},
    backends: () => {
      if (commandResult.message) {
        appendEvent("system", "Command", commandResult.message);
      }
      return;
    },
    models: () => {
      if (!modelCapabilities) {
        void refreshModelCapabilities(false, true);
      }
      if (commandResult.message) {
        appendEvent("system", "Command", commandResult.message);
      }
      return;
    },
    update: async () => {
      const arg = commandResult.value ?? "status";
      if (isLocalDevChannel() && arg !== "check") {
        appendEvent("system", "Update", formatLocalDevUpdateStatus());
        return;
      }
      void (async () => {
        let freshResult = updateCheckResult;
        if (arg === "check" || freshResult === null) {
          try {
            // Shares the background checker's in-flight request and state rules:
            // a failed check is reported here but never clears a detected update.
            freshResult = await requestUpdateCheck();
          } catch {
            freshResult = null;
          }
        }
        if (freshResult?.status === "update-available" && freshResult.latestVersion) {
          setScreen("update-prompt");
        } else {
          appendEvent(
            "system",
            "Update",
            formatUpdateInstructions(
              freshResult,
              getUpdateCommand(globalPackageManager).displayCommand,
            ),
          );
        }
      })();
      return;
    },
    help: () => {},
    unknown: () => {
      if (commandResult.message) {
        appendEvent("system", "Command", commandResult.message);
      }
      return;
    },
  };
  return handlers[commandResult.action]?.();
}
