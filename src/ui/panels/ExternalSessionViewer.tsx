/**
 * Read-only transcript viewers for the `external-session-viewer` and
 * `saved-session-viewer` screens.
 *
 * `SessionTranscriptViewer` is the shared component: it loads a transcript
 * asynchronously, shows entries as collapsible sections (prompts, replies and
 * notes expanded; tool calls folded), supports search, and scrolls by wrapped
 * row. `ExternalSessionViewer` wraps it for native Claude Code / Codex / Gemini
 * / Mistral Vibe sessions (with "open natively" and "continue here"), and
 * `SavedSessionViewer` for an Ubume conversation from another workspace (with
 * "locate original folder").
 *
 * State (local): load state, expanded entry ids, query/search mode, selected
 * entry, scroll offset, and a wrap cache keyed by entry id + width. All
 * transcript text is passed through `sanitizeTerminalOutput` before rendering.
 * Late load results after unmount (or after `loadTranscript` changes) are
 * ignored. `loadTranscript` should be referentially stable: a new function
 * triggers a reload.
 *
 * Focus: registers the `external-session-viewer` id (shared by both screens)
 * with `autoFocus`; input is handled only while focused. Keys: Up/k, Down/j
 * select an entry; PageUp/PageDown scroll a page; Home/End jump; Enter toggles
 * the selected entry; `e` expands/collapses all tool entries; `/` starts
 * search; `o` opens natively and `c` continues (when provided); Esc goes back.
 * Search mode: type to filter, Backspace/Delete erase, Enter keeps the query,
 * Esc clears it.
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExternalSessionSummary,
  ExternalTranscript,
  ExternalTranscriptEntry,
  ExternalTranscriptEntryKind,
} from "../../core/externalSessions/types.js";
import { externalSourceLabel } from "../../core/externalSessions/types.js";
import { clampVisualText, wrapPlainText } from "../../core/shared/text.js";
import { errorMessage } from "../../core/shared/values.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import type { SessionSummary } from "../../session/sessionCatalog.js";
import { readOwnedConversation } from "../../session/sessionCatalog.js";
import { inspectionEntries } from "../../session/workbench.js";
import { usePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";

/** Props for the external-session wrapper; callbacks receive the session summary. */
interface ExternalSessionViewerProps {
  summary: ExternalSessionSummary;
  loadTranscript: () => Promise<ExternalTranscript>;
  onBack: () => void;
  onOpenNative: (summary: ExternalSessionSummary) => void;
  onContinue: (summary: ExternalSessionSummary) => void;
}

interface SessionTranscriptViewerProps {
  /** Header info: title, working folder and optional session id. */
  summary: { title: string; cwd: string | null; id?: string };
  /** Source name shown in the title and the "open in …" hint. */
  label: string;
  /** Loads the entries (and an optional notice line); keep it stable across renders. */
  loadTranscript: () => Promise<Pick<ExternalTranscript, "entries" | "notice">>;
  onBack: () => void;
  /** `o` action; the hint is hidden when omitted. */
  onOpenNative?: () => void;
  /** `c` action; the hint is hidden when omitted. */
  onContinue?: () => void;
  /** Hint text for the `c` action. */
  continueLabel?: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; transcript: Pick<ExternalTranscript, "entries" | "notice"> }
  | { status: "error"; message: string };

/** One rendered line: an entry header or a wrapped body line of entry index `entry`. */
interface TranscriptRow {
  entry: number;
  kind: ExternalTranscriptEntryKind;
  header: boolean;
  text: string;
}

/** Local `HH:MM` for an entry timestamp, or "" when missing/invalid. */
function entryTime(timestamp: string | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Sanitize and wrap entry text to `width`, preserving blank lines. */
function wrapEntryText(text: string, width: number): string[] {
  return sanitizeTerminalOutput(text)
    .split("\n")
    .flatMap((line) => (line ? wrapPlainText(line, width) : [""]));
}

/** Read-only transcript of a native Claude Code / Codex / Mistral Vibe session. */
export function SessionTranscriptViewer({
  summary,
  label,
  loadTranscript,
  onBack,
  onOpenNative,
  onContinue,
  continueLabel = "continue here",
}: SessionTranscriptViewerProps) {
  const theme = useTheme();
  const layout = usePanelLayout();
  const { isFocused } = useFocus({ id: "external-session-viewer", autoFocus: true });
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(0);
  const wrapCache = useRef(new Map<string, string[]>());

  useEffect(() => {
    let active = true;
    loadTranscript().then(
      (transcript) => {
        if (!active) return;
        // Prompts and replies open; tool calls stay folded until asked for.
        setExpanded(
          new Set(
            transcript.entries.filter((entry) => entry.kind !== "tool").map((entry) => entry.id),
          ),
        );
        setState({ status: "ready", transcript });
      },
      (error: unknown) => {
        if (active)
          setState({
            status: "error",
            message: errorMessage(error, "unknown error"),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [loadTranscript]);

  const allEntries = state.status === "ready" ? state.transcript.entries : [];
  const entries = useMemo(() => {
    const needle = query.toLowerCase();
    return needle
      ? allEntries.filter((entry) => `${entry.title}\n${entry.text}`.toLowerCase().includes(needle))
      : allEntries;
  }, [allEntries, query]);

  const notice = state.status === "ready" ? state.transcript.notice : undefined;
  const width = Math.max(8, (layout?.availableCols ?? 80) - 4);
  // Body height: available rows minus title, metadata and footer lines and the
  // two border rows, minus the notice line when shown.
  const height = Math.max(1, (layout?.availableRows ?? 20) - 5 - (notice ? 1 : 0));

  const { rows, headerRows } = useMemo(() => {
    const cache = wrapCache.current;
    const result: TranscriptRow[] = [];
    const headers: number[] = [];
    entries.forEach((entry: ExternalTranscriptEntry, index) => {
      headers.push(result.length);
      const open = expanded.has(entry.id);
      const time = entryTime(entry.timestamp);
      result.push({
        entry: index,
        kind: entry.kind,
        header: true,
        text: `${open ? "▾" : "▸"} ${time ? `${time} · ` : ""}${sanitizeTerminalOutput(entry.title)}`,
      });
      if (!open) return;
      const key = `${entry.id}:${width}`;
      let lines = cache.get(key);
      if (!lines) {
        lines = wrapEntryText(entry.text, width - 4);
        cache.set(key, lines);
      }
      for (const line of lines)
        result.push({ entry: index, kind: entry.kind, header: false, text: `  ${line}` });
    });
    return { rows: result, headerRows: headers };
  }, [entries, expanded, width]);

  const maxOffset = Math.max(0, rows.length - height);
  const start = Math.min(offset, maxOffset);
  const selectedIndex = Math.min(selected, Math.max(0, entries.length - 1));

  // Select an entry and scroll its header into view if needed.
  const select = (index: number) => {
    const next = Math.max(0, Math.min(entries.length - 1, index));
    setSelected(next);
    const header = headerRows[next] ?? 0;
    if (header < start || header >= start + height) setOffset(header);
  };
  // Scroll to a row (page keys) and select the entry that row belongs to.
  const scrollTo = (row: number) => {
    const next = Math.max(0, Math.min(maxOffset, row));
    setOffset(next);
    const entry = rows[next]?.entry;
    if (entry !== undefined) setSelected(entry);
  };

  useInput(
    (input, key) => {
      if (searching) {
        if (key.escape) {
          setSearching(false);
          setQuery("");
        } else if (key.return) setSearching(false);
        else if (key.backspace || key.delete) setQuery((text) => text.slice(0, -1));
        else if (!key.ctrl && !key.meta && input) setQuery((text) => text + input);
        setSelected(0);
        setOffset(0);
        return;
      }
      if (key.escape) return onBack();
      if (input === "o") return onOpenNative?.();
      if (input === "c") return onContinue?.();
      if (input === "/") {
        setSearching(true);
        return;
      }
      if (key.upArrow || input === "k") return select(selectedIndex - 1);
      if (key.downArrow || input === "j") return select(selectedIndex + 1);
      if (key.pageDown) return scrollTo(start + height);
      if (key.pageUp) return scrollTo(start - height);
      if (key.home) {
        setSelected(0);
        setOffset(0);
        return;
      }
      if (key.end) {
        setSelected(Math.max(0, entries.length - 1));
        setOffset(maxOffset);
        return;
      }
      if (key.return) {
        const entry = entries[selectedIndex];
        if (!entry) return;
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(entry.id)) next.delete(entry.id);
          else next.add(entry.id);
          return next;
        });
        const header = headerRows[selectedIndex] ?? 0;
        if (header < start) setOffset(header);
        return;
      }
      if (input === "e") {
        const tools = allEntries.filter((entry) => entry.kind === "tool");
        const allOpen = tools.every((entry) => expanded.has(entry.id));
        setExpanded((current) => {
          const next = new Set(current);
          for (const tool of tools) {
            if (allOpen) next.delete(tool.id);
            else next.add(tool.id);
          }
          return next;
        });
      }
    },
    { isActive: isFocused },
  );

  const headerColor = (kind: ExternalTranscriptEntryKind) =>
    kind === "user"
      ? theme.prompt
      : kind === "assistant"
        ? theme.text
        : kind === "note"
          ? theme.info
          : theme.command;
  const bodyColor = (kind: ExternalTranscriptEntryKind) =>
    kind === "tool" || kind === "note" ? theme.textMuted : theme.text;
  const counts =
    state.status === "ready"
      ? ` · ${entries.length}${query ? ` of ${allEntries.length}` : ""} entries`
      : "";

  let placeholder: { text: string; color: string } | null = null;
  if (state.status === "loading")
    placeholder = { text: "Loading transcript…", color: theme.textMuted };
  else if (state.status === "error")
    placeholder = { text: `Could not read this session: ${state.message}`, color: theme.error };
  else if (entries.length === 0)
    placeholder = {
      text: query ? "No entries match your search." : "This session has no readable messages.",
      color: theme.textMuted,
    };

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={theme.borderFocused}
      paddingX={1}
    >
      <Text color={theme.accent} bold wrap="truncate">
        {sanitizeTerminalOutput(`${label} · ${summary.title}`)}
      </Text>
      <Text color={theme.textDim} wrap="truncate">
        {sanitizeTerminalOutput(
          `${summary.cwd ?? "Unknown folder"} · ${summary.id ?? ""}${counts}`,
        )}
      </Text>
      {notice && (
        <Text color={theme.warning} wrap="truncate">
          {sanitizeTerminalOutput(notice)}
        </Text>
      )}
      <Box flexDirection="column" height={height} overflow="hidden">
        {placeholder ? (
          <Text color={placeholder.color} wrap="truncate">
            {sanitizeTerminalOutput(placeholder.text)}
          </Text>
        ) : (
          rows.slice(start, start + height).map((row, index) => {
            const isSelected = row.header && row.entry === selectedIndex;
            return (
              <Text
                key={start + index}
                color={
                  isSelected
                    ? theme.accent
                    : row.header
                      ? headerColor(row.kind)
                      : bodyColor(row.kind)
                }
                bold={row.header}
                wrap="truncate"
              >
                {row.header
                  ? `${isSelected ? "›" : " "} ${clampVisualText(row.text, Math.max(1, width - 2))}`
                  : row.text || " "}
              </Text>
            );
          })
        )}
      </Box>
      <Text color={theme.textDim} wrap="truncate">
        {searching
          ? `Search: ${query}`
          : `↑↓ select · Enter expand · e tools · PgUp/PgDn · / search${onOpenNative ? ` · o open in ${label}` : ""}${onContinue ? ` · c ${continueLabel}` : ""} · Esc back`}
      </Text>
    </Box>
  );
}

/** Viewer for a native external CLI session, labelled with its source CLI. */
export function ExternalSessionViewer({
  summary,
  loadTranscript,
  onBack,
  onOpenNative,
  onContinue,
}: ExternalSessionViewerProps) {
  return (
    <SessionTranscriptViewer
      summary={summary}
      label={externalSourceLabel(summary.source)}
      loadTranscript={loadTranscript}
      onBack={onBack}
      onOpenNative={() => onOpenNative(summary)}
      onContinue={() => onContinue(summary)}
    />
  );
}

/**
 * Viewer for an Ubume conversation saved under another workspace. Builds
 * entries from the recorded session events when available (kind inferred from
 * the inspection entry id prefix), otherwise from the plain message list. The
 * `c` action asks the user to locate the original folder (`onLocateWorkspace`).
 * Throws (shown as a load error) if the session is not an Ubume conversation.
 */
export function SavedSessionViewer({
  session,
  onBack,
  onLocateWorkspace,
}: {
  session: SessionSummary;
  onBack: () => void;
  onLocateWorkspace: () => void;
}) {
  const loadTranscript = useCallback(async () => {
    if (session.ref.kind !== "ubume") throw new Error("Expected a Ubume conversation.");
    const record = readOwnedConversation(session.ref);
    const entries: ExternalTranscriptEntry[] = record.session
      ? inspectionEntries(record.session.events).map((entry) => ({
          id: entry.id,
          kind: entry.id.startsWith("user-")
            ? "user"
            : entry.id.startsWith("assistant-")
              ? "assistant"
              : entry.id.startsWith("tool-")
                ? "tool"
                : "note",
          title: entry.title,
          text: entry.details,
        }))
      : record.messages.map((message, index) => ({
          id: String(index),
          kind: message.role,
          title: message.role === "user" ? "You" : "Assistant",
          text: [message.content, message.activitySummary].filter(Boolean).join("\n\n"),
        }));
    return {
      entries,
      notice: `Original workspace: ${session.workspaceRoot ?? "not recorded"}. Locate the original folder to resume.`,
    };
  }, [session]);
  return (
    <SessionTranscriptViewer
      summary={{ title: session.title, cwd: session.workspaceRoot }}
      label="Ubume"
      loadTranscript={loadTranscript}
      onBack={onBack}
      onContinue={onLocateWorkspace}
      continueLabel="locate original folder"
    />
  );
}
