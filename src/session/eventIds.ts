/**
 * Timeline identity counters and the static events seeded at startup.
 *
 * Event and turn ids come from process-wide monotonic counters so timeline
 * entries stay unique and stable for the whole session. `advanceIdsPast` must
 * run whenever restored events are introduced, so the next live turn can never
 * collide with a restored one (the timeline groups events by `turnId`).
 *
 * This module also owns `createInitialAuthStatus`, the seed for the app's auth
 * state probe, and re-exports prompt-run timing from `promptRunTiming.ts` for
 * compatibility with existing import paths.
 */

import type { CodexAuthProbeResult } from "../core/codex/codexAuth.js";
import { LEGACY_GOOGLE_MESSAGE } from "../core/providerLauncher/providerIdentity.js";
import type { ProviderId, ProviderWorkspaceConfig } from "../core/providerLauncher/types.js";
import { formatRuntimeProviderLabel } from "../core/providerRuntime/registry.js";
import { sanitizeTerminalOutput } from "../core/terminal/terminalSanitize.js";
import type { TimelineEvent } from "./types.js";

export { createPromptRunTiming, type PromptRunTiming } from "./promptRunTiming.js";

// ─── Identity counters ────────────────────────────────────────────────────────

let nextEventId = 0;

let nextTurnId = 0;

/** Returns the next timeline event id. Ids are unique for the whole process. */
export function createEventId(): number {
  return nextEventId++;
}

/** Returns the next turn id; one turn spans a user prompt, its run and reply. */
export function createTurnId(): number {
  return nextTurnId++;
}

/**
 * Moves both counters past every id used by `events`.
 *
 * Restored conversations keep their original event ids, so without this the
 * next live turn could reuse a restored turnId and the timeline would fold
 * the new prompt into the old turn.
 */
export function advanceIdsPast(events: readonly TimelineEvent[]): void {
  for (const event of events) {
    nextEventId = Math.max(nextEventId, event.id + 1);
    if ("turnId" in event) nextTurnId = Math.max(nextTurnId, event.turnId + 1);
  }
}

// ─── Startup and migration events ────────────────────────────────────────────

/**
 * The system event shown when the workspace config migrated off a removed
 * provider. Returns null when there is no notice to show.
 */
export function createProviderMigrationNoticeEvent(
  notice: ProviderWorkspaceConfig["migrationNotice"] | undefined,
  providerLabel: string | null = null,
): TimelineEvent | null {
  if (!notice) return null;

  const resolvedProviderLabel =
    providerLabel ?? formatRuntimeProviderLabel(notice.revertedProviderId);
  return {
    id: createEventId(),
    type: "system",
    createdAt: Date.now(),
    title: sanitizeTerminalOutput("Provider migrated"),
    content: sanitizeTerminalOutput(
      `${formatRuntimeProviderLabel(notice.deprecatedProviderId as ProviderId)} provider is no longer supported. Reverted to ${resolvedProviderLabel}.`,
      { preserveTabs: false, tabSize: 2 },
    ),
  };
}

/**
 * The static events seeded into the first frame (or re-seeded after /clear):
 * a Google migration warning, or the workspace's provider migration notice.
 */
export function createStartupStaticEvents({
  providerWorkspaceConfig,
}: {
  providerWorkspaceConfig: ProviderWorkspaceConfig;
}): TimelineEvent[] {
  if (providerWorkspaceConfig.googleMigrationRequired)
    return [
      {
        id: createEventId(),
        type: "system",
        createdAt: Date.now(),
        title: "Google migration required",
        content: LEGACY_GOOGLE_MESSAGE,
      },
    ];
  return [createProviderMigrationNoticeEvent(providerWorkspaceConfig.migrationNotice)].filter(
    (event): event is TimelineEvent => event !== null,
  );
}

// ─── App state seeds ─────────────────────────────────────────────────────────

/**
 * The auth status before the first probe completes: "checking" with guidance
 * for how to check manually. The app displays this immediately on startup.
 */
export function createInitialAuthStatus(): CodexAuthProbeResult {
  return {
    state: "checking",
    checkedAt: 0,
    rawSummary: "Auth check pending.",
    recommendedAction: "Run /auth status to check sign-in state.",
  };
}
