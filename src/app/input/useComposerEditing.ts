/**
 * Composer editing actions: text changes, pasted-content registration,
 * clipboard images and prompt-history navigation.
 *
 * Callbacks read live values through refs so their identities stay stable
 * while the user types.
 */

import path from "node:path";
import { useCallback } from "react";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import { readClipboardImage } from "../../core/shared/clipboard.js";
import { errorMessage } from "../../core/shared/values.js";
import { sanitizeTerminalInput } from "../../core/terminal/terminalSanitize.js";
import { resolveUbumeAttachmentDir } from "../../core/workspace/appData.js";
import { saveClipboardImage } from "../../core/workspace/attachments.js";
import type { SessionAction } from "../../session/appSession.js";
import {
  createImageAttachmentToken,
  type ImageAttachmentRegistry,
  type PastedContentRegistry,
} from "../../ui/input/pastedContent.js";

interface UseComposerEditingContext {
  // Session and feedback
  dispatchSession: (action: SessionAction) => void;
  appendEvent: (type: "system" | "error", title: string, content: string) => void;

  // Attachment registries
  pastedContentRegistryRef: React.RefObject<PastedContentRegistry>;
  imageAttachmentRegistryRef: React.RefObject<ImageAttachmentRegistry>;

  // Composer input state
  inputValueRef: React.RefObject<string>;
  cursorRef: React.RefObject<number>;

  // Workspace, config and guards
  workspaceRoot: string;
  runtimeConfig: RuntimeConfig;
  busyRef: React.RefObject<boolean>;
}

export function useComposerEditing(context: UseComposerEditingContext) {
  const {
    dispatchSession,
    pastedContentRegistryRef,
    busyRef,
    workspaceRoot,
    runtimeConfig,
    imageAttachmentRegistryRef,
    inputValueRef,
    cursorRef,
    appendEvent,
  } = context;

  // ─── Stable composer-input callbacks ──────────────────────────────────────────
  // These use refs so the function identity never changes, avoiding
  // unnecessary downstream work even though the memo comparator on
  // MemoizedBottomComposer already skips callback checks.
  const handleChangeInput = useCallback(
    (value: string, nextCursor: number) => {
      const safeValue = sanitizeTerminalInput(value);
      dispatchSession({
        type: "SET_INPUT",
        value: safeValue,
        cursor: Math.min(nextCursor, safeValue.length),
      });
    },
    [dispatchSession],
  );

  const handleRegisterPaste = useCallback((label: string, content: string) => {
    const current = pastedContentRegistryRef.current.get(label) ?? [];
    pastedContentRegistryRef.current.set(label, [...current, content]);
  }, []);

  /**
   * Saves the clipboard image into the attachments folder and inserts its
   * token at the cursor (or replaces the composer text for `/paste-image`).
   */
  const handlePasteImage = useCallback(
    async (replaceCommand = false) => {
      if (busyRef.current) {
        return;
      }

      try {
        const clipboardImage = await readClipboardImage();
        const attachmentsDir = resolveUbumeAttachmentDir(
          workspaceRoot,
          runtimeConfig.policy.attachmentDir,
        );
        const imagePath = await saveClipboardImage(clipboardImage.data, attachmentsDir);
        const attachment = {
          path: imagePath,
          mediaType: clipboardImage.mediaType,
          name: path.basename(imagePath),
          bytes: clipboardImage.data.length,
        } as const;
        const token = createImageAttachmentToken(attachment);
        imageAttachmentRegistryRef.current.set(token, attachment);

        const currentValue = replaceCommand ? "" : inputValueRef.current;
        const currentCursor = replaceCommand ? 0 : cursorRef.current;
        const separator =
          currentValue && currentCursor > 0 && !/\s$/.test(currentValue.slice(0, currentCursor))
            ? " "
            : "";
        const inserted = `${separator}${token}`;
        const nextValue =
          currentValue.slice(0, currentCursor) + inserted + currentValue.slice(currentCursor);
        const nextCursor = currentCursor + inserted.length;
        dispatchSession({ type: "SET_INPUT", value: nextValue, cursor: nextCursor });
      } catch (error) {
        appendEvent(
          "error",
          "Clipboard image unavailable",
          errorMessage(error, "Could not read an image from the clipboard."),
        );
      }
    },
    [appendEvent, dispatchSession, runtimeConfig.policy.attachmentDir, workspaceRoot],
  );

  const handleHistoryUp = useCallback(() => {
    dispatchSession({ type: "HISTORY_UP" });
  }, [dispatchSession]);

  const handleHistoryDown = useCallback(() => {
    dispatchSession({ type: "HISTORY_DOWN" });
  }, [dispatchSession]);

  return {
    handleChangeInput,
    handleRegisterPaste,
    handlePasteImage,
    handleHistoryUp,
    handleHistoryDown,
  };
}
