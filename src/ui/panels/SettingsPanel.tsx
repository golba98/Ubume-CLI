/**
 * Generic option-cycling settings form: one row per setting, each showing all
 * of its options with the active one bracketed. Used for the `/settings`
 * overlay (`USER_SETTING_DEFINITIONS`) and by `CodexaSettingsPanel`.
 *
 * Owns local `selectedIndex` and `draftValues` (a copy of `values` taken on
 * mount); nothing is applied until Enter calls `onSave` with the whole draft.
 * Esc discards the draft. Persisting is done by the caller in `src/app`.
 *
 * Focus: registers `focusId` with `autoFocus`; input is handled only while
 * focused. Keys: Up/Down select a setting, Left/Right cycle its option
 * (wrapping), Enter saves, Esc cancels. All rows are rendered (no scrolling).
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useMemo, useState } from "react";
import type { SettingDefinition } from "../../config/settings.js";
import type { FocusTargetId } from "../input/focus.js";
import { useTheme } from "../theme.js";

interface SettingsPanelProps<TKey extends string> {
  focusId: FocusTargetId;
  title?: string;
  /** Rows in display order; each defines its key, label, optional description and options. */
  settings: readonly SettingDefinition<TKey, string>[];
  /** Initial values; read once on mount (later prop changes do not reset the draft). */
  values: Record<TKey, string>;
  onSave: (values: Record<TKey, string>) => void;
  onCancel: () => void;
}

/**
 * Step to the previous/next option, wrapping around. An unknown current value
 * is treated as the first option.
 */
function cycleOption<TKey extends string>(
  definition: SettingDefinition<TKey, string>,
  currentValue: string,
  direction: -1 | 1,
): string {
  const currentIndex = definition.options.findIndex((option) => option.value === currentValue);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + definition.options.length) % definition.options.length;
  return definition.options[nextIndex]?.value ?? currentValue;
}

/** Settings form; see the module header for keys and draft semantics. */
export function SettingsPanel<TKey extends string>({
  focusId,
  title = "Settings",
  settings,
  values,
  onSave,
  onCancel,
}: SettingsPanelProps<TKey>) {
  const theme = useTheme();
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [draftValues, setDraftValues] = useState<Record<TKey, string>>(() => ({ ...values }));

  const activeSetting = settings[selectedIndex] ?? settings[0];
  const subtitle = useMemo(() => {
    const instructions = "↑↓ setting  ←→ option  Esc to close · Enter to confirm";
    if (!activeSetting?.description) {
      return instructions;
    }

    return `${instructions}\n${activeSetting.description}`;
  }, [activeSetting]);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.return) {
        onSave(draftValues);
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((current) => Math.min(settings.length - 1, current + 1));
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        const direction: -1 | 1 = key.leftArrow ? -1 : 1;
        const definition = settings[selectedIndex];
        if (!definition) {
          return;
        }

        setDraftValues((current) => ({
          ...current,
          [definition.key]: cycleOption(definition, current[definition.key], direction),
        }));
        return;
      }

      if (!input || key.ctrl || key.meta) {
        return;
      }
    },
    { isActive: isFocused },
  );

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={1}
        width="100%"
        flexDirection="column"
      >
        <Box>
          <Text color={theme.accent} bold>
            {title}{" "}
          </Text>
          <Text color={theme.textMuted}>{subtitle.split("\n")[0]}</Text>
        </Box>
        {activeSetting?.description && (
          <Box marginTop={1}>
            <Text color={theme.textDim}>{activeSetting.description}</Text>
          </Box>
        )}
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
        {settings.map((setting, index) => {
          const isSelectedRow = index === selectedIndex;
          const currentValue = draftValues[setting.key];

          return (
            <Box key={setting.key} flexDirection="row" overflow="hidden">
              <Box width={3} flexShrink={0}>
                <Text color={isSelectedRow ? theme.accent : theme.textDim}>
                  {isSelectedRow ? "▸ " : "  "}
                </Text>
              </Box>
              <Box width={20} flexShrink={0} overflow="hidden">
                <Text color={isSelectedRow ? theme.text : theme.textMuted} bold={isSelectedRow}>
                  {setting.label}
                </Text>
              </Box>
              <Box
                flexDirection="row"
                flexWrap="nowrap"
                flexGrow={1}
                flexShrink={1}
                overflow="hidden"
              >
                {setting.options.map((option, optionIndex) => {
                  const isActiveOption = option.value === currentValue;
                  const optionText = isActiveOption ? `[${option.label}]` : option.label;
                  return (
                    <Text
                      key={option.value}
                      color={
                        isActiveOption ? (isSelectedRow ? theme.accent : theme.text) : theme.textDim
                      }
                      bold={isActiveOption}
                    >
                      {optionIndex > 0 ? "  " : ""}
                      {optionText}
                    </Text>
                  );
                })}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
