/**
 * Single-line text prompt overlay (title box + bordered input with a block
 * cursor). Used for writable-root entry/removal and similar overlays in
 * `src/app/overlays/OverlayPanels.tsx`, and in place of the composer for plan
 * feedback (`src/app/input/useAppComposer.tsx`, with the composer focus id).
 *
 * Owns local `value` and `cursor` (seeded from `initialValue` on mount). The
 * trimmed value goes to `onSubmit`; the caller validates and applies it.
 * Mouse-report fragments are stripped from typed/pasted input. The cursor is a
 * UTF-16 index (no surrogate-pair or wide-glyph handling, unlike the composer).
 *
 * Focus: registers `focusId` with `autoFocus`; input is handled only while
 * focused. Keys: Left/Right move, Backspace and Delete both delete the
 * character before the cursor, Enter submits, Esc cancels; Ctrl/Meta chords
 * are ignored.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useMemo, useState } from "react";
import type { FocusTargetId } from "../input/focus.js";
import { stripMouseEscapes } from "../input/inputBuffer.js";
import { useTheme } from "../theme.js";

interface TextEntryPanelProps {
  focusId: FocusTargetId;
  title: string;
  subtitle: string;
  /** Dimmed text shown in the cursor cell while the value is empty. */
  placeholder?: string;
  /** Initial value; the cursor starts at its end. Read once on mount. */
  initialValue?: string;
  /** Label before the input, e.g. `Path: `. */
  inputLabel?: string;
  footerHint?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function insertAt(value: string, index: number, text: string): string {
  return value.slice(0, index) + text + value.slice(index);
}

/** Text prompt; see the module header for keys. */
export function TextEntryPanel({
  focusId,
  title,
  subtitle,
  placeholder = "",
  initialValue = "",
  inputLabel = "Input",
  footerHint = "Esc to close · Enter to confirm",
  onSubmit,
  onCancel,
}: TextEntryPanelProps) {
  const theme = useTheme();
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.return) {
        onSubmit(value.trim());
        return;
      }

      if (key.leftArrow) {
        setCursor((current) => Math.max(0, current - 1));
        return;
      }

      if (key.rightArrow) {
        setCursor((current) => Math.min(value.length, current + 1));
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue((current) => current.slice(0, cursor - 1) + current.slice(cursor));
        setCursor((current) => Math.max(0, current - 1));
        return;
      }

      if (!input || key.ctrl || key.meta) {
        return;
      }

      const filtered = stripMouseEscapes(input);
      if (!filtered) return;
      setValue((current) => insertAt(current, cursor, filtered));
      setCursor((current) => current + filtered.length);
    },
    { isActive: isFocused },
  );

  // Split the value around the cursor so the cursor cell can be drawn inverted.
  const display = useMemo(() => {
    if (!value) {
      return {
        before: "",
        current: placeholder || " ",
        after: "",
        isPlaceholder: true,
      };
    }

    const safeCursor = Math.max(0, Math.min(cursor, value.length));
    return {
      before: value.slice(0, safeCursor),
      current: value[safeCursor] ?? " ",
      after: value.slice(safeCursor + (safeCursor < value.length ? 1 : 0)),
      isPlaceholder: false,
    };
  }, [cursor, placeholder, value]);

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Box borderStyle="round" borderColor={theme.border} paddingX={2} paddingY={1} width="100%">
        <Text color={theme.accent} bold>
          {title}{" "}
        </Text>
        <Text color={theme.textMuted}>{subtitle}</Text>
      </Box>

      <Box
        borderStyle="round"
        borderColor={theme.borderFocused}
        paddingX={2}
        paddingY={1}
        marginTop={1}
        width="100%"
        flexDirection="column"
      >
        <Box>
          <Text color={theme.text}>{inputLabel}: </Text>
          <Text color={display.isPlaceholder ? theme.textDim : theme.text}>{display.before}</Text>
          <Text backgroundColor={theme.text} color={theme.surface}>
            {display.current}
          </Text>
          <Text color={display.isPlaceholder ? theme.textDim : theme.text}>{display.after}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.textDim}>{footerHint}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Fixed row height reserved for this panel when it replaces the composer
 * (`App.tsx` uses it as `composerRows` during plan feedback). It is a constant,
 * so it does not account for a wrapped title/subtitle; keep it in sync with the
 * JSX above.
 */
export function measureTextEntryPanelRows(): number {
  return 13;
}
