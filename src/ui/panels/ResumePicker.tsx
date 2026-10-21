/**
 * `/resume` overlay (`resume-picker` screen): a tabbed, searchable list of Ubume
 * conversations and external CLI sessions, filterable by provider tab, scope
 * (this folder / all projects) and, on the Local tab, backend and model.
 *
 * Data: `conversations` (from `src/app`) are shown immediately; when
 * `loadSessions` is provided, the full session catalog for the current scope is
 * loaded asynchronously (once per scope, cached in local `lists`) and replaces
 * them. Late results after unmount are dropped via the `mounted` ref.
 *
 * State: tab/scope/filters/query/selection are local but seeded from
 * `position`, and every change is reported through `onPositionChange` so the
 * app can restore them on the next open. `position.selectedId` is applied once
 * the matching row appears (it may arrive with the async load).
 *
 * Focus: registers the `resume-picker` id (`FOCUS_IDS.resumePicker`) with
 * `autoFocus`; input is handled only while focused. Keys (list mode): Up/k,
 * Down/j, Home/End, PageUp/PageDown move; Left/Right or 1–9 switch tab; `a`
 * toggles scope; `/` starts search; `b` / `m` cycle backend / model (Local tab);
 * Enter resumes or views; `o` resumes an external session natively; `c`
 * continues it in Ubume; Esc closes. Search mode: type to filter,
 * Backspace/Delete erase, Enter keeps the query, Esc clears it.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExternalSessionSummary } from "../../core/externalSessions/types.js";
import type { LocalBackendId } from "../../core/providerLauncher/types.js";
import { clampVisualText, getTextWidth } from "../../core/shared/text.js";
import { errorMessage } from "../../core/shared/values.js";
import { isLocalDevChannel } from "../../core/version/channel.js";
import { workspaceStorageKey } from "../../core/workspace/appData.js";
import type { ConversationListEntry } from "../../core/workspace/conversationStore.js";
import {
  conversationSummary,
  filterSessionCatalog,
  type SessionCatalogResult,
  type SessionSummary,
} from "../../session/sessionCatalog.js";
import { usePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";
import { calculateResponsivePickerViewport } from "./responsivePickerViewport.js";
import {
  type ExternalListScope,
  nextResumeTab,
  RESUME_PICKER_TABS,
  type ResumePickerPosition,
  type ResumePickerTab,
  resumeTabLabel,
  sessionRowText,
} from "./resumePickerRows.js";

interface ResumePickerProps {
  loading?: boolean;
  /** Ubume conversations shown until (or unless) the catalog loads. */
  conversations: readonly ConversationListEntry[];
  /** Enter on an Ubume conversation when `onSelectSession` is not provided. */
  onSelect: (id: string) => void;
  /** When provided, Enter on any row calls this instead of `onSelect` / `onOpenExternal`. */
  onSelectSession?: (session: SessionSummary) => void;
  onCancel: () => void;
  /** Loads the session catalog for a scope; called at most once per scope per mount. */
  loadSessions?: (scope: ExternalListScope) => Promise<SessionCatalogResult>;
  /** Enter on an external session (read-only view) when `onSelectSession` is absent. */
  onOpenExternal?: (summary: ExternalSessionSummary) => void;
  /** `o`: resume the external session in its own CLI. */
  onResumeExternalNative?: (summary: ExternalSessionSummary) => void;
  /** `c`: continue the external session inside Ubume. */
  onContinueExternal?: (summary: ExternalSessionSummary) => void;
  /** Initial picker state (restored from the previous open). */
  position?: ResumePickerPosition;
  /** Reports picker state changes so the app can persist them. */
  onPositionChange?: (position: ResumePickerPosition) => void;
}

/** Async load state of the catalog for one scope. */
type ListState =
  | { status: "loading" }
  | { status: "ready"; result: SessionCatalogResult }
  | { status: "error"; message: string };
const BACKENDS: readonly (LocalBackendId | "all")[] = ["all", "lm-studio", "unsloth"];

/**
 * Keep the active provider visible even when the complete section bar cannot fit.
 *
 * Grows a window around the active tab, first leftwards then rightwards, while
 * the labels (separated by two spaces) fit in `width` cells.
 */
export function visibleResumeTabs(
  tabs: readonly ResumePickerTab[],
  active: ResumePickerTab,
  width: number,
): readonly ResumePickerTab[] {
  const selected = Math.max(0, tabs.indexOf(active));
  let start = selected;
  let end = selected + 1;
  let used = getTextWidth(resumeTabLabel(tabs[selected]!));
  while (start > 0 && used + 2 + getTextWidth(resumeTabLabel(tabs[start - 1]!)) <= width) {
    used += 2 + getTextWidth(resumeTabLabel(tabs[--start]!));
  }
  while (end < tabs.length && used + 2 + getTextWidth(resumeTabLabel(tabs[end]!)) <= width) {
    used += 2 + getTextWidth(resumeTabLabel(tabs[end++]!));
  }
  return tabs.slice(start, end);
}

/** Resume picker; see the module header for data flow and keys. */
export function ResumePicker({
  loading = false,
  conversations,
  onSelect,
  onSelectSession,
  onCancel,
  loadSessions,
  onOpenExternal,
  onResumeExternalNative,
  onContinueExternal,
  position,
  onPositionChange,
}: ResumePickerProps) {
  const theme = useTheme();
  const layout = usePanelLayout();
  const { isFocused } = useFocus({ id: "resume-picker", autoFocus: true });
  const [tab, setTab] = useState<ResumePickerTab>(position?.tab ?? "all");
  const [scope, setScope] = useState<ExternalListScope>(position?.scope ?? "workspace");
  const [backend, setBackend] = useState<LocalBackendId | "all">(position?.backend ?? "all");
  const [model, setModel] = useState(position?.model ?? "");
  const [query, setQuery] = useState(position?.query ?? "");
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lists, setLists] = useState<Partial<Record<ExternalListScope, ListState>>>({});
  const pendingSelection = useRef(position?.selectedId ?? null);
  const selectedKey = useRef(position?.selectedId ?? null);
  const mounted = useRef(true);
  const pendingLoads = useRef(new Set<ExternalListScope>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Load the catalog for the current scope once. `pendingLoads` guards against
  // a second request while the first is in flight (the effect re-runs whenever
  // `lists` changes).
  useEffect(() => {
    if (!loadSessions || lists[scope] || pendingLoads.current.has(scope)) return;
    pendingLoads.current.add(scope);
    setLists((current) => ({ ...current, [scope]: { status: "loading" } }));
    void loadSessions(scope)
      .then(
        (result) => {
          if (mounted.current)
            setLists((current) => ({ ...current, [scope]: { status: "ready", result } }));
        },
        (error: unknown) => {
          if (mounted.current)
            setLists((current) => ({
              ...current,
              [scope]: {
                status: "error",
                message: errorMessage(error),
              },
            }));
        },
      )
      .finally(() => pendingLoads.current.delete(scope));
  }, [lists, loadSessions, scope]);
  const state = lists[scope];
  const sessions = useMemo(
    () =>
      state?.status === "ready"
        ? state.result.sessions
        : conversations.map((entry) =>
            conversationSummary(
              entry,
              entry.workspaceRoot ?? null,
              entry.storageWorkspaceKey ??
                (entry.workspaceRoot ? workspaceStorageKey(entry.workspaceRoot) : "current"),
            ),
          ),
    [conversations, state],
  );
  // Codexa tabs appear only on the local dev channel or when sessions exist for them.
  const tabs = useMemo(() => {
    const result = [...RESUME_PICKER_TABS];
    for (const provider of ["codexa-native", "codexa-cupy"] as const) {
      if (isLocalDevChannel() || sessions.some((session) => session.providerId === provider))
        result.push(provider);
    }
    return result;
  }, [sessions]);
  const items = useMemo(
    () =>
      filterSessionCatalog(sessions, {
        provider: tab,
        backend: tab === "local" ? backend : "all",
        model: tab === "local" ? model : "",
        query,
      }),
    [sessions, tab, backend, model, query],
  );
  const models = useMemo(
    () =>
      [
        ...new Set(
          filterSessionCatalog(sessions, { provider: "local", backend })
            .map((session) => session.modelId)
            .filter((value): value is string => !!value),
        ),
      ].sort(),
    [sessions, backend],
  );
  const identityIndex = selectedKey.current
    ? items.findIndex((item) => item.key === selectedKey.current)
    : -1;
  const displayIndex =
    identityIndex >= 0 ? identityIndex : Math.max(0, Math.min(selectedIndex, items.length - 1));
  if (!selectedKey.current && items[displayIndex]) selectedKey.current = items[displayIndex]!.key;
  const rows = Math.max(1, layout?.availableRows ?? 12);
  const width = Math.max(1, (layout?.availableCols ?? 80) - 4);
  // Chrome: title + status + hint at 4+ rows, title + hint at 3, none below.
  const chromeRows = rows >= 6 ? 5 : rows >= 4 ? 3 : 0;
  const viewport = useMemo(
    () =>
      calculateResponsivePickerViewport({
        itemCount: items.length,
        selectedIndex: displayIndex,
        availableRows: rows,
        chromeRows,
        scrollOffset,
      }),
    [items.length, displayIndex, rows, chromeRows, scrollOffset],
  );
  // Restore the remembered selection once its row exists; otherwise just keep
  // the index in range when the list changes.
  useEffect(() => {
    if (pendingSelection.current && items.length) {
      const index = items.findIndex((item) => item.key === pendingSelection.current);
      if (index >= 0) {
        pendingSelection.current = null;
        selectedKey.current = items[index]!.key;
        setSelectedIndex(index);
        return;
      }
    }
    setSelectedIndex((index) => Math.max(0, Math.min(index, items.length - 1)));
  }, [items]);
  useEffect(() => setScrollOffset(viewport.start), [viewport.start]);
  const selected = items[displayIndex];
  useEffect(() => {
    onPositionChange?.({ tab, scope, selectedId: selected?.key ?? null, backend, model, query });
  }, [onPositionChange, tab, scope, selected?.key, backend, model, query]);
  const resetSelection = () => {
    pendingSelection.current = null;
    selectedKey.current = null;
    setSelectedIndex(0);
    setScrollOffset(0);
  };
  const switchTab = (next: ResumePickerTab) => {
    setTab(next);
    setSearching(false);
    resetSelection();
  };
  useInput(
    (input, key) => {
      if (loading) {
        if (key.escape) onCancel();
        return;
      }
      if (searching) {
        if (key.escape) {
          setSearching(false);
          setQuery("");
          return;
        }
        if (key.return) {
          setSearching(false);
          return;
        }
        if (key.backspace || key.delete)
          setQuery((value) => Array.from(value).slice(0, -1).join(""));
        else if (!key.ctrl && !key.meta && input) setQuery((value) => value + input);
        resetSelection();
        return;
      }
      if (key.escape) return onCancel();
      if (input.startsWith("/")) {
        setSearching(true);
        if (input.length > 1) {
          setQuery(input.slice(1));
          resetSelection();
        }
        return;
      }
      if (key.leftArrow) return switchTab(nextResumeTab(tab, -1, tabs));
      if (key.rightArrow) return switchTab(nextResumeTab(tab, 1, tabs));
      if (/^[1-9]$/.test(input) && tabs[Number(input) - 1])
        return switchTab(tabs[Number(input) - 1]!);
      if (input === "a") {
        setScope((value) => (value === "workspace" ? "all" : "workspace"));
        resetSelection();
        return;
      }
      if (tab === "local" && input === "b") {
        setBackend(BACKENDS[(BACKENDS.indexOf(backend) + 1) % BACKENDS.length]!);
        setModel("");
        resetSelection();
        return;
      }
      if (tab === "local" && input === "m") {
        const choices = ["", ...models];
        setModel(choices[(choices.indexOf(model) + 1) % choices.length]!);
        resetSelection();
        return;
      }
      if (key.return && selected) {
        if (onSelectSession) return onSelectSession(selected);
        if (selected.native) return onOpenExternal?.(selected.native);
        if (selected.ref.kind === "ubume") return onSelect(selected.ref.conversationId);
      }
      if (selected?.native) {
        if (input === "o") return onResumeExternalNative?.(selected.native);
        if (input === "c") return onContinueExternal?.(selected.native);
      }
      const move = (index: number) => {
        const next = Math.max(0, Math.min(index, items.length - 1));
        selectedKey.current = items[next]?.key ?? null;
        setSelectedIndex(next);
      };
      if (key.upArrow || input === "k") return move(displayIndex - 1);
      if (key.downArrow || input === "j") return move(displayIndex + 1);
      if (key.home) return move(0);
      if (key.end) return move(items.length - 1);
      if (key.pageUp) return move(displayIndex - Math.max(1, viewport.capacity));
      if (key.pageDown) return move(displayIndex + Math.max(1, viewport.capacity));
    },
    { isActive: isFocused },
  );
  const status = searching
    ? `Search: ${query}`
    : [
        scope === "workspace" ? "This folder" : "All projects",
        ...(tab === "local"
          ? [
              backend === "all" ? "All backends" : backend === "unsloth" ? "Unsloth" : "LM Studio",
              model || "All models",
            ]
          : []),
        ...(query ? [`“${query}”`] : []),
        ...(items.length ? [`${displayIndex + 1}/${items.length}`] : []),
        ...(selected?.workspaceRoot ? [selected.workspaceRoot] : []),
      ].join(" · ");
  const warning =
    state?.status === "ready"
      ? state.result.errors[0]
      : state?.status === "error"
        ? state.message
        : null;
  const empty =
    loadSessions && (!state || state.status === "loading")
      ? "Loading saved sessions…"
      : warning
        ? `Could not read some sessions: ${warning}`
        : query
          ? "No sessions match your search."
          : `No ${tab === "all" ? "saved" : resumeTabLabel(tab)} sessions ${scope === "workspace" ? "in this folder — press a for all projects" : "found"}.`;
  const hint = `${tab === "local" ? "b backend · m model · " : ""}${selected?.native ? "Enter view · o native · c continue" : "Enter resume"} · a projects · / search · ←→ section · Esc close`;
  const visibleTabs = visibleResumeTabs(tabs, tab, Math.max(1, width - 9));
  return (
    <Box
      borderStyle={rows >= 4 ? "round" : undefined}
      borderColor={theme.borderFocused}
      paddingX={rows >= 4 ? 1 : 0}
      width="100%"
      flexDirection="column"
      overflow="hidden"
    >
      {rows >= 4 && (
        <Text wrap="truncate">
          <Text color={theme.accent} bold>
            Resume{" "}
          </Text>
          {visibleTabs[0] !== tabs[0] && <Text color={theme.textDim}>‹ </Text>}
          {visibleTabs.map((item, index) => (
            <Text
              key={item}
              color={item === tab ? theme.accent : theme.textMuted}
              bold={item === tab}
              underline={item === tab}
            >
              {index ? "  " : ""}
              {resumeTabLabel(item)}
            </Text>
          ))}
          {visibleTabs.at(-1) !== tabs.at(-1) && <Text color={theme.textDim}> ›</Text>}
        </Text>
      )}
      {rows >= 6 && (
        <Text color={warning ? theme.error : theme.textDim} wrap="truncate">
          {loading ? "Restoring session… Esc cancels" : warning ? `${status} · ${warning}` : status}
        </Text>
      )}
      {items.length === 0 && (
        <Text color={warning ? theme.error : theme.textMuted} wrap="truncate">
          {empty}
        </Text>
      )}
      {items.slice(viewport.start, viewport.end).map((item, offset) => (
        <Text
          key={item.key}
          color={viewport.start + offset === displayIndex ? theme.accent : theme.textMuted}
          bold={viewport.start + offset === displayIndex}
          wrap="truncate"
        >
          {viewport.start + offset === displayIndex ? "> " : "  "}
          {clampVisualText(sessionRowText(item, scope), Math.max(1, width - 2))}
        </Text>
      ))}
      {rows >= 6 && (
        <Text color={theme.textDim} wrap="truncate">
          {hint}
        </Text>
      )}
    </Box>
  );
}
