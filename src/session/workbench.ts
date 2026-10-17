/**
 * Workbench state: the persisted snapshot format, the pending prompt queue,
 * and utilities built on workbench data.
 *
 * This module is the stable import surface for workbench state. The
 * implementations live in focused modules — `promptQueue.ts` for the queue
 * and `workbenchSnapshot.ts` for the snapshot format, its validation and its
 * restore-time normalization — and are re-exported here so existing import
 * paths keep working. This file owns the two runtime utilities that operate on
 * workbench data: the per-turn tool output budget and the transcript
 * inspection view model.
 */

import { sanitizeTerminalOutput } from "../core/terminal/terminalSanitize.js";
import type { RunToolActivity, TimelineEvent } from "./types.js";
import { getAssistantContent } from "./types.js";

export { PromptQueue, type QueuedPrompt, queuedPrompt } from "./promptQueue.js";
export {
  eventsBeforeTurn,
  type FileAttachment,
  parseWorkbench,
  restoredEvents,
  type WorkbenchSnapshot,
} from "./workbenchSnapshot.js";

// ─── Tool output budget ───────────────────────────────────────────────────────

/** Per-tool cap for captured tool output. */
export const TOOL_OUTPUT_BYTES = 256 * 1024;
/** Total cap for all tool output in one turn. */
const TURN_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Bounds captured tool output across one turn.
 *
 * Each tool's captured output is capped so a chatty command cannot crowd out
 * everything else: a tool may use at most `TOOL_OUTPUT_BYTES`, and the whole
 * turn at most `TURN_OUTPUT_BYTES`. Repeated updates for the same tool do not
 * recharge the budget — only the latest accepted output is charged.
 */
export class ToolOutputBudget {
  private sizes = new Map<string, number>();

  /**
   * Returns `activity` with its output bounded by the remaining turn budget.
   *
   * Truncation decodes at a UTF-8 boundary (`stream: true`), so the truncated
   * output never ends in a broken character, and `outputTruncated` records
   * that the user is not seeing the full output.
   */
  bound(activity: RunToolActivity): RunToolActivity {
    if (activity.output === undefined) return activity;

    const occupiedByOthers = [...this.sizes].reduce(
      (total, [id, bytes]) => total + (id === activity.id ? 0 : bytes),
      0,
    );
    const cap = Math.max(0, Math.min(TOOL_OUTPUT_BYTES, TURN_OUTPUT_BYTES - occupiedByOthers));

    const bytes = Buffer.from(activity.output);
    const output =
      bytes.length <= cap
        ? activity.output
        : new TextDecoder().decode(bytes.subarray(0, cap), { stream: true });

    this.sizes.set(activity.id, Buffer.byteLength(output));
    return { ...activity, output, outputTruncated: activity.outputTruncated || bytes.length > cap };
  }
}

// ─── Transcript inspection ─────────────────────────────────────────────────────

interface InspectionEntry {
  id: string;
  title: string;
  details: string;
}

/**
 * Flattens transcript events into the entries the workbench inspection view
 * shows: one entry per user prompt, assistant answer, run, shell command and
 * tool activity. Titles and details are sanitized because tool and shell
 * output can contain terminal control characters.
 */
export function inspectionEntries(events: readonly TimelineEvent[]): InspectionEntry[] {
  return events
    .flatMap((event): InspectionEntry[] => {
      const time = new Date(event.createdAt).toLocaleTimeString();

      if (event.type === "user")
        return [{ id: `user-${event.id}`, title: `${time} · Prompt`, details: event.prompt }];

      if (event.type === "assistant")
        return [
          {
            id: `assistant-${event.id}`,
            title: `${time} · Answer`,
            details: getAssistantContent(event),
          },
        ];

      if (event.type === "run")
        return [
          {
            id: `run-${event.id}`,
            title: `${time} · ${event.runtime.model} · ${event.status}`,
            details: [
              event.summary,
              event.errorMessage,
              ...event.activity.map((item) => `${item.operation}: ${item.path}`),
              ...event.progressEntries.map((item) => item.text),
            ].join("\n"),
          },
          ...event.toolActivities.map((tool) => ({
            id: `tool-${event.id}-${tool.id}`,
            title: `${tool.status} · ${tool.command}`,
            details: [
              tool.summary,
              tool.output ?? "Detailed output was not supplied by this provider.",
              tool.outputTruncated ? "[Output truncated]" : "",
            ]
              .filter(Boolean)
              .join("\n"),
          })),
        ];

      if (event.type === "shell")
        return [
          {
            id: `shell-${event.id}`,
            title: `${time} · ${event.status} · ${event.command}`,
            details: [...event.lines, ...event.stderrLines].join("\n"),
          },
        ];

      return [
        {
          id: `${event.type}-${event.id}`,
          title: `${time} · ${event.title}`,
          details: event.content,
        },
      ];
    })
    .map((entry) => ({
      ...entry,
      title: sanitizeTerminalOutput(entry.title),
      details: sanitizeTerminalOutput(entry.details),
    }));
}
