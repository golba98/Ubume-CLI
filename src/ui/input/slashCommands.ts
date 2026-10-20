/**
 * Static catalog of slash commands shown as composer autocomplete suggestions.
 *
 * This list only drives suggestions (`chrome/composer/composerModel.ts` and the
 * exact-match check in `chrome/composer/useComposerInput.ts`); the commands are
 * parsed and executed by `src/commands/handler.ts`. Adding an entry here does
 * not implement a command, and a command missing here still works when typed.
 *
 * Pure module: no state, no side effects.
 */
interface SlashCommandSuggestion {
  cmd: string;
  desc: string;
  aliases?: readonly string[];
}

/** Suggestion entries in display order; `aliases` also match the typed prefix. */
export const SLASH_COMMANDS = [
  { cmd: "/help", desc: "Show available commands" },
  { cmd: "/clear", desc: "Clear chat and cancel active run" },
  {
    cmd: "/resume",
    desc: "Resume a conversation, or a Claude Code / Codex / Mistral Vibe session",
  },
  { cmd: "/providers", desc: "Open AI provider picker", aliases: ["/provider"] },
  { cmd: "/model", desc: "Change active model" },
  { cmd: "/models", desc: "Open model picker" },
  { cmd: "/mode", desc: "Change execution mode" },
  { cmd: "/route", desc: "Show active chat route" },
  { cmd: "/reasoning", desc: "Change reasoning level" },
  { cmd: "/plan", desc: "Show or toggle session plan mode" },
  { cmd: "/settings", desc: "Open the settings picker", aliases: ["/setting"] },
  { cmd: "/status", desc: "Show effective runtime configuration" },
  { cmd: "/usage", desc: "Show account usage limits for the active provider" },
  { cmd: "/permissions", desc: "Inspect or update permissions and sandbox controls" },
  { cmd: "/runtime", desc: "Compatibility runtime policy controls" },
  { cmd: "/themes", desc: "Open visual theme picker" },
  { cmd: "/preferences", desc: "Open preferences (startup logo, color theme)" },
  { cmd: "/verbose", desc: "Toggle verbose mode (detailed processing info)" },
  { cmd: "/auth", desc: "Manage authentication" },
  { cmd: "/workspace", desc: "Show the locked workspace" },
  { cmd: "/copy", desc: "Copy the full conversation transcript to clipboard" },
  { cmd: "/paste-image", desc: "Attach the image currently on the clipboard" },
  { cmd: "/update", desc: "Check for updates and install the latest Ubume" },
  { cmd: "/queue", desc: "Manage queued instructions" },
  { cmd: "/transcript", desc: "Inspect tool activity and output" },
  { cmd: "/diff", desc: "Review session or turn changes" },
  { cmd: "/rewind", desc: "Preview conversation and file recovery" },
  { cmd: "/send-now", desc: "Interrupt and send queued instructions" },
  { cmd: "/exit", desc: "Quit the application" },
] as const satisfies readonly SlashCommandSuggestion[];

export type CommandSuggestion = (typeof SLASH_COMMANDS)[number];

function matchesPrefix(suggestion: SlashCommandSuggestion, prefix: string): boolean {
  if (suggestion.cmd.startsWith(prefix)) return true;
  return suggestion.aliases?.some((alias) => alias.startsWith(prefix)) ?? false;
}

/**
 * Return up to five suggestions whose command or any alias starts with
 * `prefix` (case-insensitive), preserving catalog order. The suggestion shows
 * the canonical `cmd`, even when only an alias matched.
 */
export function getSlashCommandSuggestions(prefix: string): readonly CommandSuggestion[] {
  const normalized = prefix.toLowerCase();
  return SLASH_COMMANDS.filter((command) => matchesPrefix(command, normalized)).slice(0, 5);
}
