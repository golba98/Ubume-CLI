/**
 * Update overlay (`update-prompt` screen): offers "Update now" / "Later", runs
 * the global package-manager update in-process while streaming its output, and
 * then offers a restart or shows the failure.
 *
 * State machine (local): `available` -> `installing` -> `success` | `failed`.
 * Entering `installing` starts the update command in an effect; the effect's
 * cleanup cancels the command if it has not settled (on Esc, unmount or a state
 * change) and ignores late results via a `disposed` flag. The package manager
 * and version info come from `src/app`; `onSkip` / `onRestart` hand control
 * back to it.
 *
 * Listeners: a raw stdin `data` listener (removed on unmount) records the last
 * horizontal arrow seen in a raw chunk, which `useInput` uses as a fallback to
 * `key.leftArrow` / `key.rightArrow` (see `input/rawArrowKeys.ts`).
 *
 * Keys: available — Left/h, Right/l choose, Enter confirms, Esc skips;
 * installing — Esc cancels back to `available`; success — Enter restarts, Esc
 * skips; failed — Enter or Esc closes.
 */
import { Box, Text, useFocus, useInput, useStdin } from "ink";
import { useEffect, useRef, useState } from "react";
import type { CommandResult, CommandStreamHandlers } from "../../core/process/commandRunner.js";
import {
  formatPermissionGuidance,
  type GlobalPackageManager,
  getUpdateCommand,
  isPermissionError,
  runUpdateCommand,
} from "../../core/version/packageManager.js";
import { formatVersionLabel, UBUME_NPM_PACKAGE } from "../../core/version/updateCheck.js";
import {
  getHorizontalArrowDirection,
  type HorizontalArrowDirection,
} from "../input/rawArrowKeys.js";
import { useTheme } from "../theme.js";

type UpdateUIState = "available" | "installing" | "success" | "failed";

/** Starts the update command; returns its result promise and a cancel function. */
export type RunUpdateFn = (
  pm: GlobalPackageManager,
  handlers?: CommandStreamHandlers,
) => { result: Promise<CommandResult>; cancel: () => void };

const MENU_ITEMS = [{ label: "Update now" }, { label: "Later" }] as const;

type HorizontalDirection = HorizontalArrowDirection;

// Re-exported so existing imports from this module (e.g. tests) keep working.
export { getHorizontalArrowDirection };

interface UpdatePromptPanelProps {
  focusId: string;
  currentVersion: string;
  latestVersion: string;
  packageManager: GlobalPackageManager;
  /** Test seam — defaults to the real cross-platform runner. */
  runUpdate?: RunUpdateFn;
  onSkip: () => void;
  onRestart: () => void;
}

/** Update prompt; see the module header for the state machine and keys. */
export function UpdatePromptPanel({
  focusId,
  currentVersion,
  latestVersion,
  packageManager,
  runUpdate,
  onSkip,
  onRestart,
}: UpdatePromptPanelProps) {
  const theme = useTheme();
  const { stdin } = useStdin();
  const { isFocused, focus } = useFocus({ id: focusId, autoFocus: true });

  const [updateState, setUpdateState] = useState<UpdateUIState>("available");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Last horizontal arrow decoded from raw stdin. Consumed (reset) by the next
  // `useInput` call in the `available` state.
  const rawArrowRef = useRef<HorizontalDirection | null>(null);

  useEffect(() => {
    const handleRawInput = (chunk: Buffer | string) => {
      rawArrowRef.current = getHorizontalArrowDirection(
        typeof chunk === "string" ? chunk : chunk.toString(),
      );
    };
    stdin.on("data", handleRawInput);
    return () => {
      stdin.off("data", handleRawInput);
    };
  }, [stdin]);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (updateState === "installing") {
          setOutputLines([]);
          setErrorMessage(null);
          setUpdateState("available");
          // Ink clears the active focus id for every bare Escape before
          // dispatching useInput handlers. Cancellation keeps this panel open,
          // so explicitly retain its focus for the restored available state.
          focus(focusId);
          return;
        }
        onSkip();
        return;
      }
      if (updateState === "available") {
        const rawArrow = rawArrowRef.current;
        rawArrowRef.current = null;
        if (key.leftArrow || rawArrow === "left" || input === "h") {
          setSelectedIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.rightArrow || rawArrow === "right" || input === "l") {
          setSelectedIndex((i) => Math.min(MENU_ITEMS.length - 1, i + 1));
          return;
        }
        if (key.return) {
          if (selectedIndex === 0) {
            setOutputLines([]);
            setErrorMessage(null);
            setUpdateState("installing");
          } else {
            onSkip();
          }
          return;
        }
      } else if (updateState === "success") {
        if (key.return) {
          onRestart();
        }
      } else if (updateState === "failed") {
        if (key.return) {
          onSkip();
        }
      }
    },
    { isActive: isFocused },
  );

  useEffect(() => {
    if (updateState !== "installing") return;

    let disposed = false;
    const appendLines = (text: string) => {
      if (disposed) return;
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) {
        setOutputLines((prev) => [...prev, ...lines]);
      }
    };

    const runner = runUpdate ?? runUpdateCommand;
    const { result, cancel } = runner(packageManager, {
      onStdout: appendLines,
      onStderr: appendLines,
    });

    let settled = false;
    void result.then((res) => {
      if (disposed) return;
      settled = true;
      if (res.status === "completed" && res.exitCode === 0) {
        setUpdateState("success");
        return;
      }
      if (isPermissionError(res)) {
        setErrorMessage(formatPermissionGuidance(packageManager));
      } else {
        setErrorMessage(res.userMessage);
      }
      setUpdateState("failed");
    });

    return () => {
      disposed = true;
      if (!settled) cancel();
    };
  }, [updateState, packageManager, runUpdate]);

  const footerText =
    updateState === "available"
      ? "←/→ to choose · Enter to confirm · Esc to close"
      : updateState === "success"
        ? "Enter to restart · Esc to stay in Ubume"
        : updateState === "installing"
          ? "Esc to cancel"
          : "Esc to close";

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor={updateState === "available" ? theme.borderFocused : theme.border}
        paddingX={2}
        paddingY={1}
        width="100%"
        flexDirection="column"
      >
        {updateState === "available" && (
          <>
            <Text color={theme.accent} bold>{`Update available: Ubume ${latestVersion}`}</Text>
            <Box marginTop={1}>
              <Text color={theme.text}>{`Current version: ${currentVersion}`}</Text>
            </Box>
            <Text color={theme.textMuted}>{`Package: ${UBUME_NPM_PACKAGE}`}</Text>
            <Text
              color={theme.textMuted}
            >{`Run: ${getUpdateCommand(packageManager).displayCommand}`}</Text>
            <Box marginTop={1}>
              {MENU_ITEMS.map((item, index) => (
                <Text
                  key={item.label}
                  color={index === selectedIndex ? theme.text : theme.textMuted}
                  bold={index === selectedIndex}
                >
                  {`${index === selectedIndex ? "❯ " : "  "}[ ${item.label} ]${index === 0 ? "  " : ""}`}
                </Text>
              ))}
            </Box>
          </>
        )}

        {updateState === "installing" && (
          <>
            <Text color={theme.text}>{`Installing Ubume ${latestVersion}...`}</Text>
            {outputLines.map((line, i) => (
              <Text key={i} color={theme.textMuted}>
                {line}
              </Text>
            ))}
          </>
        )}

        {updateState === "success" && (
          <>
            <Text
              color={theme.success}
            >{`Ubume ${formatVersionLabel(latestVersion)} installed successfully.`}</Text>
            <Text color={theme.textMuted}>{"Restart Ubume to use the new version."}</Text>
            <Box marginTop={1}>
              <Text color={theme.text} bold>
                {"❯ [ Restart now ]"}
              </Text>
            </Box>
          </>
        )}

        {updateState === "failed" && (
          <>
            <Text color={theme.error}>{"Update failed."}</Text>
            {errorMessage != null && <Text color={theme.textMuted}>{errorMessage}</Text>}
            {outputLines.slice(-5).map((line, i) => (
              <Text key={i} color={theme.textDim}>
                {line}
              </Text>
            ))}
          </>
        )}

        <Box marginTop={1}>
          <Text color={theme.textDim}>{footerText}</Text>
        </Box>
      </Box>
    </Box>
  );
}
