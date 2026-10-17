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
  getAvailableRowsForPanel,
  getShellWidth,
  type Layout,
  type PanelLayout,
  useActivePanelLayout,
  useAppLayoutBudget,
  usePanelAvailableRows,
  usePanelLayout,
} from "../layout.js";
import { useTheme } from "../theme.js";
import { calculateResponsivePickerViewport } from "./responsivePickerViewport.js";

// ─── Types & helpers ─────────────────────────────────────────────────────────

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

type ProviderPickerMode = "providers" | "codexa-native-models" | "local-backends";

const CODEXA_NATIVE_PROVIDER_IDS = new Set<ProviderId>(["codexa-native", "codexa-cupy"]);

function isCodexaNativeProvider(provider: ProviderConfig): boolean {
  return CODEXA_NATIVE_PROVIDER_IDS.has(provider.id);
}

export function groupCodexaNativeProviders(providers: readonly ProviderConfig[]): ProviderConfig[] {
  const nativeProviders = providers.filter(isCodexaNativeProvider);
  if (nativeProviders.length === 0) return [...providers];

  const primary =
    nativeProviders.find((provider) => provider.id === "codexa-native") ?? nativeProviders[0]!;
  const active = nativeProviders.find((provider) => provider.isActiveRoute);
  const defaultProvider = nativeProviders.find((provider) => provider.isDefault);
  const grouped: ProviderConfig = {
    ...primary,
    displayName: "Codexa Native",
    currentModel: (active ?? defaultProvider ?? primary).currentModel,
    enabled: nativeProviders.some((provider) => provider.enabled),
    isDefault: nativeProviders.some((provider) => provider.isDefault),
    isActiveRoute: nativeProviders.some((provider) => provider.isActiveRoute),
    routeUnavailableReason: nativeProviders.every((provider) => provider.routeUnavailableReason)
      ? (nativeProviders[0]?.routeUnavailableReason ?? null)
      : null,
  };

  const firstNativeIndex = providers.findIndex(isCodexaNativeProvider);
  return providers
    .filter((provider, index) => {
      if (!isCodexaNativeProvider(provider)) return true;
      return index === firstNativeIndex;
    })
    .map((provider) => (isCodexaNativeProvider(provider) ? grouped : provider));
}

export function getCodexaNativeModelProviders(
  providers: readonly ProviderConfig[],
): ProviderConfig[] {
  return providers.filter(isCodexaNativeProvider).map((provider) => ({
    ...provider,
    displayName: provider.id === "codexa-native" ? "Codexa PyTorch" : "Codexa CuPy",
  }));
}

export function getTableLayout(innerWidth: number, isMicro = false) {
  if (innerWidth < 70) {
    const columnWidthBudget = Math.max(26, innerWidth - 5 - 4);
    const status = Math.min(8, Math.max(6, columnWidthBudget - 20));
    const tool = innerWidth < 65 ? 0 : 4;
    const stream = innerWidth < 65 ? 0 : 4;
    const context =
      innerWidth < 45
        ? 0
        : Math.min(11, Math.max(10, columnWidthBudget - status - (tool || 4) - (stream || 4) - 16));
    const provider = Math.min(
      isMicro ? 10 : 14,
      Math.max(8, columnWidthBudget - status - tool - stream - context - 8),
    );
    const model = Math.max(5, columnWidthBudget - provider - context - tool - stream - status);
    const trailingPadding = 0;
    return { provider, model, context, tool, stream, status, trailingPadding };
  }

  const provider = Math.min(22, Math.max(12, Math.floor(innerWidth * 0.18)));
  const status = Math.min(20, Math.max(12, Math.floor(innerWidth * 0.15)));
  const context = Math.min(14, Math.max(11, Math.floor(innerWidth * 0.12)));
  const tool = 4;
  const stream = 4;
  const fixed = 5 + provider + 1 + context + 1 + tool + 1 + stream + 1 + status;
  const model = Math.max(10, innerWidth - fixed - 3);
  const trailingPadding = Math.max(0, innerWidth - (fixed + 1 + model + 1));

  return {
    provider,
    model,
    context,
    tool,
    stream,
    status,
    trailingPadding,
  };
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
  const localBackends = useMemo<ProviderConfig[]>(() => {
    const local = providers.find((provider) => provider.id === "local");
    if (!local) return [];
    return [
      {
        ...local,
        displayName: "LM Studio",
        currentModel: activeLocalBackend === "lm-studio" ? local.currentModel : "Local server",
      },
      {
        ...local,
        displayName: "Unsloth",
        currentModel: activeLocalBackend === "unsloth" ? local.currentModel : "Studio server",
      },
    ];
  }, [activeLocalBackend, providers]);
  const initialIndex = initialProviderId
    ? Math.max(
        0,
        groupedProviders.findIndex((provider) =>
          initialProviderId === "codexa-cupy"
            ? provider.id === "codexa-native"
            : provider.id === initialProviderId,
        ),
      )
    : 0;
  const [providerIndex, setProviderIndex] = useState(initialIndex);
  const [mode, setMode] = useState<ProviderPickerMode>("providers");
  const [scrollOffset, setScrollOffset] = useState(0);

  const pickerProviders =
    mode === "codexa-native-models"
      ? codexaNativeModels
      : mode === "local-backends"
        ? localBackends
        : groupedProviders;
  const selectedLocalBackend: LocalBackendId = providerIndex === 1 ? "unsloth" : "lm-studio";

  const contextLayout = useActivePanelLayout();
  const activeLayout = (activePanelLayout ?? contextLayout) as ActivePanelLayout | undefined;

  const selectedProvider = pickerProviders[clampIndex(providerIndex, pickerProviders.length)];
  const shellWidth = getShellWidth(layout?.cols ?? 120);
  const panelWidth = activeLayout
    ? activeLayout.width
    : Math.max(42, Math.min(layout?.contentWidth ?? shellWidth - 2, shellWidth - 2));

  const hookPanelLayout = usePanelLayout();
  const hookAvailableRows = usePanelAvailableRows();
  const resolvedPanelLayout = useMemo<PanelLayout>(() => {
    if (panelLayout) return panelLayout;
    if (hookPanelLayout) return hookPanelLayout;

    const mode = layout?.mode ?? "regular";
    const resolvedRows = activeLayout
      ? activeLayout.availableRows
      : getAvailableRowsForPanel(
          layout || { cols: 120, rows: 24, mode: "regular" },
          propAvailableRows ?? hookAvailableRows,
        );
    const resolvedCols = activeLayout ? activeLayout.availableCols : Math.max(30, shellWidth - 4);

    return {
      mode,
      availableRows: resolvedRows,
      availableCols: resolvedCols,
    };
  }, [
    panelLayout,
    hookPanelLayout,
    layout,
    activeLayout,
    propAvailableRows,
    shellWidth,
    hookAvailableRows,
  ]);

  const availableRows = resolvedPanelLayout.availableRows;
  const innerWidth = Math.max(1, Math.min(resolvedPanelLayout.availableCols, panelWidth - 4));

  const isCompactLayout = resolvedPanelLayout.mode === "compact";

  // Regular columns:
  const cols = getTableLayout(innerWidth, false);
  const providerNameWidth = cols.provider;
  const modelWidth = cols.model;
  const contextWidth = cols.context;
  const toolsWidth = cols.tool;
  const streamWidth = cols.stream;
  const statusWidth = cols.status;

  const helpText =
    mode === "codexa-native-models"
      ? "Enter use · Esc back"
      : mode === "local-backends"
        ? "Enter use · Esc back"
        : "Enter use · M models · Esc close";

  const openCodexaNativeModels = () => {
    const selectedNativeIndex = codexaNativeModels.findIndex(
      (provider) => provider.isActiveRoute || provider.isDefault,
    );
    setMode("codexa-native-models");
    setProviderIndex(Math.max(0, selectedNativeIndex));
    setScrollOffset(0);
  };

  const openLocalBackends = () => {
    setMode("local-backends");
    setProviderIndex(activeLocalBackend === "unsloth" ? 1 : 0);
    setScrollOffset(0);
    onLocalBackendsOpen();
  };

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

      if (key.ctrl && (input === "c" || input === "q")) {
        onCancel();
        return;
      }

      if (key.escape) {
        if (mode === "codexa-native-models" || mode === "local-backends") {
          const groupedIndex = groupedProviders.findIndex(
            (provider) => provider.id === (mode === "local-backends" ? "local" : "codexa-native"),
          );
          setMode("providers");
          setProviderIndex(Math.max(0, groupedIndex));
          setScrollOffset(0);
          return;
        }
        onCancel();
        return;
      }

      if (mode === "providers" || mode === "codexa-native-models" || mode === "local-backends") {
        if (key.home) {
          setProviderIndex(0);
          return;
        }
        if (key.end) {
          setProviderIndex(Math.max(0, pickerProviders.length - 1));
          return;
        }
        if (key.pageUp) {
          setProviderIndex((current) =>
            clampIndex(current - Math.max(1, windowResult?.capacity ?? 1), pickerProviders.length),
          );
          return;
        }
        if (key.pageDown) {
          setProviderIndex((current) =>
            clampIndex(current + Math.max(1, windowResult?.capacity ?? 1), pickerProviders.length),
          );
          return;
        }
        if (key.upArrow || input === "k") {
          setProviderIndex((current) => clampIndex(current - 1, pickerProviders.length));
          return;
        }
        if (key.downArrow || input === "j") {
          setProviderIndex((current) => clampIndex(current + 1, pickerProviders.length));
          return;
        }
        if (input.toLowerCase() === "m" && selectedProvider) {
          if (
            mode === "providers" &&
            selectedProvider.id === "codexa-native" &&
            codexaNativeModels.length > 0
          ) {
            openCodexaNativeModels();
            return;
          }
          onAction(
            selectedProvider.id,
            "select-model",
            mode === "local-backends" ? selectedLocalBackend : undefined,
          );
          return;
        }
        if (input.toLowerCase() === "u" && selectedProvider) {
          if (
            mode === "providers" &&
            selectedProvider.id === "codexa-native" &&
            codexaNativeModels.length > 0
          ) {
            openCodexaNativeModels();
            return;
          }
          if (mode === "providers" && selectedProvider.id === "local" && localBackends.length > 0) {
            openLocalBackends();
            return;
          }
          onAction(
            selectedProvider.id,
            "use-in-ubume",
            mode === "local-backends" ? selectedLocalBackend : undefined,
          );
          return;
        }
        if (input.toLowerCase() === "s" && selectedProvider) {
          if (
            mode === "providers" &&
            selectedProvider.id === "codexa-native" &&
            codexaNativeModels.length > 0
          ) {
            openCodexaNativeModels();
            return;
          }
          onAction(selectedProvider.id, "set-default");
          return;
        }
        if (key.return && selectedProvider) {
          if (
            mode === "providers" &&
            selectedProvider.id === "codexa-native" &&
            codexaNativeModels.length > 0
          ) {
            openCodexaNativeModels();
            return;
          }
          if (mode === "providers" && selectedProvider.id === "local" && localBackends.length > 0) {
            openLocalBackends();
            return;
          }
          onAction(
            selectedProvider.id,
            "use-in-ubume",
            mode === "local-backends" ? selectedLocalBackend : undefined,
          );
        }
        return;
      }
    },
    { isActive: isFocused },
  );

  // ─── Layout & Windowing ───────────────────────────────────────────────────

  const activeRouteIndex = pickerProviders.findIndex((provider) => provider.isActiveRoute);

  const windowResult = useMemo(() => {
    const showBorder = availableRows >= 3;
    const showTitle = availableRows >= 2;
    const useCompactRows = true;
    const showHeaders = false;
    const chromeRows = (showTitle ? 1 : 0) + (showHeaders ? 1 : 0);
    let viewport = calculateResponsivePickerViewport({
      itemCount: pickerProviders.length,
      selectedIndex: providerIndex,
      availableRows,
      chromeRows,
      scrollOffset,
    });
    let reserveCurrent =
      viewport.hasOverflow &&
      activeRouteIndex >= 0 &&
      (activeRouteIndex < viewport.start || activeRouteIndex >= viewport.end);
    if (reserveCurrent) {
      viewport = calculateResponsivePickerViewport({
        itemCount: pickerProviders.length,
        selectedIndex: providerIndex,
        availableRows,
        chromeRows: chromeRows + 1,
        scrollOffset,
      });
      reserveCurrent = activeRouteIndex < viewport.start || activeRouteIndex >= viewport.end;
    }
    return {
      ...viewport,
      visibleCount: viewport.end - viewport.start,
      showAbove: false,
      showBelow: false,
      showRange: viewport.hasOverflow,
      showBorder,
      showTitle,
      showHeaders,
      reserveCurrent,
      renderMode: useCompactRows
        ? ("compact" as const)
        : viewport.hasOverflow
          ? ("windowed" as const)
          : ("full" as const),
    };
  }, [
    pickerProviders.length,
    providerIndex,
    availableRows,
    resolvedPanelLayout.mode,
    scrollOffset,
    activeRouteIndex,
  ]);

  useEffect(() => {
    setProviderIndex((current) => clampIndex(current, pickerProviders.length));
  }, [pickerProviders.length]);

  useEffect(() => {
    if (windowResult) setScrollOffset(windowResult.start);
  }, [windowResult?.start]);

  const visibleProviders = useMemo(() => {
    if (!windowResult) return pickerProviders;
    return pickerProviders.slice(windowResult.start, windowResult.end);
  }, [pickerProviders, windowResult]);

  const titleText = windowResult?.showRange
    ? `${mode === "codexa-native-models" ? "Codexa Native Models" : mode === "local-backends" ? "Local Backends" : "Providers"} · ${windowResult.selectedIndex + 1}/${pickerProviders.length}`
    : mode === "codexa-native-models"
      ? "Codexa Native Models"
      : mode === "local-backends"
        ? "Local Backends"
        : "Providers";
  const showCurrent = false;

  const body = useMemo(() => {
    return visibleProviders.map((provider, index) => (
      <ProviderRowSimple
        key={`${mode}-${provider.id}-${provider.displayName}`}
        provider={provider}
        isHighlighted={windowResult!.start + index === providerIndex}
        width={innerWidth}
        secondaryText={
          mode === "local-backends"
            ? (localBackendStatuses[windowResult!.start + index === 1 ? "unsloth" : "lm-studio"]
                ?.label ?? "Checking…")
            : undefined
        }
        secondaryState={
          mode === "local-backends"
            ? localBackendStatuses[windowResult!.start + index === 1 ? "unsloth" : "lm-studio"]
                ?.state
            : undefined
        }
      />
    ));
  }, [
    innerWidth,
    localBackendStatuses,
    mode,
    providerIndex,
    visibleProviders,
    windowResult?.start,
  ]);

  const showBorder = windowResult?.showBorder ?? true;

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
        {(windowResult?.showTitle ?? true) && (
          <Box width="100%" overflow="hidden" flexShrink={0}>
            <Text color={theme.accent} bold>
              {clampVisualText(showBorder ? `${titleText}   ${helpText}` : titleText, innerWidth)}
            </Text>
          </Box>
        )}

        {!(windowResult?.showTitle ?? true) && windowResult?.showRange && (
          <Box width="100%" overflow="hidden" flexShrink={0}>
            <Text color={theme.accent}>
              {mode === "codexa-native-models"
                ? "Codexa Native Models"
                : mode === "local-backends"
                  ? "Local Backends"
                  : "Providers"}{" "}
              · {windowResult.selectedIndex + 1}/{pickerProviders.length}
            </Text>
          </Box>
        )}

        {windowResult?.showAbove && (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text color={theme.accent}>
              {isCompactLayout ? "↑ more" : `↑ ${windowResult.start} more`}
            </Text>
          </Box>
        )}

        {(windowResult?.showHeaders ?? true) && (
          <Box width="100%" overflow="hidden" flexShrink={0}>
            <Text color={theme.textDim}>
              {"     "}
              {clampVisualText("Provider", providerNameWidth)}{" "}
              {clampVisualText("Model", modelWidth)}
              {contextWidth > 0 && " " + clampVisualText("Context", contextWidth)}
              {toolsWidth > 0 && " " + clampVisualText("Tool", toolsWidth)}
              {streamWidth > 0 && " " + clampVisualText("Strm", streamWidth)}{" "}
              {clampVisualText("Status", statusWidth)}
            </Text>
          </Box>
        )}

        <Box flexDirection="column" marginTop={0} width="100%" flexShrink={0}>
          {body}
        </Box>

        {showCurrent && (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text color={theme.textDim}>
              Current:{" "}
              <Text color={theme.text}>
                {clampVisualText(
                  `${pickerProviders[activeRouteIndex]!.displayName} / ${pickerProviders[activeRouteIndex]!.currentModel}`,
                  Math.max(1, innerWidth - 9),
                )}
              </Text>
            </Text>
          </Box>
        )}

        {windowResult?.showBelow && (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text color={theme.accent}>
              {isCompactLayout ? "↓ more" : `↓ ${pickerProviders.length - windowResult.end} more`}
            </Text>
          </Box>
        )}
      </Box>

      {process.env.UBUME_DEBUG_LAYOUT === "1" && (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text color="red">
            DEBUG layout: rows={layout?.rows} cols={layout?.cols} mode={layout?.mode} headerRows=
            {budget?.headerRows ?? 6} panelRows={availableRows} bottomChromeRows=
            {budget?.bottomChromeBudget.totalRows ?? 4} composerRows={budget?.composerRows ?? 3}{" "}
            providerRows={visibleProviders.length} renderMode={windowResult?.renderMode}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function ProviderRowSimple({
  provider,
  isHighlighted,
  secondaryText,
  secondaryState,
}: {
  provider: ProviderConfig;
  isHighlighted: boolean;
  width: number;
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
