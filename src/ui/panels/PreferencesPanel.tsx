/**
 * The `/preferences` overlay: a categorized list of Ubume's appearance (and,
 * later, behavior) settings. Selecting an entry opens that setting's picker
 * (`startup-logo-picker` or the existing `theme-picker`); Escape closes.
 *
 * The panel is intentionally a thin, declarative shell: entries describe label,
 * current value and target, while applying values stays with the app
 * (`app/overlays/OverlayPanels.tsx`), so `/theme`, `/preferences → Color
 * Theme` and the startup-logo picker all modify the exact same state. Layout
 * and keyboard handling mirror `SelectionPanel` (focus-managed, one line per
 * row, responsive under narrow terminals) to feel native to the other panels.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useRef, useState } from "react";
import { clampVisualText } from "../../core/shared/text.js";
import { usePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";
import { calculateResponsivePickerViewport } from "./responsivePickerViewport.js";

/** A preferences entry: what it shows and which setting screen it opens. */
export interface PreferencesEntry {
  /** Stable identifier of the underlying setting (also the React key). */
  id: string;
  label: string;
  /** Human-readable current value, shown next to the label. */
  value: string;
  /** Screen to open when the entry is activated. */
  section?: "Appearance" | "Startup Header";
  target:
    | "startup-logo-picker"
    | "startup-animation-picker"
    | "theme-picker"
    | "startup-header-picker"
    | "startup-rendering-picker";
}

interface PreferencesPanelProps {
  /** Ink focus id; must match `getFocusTargetForScreen("preferences")`. */
  focusId: string;
  /** Entries in display order, grouped under their section header. */
  entries: readonly PreferencesEntry[];
  onSelect: (entry: PreferencesEntry) => void;
  onCancel: () => void;
}

export function PreferencesPanel({ focusId, entries, onSelect, onCancel }: PreferencesPanelProps) {
  const theme = useTheme();
  const panelLayout = usePanelLayout();
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });
  const [selectedIndex, setSelectedIndex] = useState(0);

  const availableRows = Math.max(1, panelLayout?.availableRows ?? 12);
  const innerWidth = Math.max(1, (panelLayout?.availableCols ?? 80) - 2);
  const showChrome = availableRows >= 5;
  const sectionCount = new Set(entries.map((entry) => entry.section ?? "Appearance")).size;
  const showSections = showChrome && availableRows >= entries.length + sectionCount + 4;
  const scrollOffset = useRef(0);
  const viewport = calculateResponsivePickerViewport({
    itemCount: entries.length,
    selectedIndex,
    availableRows,
    chromeRows: showChrome ? 4 + (showSections ? sectionCount : 0) : 0,
    scrollOffset: scrollOffset.current,
  });
  scrollOffset.current = viewport.start;
  const labelWidth = entries.reduce(
    (max, entry) => Math.max(max, entry.label.length),
    "Color Theme".length,
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        const entry = entries[selectedIndex];
        if (entry) onSelect(entry);
        return;
      }
      if (key.home) {
        setSelectedIndex(0);
        return;
      }
      if (key.end) {
        setSelectedIndex(entries.length - 1);
        return;
      }
      if (key.pageUp) {
        setSelectedIndex((current) => Math.max(0, current - viewport.capacity));
        return;
      }
      if (key.pageDown) {
        setSelectedIndex((current) => Math.min(entries.length - 1, current + viewport.capacity));
        return;
      }
      if (key.upArrow || input === "k") {
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((current) => Math.min(entries.length - 1, current + 1));
      }
    },
    { isActive: isFocused },
  );

  return (
    <Box
      borderStyle={showChrome ? "round" : undefined}
      borderColor={theme.borderFocused}
      paddingX={showChrome ? 1 : 0}
      width="100%"
      flexDirection="column"
      overflow="hidden"
    >
      {showChrome && (
        <Text color={theme.accent} bold wrap="truncate">
          {clampVisualText("Ubume Preferences  Configure the look and feel", innerWidth)}
        </Text>
      )}
      {entries.slice(viewport.start, viewport.end).map((entry, offset) => {
        const index = viewport.start + offset;
        const selected = index === selectedIndex;
        const labelText = `${selected ? "> " : "  "}${entry.label.padEnd(labelWidth)}`;
        return (
          <Box key={entry.id} width="100%" flexDirection="column" overflow="hidden">
            {showSections && (index === 0 || entries[index - 1]?.section !== entry.section) && (
              <Text color={theme.textMuted}>{entry.section ?? "Appearance"}</Text>
            )}
            <Box width="100%">
              <Text
                color={selected ? theme.accent : theme.textMuted}
                bold={selected}
                wrap="truncate"
              >
                {clampVisualText(labelText, Math.max(1, innerWidth - 2))}
              </Text>
              <Text color={selected ? theme.text : theme.textDim} wrap="truncate">
                {clampVisualText(`  ${entry.value}`, Math.max(1, innerWidth - 2 - labelWidth))}
              </Text>
            </Box>
          </Box>
        );
      })}
      {showChrome && <Text color={theme.textDim}>↑↓ move · Enter open · Esc close</Text>}
    </Box>
  );
}
