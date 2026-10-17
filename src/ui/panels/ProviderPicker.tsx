/**
 * Provider picker overlay (`/provider`, Ctrl+Alt+P): lists the configured providers
 * and lets the user use one in Ubume, choose its model, or make it the default.
 * Codexa Native and Local open a drill-in list first (engines / backends).
 *
 * This component owns only view state (list mode, highlighted row, scroll offset).
 * Grouping, windowing and key mapping are pure functions in `providerPickerModel.ts`,
 * and the actual provider changes happen in `src/app` through `onAction`.
 * `onLocalBackendsOpen` fires when the Local drill-in opens, so the app can probe
 * backend status; results arrive back as `localBackendStatuses`.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import type {
  LocalBackendId,
  ProviderConfig,
  ProviderId,
  ProviderPickerAction,
} from "../../core/providerLauncher/types.js";
import { clampVisualText } from "../../core/shared/text.js";
import { clampIndex } from "../../core/shared/values.js";
import { FOCUS_IDS } from "../input/focus.js";
import {
  type ActivePanelLayout,
  type Layout,
  type PanelLayout,
  useAppLayoutBudget,
  usePickerPanelGeometry,
} from "../layout.js";
import { useTheme } from "../theme.js";
import {
  buildLocalBackendRows,
  calculateProviderPickerWindow,
  getCodexaNativeModelProviders,
  getInitialProviderIndex,
  getProviderPickerHelp,
  getProviderPickerTitle,
  groupCodexaNativeProviders,
  localBackendAt,
  type ProviderPickerMode,
  resolveProviderPickerKey,
} from "./providerPickerModel.js";

// Compatibility re-exports: these helpers moved to providerPickerModel.ts.
export {
  getCodexaNativeModelProviders,
  getTableLayout,
  groupCodexaNativeProviders,
} from "./providerPickerModel.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Probe result for one Local backend, shown beside its row in the Local drill-in. */
export interface LocalBackendStatus {
  state: "idle" | "checking" | "ready" | "no-model" | "not-running" | "auth-required" | "timeout";
  label: string;
}

interface ProviderPickerProps {
  layout?: Layout & { contentWidth?: number };
  providers: readonly ProviderConfig[];
  onAction: (
    providerId: ProviderId,
    action: ProviderPickerAction,
    localBackend?: LocalBackendId,
  ) => void;
  onCancel: () => void;
  /** When set, the picker mounts directly at this provider's action panel. */
  initialProviderId?: ProviderId;
  activeLocalBackend?: LocalBackendId;
  localBackendStatuses?: Partial<Record<LocalBackendId, LocalBackendStatus>>;
  onLocalBackendsOpen?: () => void;
  availableRows?: number;
  activePanelLayout?: ActivePanelLayout;
  panelLayout?: PanelLayout;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProviderPicker({
  layout,
  providers,
  onAction,
  onCancel,
  initialProviderId,
  activeLocalBackend = "lm-studio",
  localBackendStatuses = {},
  onLocalBackendsOpen = () => undefined,
  availableRows: propAvailableRows,
  activePanelLayout,
  panelLayout,
}: ProviderPickerProps) {
  const theme = useTheme();
  const budget = useAppLayoutBudget();
  const { isFocused } = useFocus({ id: FOCUS_IDS.providerPicker, autoFocus: true });
  const groupedProviders = useMemo(() => groupCodexaNativeProviders(providers), [providers]);
  const codexaNativeModels = useMemo(() => getCodexaNativeModelProviders(providers), [providers]);
  const localBackends = useMemo(
    () => buildLocalBackendRows(providers, activeLocalBackend),
    [activeLocalBackend, providers],
  );
  const [providerIndex, setProviderIndex] = useState(() =>
    getInitialProviderIndex(groupedProviders, initialProviderId),
  );
  const [mode, setMode] = useState<ProviderPickerMode>("providers");
  const [scrollOffset, setScrollOffset] = useState(0);

  const pickerProviders =
    mode === "codexa-native-models"
      ? codexaNativeModels
      : mode === "local-backends"
        ? localBackends
        : groupedProviders;
  const selectedProvider = pickerProviders[clampIndex(providerIndex, pickerProviders.length)];

  const {
    panelLayout: resolvedPanelLayout,
    panelWidth,
    innerWidth,
  } = usePickerPanelGeometry({
    layout,
    panelLayout,
    activePanelLayout,
    availableRows: propAvailableRows,
    minPanelWidth: 42,
    minAvailableCols: 30,
  });
  const availableRows = resolvedPanelLayout.availableRows;
  const helpText = getProviderPickerHelp(mode);

  useInput(
    (input, key) => {
      traceInputDebug("provider_picker_input", {
        handler: "ProviderPicker.useInput",
        input,
        return: Boolean(key.return),
        escape: Boolean(key.escape),
        upArrow: Boolean(key.upArrow),
        downArrow: Boolean(key.downArrow),
        mode,
        providerIndex,
        actionIndex: null,
      });

      const command = resolveProviderPickerKey(input, key, {
        mode,
        rowCount: pickerProviders.length,
        pageSize: Math.max(1, windowResult.capacity),
        selectedProvider,
        selectedIndex: providerIndex,
        groupedProviders,
        codexaNativeModels,
        localBackendRowCount: localBackends.length,
        activeLocalBackend,
      });

      switch (command.kind) {
        case "none":
          return;
        case "cancel":
          onCancel();
          return;
        case "move":
          // Relative to the latest index, so several keys delivered in one stdin chunk all apply.
          setProviderIndex((current) =>
            clampIndex(current + command.delta, pickerProviders.length),
          );
          return;
        case "jump":
          setProviderIndex(command.index);
          return;
        case "open":
          setMode(command.mode);
          setProviderIndex(command.index);
          setScrollOffset(0);
          if (command.mode === "local-backends") onLocalBackendsOpen();
          return;
        case "action":
          if (command.withLocalBackend) {
            onAction(command.providerId, command.action, command.localBackend);
          } else {
            onAction(command.providerId, command.action);
          }
          return;
      }
    },
    { isActive: isFocused },
  );

  // ─── Layout & Windowing ───────────────────────────────────────────────────

  const activeRouteIndex = pickerProviders.findIndex((provider) => provider.isActiveRoute);

  const windowResult = useMemo(
    () =>
      calculateProviderPickerWindow({
        itemCount: pickerProviders.length,
        selectedIndex: providerIndex,
        availableRows,
        scrollOffset,
        activeRouteIndex,
      }),
    [pickerProviders.length, providerIndex, availableRows, scrollOffset, activeRouteIndex],
  );

  // The list can shrink while open (e.g. a provider disappears from the registry).
  useEffect(() => {
    setProviderIndex((current) => clampIndex(current, pickerProviders.length));
  }, [pickerProviders.length]);

  useEffect(() => {
    setScrollOffset(windowResult.start);
  }, [windowResult.start]);

  const visibleProviders = useMemo(
    () => pickerProviders.slice(windowResult.start, windowResult.end),
    [pickerProviders, windowResult],
  );

  const modeTitle = getProviderPickerTitle(mode);
  const rangeText = `${windowResult.selectedIndex + 1}/${pickerProviders.length}`;
  const titleText = windowResult.showRange ? `${modeTitle} · ${rangeText}` : modeTitle;

  const body = useMemo(() => {
    return visibleProviders.map((provider, index) => {
      const rowIndex = windowResult.start + index;
      const backendStatus =
        mode === "local-backends" ? localBackendStatuses[localBackendAt(rowIndex)] : undefined;
      return (
        <ProviderRowSimple
          key={`${mode}-${provider.id}-${provider.displayName}`}
          provider={provider}
          isHighlighted={rowIndex === providerIndex}
          secondaryText={
            mode === "local-backends" ? (backendStatus?.label ?? "Checking…") : undefined
          }
          secondaryState={backendStatus?.state}
        />
      );
    });
  }, [localBackendStatuses, mode, providerIndex, visibleProviders, windowResult.start]);

  const showBorder = windowResult.showBorder;

  return (
    <Box flexDirection="column" width={panelWidth} flexShrink={0}>
      <Box
        borderStyle={showBorder ? "round" : undefined}
        borderColor={theme.prompt}
        paddingX={showBorder ? 1 : 0}
        paddingY={0}
        width={panelWidth}
        flexDirection="column"
        flexShrink={0}
      >
        {windowResult.showTitle && (
          <Box width="100%" overflow="hidden" flexShrink={0}>
            <Text color={theme.accent} bold>
              {clampVisualText(showBorder ? `${titleText}   ${helpText}` : titleText, innerWidth)}
            </Text>
          </Box>
        )}

        {/* Too short for a title row: keep the scroll position visible on its own line. */}
        {!windowResult.showTitle && windowResult.showRange && (
          <Box width="100%" overflow="hidden" flexShrink={0}>
            <Text color={theme.accent}>
              {modeTitle} · {windowResult.selectedIndex + 1}/{pickerProviders.length}
            </Text>
          </Box>
        )}

        <Box flexDirection="column" marginTop={0} width="100%" flexShrink={0}>
          {body}
        </Box>
      </Box>

      {process.env.UBUME_DEBUG_LAYOUT === "1" && (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text color="red">
            DEBUG layout: rows={layout?.rows} cols={layout?.cols} mode={layout?.mode} headerRows=
            {budget?.headerRows ?? 6} panelRows={availableRows} bottomChromeRows=
            {budget?.bottomChromeBudget.totalRows ?? 4} composerRows={budget?.composerRows ?? 3}{" "}
            providerRows={visibleProviders.length} renderMode={windowResult.renderMode}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

/** One provider row: highlight marker, display name, optional status suffix. */
function ProviderRowSimple({
  provider,
  isHighlighted,
  secondaryText,
  secondaryState,
}: {
  provider: ProviderConfig;
  isHighlighted: boolean;
  secondaryText?: string;
  secondaryState?: LocalBackendStatus["state"];
}) {
  const theme = useTheme();
  const markerWidth = 2;

  return (
    <Box width="100%" overflow="hidden" flexDirection="row" flexShrink={0}>
      <Box width={markerWidth} flexShrink={0}>
        <Text color={isHighlighted ? theme.accent : theme.textDim}>
          {isHighlighted ? ">" : " "}
        </Text>
      </Box>
      <Box flexGrow={1} overflow="hidden">
        <Text color={isHighlighted ? theme.text : theme.textMuted} bold={isHighlighted}>
          {provider.displayName}
        </Text>
        {secondaryText && (
          <Text
            color={
              secondaryState === "ready"
                ? theme.success
                : secondaryState === "checking"
                  ? theme.accent
                  : theme.textDim
            }
          >
            {` — ${secondaryText}`}
          </Text>
        )}
      </Box>
    </Box>
  );
}
