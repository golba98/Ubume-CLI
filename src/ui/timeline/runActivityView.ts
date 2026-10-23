/**
 * Pure view-model helpers for run activity, shared by the measured row
 * builders (`measure/streamRows.ts`, `measure/eventRows.ts`) and the React
 * `TurnGroup` path so both select, merge and label activity identically.
 *
 * Covers: which file activity entries to show, thinking-block coalescing,
 * shell-wrapper stripping for action commands, and friendly action labels.
 * `shouldShowRawOutputFallback` / `getVisibleRawOutputLines` are retained
 * stubs that currently always disable the raw-output fallback.
 */
import type { RunEvent, RunProgressBlock, RunToolActivity } from "../../session/types.js";
import { formatTerminalAnswerInline } from "../render/terminalAnswerFormat.js";

const MAX_VISIBLE_ACTIVE_ACTIVITY = 6;
const MAX_VISIBLE_SUMMARY_ACTIVITY = 4;
/**
 * Pick the trailing file-activity entries to display: up to 6 of the live
 * `activity` list while running, otherwise up to 4 of `activitySummary.recent`
 * (falling back to `activity`). `hiddenCount` is how many older entries were
 * dropped.
 */
export function selectVisibleRunActivity(event: RunEvent) {
  const source =
    event.status === "running" ? event.activity : (event.activitySummary?.recent ?? event.activity);
  const limit =
    event.status === "running" ? MAX_VISIBLE_ACTIVE_ACTIVITY : MAX_VISIBLE_SUMMARY_ACTIVITY;
  const visible = source.slice(-limit);
  return {
    visible,
    hiddenCount: Math.max(0, source.length - visible.length),
  };
}

export function shouldShowRawOutputFallback(event: RunEvent): boolean {
  void event;
  return false;
}

export function getVisibleRawOutputLines(event: RunEvent): string[] {
  void event;
  return [];
}

/**
 * One-line "N files touched  +created  ~modified  -deleted" summary, or null
 * when there is no summary or no touched files.
 */
export function formatRunActivityStats(event: RunEvent): string | null {
  const summary = event.activitySummary;
  if (!summary || event.touchedFileCount === 0) return null;

  return [
    `${event.touchedFileCount} file${event.touchedFileCount === 1 ? "" : "s"} touched`,
    `+${summary.created}`,
    `~${summary.modified}`,
    `-${summary.deleted}`,
  ].join("  ");
}

interface ThinkingLikeEvent {
  kind: string;
  streamSeq: number;
  block: RunProgressBlock;
}

/**
 * Merge each run of consecutive `kind === "thinking"` events into a single
 * event so contiguous chain-of-thought renders under one header. Local models
 * emit every reasoning paragraph as its own progress item, which otherwise
 * stacks one labeled block per sentence. Thoughts separated by a tool call or
 * response segment stay separate — only uninterrupted runs merge.
 *
 * The merged event keeps the first member's identity (`streamSeq`, block id),
 * so row keys derived from it stay stable; its text joins non-empty member
 * texts with blank lines, `updatedAt` is the latest member's, and `status` is
 * the last member's.
 */
export function coalesceConsecutiveThinking<T extends { kind: string; streamSeq: number }>(
  events: T[],
): T[] {
  const result: T[] = [];
  let index = 0;
  while (index < events.length) {
    const event = events[index]!;
    if (event.kind !== "thinking") {
      result.push(event);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < events.length && events[end]!.kind === "thinking") {
      end += 1;
    }
    if (end - index === 1) {
      result.push(event);
      index = end;
      continue;
    }

    const members = events.slice(index, end) as unknown as ThinkingLikeEvent[];
    const first = members[0]!;
    const last = members[members.length - 1]!;
    const mergedBlock: RunProgressBlock = {
      ...first.block,
      text: members
        .map((member) => member.block.text)
        .filter((text) => text.trim().length > 0)
        .join("\n\n"),
      updatedAt: Math.max(...members.map((member) => member.block.updatedAt)),
      status: last.block.status,
    };
    result.push({ ...event, block: mergedBlock });
    index = end;
  }
  return result;
}

function stripOuterQuotes(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function decodeEscapedQuotes(s: string): string {
  return s.replace(/\\"/g, '"');
}

/** Unescape `\"`, trim, and compact local file paths for display. */
function cleanCommand(command: string): string {
  return formatTerminalAnswerInline(decodeEscapedQuotes(command.trim()));
}

/**
 * Strips shell-wrapper invocations from a command string and returns the inner
 * command that is actually being executed.
 *
 * Handles:
 *   "C:\Program Files\PowerShell\7\pwsh.exe" -Command '...'
 *   pwsh.exe -Command "..."
 *   powershell.exe -Command '...'
 *   cmd.exe /c "..."
 *   bash -lc '...'
 */
export function normalizeCommand(command: string): string {
  // Full quoted path ending with pwsh.exe / powershell.exe
  let match = command.match(/^"[^"]*(?:pwsh|powershell)(?:\.exe)?"\s+-Command\s+(.+)$/is);
  if (match) return cleanCommand(stripOuterQuotes(match[1].trim()));

  // Bare pwsh.exe / powershell.exe on PATH
  match = command.match(/^(?:pwsh|powershell)(?:\.exe)?\s+-Command\s+(.+)$/is);
  if (match) return cleanCommand(stripOuterQuotes(match[1].trim()));

  // cmd.exe /c "..."
  match = command.match(/^cmd(?:\.exe)?\s+\/[cC]\s+(.+)$/s);
  if (match) return cleanCommand(stripOuterQuotes(match[1].trim()));

  // bash -lc "..." or bash -lc '...'
  match = command.match(/^bash\s+-lc\s+(.+)$/s);
  if (match) return cleanCommand(stripOuterQuotes(match[1].trim()));

  return cleanCommand(command);
}

/**
 * Maps a normalized command to a short human-readable label.
 * Returns null when no label applies and the command itself should be shown.
 * The exact "Read file" / "List files" strings are also what
 * `compactActionBursts` (measure/streamRows.ts) groups on; renaming them
 * changes burst compaction.
 */
export function getFriendlyActionLabel(normalizedCommand: string): string | null {
  const cmd = normalizedCommand.trim();

  if (/^(?:Get-ChildItem|dir|ls)\b/i.test(cmd)) return "List files";
  if (/^rg\s+--files\b/i.test(cmd)) return "List files";
  if (/^(?:Get-Content|cat)\b/i.test(cmd)) return "Read file";
  if (/^git\s+status\b/.test(cmd)) return "Check git status";
  if (/^git\s+diff\b/.test(cmd)) return "Inspect changes";
  if (/^(?:bun|npm)\s+install\b/.test(cmd)) return "Install dependencies";
  if (/^(?:bun|npm)\s+test\b/.test(cmd)) return "Run tests";
  if (/^(?:tsc\b|bun\s+run\s+typecheck\b)/.test(cmd)) return "Run typecheck";

  return null;
}

/** Native announcements and host consent must not be presented as confirmed execution. */
export function toolActivityLabel(tool: RunToolActivity, command: string): string {
  const label = getFriendlyActionLabel(command) ?? "";
  const state = tool.authorization;
  const suffix =
    state === "denied"
      ? "Permission denied"
      : state === "cancelled"
        ? "Cancelled"
        : tool.status !== "running"
          ? ""
          : state === "pending"
            ? "Awaiting permission"
            : state === "approved"
              ? "Approved; waiting for provider"
              : state === "requested"
                ? "Tool requested"
                : state === "executing"
                  ? "Executing tool"
                  : "";
  return suffix ? `${label} · ${suffix}` : label;
}
