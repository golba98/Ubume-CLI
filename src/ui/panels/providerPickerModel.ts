/**
 * Pure provider-picker logic: grouping of the Codexa Native routes, the Local
 * backend rows, the responsive window, and the key → command mapping.
 *
 * `ProviderPicker.tsx` owns rendering and React state. It calls
 * `resolveProviderPickerKey` for each key and applies the returned command. No
 * provider configuration is read or written here: choices leave the picker as
 * `onAction(providerId, action, localBackend?)`, and `src/app` performs them.
 *
 * The picker has three list modes:
 * - `providers`: one row per provider; the two Codexa Native routes are grouped
 *   into a single "Codexa Native" row.
 * - `codexa-native-models`: drill-in listing the grouped Codexa Native routes.
 * - `local-backends`: drill-in listing the Local backends (LM Studio, Unsloth).
 */
import type { Key } from "ink";
import type {
  LocalBackendId,
  ProviderConfig,
  ProviderId,
  ProviderPickerAction,
} from "../../core/providerLauncher/types.js";
import { calculateResponsivePickerViewport } from "./responsivePickerViewport.js";

export type ProviderPickerMode = "providers" | "codexa-native-models" | "local-backends";

const CODEXA_NATIVE_PROVIDER_IDS = new Set<ProviderId>(["codexa-native", "codexa-cupy"]);

function isCodexaNativeProvider(provider: ProviderConfig): boolean {
  return CODEXA_NATIVE_PROVIDER_IDS.has(provider.id);
}

/**
 * Collapses the Codexa Native routes into one "Codexa Native" row at the position
 * of the first one. The grouped row is enabled, default or active if any member
 * is, and it shows the active (else default, else primary) member's model.
 */
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
    .filter((provider, index) => !isCodexaNativeProvider(provider) || index === firstNativeIndex)
    .map((provider) => (isCodexaNativeProvider(provider) ? grouped : provider));
}

/** The individual Codexa Native routes, labelled by engine, for the drill-in list. */
export function getCodexaNativeModelProviders(
  providers: readonly ProviderConfig[],
): ProviderConfig[] {
  return providers.filter(isCodexaNativeProvider).map((provider) => ({
    ...provider,
    displayName: provider.id === "codexa-native" ? "Codexa PyTorch" : "Codexa CuPy",
  }));
}

/**
 * Rows for the Local drill-in: the Local provider presented once per backend. Only
 * the active backend shows the configured model; the other shows a server hint.
 * Row index 0 is LM Studio and index 1 is Unsloth (see `localBackendAt`).
 */
export function buildLocalBackendRows(
  providers: readonly ProviderConfig[],
  activeLocalBackend: LocalBackendId,
): ProviderConfig[] {
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
}

/** Local backend shown at a row index of the `local-backends` list. */
export function localBackendAt(index: number): LocalBackendId {
  return index === 1 ? "unsloth" : "lm-studio";
}

/** Row to highlight when the picker opens (`codexa-cupy` maps to the grouped row). */
export function getInitialProviderIndex(
  groupedProviders: readonly ProviderConfig[],
  initialProviderId: ProviderId | undefined,
): number {
  if (!initialProviderId) return 0;
  const targetId = initialProviderId === "codexa-cupy" ? "codexa-native" : initialProviderId;
  return Math.max(
    0,
    groupedProviders.findIndex((provider) => provider.id === targetId),
  );
}

const MODE_TITLES: Record<ProviderPickerMode, string> = {
  providers: "Providers",
  "codexa-native-models": "Codexa Native Models",
  "local-backends": "Local Backends",
};

/** List heading for a mode. */
export function getProviderPickerTitle(mode: ProviderPickerMode): string {
  return MODE_TITLES[mode];
}

/** Footer hint for a mode. */
export function getProviderPickerHelp(mode: ProviderPickerMode): string {
  return mode === "providers" ? "Enter use · M models · Esc close" : "Enter use · Esc back";
}

/**
 * Column widths for a provider table. No table header is rendered at present (the
 * picker uses compact one-line rows), but the layout is kept and tested for when
 * the header returns.
 */
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

  return { provider, model, context, tool, stream, status, trailingPadding };
}

/** Visible slice of the list plus which chrome rows are shown. */
export interface ProviderPickerWindow {
  start: number;
  end: number;
  capacity: number;
  selectedIndex: number;
  hasOverflow: boolean;
  /** Show "n/total" in the title because the list scrolls. */
  showRange: boolean;
  showBorder: boolean;
  showTitle: boolean;
  /** Always "compact": the picker renders one line per provider. */
  renderMode: "compact";
}

/**
 * Fits the list into `availableRows`. The border needs at least 3 rows and the
 * title at least 2.
 *
 * When the list scrolls and the active route is outside the visible window, one
 * extra chrome row is reserved. This mirrors the model picker's "Current:" line,
 * but the provider picker does not render that line, so the reservation only
 * shortens the window. It is kept so the visible list does not change.
 */
export function calculateProviderPickerWindow(params: {
  itemCount: number;
  selectedIndex: number;
  availableRows: number;
  scrollOffset: number;
  activeRouteIndex: number;
}): ProviderPickerWindow {
  const { itemCount, selectedIndex, availableRows, scrollOffset, activeRouteIndex } = params;
  const showBorder = availableRows >= 3;
  const showTitle = availableRows >= 2;
  const chromeRows = showTitle ? 1 : 0;
  const viewport = (chrome: number) =>
    calculateResponsivePickerViewport({
      itemCount,
      selectedIndex,
      availableRows,
      chromeRows: chrome,
      scrollOffset,
    });
  const isOutside = (window: { start: number; end: number }) =>
    activeRouteIndex < window.start || activeRouteIndex >= window.end;

  let window = viewport(chromeRows);
  if (window.hasOverflow && activeRouteIndex >= 0 && isOutside(window)) {
    window = viewport(chromeRows + 1);
  }
  return {
    ...window,
    showRange: window.hasOverflow,
    showBorder,
    showTitle,
    renderMode: "compact",
  };
}

/** What a key press asks the picker to do. */
export type ProviderPickerCommand =
  | { kind: "none" }
  | { kind: "cancel" }
  /** Move the highlight relative to its current (latest) position. */
  | { kind: "move"; delta: number }
  /** Jump the highlight to an absolute row. */
  | { kind: "jump"; index: number }
  /** Switch list mode (drill in, or back out) and highlight `index`; scrolls to the top. */
  | { kind: "open"; mode: ProviderPickerMode; index: number }
  /** Hand a choice to the app. `localBackend` is set only from the Local drill-in. */
  | {
      kind: "action";
      providerId: ProviderId;
      action: ProviderPickerAction;
      localBackend?: LocalBackendId;
      /** False when the action takes no backend argument (set-default). */
      withLocalBackend: boolean;
    };

/** Everything the key resolver needs to know about the current picker state. */
export interface ProviderPickerKeyContext {
  mode: ProviderPickerMode;
  rowCount: number;
  /** Rows per page for PgUp/PgDn. */
  pageSize: number;
  selectedProvider: ProviderConfig | undefined;
  selectedIndex: number;
  groupedProviders: readonly ProviderConfig[];
  codexaNativeModels: readonly ProviderConfig[];
  localBackendRowCount: number;
  activeLocalBackend: LocalBackendId;
}

/**
 * Maps a key to a picker command.
 *
 * - Esc: from a drill-in, back to the providers list on the row you came from;
 *   from the providers list, cancel. Ctrl+C or Ctrl+Q always cancels.
 * - ↑/↓ or j/k, PgUp/PgDn, Home/End: move the highlight.
 * - Enter or U: use the highlighted provider in Ubume (drills into Codexa Native /
 *   Local first).
 * - M: pick a model (drills into Codexa Native first).
 * - S: make the provider the default (drills into Codexa Native first).
 */
export function resolveProviderPickerKey(
  input: string,
  key: Pick<
    Key,
    "ctrl" | "escape" | "home" | "end" | "pageUp" | "pageDown" | "upArrow" | "downArrow" | "return"
  >,
  context: ProviderPickerKeyContext,
): ProviderPickerCommand {
  const { mode, selectedProvider } = context;

  if (key.ctrl && (input === "c" || input === "q")) return { kind: "cancel" };

  if (key.escape) {
    if (mode === "providers") return { kind: "cancel" };
    const parentId = mode === "local-backends" ? "local" : "codexa-native";
    const parentIndex = context.groupedProviders.findIndex((provider) => provider.id === parentId);
    return { kind: "open", mode: "providers", index: Math.max(0, parentIndex) };
  }

  if (key.home) return { kind: "jump", index: 0 };
  if (key.end) return { kind: "jump", index: Math.max(0, context.rowCount - 1) };
  if (key.pageUp) return { kind: "move", delta: -context.pageSize };
  if (key.pageDown) return { kind: "move", delta: context.pageSize };
  if (key.upArrow || input === "k") return { kind: "move", delta: -1 };
  if (key.downArrow || input === "j") return { kind: "move", delta: 1 };

  const letter = input.toLowerCase();
  const isShortcut = letter === "m" || letter === "u" || letter === "s" || key.return;
  if (!isShortcut || !selectedProvider) return { kind: "none" };

  const atProviders = mode === "providers";
  // Grouped rows open their drill-in instead of acting on the group.
  if (
    atProviders &&
    selectedProvider.id === "codexa-native" &&
    context.codexaNativeModels.length > 0
  ) {
    const activeIndex = context.codexaNativeModels.findIndex(
      (provider) => provider.isActiveRoute || provider.isDefault,
    );
    return { kind: "open", mode: "codexa-native-models", index: Math.max(0, activeIndex) };
  }
  const opensLocalBackends =
    (letter === "u" || key.return) &&
    atProviders &&
    selectedProvider.id === "local" &&
    context.localBackendRowCount > 0;
  if (opensLocalBackends) {
    return {
      kind: "open",
      mode: "local-backends",
      index: context.activeLocalBackend === "unsloth" ? 1 : 0,
    };
  }

  const localBackend =
    mode === "local-backends" ? localBackendAt(context.selectedIndex) : undefined;
  if (letter === "m") {
    return {
      kind: "action",
      providerId: selectedProvider.id,
      action: "select-model",
      localBackend,
      withLocalBackend: true,
    };
  }
  if (letter === "s") {
    return {
      kind: "action",
      providerId: selectedProvider.id,
      action: "set-default",
      withLocalBackend: false,
    };
  }
  return {
    kind: "action",
    providerId: selectedProvider.id,
    action: "use-in-ubume",
    localBackend,
    withLocalBackend: true,
  };
}
