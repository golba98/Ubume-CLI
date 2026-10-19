import { normalizeLineBreaks } from "../shared/text.js";

interface SanitizeTerminalOptions {
  preserveTabs?: boolean;
  tabSize?: number;
}

const DEFAULT_TAB_SIZE = 2;

// ── Dangerous sequence patterns (always stripped) ─────────────────────────────
// OSC: Operating System Command — can set window titles, hyperlinks, etc.
const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
// DCS/PM/APC: Device Control String and friends — rare but risky
const DCS_PM_APC_SEQUENCE = /\u001B[PX^_][\s\S]*?\u001B\\/g;
// CSI: Control Sequence Introducer — covers cursor movement, erase, colour, etc.
const CSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
// ESC + single intermediate — Fe sequences (e.g. ESC M = reverse index)
const ESC_INTERMEDIATE_SEQUENCE = /\u001B[@-Z\\-_]/g;
// C1 control codes (0x80–0x9F) — can masquerade as CSI openers on some terminals
const SINGLE_C1_SEQUENCE = /[\u0080-\u009F]/g;
// Remaining non-printable bytes after the above passes
const DISALLOWED_CONTROL_BYTES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function normalizeTabs(text: string, preserveTabs: boolean, tabSize: number): string {
  if (preserveTabs) return text;
  return text.replace(/\t/g, " ".repeat(Math.max(1, tabSize)));
}

/** Strip all terminal escape sequences. */
function stripTerminalSequences(raw: string): string {
  return raw
    .replace(OSC_SEQUENCE, "")
    .replace(DCS_PM_APC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESC_INTERMEDIATE_SEQUENCE, "")
    .replace(SINGLE_C1_SEQUENCE, "");
}

function stripUnsafeControls(text: string): string {
  return text.replace(DISALLOWED_CONTROL_BYTES, "");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Removes escape/control sequences, normalizes line endings and expands tabs unless preservation
 * is requested.
 */
export function sanitizeTerminalOutput(raw: string, options: SanitizeTerminalOptions = {}): string {
  if (!raw) return "";
  const preserveTabs = options.preserveTabs ?? false;
  const tabSize = options.tabSize ?? DEFAULT_TAB_SIZE;

  const withoutSequences = stripTerminalSequences(raw);
  const normalizedBreaks = normalizeLineBreaks(withoutSequences);
  const withoutUnsafeControls = stripUnsafeControls(normalizedBreaks);
  return normalizeTabs(withoutUnsafeControls, preserveTabs, tabSize);
}

/** Fast equivalent of the default sanitizer for already decoded process-stream chunks. */
export function sanitizeTerminalStreamChunk(raw: string): string {
  // Ordinary streamed text needs none of the escape stripping, CR normalization or tab work.
  // LF is already canonical; all other controls and C1 bytes take the full sanitizer below.
  if (!/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(raw)) return raw;
  return sanitizeTerminalOutput(raw);
}

/** Sanitizes untrusted input with the default two-space tab expansion. */
export function sanitizeTerminalInput(raw: string): string {
  return sanitizeTerminalOutput(raw, { preserveTabs: false, tabSize: DEFAULT_TAB_SIZE });
}

/** Sanitizes and right-trims lines, discarding those that become empty. */
export function sanitizeTerminalLines(lines: string[]): string[] {
  const sanitized: string[] = [];
  for (const line of lines) {
    const value = sanitizeTerminalOutput(line).trimEnd();
    if (value.length > 0) sanitized.push(value);
  }
  return sanitized;
}
