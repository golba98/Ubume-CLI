/**
 * Pure helpers for `ResumePicker`: provider tab model, tab labels, and the
 * one-line text for each session row (Ubume conversations and external
 * Claude Code / Codex / Gemini / Mistral Vibe sessions).
 *
 * `ResumePickerPosition` is also the shape `src/app` stores so reopening the
 * picker restores the tab, scope, filters and selection. Date labels use the
 * process locale; functions that depend on "now" accept it as a parameter for
 * deterministic tests. No state, no side effects.
 */
import { basename } from "node:path";
import {
  type ExternalSessionSummary,
  externalSourceLabel,
} from "../../core/externalSessions/types.js";
import type { LocalBackendId } from "../../core/providerLauncher/types.js";
import { stripAttachmentIds } from "../../core/shared/text.js";
import type { ConversationListEntry } from "../../core/workspace/conversationStore.js";
import type { SessionSummary } from "../../session/sessionCatalog.js";

/** Provider filter tabs. The two `codexa-*` tabs are appended conditionally by the picker. */
export type ResumePickerTab =
  | "all"
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "local"
  | "codexa-native"
  | "codexa-cupy";
/** Session list scope: the current workspace only, or every project. */
export type ExternalListScope = "workspace" | "all";

/** Picker state persisted by the app between openings (see `onPositionChange`). */
export interface ResumePickerPosition {
  tab: ResumePickerTab;
  scope: ExternalListScope;
  /** `SessionSummary.key` of the highlighted row; restored once that row loads. */
  selectedId: string | null;
  /** Local-backend filter; only applied on the `local` tab. */
  backend?: LocalBackendId | "all";
  /** Local model filter (`""` = all); only applied on the `local` tab. */
  model?: string;
  /** Free-text search query. */
  query?: string;
}

/** Always-visible tabs, in display order. */
export const RESUME_PICKER_TABS: readonly ResumePickerTab[] = [
  "all",
  "openai",
  "anthropic",
  "google",
  "mistral",
  "local",
];

/** Display label for a tab ("All" or the provider name). */
export function resumeTabLabel(tab: ResumePickerTab): string {
  return tab === "all" ? "All" : providerLabel(tab);
}

/** Previous/next tab within `tabs`, wrapping around; an unknown tab is treated as the first. */
export function nextResumeTab(
  tab: ResumePickerTab,
  direction: 1 | -1,
  tabs: readonly ResumePickerTab[] = RESUME_PICKER_TABS,
): ResumePickerTab {
  const index = Math.max(0, tabs.indexOf(tab));
  return tabs[(index + direction + tabs.length) % tabs.length]!;
}

/** "Today, 14:05", "Yesterday, 09:12", otherwise a short date; "Unknown time" for invalid input. */
export function activityLabel(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Provider id -> display name; unknown or null ids render as "Unavailable". */
function providerLabel(providerId: string | null): string {
  switch (providerId) {
    case "local":
      return "Local";
    case "anthropic":
      return "Anthropic";
    case "google":
    case "antigravity":
      return "Google";
    case "mistral":
      return "Mistral";
    case "codexa-native":
      return "ubume-PyTorch";
    case "codexa-cupy":
      return "CuPy";
    case "openai":
      return "OpenAI";
    default:
      return "Unavailable";
  }
}

/** Label for an imported conversation's source; unknown sources are shown verbatim. */
function importedLabel(source: string): string {
  return source === "claude" ||
    source === "codex" ||
    source === "google" ||
    source === "antigravity" ||
    source === "vibe"
    ? externalSourceLabel(source)
    : source;
}

function displayTitle(title: string): string {
  // Older saved titles can still carry composer attachment IDs; strip them for display.
  return stripAttachmentIds(title);
}

/** Row text for an Ubume conversation: title — activity · model · provider · [backend] · count · [import source]. */
export function ubumeRowText(conversation: ConversationListEntry, now = new Date()): string {
  const parts = [
    activityLabel(conversation.lastActivityAt ?? conversation.updatedAt, now),
    conversation.modelId,
    providerLabel(conversation.providerId),
    ...(conversation.localBackend
      ? [conversation.localBackend === "unsloth" ? "Unsloth" : "LM Studio"]
      : []),
    `${conversation.messageCount} messages`,
    ...(conversation.importedFrom
      ? [`from ${importedLabel(conversation.importedFrom.source)}`]
      : []),
  ];
  return `${displayTitle(conversation.title)} — ${parts.join(" · ")}`;
}

/** Row text for an external CLI session; adds the project folder name when listing all projects. */
export function externalRowText(
  summary: ExternalSessionSummary,
  scope: ExternalListScope,
  now = new Date(),
): string {
  const parts = [
    activityLabel(summary.updatedAt, now),
    externalSourceLabel(summary.source),
    ...(summary.model ? [summary.model] : []),
    ...(scope === "all" && summary.cwd ? [basename(summary.cwd) || summary.cwd] : []),
  ];
  return `${displayTitle(summary.title)} — ${parts.join(" · ")}`;
}

/** Case-insensitive substring match against any field; an empty query matches everything. */
export function matchesQuery(
  fields: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const needle = query.toLowerCase();
  return !needle || fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * Row text for a catalog entry: external sessions and Ubume conversations use
 * the builders above (with the workspace folder appended in `all` scope);
 * entries with neither fall back to the raw title.
 */
export function sessionRowText(session: SessionSummary, scope: ExternalListScope): string {
  if (session.native) return externalRowText(session.native, scope);
  if (!session.conversation) return session.title;
  const text = ubumeRowText(session.conversation);
  return scope === "all"
    ? `${text} · ${session.workspaceRoot ? basename(session.workspaceRoot) : "Folder unknown"}`
    : text;
}
