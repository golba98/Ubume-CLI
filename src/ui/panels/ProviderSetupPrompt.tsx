/**
 * Overlay shown when a provider's CLI executable cannot be found: explains the
 * situation and offers "install and sign in" (when an install command is
 * known) or "I installed it — retry launch", plus Cancel, via `SelectionPanel`.
 *
 * Stateless. Both the install and retry choices call `onInstall`; the caller
 * (`src/app/providers/useProviderRoute.ts` via OverlayPanels) decides what that
 * means. Uses the `providerSetup` focus id. Note: colors here are literal
 * (`yellow`/`gray`) rather than theme tokens.
 */
import { Box, Text } from "ink";
import { FOCUS_IDS } from "../input/focus.js";
import { SelectionPanel } from "./SelectionPanel.js";

interface ProviderSetupPromptProps {
  providerLabel: string;
  /** Executable name that was not found, shown to the user. */
  executable: string;
  /** Install command, or null when Ubume cannot install this provider (manual install + retry). */
  installCommand: string | null;
  /** Sign-in/setup command shown when an install command exists. */
  setupCommand: string;
  onInstall: () => void;
  onCancel: () => void;
}

export function ProviderSetupPrompt({
  providerLabel,
  executable,
  installCommand,
  setupCommand,
  onInstall,
  onCancel,
}: ProviderSetupPromptProps) {
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text color="yellow" bold>
          {providerLabel} is not ready
        </Text>
        <Text color="gray">Ubume could not find `{executable}` on this computer.</Text>
        <Text color="gray">
          {installCommand
            ? `Install it and open ${providerLabel}'s sign-in/setup flow?`
            : `Install ${providerLabel} manually, then retry the launch?`}
        </Text>
        <Text color="gray">
          Credentials stay in the provider’s own CLI and are not stored by Ubume.
        </Text>
        {installCommand && <Text color="gray">Setup command: {setupCommand}</Text>}
      </Box>
      <SelectionPanel
        focusId={FOCUS_IDS.providerSetup}
        title={`Set up ${providerLabel}`}
        subtitle="Enter starts installation and setup · Esc cancels"
        items={
          installCommand
            ? [
                { label: `Install ${providerLabel} and sign in`, value: "install" },
                { label: "Cancel", value: "cancel" },
              ]
            : [
                { label: "I installed it — retry launch", value: "retry" },
                { label: "Cancel", value: "cancel" },
              ]
        }
        onSelect={(value) => (value === "install" || value === "retry" ? onInstall() : onCancel())}
        onCancel={onCancel}
      />
    </Box>
  );
}
