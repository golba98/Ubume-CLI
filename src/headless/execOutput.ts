/**
 * Filters and formats what a headless run writes to its streams.
 *
 * The stream contract is:
 * - **stdout** carries only assistant text, sanitised so control sequences from the
 *   provider cannot reach the caller's terminal or a file it is redirected to.
 * - **stderr** carries one `[ubume exec] <kind>: <message>` line per diagnostic, with
 *   continuation lines indented by two spaces.
 *
 * Provider CLIs sometimes leak protocol frames or OS noise into the text channels.
 * The predicates here drop those so they never become part of an answer.
 */
import type { ResolvedRuntimeConfig } from "../config/runtimeConfig.js";
import type { BackendProvider } from "../core/providers/types.js";
import { normalizeLineBreaks } from "../core/shared/text.js";
import { sanitizeTerminalOutput } from "../core/terminal/terminalSanitize.js";
import type { RunToolActivity } from "../session/types.js";

type Writable = Pick<NodeJS.WriteStream, "write">;

/** Strips terminal control sequences, normalises line breaks and trims surrounding whitespace. */
export function formatDiagnosticText(value: string): string {
  return normalizeLineBreaks(sanitizeTerminalOutput(value)).trim();
}

/** Sanitises assistant text for stdout, expanding tabs to two spaces. */
export function sanitizeAssistantText(value: string): string {
  return sanitizeTerminalOutput(value, { preserveTabs: false, tabSize: 2 });
}

/**
 * Writes one `[ubume exec] kind: message` diagnostic to stderr. Messages that are empty
 * after sanitising are skipped, so blank provider progress never prints a bare prefix.
 */
export function writeDiagnostic(stderr: Writable, kind: string, message: string): void {
  const safeMessage = formatDiagnosticText(message);
  if (!safeMessage) return;
  stderr.write(`[ubume exec] ${kind}: ${safeMessage.replace(/\n/g, "\n  ")}\n`);
}

/** Windows `taskkill` confirmation printed when a provider's process tree is torn down. */
export function isProcessTerminationNoise(line: string): boolean {
  return /^SUCCESS: The process with PID \d+ .* has been terminated\.$/.test(line.trim());
}

/** A raw Codex JSONL event (`thread.*`, `turn.*`, `item.*`) that leaked into the text channel. */
function isStructuredCodexEventLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;

  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return typeof parsed.type === "string" && /^(?:thread|turn|item)\./.test(parsed.type);
  } catch {
    return false;
  }
}

/**
 * True when every non-blank line of an assistant chunk is protocol or teardown noise.
 * Mixed chunks pass through unchanged: dropping part of a chunk could corrupt real
 * output that merely looks like JSON.
 */
export function shouldSuppressAssistantChunk(chunk: string): boolean {
  const lines = normalizeLineBreaks(chunk)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.length > 0 &&
    lines.every((line) => isStructuredCodexEventLine(line) || isProcessTerminationNoise(line))
  );
}

/** `status: command`, with the tool's summary on the next line unless it is teardown noise. */
export function formatToolActivity(activity: RunToolActivity): string {
  const header = `${activity.status}: ${activity.command}`;
  const summary = activity.summary?.trim();
  if (!summary || isProcessTerminationNoise(summary)) return header;
  return `${header}\n${summary}`;
}

/**
 * The single startup diagnostic line, which states the effective workspace, provider,
 * model and policy.
 *
 * The Antigravity CLI backend owns its own permissions and buffers its responses, so it
 * gets a reduced line instead of a list of local policy settings that do not apply to it.
 */
export function formatRuntimeStartup(
  runtime: ResolvedRuntimeConfig,
  workspaceRoot: string,
  provider: BackendProvider,
  backendKind?: string,
): string {
  if (backendKind === "antigravity-cli-auth") {
    return [
      `workspace ${workspaceRoot}`,
      `provider Google (${backendKind})`,
      `requested model ${runtime.model}`,
      "responses buffered; permissions managed by Antigravity CLI",
    ].join("; ");
  }

  return [
    `workspace ${workspaceRoot}`,
    `provider ${provider.label} (${provider.id})`,
    `model ${runtime.model}`,
    `mode ${runtime.mode}`,
    `planMode ${runtime.planMode ? "enabled" : "disabled"}`,
    `sandbox ${runtime.policy.sandboxMode}`,
    `approval ${runtime.policy.approvalPolicy}`,
    `network ${runtime.policy.networkAccess ? "enabled" : "disabled"}`,
  ].join("; ");
}
