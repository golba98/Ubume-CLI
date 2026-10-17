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
  busy: boolean;
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
    busy,
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

  const applyWorkspaceDisplayMode = useCallback((nextMode: WorkspaceDisplayMode) => {
    setWorkspaceDisplayMode(nextMode);
  }, []);

  const setWorkspaceDisplayModeWithNotice = useCallback(
    (nextMode: WorkspaceDisplayMode) => {
      applyWorkspaceDisplayMode(nextMode);
    },
    [applyWorkspaceDisplayMode],
  );

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

  const saveSettingsFromPanel = useCallback(
    (nextSettings: UserSettingValues) => {
      if (nextSettings.workspaceDisplayMode !== workspaceDisplayMode) {
        applyWorkspaceDisplayMode(nextSettings.workspaceDisplayMode);
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
    [applyWorkspaceDisplayMode, showBusyLoader, terminalTitleMode, workspaceDisplayMode],
  );

  const handleSkipUpdateForSession = useCallback(() => {
    returnFromUpdateOverlay();
  }, [returnFromUpdateOverlay]);

  const setPolicyField = useCallback(
    <K extends keyof typeof POLICY_FIELDS>(field: K, value: RuntimeConfig["policy"][K]) => {
      updateRuntimePolicy((current) => ({ ...current, [field]: value }));
      const spec = POLICY_FIELDS[field];
      appendEvent("system", "Runtime policy", `${spec.label} set to ${spec.format(value)}.`);
    },
    [appendEvent, busy, updateRuntimePolicy],
  );
  const setApprovalPolicyWithNotice = useCallback(
    (nextValue: RuntimeApprovalPolicy) => {
      setPolicyField("approvalPolicy", nextValue);
    },
    [appendEvent, busy, updateRuntimePolicy],
  );

  const setSandboxModeWithNotice = useCallback(
    (nextValue: RuntimeSandboxMode) => {
      setPolicyField("sandboxMode", nextValue);
    },
    [appendEvent, busy, updateRuntimePolicy],
  );

  const setNetworkAccessWithNotice = useCallback(
    (nextValue: RuntimeNetworkAccess) => {
      setPolicyField("networkAccess", nextValue);
    },
    [appendEvent, busy, updateRuntimePolicy],
  );

  const addWritableRootWithNotice = useCallback(
    (pathValue: string) => {
      const resolvedPath = resolveWritableRootCommandPath(pathValue, workspaceRoot);
      updateRuntimeConfig((current) => addWritableRoot(current, resolvedPath));
      appendEvent("system", "Runtime policy", `Writable root added: ${resolvedPath}.`);
    },
    [appendEvent, busy, updateRuntimeConfig, workspaceRoot],
  );

  const removeWritableRootWithNotice = useCallback(
    (pathValue: string) => {
      const resolvedPath = resolveWritableRootCommandPath(pathValue, workspaceRoot);
      updateRuntimeConfig((current) => removeWritableRoot(current, resolvedPath));
      appendEvent("system", "Runtime policy", `Writable root removed: ${resolvedPath}.`);
    },
    [appendEvent, busy, updateRuntimeConfig, workspaceRoot],
  );

  const clearWritableRootsWithNotice = useCallback(() => {
    updateRuntimeConfig((current) => clearWritableRoots(current));
    appendEvent("system", "Runtime policy", "Writable roots cleared.");
  }, [appendEvent, busy, updateRuntimeConfig]);

  const setServiceTierWithNotice = useCallback(
    (nextValue: RuntimeServiceTier) => {
      setPolicyField("serviceTier", nextValue);
    },
    [appendEvent, busy, updateRuntimePolicy],
  );

  const setPersonalityWithNotice = useCallback(
    (nextValue: RuntimePersonality) => {
      setPolicyField("personality", nextValue);
    },
    [appendEvent, busy, updateRuntimePolicy],
  );

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
    [appendEvent, baseLayeredConfig.diagnostics.projectRoot, busy, reloadBaseLayeredConfig],
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
