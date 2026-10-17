/**
 * Multi-view workbench overlay (`workbench-panel` screen) behind `/queue`,
 * `/transcript`, `/diff` and `/rewind`. `view` selects which one is shown.
 *
 * - queue: queued prompts; edit/remove/reorder, pause, or continue sending.
 * - transcript: tool activity and output (`inspectionEntries(events)`) as
 *   collapsible entries with search.
 * - diff: files changed for the whole session (default) or one turn, from the
 *   checkpoint store; Enter loads that file's patch into a scrollable view.
 * - rewind: previous turns; preview a conversation, file, or combined
 *   recovery, then confirm with Enter.
 *
 * State (local): selection index, diff turn (-1 = whole session), scroll
 * offset, search query, expanded entries, loaded patch text, restore preview,
 * notice line, and a `working` flag that blocks input while an async store or
 * rewind operation runs. Queue contents, checkpoints and the store come from
 * `src/app` (`useWorkbenchActions`), which also performs queue actions and the
 * rewind itself via `onQueueAction` / `onRewind`.
 *
 * Focus: registers the `workbench-panel` id (`FOCUS_IDS.workbench`) with
 * `autoFocus`; input is handled only while focused and ignored for Ctrl/Meta
 * chords. Common keys: Up/k, Down/j select (or scroll a patch/preview),
 * PageUp/PageDown scroll, Esc closes the preview/patch first, then the panel.
 * Per view: queue — e edit, d/Delete remove, [ ] reorder, Space pause, s/Enter
 * continue and close; rewind — c/f/b (Enter = b) preview, Enter again applies;
 * diff — Left/Right change turn, Enter opens patch; transcript — Enter toggles,
 * `/` searches (Enter keeps, Esc clears the query).
 */
import { Box, Text, useFocus, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { wrapPlainText } from "../../core/shared/text.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import type {
  CheckpointStore,
  FileBoundary,
  FileCheckpoint,
  RestoreOperation,
} from "../../core/workspace/checkpoints.js";
import type { TimelineEvent } from "../../session/types.js";
import type { QueuedPrompt } from "../../session/workbench.js";
import { inspectionEntries } from "../../session/workbench.js";
import { usePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";

/** Which workbench view to show. */
export type WorkbenchView = "queue" | "transcript" | "diff" | "rewind";
/** Queue operations; `pause` and `continue` apply to the whole queue (no id). */
export type QueueAction = "edit" | "remove" | "up" | "down" | "pause" | "continue";
/** What a rewind restores: the conversation, the files, or both. */
export type RecoveryMode = "conversation" | "files" | "both";
interface Props {
  view: WorkbenchView;
  /** Timeline events for the transcript view. */
  events: readonly TimelineEvent[];
  queue: readonly QueuedPrompt[];
  /** Queue paused flag, shown in the title. */
  paused: boolean;
  /** Per-turn file checkpoints, oldest first; used by diff and rewind. */
  checkpoints: readonly FileCheckpoint[];
  /** Session-diff end boundary after a restore; otherwise the last checkpoint's `after` is used. */
  restoredFileBoundary?: FileBoundary;
  /** Checkpoint store for diffs, patches and restore previews; null when unavailable. */
  store: CheckpointStore | null;
  onQueueAction: (action: QueueAction, id?: string) => void;
  onRewind: (
    checkpoint: FileCheckpoint,
    mode: RecoveryMode,
    operations: RestoreOperation[],
  ) => Promise<void>;
  onClose: () => void;
}
/** Workbench overlay; see the module header for views and keys. */
export function WorkbenchPanel({
  view,
  events,
  queue,
  paused,
  checkpoints,
  restoredFileBoundary,
  store,
  onQueueAction,
  onRewind,
  onClose,
}: Props) {
  const theme = useTheme();
  const layout = usePanelLayout();
  const { isFocused } = useFocus({ id: "workbench-panel", autoFocus: true });
  const [index, setIndex] = useState(0);
  const [turn, setTurn] = useState(-1);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [patch, setPatch] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<{
    mode: RecoveryMode;
    checkpoint: FileCheckpoint;
    operations: RestoreOperation[];
  } | null>(null);
  const width = Math.max(1, (layout?.availableCols ?? 80) - 4);
  const entries = useMemo(
    () =>
      inspectionEntries(events).filter(
        (entry) =>
          !query || `${entry.title}\n${entry.details}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [events, query],
  );
  // Diff range: a single turn's before/after, or (turn -1) the whole session
  // from the first checkpoint to the restored boundary / last checkpoint.
  const point = turn < 0 ? null : checkpoints[turn];
  const before = point?.before ?? checkpoints[0]?.before;
  const after =
    point?.after ??
    (turn < 0 ? (restoredFileBoundary ?? checkpoints[checkpoints.length - 1]?.after) : undefined);
  // Body height: available rows minus title, footer and borders, and the
  // optional notice / skipped-files lines.
  const height = Math.max(
    1,
    (layout?.availableRows ?? 20) - 5 - (notice ? 1 : 0) - (before?.skipped.length ? 1 : 0),
  );
  const files = before && after && store ? store.changed(before, after) : [];
  const count =
    view === "queue"
      ? queue.length
      : view === "rewind"
        ? checkpoints.length
        : view === "diff"
          ? files.length
          : entries.length;
  useEffect(() => {
    setIndex((current) => Math.max(0, Math.min(current, count - 1)));
  }, [count]);
  const lines = useMemo(() => {
    if (preview)
      return [
        `Restore ${preview.mode} before: ${preview.checkpoint.prompt}`,
        ...preview.operations.map(
          (op) => `${!op.target ? "DELETE" : !op.current ? "CREATE" : "RESTORE"} ${op.path}`,
        ),
        "Press Enter to apply, Esc to cancel.",
      ];
    if (patch !== null) return patch.split("\n");
    if (view === "queue")
      return queue.length
        ? queue.map((item, i) => `${i === index ? "›" : " "} ${i + 1}. ${item.display}`)
        : ["No queued instructions."];
    if (view === "rewind")
      return checkpoints.length
        ? checkpoints.map(
            (item, i) =>
              `${i === index ? "›" : " "} Before: ${item.prompt}${item.after && !item.recoveryInvalidated ? "" : " · conversation only"}`,
          )
        : ["No previous turns."];
    if (view === "diff")
      return files.length
        ? files.map((file, i) => `${i === index ? "›" : " "} ${file}`)
        : [after ? "No supported text-file changes." : "No finalized file checkpoint available."];
    return entries.flatMap((entry, i) => [
      `${i === index ? "›" : " "} ${expanded.has(entry.id) ? "▾" : "▸"} ${entry.title}`,
      ...(expanded.has(entry.id) ? entry.details.split("\n").map((line) => `  ${line}`) : []),
    ]);
  }, [preview, patch, view, queue, index, checkpoints, files.join("\0"), entries, expanded]);
  const rows = lines.flatMap((line) => wrapPlainText(sanitizeTerminalOutput(line), width));
  const selectedLines =
    view === "transcript"
      ? entries
          .slice(0, index)
          .flatMap((entry) => [
            `  ${expanded.has(entry.id) ? "▾" : "▸"} ${entry.title}`,
            ...(expanded.has(entry.id) ? entry.details.split("\n").map((line) => `  ${line}`) : []),
          ])
      : lines.slice(0, index);
  // Wrapped row index of the selected item, so the list auto-scrolls to keep it
  // visible. Patch and preview views scroll freely by `offset` instead.
  const selectedRow = selectedLines.reduce(
    (total, line) => total + wrapPlainText(sanitizeTerminalOutput(line), width).length,
    0,
  );
  const start =
    patch !== null || preview ? offset : Math.max(offset, Math.max(0, selectedRow - height + 1));
  /**
   * Build a restore preview for the selected checkpoint. Conversation-only
   * rewinds touch no files; file modes ask the store which files the restore
   * would delete/create/restore. Errors are shown in the notice line.
   */
  const prepare = async (mode: RecoveryMode) => {
    const checkpoint = checkpoints[index];
    if (!checkpoint) return;
    setWorking(true);
    setNotice("");
    try {
      const operations =
        mode === "conversation" ? [] : await store?.preview(checkpoints.slice(index));
      if (!operations) throw new Error("File recovery is unavailable for this conversation.");
      setPreview({ checkpoint, mode, operations });
      setOffset(0);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setWorking(false);
    }
  };
  useInput(
    (input, key) => {
      if (working || key.ctrl || key.meta) return;
      if (searching) {
        if (key.escape || key.return) {
          setSearching(false);
          if (key.escape) setQuery(null);
          return;
        }
        if (key.backspace) setQuery((value) => value?.slice(0, -1) ?? "");
        else if (!key.ctrl && input) {
          setQuery((value) => `${value ?? ""}${input}`);
          setIndex(0);
          setOffset(0);
        }
        return;
      }
      if (key.escape) {
        if (preview) {
          setPreview(null);
          setOffset(0);
          return;
        }
        if (patch !== null) {
          setPatch(null);
          setOffset(0);
          return;
        }
        onClose();
        return;
      }
      if (preview && key.return) {
        setWorking(true);
        void onRewind(preview.checkpoint, preview.mode, preview.operations)
          .then(onClose)
          .catch((error) => {
            setNotice(error.message);
            setPreview(null);
          })
          .finally(() => setWorking(false));
        return;
      }
      if (
        key.pageDown ||
        key.pageUp ||
        ((patch !== null || preview !== null) && (key.downArrow || key.upArrow))
      ) {
        const direction = key.pageUp || key.upArrow ? -1 : 1;
        setOffset((current) =>
          Math.max(
            0,
            Math.min(
              Math.max(0, rows.length - height),
              current + direction * (key.pageUp || key.pageDown ? height : 1),
            ),
          ),
        );
        return;
      }
      if (patch !== null || preview) return;
      if (key.upArrow || input === "k") {
        setIndex((current) => Math.max(0, current - 1));
        setOffset(0);
        return;
      }
      if (key.downArrow || input === "j") {
        setIndex((current) => Math.min(Math.max(0, count - 1), current + 1));
        setOffset(0);
        return;
      }
      if (view === "queue") {
        const id = queue[index]?.id;
        if (input === "e") onQueueAction("edit", id);
        else if (input === "d" || key.delete) onQueueAction("remove", id);
        else if (input === "[") onQueueAction("up", id);
        else if (input === "]") onQueueAction("down", id);
        else if (input === " ") onQueueAction("pause");
        else if (input === "s" || key.return) {
          onQueueAction("continue");
          onClose();
        }
      } else if (view === "rewind") {
        if (input === "c") void prepare("conversation");
        else if (input === "f") void prepare("files");
        else if (input === "b" || key.return) void prepare("both");
      } else if (view === "diff") {
        if (key.leftArrow || key.rightArrow) {
          setTurn((current) =>
            Math.max(-1, Math.min(checkpoints.length - 1, current + (key.leftArrow ? -1 : 1))),
          );
          setIndex(0);
          setOffset(0);
        } else if (key.return && before && after && files[index] && store) {
          setWorking(true);
          void store
            .patch(before, after, files[index]!)
            .then((text) => {
              setPatch(text);
              setOffset(0);
            })
            .catch((error) => setNotice(error.message))
            .finally(() => setWorking(false));
        }
      } else {
        if (input === "/") {
          setQuery("");
          setSearching(true);
          setIndex(0);
          return;
        }
        if (key.return && entries[index])
          setExpanded((current) => {
            const next = new Set(current);
            const id = entries[index]!.id;
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
      }
    },
    { isActive: isFocused },
  );
  const hint =
    view === "queue"
      ? "e edit · d remove · [/] reorder · Space pause · s continue"
      : view === "rewind"
        ? "c conversation · f files · b both · Enter preview"
        : view === "diff"
          ? "←/→ session/turn · ↑↓ file · Enter patch"
          : "↑↓ select · Enter expand · / search";
  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={theme.borderFocused}
      paddingX={1}
    >
      <Text bold color={theme.accent}>
        {view.toUpperCase()}
        {view === "queue"
          ? paused
            ? " · paused"
            : " · active"
          : view === "diff"
            ? ` · ${turn < 0 ? "Session" : `Turn ${turn + 1}`}`
            : ""}
        {working ? " · working…" : ""}
      </Text>
      <Box flexDirection="column" height={height} overflow="hidden">
        {rows.slice(start, start + height).map((row, i) => (
          <Text
            key={i}
            color={
              row.startsWith("+") ? theme.success : row.startsWith("-") ? theme.error : theme.text
            }
          >
            {row || " "}
          </Text>
        ))}
      </Box>
      {notice && (
        <Box height={1} overflow="hidden">
          <Text color={theme.error} wrap="truncate">
            {sanitizeTerminalOutput(notice)}
          </Text>
        </Box>
      )}
      {before?.skipped.length ? (
        <Text color={theme.textDim} wrap="truncate">
          Unsupported files omitted: {before.skipped.length}
        </Text>
      ) : null}
      <Text color={theme.textDim}>
        {query !== null ? `Search: ${query}` : hint} · PgUp/PgDn scroll · Esc close
      </Text>
    </Box>
  );
}
