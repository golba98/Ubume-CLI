/**
 * Confirmation overlay (`import-confirmation` screen) for copying files that
 * live outside the workspace into the attachments directory before they are
 * attached to a prompt.
 *
 * Shows each source file and its destination, a warning when images are being
 * imported for a model known not to support vision, and Import once / Cancel.
 * Owns only the highlighted button; the pending import list is owned by
 * `src/app` (`useAppState` / `useWorkbenchActions`), which performs the copy in
 * `onConfirm`. The destination is shown relative to the workspace, or
 * home-abbreviated when it lies outside it.
 *
 * Focus: registers `focusId` with `autoFocus`; input is handled only while
 * focused. Keys: Left selects Import, Right/Tab selects Cancel, Enter confirms
 * the highlighted button, Esc cancels.
 */
import path from "node:path";
import { Box, Text, useFocus, useInput } from "ink";
import { useState } from "react";
import { getHomeDir } from "../../config/settings.js";
import { useTheme } from "../theme.js";

/** One file awaiting import confirmation. */
export interface PendingImportFile {
  /** Resolved source path on disk. */
  srcPath: string;
  /** Path as written in the prompt; the app replaces it with the imported copy's path. */
  rawPath: string;
  /** File name it will get inside the attachments directory. */
  destFilename: string;
  isImage: boolean;
}

interface AttachmentImportPanelProps {
  focusId: string;
  files: PendingImportFile[];
  attachmentsDir: string;
  workspaceRoot: string;
  /** `false` shows the image warning; `null` (unknown) does not. */
  modelSupportsVision: boolean | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Display helper: normalize separators to `/` and replace a leading home
 * directory with `~`. Paths outside home (or equal to it) are returned
 * normalized but otherwise unchanged.
 */
export function compactHomePath(value: string, homeDir = getHomeDir()): string {
  const normalizedValue = value.replace(/\\/g, "/");
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalizedHome || normalizedValue === normalizedHome) return normalizedValue;
  return normalizedValue.startsWith(`${normalizedHome}/`)
    ? `~/${normalizedValue.slice(normalizedHome.length + 1)}`
    : normalizedValue;
}

/** Import confirmation; see the module header for keys. */
export function AttachmentImportPanel({
  focusId,
  files,
  attachmentsDir,
  workspaceRoot,
  modelSupportsVision,
  onConfirm,
  onCancel,
}: AttachmentImportPanelProps) {
  const theme = useTheme();
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        if (selectedIndex === 0) onConfirm();
        else onCancel();
        return;
      }
      if (key.leftArrow) setSelectedIndex(0);
      if (key.rightArrow || key.tab) setSelectedIndex(1);
    },
    { isActive: isFocused },
  );

  const relativeAttachmentsDir = path.relative(workspaceRoot, attachmentsDir).replace(/\\/g, "/");
  const displayedAttachmentsDir = relativeAttachmentsDir.startsWith("..")
    ? compactHomePath(attachmentsDir)
    : relativeAttachmentsDir;
  const hasImages = files.some((f) => f.isImage);
  const showVisionWarning = hasImages && modelSupportsVision === false;
  const fileLabel = files.length === 1 ? "file" : "files";

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Box borderStyle="round" borderColor={theme.border} paddingX={2} paddingY={1} width="100%">
        <Text color={theme.accent} bold>
          IMPORT FILE{" "}
        </Text>
        <Text color={theme.textMuted}>
          Copy {files.length} outside-workspace {fileLabel} into {displayedAttachmentsDir}?
        </Text>
      </Box>

      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={1}
        marginTop={1}
        width="100%"
        flexDirection="column"
      >
        {files.map((file, i) => (
          <Box key={i} marginBottom={i < files.length - 1 ? 1 : 0}>
            <Text color={theme.text}>{path.basename(file.srcPath)} </Text>
            <Text color={theme.textDim}>
              {"→ "}
              {displayedAttachmentsDir}/{file.destFilename}
            </Text>
          </Box>
        ))}

        {showVisionWarning && (
          <Box marginTop={1}>
            <Text color={theme.warning}>Note: active model may not support images.</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text
            color={selectedIndex === 0 ? theme.accent : theme.textMuted}
            bold={selectedIndex === 0}
          >
            {selectedIndex === 0 ? "› " : "  "}Import once
          </Text>
          <Text color={theme.textDim}> · </Text>
          <Text
            color={selectedIndex === 1 ? theme.accent : theme.textMuted}
            bold={selectedIndex === 1}
          >
            {selectedIndex === 1 ? "› " : "  "}Cancel
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.textMuted}>
            This copies only the listed {fileLabel}; it does not grant folder or workspace access.
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.textDim}>←/→ to navigate · Enter to select · Esc to cancel</Text>
        </Box>
      </Box>
    </Box>
  );
}
