/**
 * Generic single-select list overlay: bordered box, title, scrolling items and a
 * key hint. Backs the mode, theme and reasoning pickers (`SimplePickers.tsx`),
 * `SettingsPanel`'s sub-pickers, PermissionsPanel and others.
 *
 * Owns local `selectedIndex` and `scrollOffset`; items, callbacks and the focus
 * id come from the caller. Size comes from `usePanelLayout()` (provided by
 * `AppShell`), with fallbacks for standalone rendering. Below 3 available rows
 * the border, title and hint are dropped so at least the list remains.
 *
 * Focus: registers `focusId` with `autoFocus`; input is only handled while
 * focused. Keys: Up/Down or k/j move, PageUp/PageDown move by one window,
 * Home/End jump, Enter selects, Esc cancels.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { clampVisualText } from "../../core/shared/text.js";
import { clampIndex } from "../../core/shared/values.js";
import { usePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";
import { calculateResponsivePickerViewport } from "./responsivePickerViewport.js";

interface SelectionPanelProps {
  /** Ink focus id (one of `FOCUS_IDS`); must match what focus routing targets for the screen. */
  focusId: string;
  title: string;
  /** Appended to the title only when the panel is at least 70 columns wide. */
  subtitle: string;
  /** Items keyed by `value`, which must be unique (used as React key). */
  items: Array<{ label: string; value: string }>;
  /** Accepted for API compatibility but currently unused; the window size comes from the layout. */
  limit?: number;
  /** Value to preselect on mount; falls back to the first item. */
  initialValue?: string;
  onSelect: (value: string) => void;
  /** Called on every keyboard move (not on mount), e.g. for live theme preview. */
  onHighlight?: (value: string) => void;
  onCancel: () => void;
  onReplay?: () => void;
}

export function SelectionPanel({
  focusId,
  title,
  subtitle,
  items,
  initialValue,
  onSelect,
  onHighlight,
  onCancel,
  onReplay,
}: SelectionPanelProps) {
  const theme = useTheme();
  const panelLayout = usePanelLayout();
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const initialIndex = initialValue ? items.findIndex((item) => item.value === initialValue) : -1;
    return initialIndex >= 0 ? initialIndex : 0;
  });
  const [scrollOffset, setScrollOffset] = useState(0);
  const availableRows = Math.max(1, panelLayout?.availableRows ?? 12);
  const innerWidth = Math.max(1, (panelLayout?.availableCols ?? 80) - 2);

  const viewport = useMemo(
    () =>
      calculateResponsivePickerViewport({
        itemCount: items.length,
        selectedIndex,
        availableRows,
        chromeRows: availableRows >= 3 ? 2 : 0,
        scrollOffset,
      }),
    [availableRows, items.length, scrollOffset, selectedIndex],
  );

  // Keep the selection valid if the item list shrinks while open.
  useEffect(() => {
    setSelectedIndex((current) => clampIndex(current, items.length));
  }, [items.length]);

  // Persist the computed window start so the next render scrolls from here.
  useEffect(() => {
    setScrollOffset(viewport.start);
  }, [viewport.start]);

  const highlightIndex = (index: number) => {
    const nextIndex = clampIndex(index, items.length);
    setSelectedIndex(nextIndex);
    const item = items[nextIndex];
    if (item) onHighlight?.(item.value);
  };

  useInput(
    (input, key) => {
      if (input === "r" && onReplay) {
        onReplay();
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        const item = items[viewport.selectedIndex];
        if (item) onSelect(item.value);
        return;
      }
      if (key.home) {
        highlightIndex(0);
        return;
      }
      if (key.end) {
        highlightIndex(items.length - 1);
        return;
      }
      if (key.pageUp) {
        highlightIndex(selectedIndex - Math.max(1, viewport.capacity));
        return;
      }
      if (key.pageDown) {
        highlightIndex(selectedIndex + Math.max(1, viewport.capacity));
        return;
      }
      if (key.upArrow || input === "k") {
        highlightIndex(selectedIndex - 1);
        return;
      }
      if (key.downArrow || input === "j") {
        highlightIndex(selectedIndex + 1);
      }
    },
    { isActive: isFocused },
  );

  const visibleItems = items.slice(viewport.start, viewport.end);
  const titleText = viewport.hasOverflow
    ? `${title} · ${viewport.selectedIndex + 1}/${items.length}`
    : title;
  const heading = innerWidth >= 70 ? `${titleText}  ${subtitle}` : titleText;

  return (
    <Box
      borderStyle={availableRows >= 3 ? "round" : undefined}
      borderColor={theme.borderFocused}
      paddingX={availableRows >= 3 ? 1 : 0}
      width="100%"
      flexDirection="column"
      overflow="hidden"
    >
      {availableRows >= 3 && (
        <Text color={theme.accent} bold wrap="truncate">
          {clampVisualText(heading, innerWidth)}
        </Text>
      )}
      {visibleItems.map((item, index) => {
        const actualIndex = viewport.start + index;
        const selected = actualIndex === viewport.selectedIndex;
        return (
          <Box key={item.value} width="100%" overflow="hidden">
            <Text color={selected ? theme.accent : theme.textMuted} bold={selected} wrap="truncate">
              {selected ? "> " : "  "}
              {clampVisualText(item.label, Math.max(1, innerWidth - 2))}
            </Text>
          </Box>
        );
      })}
      {availableRows >= 3 && (
        <Text color={theme.textDim}>
          ↑↓ move · Enter confirm{onReplay ? " · r preview/replay" : ""} · Esc close
        </Text>
      )}
    </Box>
  );
}
