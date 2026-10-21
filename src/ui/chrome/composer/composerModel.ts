/**
 * Composer view model: the props contract (`BottomComposerProps`), persona
 * selection from the run state, slash-command suggestion state, status-line text,
 * the context meter, and row measurement (`measureBottomComposerRows`), which
 * `src/app` uses to budget terminal rows before rendering.
 *
 * Pure functions only; the measurement must stay in step with what
 * `BottomComposer.tsx` renders, or the transcript and composer will overlap.
 */
import type { ModelSpec } from "../../../core/providerRuntime/contextMetadata.js";
import { formatContextCompact } from "../../../core/providerRuntime/contextMetadata.js";
import { clampVisualText, getTextWidth } from "../../../core/shared/text.js";
import type { ExternalCliStatus, UIState } from "../../../session/types.js";

import {
  createInputViewport,
  getComposerRowLayout,
  normalizeCursorOffset,
  normalizeInputText,
} from "../../input/inputBuffer.js";

import { type CommandSuggestion, getSlashCommandSuggestions } from "../../input/slashCommands.js";
import type { Layout } from "../../layout.js";

import { isAnimatedBusyState } from "../statusIndicators.js";

// ─── Types & constants ────────────────────────────────────────────────────────

export type ComposerPersona = "idle" | "busy" | "answer" | "error";

export const MAX_VISIBLE_INPUT_ROWS = 5;

/** Keep both route labels recognizable when the footer cannot show the full names. */
export function fitFooterRuntimeLabel(label: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  width = Math.floor(width);
  if (getTextWidth(label) <= width) return label;
  const slash = label.indexOf("/");
  if (slash < 0 || width < 5) return clampVisualText(label, width);
  const provider = label.slice(0, slash).trim();
  const model = label.slice(slash + 1).trim();
  const providerWidth = Math.min(getTextWidth(provider), Math.max(1, Math.floor((width - 3) / 3)));
  return `${clampVisualText(provider, providerWidth)} / ${clampVisualText(model, width - providerWidth - 3)}`;
}

/** Measurement and renderer share this budget; the draft itself is never truncated. */
export function composerGeometry(rows: number, auxiliaryRows = 0, statusRows = 0) {
  const height = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
  const bordered = height >= 6;
  const showAuxiliary = height >= 12;
  const showStatus = height >= 6;
  const footer = height >= 3;
  const reserved =
    1 +
    1 +
    (bordered ? 2 : 0) +
    (footer ? 1 : 0) +
    (showAuxiliary ? auxiliaryRows : 0) +
    (showStatus ? statusRows : 0);
  return {
    bordered,
    showAuxiliary,
    showStatus,
    footer,
    maxInputRows: Math.max(1, Math.min(MAX_VISIBLE_INPUT_ROWS, height - reserved)),
  };
}

export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ─── Exported helpers ────────────────────────────────────────────────────────

export function getTokenBarDisplay(tokensUsed: number, modelSpec: ModelSpec) {
  if (modelSpec.status !== "verified") {
    return {
      usedText: "Context",
      limitText: "Unknown",
      percentage: null as number | null,
      isEstimatedLimit: false,
      hasKnownLimit: false,
    };
  }
  const isEstimated = modelSpec.isEstimated === true;
  const pct =
    modelSpec.contextWindow > 0
      ? Math.min(100, Math.floor((tokensUsed / modelSpec.contextWindow) * 100))
      : 0;
  return {
    usedText: tokensUsed.toLocaleString("en-US"),
    limitText: isEstimated
      ? `~${formatContextCompact(modelSpec.contextWindow)}`
      : modelSpec.contextWindow.toLocaleString("en-US"),
    percentage: pct,
    isEstimatedLimit: isEstimated,
    hasKnownLimit: true,
  };
}

/** Composer status after Ctrl+C: a run is stopping, or the next press quits. */
export type InterruptHint = "stopping" | "confirm-exit";

export interface BottomComposerProps {
  layout: Layout;
  width?: number;
  uiState: UIState;
  interruptHint?: InterruptHint | null;
  themeName?: string;
  mode?: string;
  model?: string;
  footerModelDisplay?: string;
  reasoningLevel?: string;
  contextDisplay?: string;
  showContext?: boolean;
  planMode?: boolean;
  showBusyLoader?: boolean;
  tokensUsed?: number;
  modelSpec?: ModelSpec;
  value: string;
  cursor: number;
  onChangeInput: (value: string, cursor: number) => void;
  onRegisterPaste?: (label: string, content: string) => void;
  onPasteImage?: () => void;
  onSubmit: () => void;
  onInterrupt?: () => void;
  onRedraw?: () => void;
  onTranscript?: () => void;
  onExternalEditor?: () => void;
  onSendNow?: () => void;
  onRegisterFile?: (token: string, path: string) => void;
  workspaceRoot?: string;
  history?: readonly string[];
  queueCount?: number;
  queuePaused?: boolean;
  onCancel: () => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onOpenProviderPicker?: () => void;
  onOpenModelPicker: () => void;
  onCycleMode: () => void;
  onQuit: () => void;
  activeProviderId?: string;
  externalCliStatus?: ExternalCliStatus;
}

export interface BottomComposerMeasureParams {
  layout: Layout;
  width?: number;
  uiState: UIState;
  interruptHint?: InterruptHint | null;
  mode?: string;
  model?: string;
  reasoningLevel?: string;
  tokensUsed?: number;
  modelSpec?: ModelSpec;
  value: string;
  cursor: number;
  queueCount?: number;
}

export interface CommandSuggestionState {
  showSuggestions: boolean;
  reserveSuggestionRow: boolean;
  suggestions: readonly CommandSuggestion[];
}

export const FALLBACK_MODEL_SPEC: ModelSpec = {
  status: "unknown",
  contextWindow: null,
  maxOutputTokens: null,
  sourceUrl: "",
  verifiedAt: null,
  error: null,
};

export function getComposerPersona(uiState: UIState): ComposerPersona {
  if (isAnimatedBusyState(uiState.kind)) {
    return "busy";
  }
  if (uiState.kind === "AWAITING_USER_ACTION") {
    return "answer";
  }
  if (uiState.kind === "ERROR") {
    return "error";
  }
  return "idle";
}

export function getCommandSuggestionState({
  value,
  allowCommands,
}: {
  value: string;
  allowCommands: boolean;
}): CommandSuggestionState {
  const isCmdPrefix = allowCommands && value.startsWith("/");
  const cmdPrefix = value.split(" ")[0]?.toLowerCase() ?? "";
  const canSuggest = isCmdPrefix && !value.includes(" ");
  const matchingSuggestions = canSuggest ? getSlashCommandSuggestions(cmdPrefix) : [];
  const exactMatch = matchingSuggestions.find((command) => command.cmd === cmdPrefix);
  const exactMatchAliases = exactMatch && "aliases" in exactMatch ? exactMatch.aliases : undefined;
  const suppressExactMatch = exactMatch ? !(exactMatchAliases?.length ?? 0) : true;
  const suggestions = matchingSuggestions.filter(
    (command) => !(suppressExactMatch && command.cmd === cmdPrefix),
  );

  return {
    showSuggestions: canSuggest,
    reserveSuggestionRow: matchingSuggestions.length > 0,
    suggestions,
  };
}

export function measureBottomComposerRows({
  layout,
  width = layout.cols,
  uiState,
  value,
  cursor,
  queueCount = 0,
  interruptHint = null,
}: BottomComposerMeasureParams): number {
  const persona = getComposerPersona(uiState);
  const allowCommands = persona !== "answer";
  const { editorWidth: promptWidth } = getComposerRowLayout(width);
  const normalizedValue = normalizeInputText(value);
  const normalizedCursor = normalizeCursorOffset(normalizedValue, cursor);
  const commandSuggestionState = getCommandSuggestionState({
    value: normalizedValue,
    allowCommands,
  });
  const auxiliaryRows =
    (queueCount > 0 || /(?:^|\s)@[^\s]*$/.test(value.slice(0, cursor)) ? 1 : 0) +
    (commandSuggestionState.reserveSuggestionRow ? 1 : 0);
  const statusRows =
    getVisibleComposerStatusLine({ uiState, interruptHint, value: normalizedValue, allowCommands })
      .length > 0
      ? 1
      : 0;
  const geometry = composerGeometry(layout.rows, auxiliaryRows, statusRows);
  const promptViewport = createInputViewport({
    text: normalizedValue,
    cursorOffset: normalizedCursor,
    width: promptWidth,
    maxVisibleRows: geometry.maxInputRows,
    scrollRow: 0,
  });
  const bottomPadding = layout.mode === "compact" ? 0 : 1;
  const transientStatusRows = geometry.showStatus ? statusRows : 0;
  const visiblePromptRows = promptViewport.visibleRows.length;

  return (
    visiblePromptRows +
    (geometry.bordered ? 2 : 0) +
    (geometry.showAuxiliary ? auxiliaryRows : 0) +
    transientStatusRows +
    (geometry.footer ? 1 : 0) +
    bottomPadding
  );
}

export function getExternalCliLabel(providerId: string): string | null {
  if (providerId === "google") return "Antigravity CLI";
  if (providerId === "anthropic") return "Claude Code";
  if (providerId === "openai") return "Codex CLI";
  return null;
}

export function getProviderReadyLabel(providerId: string): string | null {
  if (providerId === "google") return "Google";
  if (providerId === "anthropic") return "Claude";
  if (providerId === "openai") return "Codex";
  return null;
}

export function getStatusLine(
  uiState: UIState,
  activeProviderId?: string,
  runElapsedSeconds?: number,
  externalCliStatus?: ExternalCliStatus,
): string | null {
  if (uiState.kind === "THINKING") {
    const cliLabel = activeProviderId ? getExternalCliLabel(activeProviderId) : null;
    if (cliLabel && externalCliStatus !== "ready") {
      const elapsed = runElapsedSeconds ?? 0;
      const timerStr = elapsed > 0 ? `  ${formatElapsed(elapsed)}` : "";
      if (elapsed >= 15) return `Still waiting for ${cliLabel}${timerStr}`;
      if (elapsed >= 5)
        return `${cliLabel} is still starting. The upstream CLI can take a moment${timerStr}`;
      return `Starting ${cliLabel}${timerStr}`;
    }
    return `✧ ${getProviderReadyLabel(activeProviderId ?? "") ?? "Ubume"} is working`;
  }
  if (uiState.kind === "RESPONDING") {
    const readyLabel = activeProviderId ? getProviderReadyLabel(activeProviderId) : null;
    if (readyLabel) return `✧ ${readyLabel} is working`;
    return `✧ ${getProviderReadyLabel(activeProviderId ?? "") ?? "Ubume"} is working`;
  }
  if (uiState.kind === "ANSWER_VISIBLE") return "✧ Ubume response complete";
  if (uiState.kind === "SHELL_RUNNING") return "✧ Ubume is running command";
  if (uiState.kind === "AWAITING_USER_ACTION") return "✧ waiting for your answer";
  if (uiState.kind === "ERROR") return uiState.message;
  return null;
}

export function getVisibleComposerStatusLine({
  uiState,
  value,
  allowCommands,
  activeProviderId,
  runElapsedSeconds,
  externalCliStatus,
  interruptHint = null,
}: {
  uiState: UIState;
  interruptHint?: InterruptHint | null;
  value: string;
  allowCommands: boolean;
  activeProviderId?: string;
  runElapsedSeconds?: number;
  externalCliStatus?: ExternalCliStatus;
}): string {
  if (interruptHint === "stopping") return "✧ Stopping · Ctrl+C again to exit";
  if (interruptHint === "confirm-exit") return "Press Ctrl+C again to exit";
  const persona = getComposerPersona(uiState);
  const rawStatusLine =
    getStatusLine(uiState, activeProviderId, runElapsedSeconds, externalCliStatus) ?? "";
  const isCommandDraft = allowCommands && value.startsWith("/");

  if (
    rawStatusLine.length === 0 ||
    persona === "answer" ||
    (isCommandDraft && persona !== "busy")
  ) {
    return "";
  }

  return rawStatusLine;
}

export function getPlaceholder(persona: ComposerPersona): string {
  switch (persona) {
    case "answer":
      return "Type your answer...";
    case "error":
      return "Ask again or use /command";
    case "busy":
      return "";
    case "idle":
    default:
      return "Ask Ubume, run !shell, or use /command";
  }
}
