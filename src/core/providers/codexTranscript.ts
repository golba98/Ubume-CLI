/**
 * Parses human/legacy Codex transcript output and filters noise while preserving response and
 * activity ordering.
 */

import type { RunToolActivity } from "../../session/types.js";
import { normalizeLineBreaks } from "../shared/text.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";

const ANSI_ESCAPE_PATTERN =
  // Strip ANSI color/control sequences before attempting transcript parsing.
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const NOISE_EXACT_LINES = new Set([
  "reading additional input from stdin...",
  "tokens used",
  "user",
  "codex",
  "assistant",
  // Injected system-prompt lines (from buildCodexPrompt) that the backend echoes back
  "the user request below is the task to handle now.",
  "do not reply with generic readiness or ask what they want changed if the request is already specific.",
  "runtime permissions are read-only for this turn.",
  "inspect files and answer carefully, but do not claim to have edited files unless you actually could.",
  "the current permissions allow workspace edits, but this turn is still in suggest mode.",
  "inspect the repo and answer carefully without making file changes in this turn.",
  "if the request is actionable, make the change in the workspace before responding.",
  "you are running inside the user's current workspace with write access.",
  "only ask a follow-up question if a required detail is truly missing and blocks the work.",
  "default to best-effort continuation instead of stopping for clarification.",
  "if a detail is missing but non-critical, make the most reasonable assumption and state it briefly.",
  "if multiple paths are possible, choose one sensible path and continue.",
  "only ask a blocking follow-up question if proceeding would likely use the wrong file, wrong command, destructive behavior, or produce fundamentally incorrect output.",
  "if you are truly blocked on one critical missing fact, end the response with exactly one line in this format: [question]: <your question>",
  "after doing the work, summarize what changed.",
  "you are in read-only mode, so inspect files and answer carefully, but do not claim to have edited files unless you actually could.",
  "task:",
  // Section headers that may leak from internal prompt scaffolding
  "analysis",
  "analysis:",
  "suggestions",
  "suggestions:",
  "summary",
  "summary:",
  "no code changes are needed",
  "no code changes are needed.",
]);

const NOISE_PREFIXES = [
  "OpenAI Codex v",
  "workdir:",
  "model:",
  "provider:",
  "approval:",
  "sandbox:",
  "reasoning effort:",
  "reasoning summaries:",
  "session id:",
  "auth:",
  "tokens used", // catches "tokens used", "tokens used:", "tokens used1,969", etc.
  "act with strong autonomy",
  "act like a coding agent",
  // Additional internal scaffolding patterns
  "use these markers to structure",
  "hidden workflow",
  "internal rubric",
  "prompt-management",
  "tool-selection rationale",
];

/** Removes ANSI sequences before legacy transcript classification. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

const STDERR_NOISE_PATTERNS = [
  /\[\d+\/\d+\]/, // Progress fractions: [3/10]
  /^\s*\d+\/\d+\s*$/, // Bare fractions: 3/10
  /\d+(\.\d+)?%/, // Percentages: 45.2%
  /^[\s#=.]+$/, // Progress bars: ####, ====, ....
  /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\-\\|/]+$/, // Spinner characters
  /^\(node:\d+\)/, // Node.js warnings: (node:1234)
  /DeprecationWarning:/i, // Node deprecation warnings
  /ExperimentalWarning:/i, // Node experimental warnings
  /^\s*Warning:/i, // Generic warnings
];

/**
 * Applies the established metadata, progress and warning filters to legacy Codex stderr lines.
 */
export function isStderrNoise(line: string): boolean {
  if (isNoiseLine(line)) return true;
  const trimmed = line.trim();
  if (!trimmed) return true;
  return STDERR_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// Keep line breaks but drop control bytes that can move or corrupt terminal cursor/layout.
/** Removes disallowed control bytes while retaining text layout used by transcript parsing. */
export function stripNonPrintableControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

// Box-drawing and block-element Unicode characters (U+2500–U+259F) used by
// terminal TUI frame decorations — strip these from streaming output.
const BOX_DRAWING_BLOCK_ELEMENTS = /[\u2500-\u259F]/g;

/**
 * Stateful factory that pre-sanitizes raw stdout chunks before the stream
 * parser sees them.  Maintains a carryover buffer so that ANSI escape
 * sequences split across Node `data` events are handled correctly.
 */
export function createStdoutSanitizer(): {
  process(chunk: string): string;
  flush(): string;
} {
  let carryover = "";

  const sanitize = (text: string): string => {
    let cleaned = sanitizeTerminalOutput(text);
    cleaned = cleaned.replace(BOX_DRAWING_BLOCK_ELEMENTS, "");
    return cleaned;
  };

  return {
    process(chunk: string): string {
      const input = carryover + chunk;
      carryover = "";

      // Scan the last 20 characters for an incomplete ESC sequence.
      // An ESC (0x1B) not followed by a complete CSI/OSC/Fe terminator
      // means the sequence spans into the next chunk.
      const tail = input.slice(-20);
      const lastEsc = tail.lastIndexOf("\u001B");
      if (lastEsc !== -1) {
        const afterEsc = tail.slice(lastEsc);
        // Check if this looks like a complete sequence:
        // - Fe: ESC + single byte in @-Z\_
        // - CSI: ESC [ ... <letter>
        // - OSC: ESC ] ... (BEL or ST)
        const isComplete =
          /^\u001B[@-Z\\-_]/.test(afterEsc) || // Fe
          /^\u001B\[[0-?]*[ -/]*[@-~]/.test(afterEsc) || // CSI complete
          /^\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/.test(afterEsc); // OSC complete

        if (!isComplete && afterEsc.length < 20) {
          // Incomplete escape — hold it back for the next chunk
          const splitAt = input.length - tail.length + lastEsc;
          carryover = input.slice(splitAt);
          return sanitize(input.slice(0, splitAt));
        }
      }

      return sanitize(input);
    },

    flush(): string {
      if (!carryover) return "";
      const remaining = carryover;
      carryover = "";
      return sanitize(remaining);
    },
  };
}

type TranscriptSection = "preamble" | "task" | "user" | "assistant" | "tool_output" | "postlude";

interface CodexTranscriptStreamHandlers {
  onThinkingLine?: (line: string) => void;
  onAssistantDelta?: (chunk: string) => void;
  onToolActivity?: (activity: RunToolActivity) => void;
}

function normalizeLines(raw: string): string[] {
  return normalizeLineBreaks(stripNonPrintableControls(stripAnsi(raw)))
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
}

function isDivider(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && /^-+$/.test(trimmed);
}

/** Identifies legacy CLI metadata/chatter that should not become assistant text. */
export function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isDivider(trimmed)) return true;
  if (NOISE_EXACT_LINES.has(trimmed.toLowerCase())) return true;

  const lower = trimmed.toLowerCase();
  return NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

function isAssistantLabel(line: string): boolean {
  const lower = line.trim().toLowerCase();
  return lower === "assistant" || lower === "codex";
}

// Detect lines that mark the start of tool/shell execution output from the
// codex backend.  When the backend runs commands (Get-ChildItem, rg, etc.) it
// often emits markers like "$ cmd", "> cmd", "tool_call: shell", or fenced
// code blocks tagged with "ex"/"shell"/"output".  These should be hidden from
// the user and routed to the thinking stream instead.
const TOOL_EXEC_PATTERNS = [
  /^\s*\$\s+\S/, // $ Get-ChildItem, $ rg --files …
  /^\s*>\s+\S/, // > Get-ChildItem (PowerShell prompt)
  /^\s*tool_call\s*:/i, // tool_call: shell
  /^\s*```\s*(ex|shell|bash|powershell|output|cmd)\s*$/i, // fenced execution block
  /^\s*\[running:?\s/i, // [running: Get-ChildItem]
  /^\s*\[exec(uting)?:?\s/i, // [exec: rg --files]
  /^\s*executing\s*:/i, // executing: Get-ChildItem
  /^\s*reading\s+(file|from)\s+/i, // reading file src/...
  /^\s*scanning\s+/i, // scanning directory...
  /^\s*searching\s+/i, // searching for...
  /^\s*writing\s+(to\s+)?file\s+/i, // writing to file...
  /^\s*creating\s+file\s+/i, // creating file...
  /^\s*deleting\s+file\s+/i, // deleting file...
  /^\s*\[tool:\s/i, // [tool: read_file]
  /^\s*\[function:\s/i, // [function: search]
  /^\s*tool_use\s*:/i, // tool_use: read
  /^\s*function_call\s*:/i, // function_call: write
];

function isToolExecStart(line: string): boolean {
  return TOOL_EXEC_PATTERNS.some((pattern) => pattern.test(line));
}

function isToolExecEnd(line: string): boolean {
  const trimmed = line.trim();
  // A closing fence (```) or a blank line after tool output ends the block
  return trimmed === "```" || trimmed === "";
}

function shouldIgnoreStreamingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isDivider(trimmed)) return true;
  if (trimmed.toLowerCase() === "tokens used") return true;
  if (isNoiseLine(trimmed)) return true;
  return false;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function looksLikePath(line: string): boolean {
  return /[\\/]/.test(line) || /\.[a-z0-9_-]+$/i.test(line);
}

function summarizeToolOutput(
  command: string,
  outputLines: string[],
): {
  status: RunToolActivity["status"];
  summary: string;
} {
  const lines = outputLines.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { status: "completed", summary: "Completed with no output" };
  }

  const firstLine = lines[0]!;
  const lowerCommand = command.toLowerCase();
  const failurePattern =
    /(error|exception|fatal|failed|permission denied|not recognized|not found)/i;
  if (failurePattern.test(firstLine)) {
    return { status: "failed", summary: firstLine };
  }

  if (/\brg\b/.test(lowerCommand) && /--files\b/.test(lowerCommand)) {
    return { status: "completed", summary: `Found ${pluralize(lines.length, "file")}` };
  }

  if (/\b(get-childitem|ls|dir)\b/.test(lowerCommand)) {
    const noun = lines.every(looksLikePath) ? "item" : "line";
    return { status: "completed", summary: `Listed ${pluralize(lines.length, noun)}` };
  }

  if (/\b(rg|grep|select-string|findstr)\b/.test(lowerCommand)) {
    return { status: "completed", summary: `Found ${pluralize(lines.length, "match", "matches")}` };
  }

  if (lines.length === 1) {
    return { status: "completed", summary: firstLine };
  }

  if (lines.every(looksLikePath)) {
    return { status: "completed", summary: `Returned ${pluralize(lines.length, "path")}` };
  }

  return { status: "completed", summary: `Produced ${pluralize(lines.length, "line")} of output` };
}

/**
 * Creates per-run legacy transcript state, retaining assistant/tool ordering and stream-boundary
 * cleanup.
 */
export function createCodexTranscriptStreamParser(handlers: CodexTranscriptStreamHandlers) {
  let pending = "";
  let section: TranscriptSection = "preamble";
  let emittedAssistantLine = false;
  let toolCounter = 0;
  let activeTool: {
    id: string;
    command: string;
    startedAt: number;
    outputLines: string[];
  } | null = null;

  // Partial-line flush: emit pending content after a short delay if we're in
  // the assistant section, so sub-line text appears progressively.
  let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEmittedAsPartial = false;

  // Code fence buffering: buffer lines inside fenced blocks and emit them
  // atomically when the closing fence arrives (or after a safety timeout).
  let inCodeFence = false;
  let codeFenceBuffer: string[] = [];
  let codeFenceTimeout: ReturnType<typeof setTimeout> | null = null;
  const CODE_FENCE_TIMEOUT_MS = 3000;

  const clearPartialFlushTimer = () => {
    if (partialFlushTimer) {
      clearTimeout(partialFlushTimer);
      partialFlushTimer = null;
    }
  };

  const clearCodeFenceTimeout = () => {
    if (codeFenceTimeout) {
      clearTimeout(codeFenceTimeout);
      codeFenceTimeout = null;
    }
  };

  const emitThinking = (line: string) => {
    const cleaned = line.replace(/\s+$/g, "");
    if (!cleaned.trim()) return;
    handlers.onThinkingLine?.(cleaned);
  };

  const emitAssistant = (line: string) => {
    const cleaned = line.replace(/\s+$/g, "");
    if (!cleaned && !emittedAssistantLine) return;

    // Code fence buffering: accumulate fenced lines and emit atomically
    if (!inCodeFence && /^\s*```/.test(cleaned)) {
      inCodeFence = true;
      codeFenceBuffer = [cleaned];
      clearCodeFenceTimeout();
      codeFenceTimeout = setTimeout(() => {
        // Safety timeout: force-emit buffered content if fence never closes
        if (inCodeFence && codeFenceBuffer.length > 0) {
          const block = codeFenceBuffer.join("\n");
          const chunk = emittedAssistantLine ? `\n${block}` : block;
          handlers.onAssistantDelta?.(chunk);
          emittedAssistantLine = true;
          codeFenceBuffer = [];
          inCodeFence = false;
        }
        codeFenceTimeout = null;
      }, CODE_FENCE_TIMEOUT_MS);
      return;
    }

    if (inCodeFence) {
      codeFenceBuffer.push(cleaned);
      // Detect closing fence
      if (/^\s*```\s*$/.test(cleaned) && codeFenceBuffer.length > 1) {
        clearCodeFenceTimeout();
        const block = codeFenceBuffer.join("\n");
        const chunk = emittedAssistantLine ? `\n${block}` : block;
        handlers.onAssistantDelta?.(chunk);
        emittedAssistantLine = true;
        codeFenceBuffer = [];
        inCodeFence = false;
      }
      return;
    }

    const chunk = emittedAssistantLine ? `\n${cleaned}` : cleaned;
    handlers.onAssistantDelta?.(chunk);
    emittedAssistantLine = true;
  };

  const finalizeActiveTool = () => {
    if (!activeTool) return;

    const result = summarizeToolOutput(activeTool.command, activeTool.outputLines);
    handlers.onToolActivity?.({
      id: activeTool.id,
      command: activeTool.command,
      status: result.status,
      startedAt: activeTool.startedAt,
      completedAt: Date.now(),
      summary: result.summary,
    });
    activeTool = null;
  };

  const startToolCapture = (rawCommand: string) => {
    finalizeActiveTool();
    toolCounter += 1;
    activeTool = {
      id: `tool-${toolCounter}`,
      command: rawCommand,
      startedAt: Date.now(),
      outputLines: [],
    };
    handlers.onToolActivity?.({
      id: activeTool.id,
      command: activeTool.command,
      status: "running",
      startedAt: activeTool.startedAt,
    });
  };

  const processLine = (rawLine: string) => {
    const line = stripNonPrintableControls(stripAnsi(rawLine)).replace(/\r/g, "");
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    if (section === "postlude") {
      return;
    }

    if (lower === "tokens used") {
      section = "postlude";
      return;
    }

    if (lower === "task:") {
      section = "task";
      return;
    }

    if (isAssistantLabel(line)) {
      section = "assistant";
      return;
    }

    if (lower === "user") {
      section = "user";
      return;
    }

    if (shouldIgnoreStreamingLine(line)) {
      return;
    }

    if (section === "task") {
      if (!trimmed) {
        section = "preamble";
      }
      return;
    }

    // When inside a tool_output block, swallow lines until the block ends,
    // then resume the assistant section.
    if (section === "tool_output") {
      if (isToolExecEnd(line)) {
        finalizeActiveTool();
        section = "assistant";
        return;
      }
      if (activeTool && trimmed) {
        activeTool.outputLines.push(line);
      }
      return;
    }

    if (section === "assistant") {
      // Detect start of an inline tool execution block and switch to
      // tool_output mode so the raw stdout is hidden from the user.
      if (isToolExecStart(line)) {
        const cmd = trimmed
          .replace(/^\s*[$>]\s+/, "")
          .replace(/^\s*tool_call\s*:\s*/i, "")
          .replace(/^\s*```\s*/i, "")
          .replace(/^\s*\[(running|exec|executing):?\s*/i, "")
          .replace(/\]\s*$/, "");
        if (cmd) startToolCapture(cmd);
        section = "tool_output";
        return;
      }

      emitAssistant(line);
      return;
    }

    if (!trimmed) {
      return;
    }

    // Auto-promotion: if we're in preamble and the line looks like substantive
    // prose (multiple words, length > 40, no noise patterns, not a progress/status
    // line), auto-promote to assistant section. This handles backends that skip
    // the "Assistant:" label.
    if (
      section === "preamble" &&
      trimmed.length > 40 &&
      (trimmed.match(/\s+/g)?.length ?? 0) >= 4 &&
      !isNoiseLine(trimmed) &&
      !isToolExecStart(line) &&
      !/^(checking|scanning|searching|reading|loading|processing|analyzing|looking)\s/i.test(
        trimmed,
      )
    ) {
      section = "assistant";
      emitAssistant(line);
      return;
    }

    emitThinking(line);
  };

  const feed = (chunk: string) => {
    // If the previous pending content was already emitted as a partial,
    // clear that flag since we're about to process new data.
    if (pendingEmittedAsPartial) {
      pendingEmittedAsPartial = false;
    }

    pending += chunk;
    const normalized = normalizeLineBreaks(pending);
    const lines = normalized.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      processLine(line);
    }

    // Partial-line flush: if there's leftover content in pending and we're
    // in the assistant section, schedule a timer to emit it as a partial delta.
    clearPartialFlushTimer();
    if (pending && section === "assistant" && !inCodeFence) {
      partialFlushTimer = setTimeout(() => {
        partialFlushTimer = null;
        if (pending && section === "assistant" && !inCodeFence) {
          const cleaned = stripNonPrintableControls(stripAnsi(pending)).replace(/\s+$/g, "");
          if (cleaned) {
            const partialChunk = emittedAssistantLine ? `\n${cleaned}` : cleaned;
            handlers.onAssistantDelta?.(partialChunk);
            emittedAssistantLine = true;
            pendingEmittedAsPartial = true;
          }
        }
      }, 100);
    }
  };

  const flush = () => {
    clearPartialFlushTimer();
    clearCodeFenceTimeout();

    // Force-emit any buffered code fence content
    if (inCodeFence && codeFenceBuffer.length > 0) {
      const block = codeFenceBuffer.join("\n");
      const chunk = emittedAssistantLine ? `\n${block}` : block;
      handlers.onAssistantDelta?.(chunk);
      emittedAssistantLine = true;
      codeFenceBuffer = [];
      inCodeFence = false;
    }

    if (pending) {
      // If pending was already emitted as a partial, skip re-emission
      if (!pendingEmittedAsPartial) {
        processLine(pending);
      }
      pending = "";
      pendingEmittedAsPartial = false;
    }
    finalizeActiveTool();
  };

  return { feed, flush };
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;

  return lines.slice(start, end);
}

function stripToolOutputBlocks(lines: string[]): string[] {
  const visible: string[] = [];
  let inToolOutput = false;

  for (const line of lines) {
    if (inToolOutput) {
      if (isToolExecEnd(line)) {
        inToolOutput = false;
      }
      continue;
    }

    if (isToolExecStart(line)) {
      inToolOutput = true;
      continue;
    }

    visible.push(line);
  }

  return visible;
}

function dedupeTrailingRepeat(lines: string[]): string[] {
  if (lines.length < 2) return lines;

  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] === line && line.trim()) continue;
    deduped.push(line);
  }
  return deduped;
}

function extractLabeledAssistantBlock(lines: string[]): string[] {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim().toLowerCase();
    if (trimmed !== "codex" && trimmed !== "assistant") continue;

    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      const normalized = line.trim().toLowerCase();
      if (normalized === "user" || normalized === "codex" || normalized === "assistant") break;
      if (normalized.startsWith("tokens used")) break;
      if (isDivider(line)) continue;
      if (NOISE_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()))) break;
      block.push(line);
    }

    const cleaned = trimBlankEdges(stripToolOutputBlocks(block));
    if (cleaned.length > 0) {
      return dedupeTrailingRepeat(cleaned);
    }
  }

  return [];
}

// Handles backends that echo the full injected prompt (Task: + user message) before
// their response, without an "assistant" label.  Finds the last "Task:" line, skips
// past the user's prompt text that follows it, then treats everything after as the
// actual response.
function extractAfterTaskSection(lines: string[]): string[] {
  let taskIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k]!.trim().toLowerCase() === "task:") {
      taskIdx = k;
      break;
    }
  }
  if (taskIdx === -1) return [];

  // Skip the "Task:" line and the user-prompt lines that follow (until blank or noise)
  let i = taskIdx + 1;
  while (i < lines.length && lines[i]!.trim() !== "") i++;
  // Skip any blank separator lines
  while (i < lines.length && lines[i]!.trim() === "") i++;

  const rest = lines.slice(i);
  const filtered = trimBlankEdges(
    stripToolOutputBlocks(rest).filter((line) => {
      if (!line.trim()) return true;
      return !isNoiseLine(line);
    }),
  );

  return dedupeTrailingRepeat(filtered);
}

/** Converts a complete legacy transcript into cleaned assistant-facing text. */
export function sanitizeCodexTranscript(raw: string): string {
  const lines = normalizeLines(raw);

  // 1. Prefer a properly labeled "assistant:" / "codex:" block
  const labeled = extractLabeledAssistantBlock(lines);
  if (labeled.length > 0) {
    return labeled.join("\n").trim();
  }

  // 2. If the backend echoed the full prompt (Task: … user message …) without a label,
  //    extract everything that comes after the task section.
  const afterTask = extractAfterTaskSection(lines);
  if (afterTask.length > 0) {
    return afterTask.join("\n").trim();
  }

  // 3. Last resort: strip all known noise and return what's left.
  const filtered = trimBlankEdges(
    stripToolOutputBlocks(lines).filter((line) => {
      if (!line.trim()) return true;
      return !isNoiseLine(line);
    }),
  );

  if (filtered.length === 0) {
    return "Codex completed successfully, but no assistant response text was detected.";
  }

  return dedupeTrailingRepeat(filtered).join("\n").trim();
}
