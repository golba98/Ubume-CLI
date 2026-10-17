/**
 * Ink focus-id registry and the screen-to-focus-target mapping.
 *
 * Every focusable panel registers with Ink's focus manager via
 * `useFocus({ id, autoFocus: true })` using one of the ids below, and
 * `src/app/lifecycle/useFocusRouting.ts` calls `focusManager.focus(...)` with
 * `getFocusTargetForScreen(screen)` whenever the active screen (or composer
 * instance) changes. Keeping the ids in one place means a panel and the router
 * cannot drift apart.
 *
 * Pure module: no state, no side effects. A few panels (ResumePicker,
 * WorkbenchPanel, ExternalSessionViewer) pass the id as a string literal; those
 * literals must stay equal to the values here.
 */
import type { Screen } from "../../session/types.js";

/** Ink focus ids for every focusable surface, keyed by a stable code name. */
export const FOCUS_IDS = {
  composer: "composer",
  workbench: "workbench-panel",
  resumePicker: "resume-picker",
  externalSessionViewer: "external-session-viewer",
  resumeWorkspace: "resume-workspace",
  planReviewPanel: "plan-review-panel",
  providerPicker: "provider-picker",
  providerSetup: "provider-setup",
  modelPicker: "model-picker",
  modePicker: "mode-picker",
  reasoningPicker: "reasoning-picker",
  themePicker: "theme-picker",
  settingsPanel: "settings-panel",
  authPanel: "auth-panel",
  permissionsPanel: "permissions-panel",
  permissionsApprovalPicker: "permissions-approval-picker",
  permissionsSandboxPicker: "permissions-sandbox-picker",
  permissionsNetworkPicker: "permissions-network-picker",
  permissionsAddWritableRoot: "permissions-add-writable-root",
  permissionsRemoveWritableRoot: "permissions-remove-writable-root",
  importConfirmationPanel: "import-confirmation",
  toolApprovalPanel: "tool-approval",
  updatePrompt: "update-prompt",
  usagePanel: "usage-panel",
} as const;

/** Union of every registered focus id string. */
export type FocusTargetId = (typeof FOCUS_IDS)[keyof typeof FOCUS_IDS];

/**
 * Map an app `Screen` to the focus id that should own keyboard input on it.
 *
 * The saved and external session viewers share one component and therefore
 * one id. `main` and any unknown screen fall back to the composer, so focus is
 * never left on an unmounted panel.
 */
export function getFocusTargetForScreen(screen: Screen): FocusTargetId {
  switch (screen) {
    case "workbench-panel":
      return FOCUS_IDS.workbench;
    case "resume-picker":
      return FOCUS_IDS.resumePicker;
    case "saved-session-viewer":
    case "external-session-viewer":
      return FOCUS_IDS.externalSessionViewer;
    case "resume-workspace":
      return FOCUS_IDS.resumeWorkspace;
    case "provider-picker":
      return FOCUS_IDS.providerPicker;
    case "provider-setup":
      return FOCUS_IDS.providerSetup;
    case "model-picker":
      return FOCUS_IDS.modelPicker;
    case "mode-picker":
      return FOCUS_IDS.modePicker;
    case "reasoning-picker":
      return FOCUS_IDS.reasoningPicker;
    case "theme-picker":
      return FOCUS_IDS.themePicker;
    case "settings-panel":
      return FOCUS_IDS.settingsPanel;
    case "auth-panel":
      return FOCUS_IDS.authPanel;
    case "permissions-panel":
      return FOCUS_IDS.permissionsPanel;
    case "permissions-approval-picker":
      return FOCUS_IDS.permissionsApprovalPicker;
    case "permissions-sandbox-picker":
      return FOCUS_IDS.permissionsSandboxPicker;
    case "permissions-network-picker":
      return FOCUS_IDS.permissionsNetworkPicker;
    case "permissions-add-writable-root":
      return FOCUS_IDS.permissionsAddWritableRoot;
    case "permissions-remove-writable-root":
      return FOCUS_IDS.permissionsRemoveWritableRoot;
    case "import-confirmation":
      return FOCUS_IDS.importConfirmationPanel;
    case "tool-approval":
      return FOCUS_IDS.toolApprovalPanel;
    case "update-prompt":
      return FOCUS_IDS.updatePrompt;
    case "usage-panel":
      return FOCUS_IDS.usagePanel;
    case "main":
    default:
      return FOCUS_IDS.composer;
  }
}
