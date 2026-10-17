/**
 * Sanitize and normalize stages of the subprocess-output render pipeline
 * (sanitize → normalize → classify → measure).
 *
 * The later stages live elsewhere: classification is `markdownParser.ts`
 * (`parseMarkdown` → typed `Segment[]`) and measurement is
 * `timeline/measure/` (`buildMarkdownRows` and the row builders). Note that
 * `parseMarkdown` and the row builders call `sanitizeTerminalOutput` directly,
 * so these two helpers are not on the transcript's hot path; they are
 * standalone, pure string transforms.
 */
import { isNoiseLine } from "../../core/providers/codexTranscript.js";
import { normalizeLineBreaks } from "../../core/shared/text.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";

/**
 * Sanitize: Strip ANSI escape sequences and non-printable control characters.
 * Removes known UI chrome bleed (e.g. box drawing characters) before rendering.
 * Each tab is replaced with two spaces rather than preserved.
 *
 * Note on diff colours: diff colouring in this app is applied at render time
 * from theme tones, NOT via raw ANSI escape sequences. This means
 * sanitizeTerminalOutput() can safely strip all raw ANSI here — the theme
 * colours are re-applied as row tones by `buildMarkdownRows` (code/diff blocks)
 * in `timeline/measure/markdownRows.ts`. There is no need to preserve SGR
 * codes at this stage.
 */
export function sanitizeOutput(raw: string): string {
  if (!raw) return "";
  const clean = sanitizeTerminalOutput(raw, { preserveTabs: false, tabSize: 2 });
  return clean;
}

/**
 * Normalize: Normalizes text formatting for the box wrappers.
 * Replaces CRLF with LF and collapses excessive blank lines to prevent
 * vertical stretching and layout popping. Also drops whole lines that
 * `isNoiseLine` (Codex transcript noise) recognizes.
 */
export function normalizeOutput(clean: string): string {
  let normalized = normalizeLineBreaks(clean);
  // Collapse excessive vertical whitespace (4+ newlines into 3)
  normalized = normalized.replace(/\n{4,}/g, "\n\n\n");

  // Remove lines that are purely known noise prefixes
  const lines = normalized.split("\n");
  const filteredLines = lines.filter((line) => !isNoiseLine(line));

  return filteredLines.join("\n");
}
