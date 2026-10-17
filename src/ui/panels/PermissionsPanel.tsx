/**
 * `/permissions` overlay: a `SelectionPanel` menu showing the effective
 * (resolved) approval policy, sandbox mode and network access next to the
 * configured values, plus writable-root actions.
 *
 * Stateless: it only maps a choice to a `PermissionsPanelAction`, which
 * `src/app/overlays/useOverlayRouting.ts` handles: opening a sub-picker or
 * writable-root entry screen, printing the writable-root summary, or clearing
 * the roots. When `providerManaged` is true the provider enforces its
 * own permissions, so the menu collapses to a single "Back to chat" item and
 * every selection cancels.
 */
import type { ResolvedRuntimeConfig, RuntimeConfig } from "../../config/runtimeConfig.js";
import {
  formatApprovalPolicyLabel,
  formatNetworkAccessLabel,
  formatSandboxModeLabel,
} from "../../config/runtimeConfig.js";
import { FOCUS_IDS } from "../input/focus.js";
import { SelectionPanel } from "./SelectionPanel.js";

/** Menu choices reported to the app via `onSelect`. */
export type PermissionsPanelAction =
  | "approval-policy"
  | "sandbox"
  | "network"
  | "writable-roots-summary"
  | "writable-roots-add"
  | "writable-roots-remove"
  | "writable-roots-clear";

interface PermissionsPanelProps {
  /** Configured policy (shown as "configured: …" and used for the writable-root count). */
  runtime: RuntimeConfig;
  /** Effective policy after resolution; shown as the primary value. */
  resolvedRuntime: ResolvedRuntimeConfig;
  /** True when the active provider manages permissions itself (see module header). */
  providerManaged?: boolean;
  onSelect: (action: PermissionsPanelAction) => void;
  onCancel: () => void;
}

function formatRootsSummary(count: number): string {
  return count === 1 ? "1 configured" : `${count} configured`;
}

export function PermissionsPanel({
  runtime,
  resolvedRuntime,
  providerManaged = false,
  onSelect,
  onCancel,
}: PermissionsPanelProps) {
  const items = [
    {
      label: `Approval policy  ${formatApprovalPolicyLabel(resolvedRuntime.policy.approvalPolicy)} (configured: ${formatApprovalPolicyLabel(runtime.policy.approvalPolicy)})`,
      value: "approval-policy",
    },
    {
      label: `Sandbox mode  ${formatSandboxModeLabel(resolvedRuntime.policy.sandboxMode)} (configured: ${formatSandboxModeLabel(runtime.policy.sandboxMode)})`,
      value: "sandbox",
    },
    {
      label: `Network access  ${formatNetworkAccessLabel(resolvedRuntime.policy.networkAccess)} (configured: ${formatNetworkAccessLabel(runtime.policy.networkAccess)})`,
      value: "network",
    },
    {
      label: `Writable roots  ${formatRootsSummary(runtime.policy.writableRoots.length)}`,
      value: "writable-roots-summary",
    },
    {
      label: "Add writable root",
      value: "writable-roots-add",
    },
    {
      label: "Remove writable root",
      value: "writable-roots-remove",
    },
    {
      label: "Clear writable roots",
      value: "writable-roots-clear",
    },
  ] satisfies Array<{ label: string; value: PermissionsPanelAction }>;

  return (
    <SelectionPanel
      focusId={FOCUS_IDS.permissionsPanel}
      title="Permissions"
      subtitle={
        providerManaged
          ? "Google permissions are managed by Antigravity CLI. Ubume's Codex policy settings are not forwarded."
          : "Ubume policy guards. Recommended for local coding: On request + Workspace write."
      }
      items={providerManaged ? [{ label: "Back to chat", value: "cancel" }] : items}
      limit={providerManaged ? 1 : items.length}
      onSelect={(value) =>
        providerManaged ? onCancel() : onSelect(value as PermissionsPanelAction)
      }
      onCancel={onCancel}
    />
  );
}
