/**
 * Plan review prompt shown in place of the composer when a plan is ready:
 * "Implement in Auto" or "Redo plan", chosen with ←/→ (or ↑/↓, Tab) and Enter, or
 * the I / R (U) hotkeys. Esc cancels the review.
 *
 * It takes the composer's focus id, because it occupies the composer's slot, and
 * re-claims focus whenever Ink blurs it. Esc is delayed by `ESCAPE_SETTLE_MS` so
 * that an arrow key split across two stdin reads moves the selection instead of
 * cancelling. `measurePlanActionPickerRows` must match the rendered height (1
 * row, or 3 below `VERTICAL_LAYOUT_BREAKPOINT` columns).
 */
import { Box, Text, useFocus, useFocusManager, useInput, useStdin } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { FOCUS_IDS } from "../input/focus.js";
import { type ArrowDirection, getArrowDirection } from "../input/rawArrowKeys.js";
import { isMouseReportSequence, useRawStdinSignals } from "../input/rawStdinSignals.js";
import { useTheme } from "../theme.js";

export type PlanActionValue = "implement" | "revise" | "cancel";

const ACTION_ROWS: Array<{ key: string; label: string; value: PlanActionValue }> = [
  { key: "I", label: "Implement in Auto", value: "implement" },
  { key: "R", label: "Redo plan", value: "revise" },
];
const VERTICAL_LAYOUT_BREAKPOINT = 56;
/**
 * Ink flushes a lone ESC as a bare escape 20ms after it arrives. An arrow key
 * split across two stdin reads therefore looks like "cancel review" followed by
 * stray text, so hold a cancel briefly to see whether the sequence completes.
 */
const ESCAPE_SETTLE_MS = 60;
const RAW_BUFFER_IDLE_MS = 120;
/** Swallow the printable fragments Ink emits for a terminal mouse report. */
const RAW_SIGNALS = { mouse: { matches: isMouseReportSequence, holdMs: 32 } } as const;

interface PlanActionPickerProps {
  cols?: number;
  onSelect: (value: PlanActionValue) => void;
  onCancel: () => void;
}

export function measurePlanActionPickerRows(cols = 80): number {
  return cols < VERTICAL_LAYOUT_BREAKPOINT ? 3 : 1;
}

export function PlanActionPicker({ cols = 80, onSelect, onCancel }: PlanActionPickerProps) {
  const theme = useTheme();
  const { isFocused } = useFocus({ id: FOCUS_IDS.composer, autoFocus: true });
  const { focus } = useFocusManager();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { stdin } = useStdin();
  const rawBufferRef = useRef("");
  const rawBufferTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEscapeRef = useRef(false);
  const escapeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const vertical = cols < VERTICAL_LAYOUT_BREAKPOINT;

  const moveSelection = useCallback((direction: ArrowDirection) => {
    const step = direction === "left" || direction === "up" ? ACTION_ROWS.length - 1 : 1;
    setSelectedIndex((current) => (current + step) % ACTION_ROWS.length);
  }, []);

  const clearPendingEscape = useCallback(() => {
    pendingEscapeRef.current = false;
    if (escapeTimeoutRef.current) {
      clearTimeout(escapeTimeoutRef.current);
      escapeTimeoutRef.current = null;
    }
  }, []);

  // Ink blurs every focusable when it flushes a bare ESC. This picker is only
  // mounted while the plan prompt is up, so any blur here is spurious — without
  // this the prompt silently stops responding to keys.
  useEffect(() => {
    if (!isFocused) focus(FOCUS_IDS.composer);
  }, [focus, isFocused]);

  // Ink may deliver an arrow key split across two stdin reads as a bare ESC (which
  // arms a cancel, see ESCAPE_SETTLE_MS) followed by printable "[B". Reassemble the
  // raw bytes here and apply the movement while the cancel is still pending.
  const handleRawChunk = (raw: string) => {
    if (isMouseReportSequence(raw)) {
      rawBufferRef.current = "";
      return;
    }

    rawBufferRef.current = `${rawBufferRef.current}${raw}`.slice(-16);
    if (rawBufferTimeoutRef.current) clearTimeout(rawBufferTimeoutRef.current);
    rawBufferTimeoutRef.current = setTimeout(() => {
      rawBufferRef.current = "";
    }, RAW_BUFFER_IDLE_MS);

    const direction = getArrowDirection(rawBufferRef.current);
    if (!direction) return;
    rawBufferRef.current = "";
    // Ink already delivered the leading ESC as a cancel-in-waiting, so it will
    // never surface this chunk as an arrow key — apply the movement here.
    if (pendingEscapeRef.current) {
      clearPendingEscape();
      moveSelection(direction);
    }
  };
  const rawSignals = useRawStdinSignals(stdin, RAW_SIGNALS, handleRawChunk);

  useEffect(() => {
    return () => {
      if (rawBufferTimeoutRef.current) clearTimeout(rawBufferTimeoutRef.current);
      if (escapeTimeoutRef.current) clearTimeout(escapeTimeoutRef.current);
    };
  }, []);

  useInput(
    (input, key) => {
      if (rawSignals.isActive("mouse")) return;

      if (key.escape) {
        pendingEscapeRef.current = true;
        if (escapeTimeoutRef.current) clearTimeout(escapeTimeoutRef.current);
        escapeTimeoutRef.current = setTimeout(() => {
          escapeTimeoutRef.current = null;
          if (!pendingEscapeRef.current) return;
          pendingEscapeRef.current = false;
          onCancelRef.current();
        }, ESCAPE_SETTLE_MS);
        return;
      }

      // Tail of an escape sequence Ink could not reassemble; the raw listener owns it.
      if (input.startsWith("[") || input.startsWith("O")) return;

      clearPendingEscape();

      if (key.return) {
        onSelect(ACTION_ROWS[selectedIndex]?.value ?? "implement");
        return;
      }

      if (key.upArrow || key.leftArrow || (key.shift && key.tab)) {
        moveSelection("left");
        return;
      }

      if (key.downArrow || key.rightArrow || key.tab) {
        moveSelection("right");
        return;
      }

      if (input.length === 1 && !key.meta && !key.ctrl) {
        const lower = input.toLowerCase();
        if (lower === "i") {
          onSelect("implement");
          return;
        }
        if (lower === "r" || lower === "u") {
          onSelect("revise");
          return;
        }
      }
    },
    { isActive: isFocused },
  );

  const renderAction = (row: (typeof ACTION_ROWS)[number], index: number) => {
    const selected = index === selectedIndex;
    return (
      <Text key={row.value}>
        <Text color={selected ? theme.accent : theme.textDim}>
          {selected ? "› " : vertical ? "  " : ""}
        </Text>
        <Text color={selected ? theme.text : theme.textMuted}>{`[${row.key}] ${row.label}`}</Text>
      </Text>
    );
  };

  if (vertical) {
    return (
      <Box flexDirection="column">
        <Text color={isFocused ? theme.text : theme.textMuted} bold={isFocused}>
          Plan ready
        </Text>
        {ACTION_ROWS.map(renderAction)}
      </Box>
    );
  }

  return (
    <Text>
      <Text color={isFocused ? theme.text : theme.textMuted} bold={isFocused}>
        Plan ready
      </Text>
      <Text color={theme.textDim}>{"  "}</Text>
      {ACTION_ROWS.map((row, index) => (
        <React.Fragment key={row.value}>
          {renderAction(row, index)}
          {index < ACTION_ROWS.length - 1 && <Text color={theme.textDim}>{"   "}</Text>}
        </React.Fragment>
      ))}
    </Text>
  );
}
