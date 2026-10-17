/**
 * UI preferences and runtime-policy setters used by slash commands and the
 * settings/permissions panels.
 *
 * Preferences (theme, workspace display, terminal title, busy loader, auth
 * preference) are React state here; `useAppLifecycleEffects` saves them to
 * `~/.ubume-settings.json` (built with {@link buildSettingsPayload}).
 * Runtime-policy changes are session overrides applied through
 * `updateRuntimePolicy` / `updateRuntimeConfig` and are not persisted.
 */

import { useCallback } from "react";
import type { LayeredConfigResult } from "../../config/layeredConfig.js";
import type { loadSettings } from "../../config/persistence.js";

import {
  addWritableRoot,
  clearWritableRoots,
  formatApprovalPolicyLabel,
  formatNetworkAccessLabel,
  formatPersonalityLabel,
  formatSandboxModeLabel,
  formatServiceTierLabel,
  type RuntimeApprovalPolicy,
  type RuntimeConfig,
  type RuntimeNetworkAccess,
  type RuntimePersonality,
  type RuntimeSandboxMode,
  type RuntimeServiceTier,
  removeWritableRoot,
  resolveWritableRootCommandPath,
} from "../../config/runtimeConfig.js";
import {
  type AuthPreference,
  formatAuthPreferenceLabel,
  formatWorkspaceDisplayModeLabel,
  parseBusyLoaderSettingValue,
  type TerminalTitleMode,
  type UserSettingValues,
  type WorkspaceDisplayMode,
} from "../../config/settings.js";
import { setProjectTrust } from "../../config/trustStore.js";

import type { Screen } from "../../session/types.js";

/** Runtime policy fields that share the "set and announce" behaviour. */
type PolicyField =
  | "approvalPolicy"
  | "sandboxMode"
  | "networkAccess"
  | "serviceTier"
  | "personality";
const POLICY_FIELDS: {
  [K in PolicyField]: { label: string; format: (value: RuntimeConfig["policy"][K]) => string };
} = {
  approvalPolicy: { label: "Approval policy", format: formatApprovalPolicyLabel },
  sandboxMode: { label: "Sandbox mode", format: formatSandboxModeLabel },
  networkAccess: { label: "Network access", format: formatNetworkAccessLabel },
  serviceTier: { label: "Service tier", format: formatServiceTierLabel },
  personality: { label: "Personality", format: formatPersonalityLabel },
};

interface UseSettingsContext {
  setAuthPreference: React.Dispatch<
    React.SetStateAction<"chatgpt-login-goal" | "api-key-first" | "runner-managed">
  >;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;
  setWorkspaceDisplayMode: React.Dispatch<React.SetStateAction<"dir" | "name" | "simple">>;
  setTerminalTitleMode: React.Dispatch<React.SetStateAction<"dir" | "name" | "simple">>;
  workspaceDisplayMode: "dir" | "name" | "simple";
  terminalTitleMode: "dir" | "name" | "simple";
  showBusyLoader: boolean;
  setShowBusyLoader: React.Dispatch<React.SetStateAction<boolean>>;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  returnFromUpdateOverlay: () => void;
  updateRuntimePolicy: (
    updater: (current: RuntimeConfig["policy"]) => RuntimeConfig["policy"],
  ) => void;
  workspaceRoot: string;
  updateRuntimeConfig: (updater: (current: RuntimeConfig) => RuntimeConfig) => void;
  baseLayeredConfig: LayeredConfigResult;
  reloadBaseLayeredConfig: () => LayeredConfigResult;
}

export function useSettings(context: UseSettingsContext) {
  const {
    setAuthPreference,
    appendEvent,
    setWorkspaceDisplayMode,
    setTerminalTitleMode,
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader,
    setShowBusyLoader,
    setScreen,
    returnFromUpdateOverlay,
    updateRuntimePolicy,
    workspaceRoot,
    updateRuntimeConfig,
    baseLayeredConfig,
    reloadBaseLayeredConfig,
  } = context;

  const setAuthPreferenceWithNotice = useCallback(
    (nextPreference: AuthPreference) => {
      setAuthPreference(nextPreference);
      appendEvent(
        "system",
        "Auth preference updated",
        `Preference set to ${formatAuthPreferenceLabel(nextPreference)}.`,
      );
    },
    [appendEvent],
  );

  // No transcript notice: the header's workspace label changes immediately.
  const setWorkspaceDisplayModeWithNotice = useCallback((nextMode: WorkspaceDisplayMode) => {
    setWorkspaceDisplayMode(nextMode);
  }, []);

  const setTerminalTitleModeWithNotice = useCallback(
    (nextMode: TerminalTitleMode) => {
      setTerminalTitleMode(nextMode);
      appendEvent(
        "system",
        "Settings",
        `Terminal title set to ${formatWorkspaceDisplayModeLabel(nextMode)} (${nextMode}).`,
      );
    },
    [appendEvent],
  );

  /**
   * Applies the settings panel's values. Unlike the slash commands, the panel
   * posts no transcript notices; it only changes what differs.
   */
  const saveSettingsFromPanel = useCallback(
    (nextSettings: UserSettingValues) => {
      if (nextSettings.workspaceDisplayMode !== workspaceDisplayMode) {
        setWorkspaceDisplayMode(nextSettings.workspaceDisplayMode);
      }
      if (nextSettings.terminalTitleMode !== terminalTitleMode) {
        setTerminalTitleMode(nextSettings.terminalTitleMode);
      }
      const nextShowBusyLoader = parseBusyLoaderSettingValue(nextSettings.showBusyLoader);
      if (nextShowBusyLoader !== showBusyLoader) {
        setShowBusyLoader(nextShowBusyLoader);
      }
      setScreen("main");
    },
    [showBusyLoader, terminalTitleMode, workspaceDisplayMode],
  );

  const handleSkipUpdateForSession = useCallback(() => {
    returnFromUpdateOverlay();
  }, [returnFromUpdateOverlay]);

  /** Sets a session runtime-policy field and announces the new value. */
  const setPolicyField = useCallback(
    <K extends keyof typeof POLICY_FIELDS>(field: K, value: RuntimeConfig["policy"][K]) => {
      updateRuntimePolicy((current) => ({ ...current, [field]: value }));
      const spec = POLICY_FIELDS[field];
      appendEvent("system", "Runtime policy", `${spec.label} set to ${spec.format(value)}.`);
    },
    [appendEvent, updateRuntimePolicy],
  );

  const setApprovalPolicyWithNotice = useCallback(
    (nextValue: RuntimeApprovalPolicy) => setPolicyField("approvalPolicy", nextValue),
    [setPolicyField],
  );
  const setSandboxModeWithNotice = useCallback(
    (nextValue: RuntimeSandboxMode) => setPolicyField("sandboxMode", nextValue),
    [setPolicyField],
  );
  const setNetworkAccessWithNotice = useCallback(
    (nextValue: RuntimeNetworkAccess) => setPolicyField("networkAccess", nextValue),
    [setPolicyField],
  );
  const setServiceTierWithNotice = useCallback(
    (nextValue: RuntimeServiceTier) => setPolicyField("serviceTier", nextValue),
    [setPolicyField],
  );
  const setPersonalityWithNotice = useCallback(
    (nextValue: RuntimePersonality) => setPolicyField("personality", nextValue),
    [setPolicyField],
  );

  // Writable roots are resolved against the workspace, as `/permissions` shows them.

  const addWritableRootWithNotice = useCallback(
    (pathValue: string) => {
      const resolvedPath = resolveWritableRootCommandPath(pathValue, workspaceRoot);
      updateRuntimeConfig((current) => addWritableRoot(current, resolvedPath));
      appendEvent("system", "Runtime policy", `Writable root added: ${resolvedPath}.`);
    },
    [appendEvent, updateRuntimeConfig, workspaceRoot],
  );

  const removeWritableRootWithNotice = useCallback(
    (pathValue: string) => {
      const resolvedPath = resolveWritableRootCommandPath(pathValue, workspaceRoot);
      updateRuntimeConfig((current) => removeWritableRoot(current, resolvedPath));
      appendEvent("system", "Runtime policy", `Writable root removed: ${resolvedPath}.`);
    },
    [appendEvent, updateRuntimeConfig, workspaceRoot],
  );

  const clearWritableRootsWithNotice = useCallback(() => {
    updateRuntimeConfig((current) => clearWritableRoots(current));
    appendEvent("system", "Runtime policy", "Writable roots cleared.");
  }, [appendEvent, updateRuntimeConfig]);

  /**
   * Trusts or untrusts the project root and reloads the layered config, so
   * the project's `.codex/config.toml` takes effect (or stops applying) now.
   */
  const setProjectTrustWithNotice = useCallback(
    (trusted: boolean) => {
      const projectRoot = baseLayeredConfig.diagnostics.projectRoot;
      setProjectTrust(projectRoot, trusted);
      reloadBaseLayeredConfig();
      appendEvent(
        "system",
        "Config trust",
        `${trusted ? "Trusted" : "Untrusted"} project root: ${projectRoot}.`,
      );
    },
    [appendEvent, baseLayeredConfig.diagnostics.projectRoot, reloadBaseLayeredConfig],
  );

  return {
    setAuthPreferenceWithNotice,
    setWorkspaceDisplayModeWithNotice,
    setTerminalTitleModeWithNotice,
    saveSettingsFromPanel,
    handleSkipUpdateForSession,
    setApprovalPolicyWithNotice,
    setSandboxModeWithNotice,
    setNetworkAccessWithNotice,
    addWritableRootWithNotice,
    removeWritableRootWithNotice,
    clearWritableRootsWithNotice,
    setServiceTierWithNotice,
    setPersonalityWithNotice,
    setProjectTrustWithNotice,
  };
}

/**
 * The settings file contents for the current preferences. Fields the app
 * does not edit at runtime (layout style, update-check settings) are carried
 * over from the file as it was loaded at startup.
 */
export function buildSettingsPayload(
  initial: ReturnType<typeof loadSettings>,
  ui: Pick<
    ReturnType<typeof loadSettings>["ui"],
    "theme" | "workspaceDisplayMode" | "terminalTitleMode" | "showBusyLoader" | "customTheme"
  >,
  authPreference: AuthPreference,
  header: ReturnType<typeof loadSettings>["header"],
): ReturnType<typeof loadSettings> {
  return {
    ui: { layoutStyle: initial.ui.layoutStyle, ...ui },
    auth: { preference: authPreference },
    header,
    updateCheck: initial.updateCheck,
  };
}
