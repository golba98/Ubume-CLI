/**
 * Implements the runnable Codex backend, spawning the CLI and adapting its streams to
 * BackendRunHandlers.
 */

import { spawn } from "child_process";
import { formatConversationHistory } from "../../session/conversation.js";
import { prepareCodexExecLaunch } from "../codex/codexLaunch.js";
import { buildCodexPrompt } from "../codex/codexPrompt.js";
import { formatCodexLaunchError, spawnCodexProcess } from "../executables/codexExecutable.js";
import * as perf from "../perf/profiler.js";
import { createOutputBuffer, type OutputBuffer } from "../process/outputCapture.js";
import { normalizeLineBreaks } from "../shared/text.js";
import { createTerminalTitleSequenceStripper } from "../terminal/terminalTitle.js";
import { createCodexJsonStreamParser } from "./codexJsonStream.js";
import {
  createCodexTranscriptStreamParser,
  createStdoutSanitizer,
  isStderrNoise,
  sanitizeCodexTranscript,
  stripAnsi,
  stripNonPrintableControls,
} from "./codexTranscript.js";
import { createRunControl } from "./runControl.js";
import type { BackendProvider } from "./types.js";

// Detects CLI error messages that indicate --experimental-json is not supported.
// When this fires the provider retries in legacy transcript mode.
function looksLikeUnsupportedStructuredOutput(raw: string): boolean {
  return /experimental-json|unknown option|unrecognized option|unexpected argument|unexpected option/i.test(
    raw,
  );
}

// Retention bounds (characters). Legacy transcript mode keeps complete output, because
// its final answer is reconstructed from the whole transcript. In JSON mode the answer
// comes from parsed events, so the raw text only backs a rare empty-answer fallback.
const JSON_MODE_RAW_OUTPUT_CHARS = 8 * 1024 * 1024;
// stderr is diagnostics only: keep its first and last 512 KiB.
const RAW_STDERR_CHARS = 1024 * 1024;

function isProcessTerminationNoise(line: string): boolean {
  return /^SUCCESS: The process with PID \d+ .* has been terminated\.$/.test(line.trim());
}

/**
 * Codex exec backend with one legacy-output retry when structured output is unsupported.
 * Each run owns its parsers and subprocesses; run control reports teardown separately from text.
 */
export const codexSubprocessProvider: BackendProvider = {
  id: "codex-subprocess",
  label: "Ubume",
  description: "Direct connection to the Codex neural network.",
  authState: "delegated",
  authLabel: "Authenticated via Codex",
  statusMessage: "Authentication is managed via Ubume.",
  supportsModels: () => true,
  run: (prompt, options, handlers) => {
    const control = createRunControl(handlers);
    let done = false;
    let cancelled = false;
    let proc: ReturnType<typeof spawn> | null = null;
    let procExited = false;
    let currentRawOutput: OutputBuffer = createOutputBuffer();
    // CLI diagnostics only; stdout carries tool output and must not be
    // classified (e.g. as an auth failure) when the run errors.
    let currentRawStderr: OutputBuffer = createOutputBuffer({ maxChars: RAW_STDERR_CHARS });
    let finalAnswerObserved = false;

    const finishError = (message: string) => {
      if (done) return;
      done = true;
      control.finish();
      handlers.onError(message, currentRawStderr.text());
    };

    const finishSuccess = (response: string) => {
      if (done) return;
      done = true;
      control.finish();
      handlers.onResponse(response);
    };

    const emitFinalAnswerObserved = (response: string) => {
      if (finalAnswerObserved) return;
      finalAnswerObserved = true;
      handlers.onFinalAnswerObserved?.(response);
    };

    const startAttempt = (structuredOutput: boolean, probeCapabilities = false) => {
      if (cancelled || done) return;
      let firstChunkSeen = false;
      let firstStderrSeen = false;
      handlers.benchmarkHooks?.onProviderPrepStart?.();
      void prepareCodexExecLaunch(
        {
          runtime: options.runtime,
          cwd: options.workspaceRoot,
          structuredOutput,
          probeCapabilities,
          imageAttachments: options.imageAttachments,
          codexCommandPath: options.runtime.codexCommandPath,
        },
        import.meta.url,
      )
        .then((launchPlan) => {
          if (cancelled || done) return;
          if (!launchPlan.ok) {
            finishError(launchPlan.error);
            return;
          }
          if (!launchPlan.executable) {
            finishError("Codex launch preparation did not return an executable.");
            return;
          }
          handlers.benchmarkHooks?.onProviderPrepComplete?.();

          // Per-stream copies exist only to replay output into the transcript parser and to
          // detect an unsupported --json flag; both questions are settled once a structured
          // event arrives, so JSON mode stops (and frees) them.
          let rawStdout = "";
          let rawStderr = "";
          let retainRawStreams = structuredOutput;
          let stdoutLineBuffer = "";
          let mode: "undecided" | "json" | "legacy" = structuredOutput ? "undecided" : "legacy";
          let legacyProgressSequence = 0;

          // Consecutive thinking lines from the transcript parser are coalesced into
          // a single progress update so the UI shows one accumulating block rather
          // than a rapid series of individual entries. The sequence resets whenever
          // an assistant delta or tool activity event breaks the run of thinking lines.
          let activeTranscriptThinkingId: string | null = null;
          let activeTranscriptThinkingText = "";

          const resetTranscriptCoalescing = () => {
            activeTranscriptThinkingId = null;
            activeTranscriptThinkingText = "";
          };

          const emitLegacyProgress = (source: "stdout" | "stderr" | "transcript", text: string) => {
            if (isProcessTerminationNoise(text)) return;
            const displayText = text.length > 80 ? `${text.slice(0, 77)}...` : text;
            handlers.onProgress?.({
              id: `${source}-${++legacyProgressSequence}`,
              source,
              text: displayText,
            });
          };

          const transcriptParser = createCodexTranscriptStreamParser({
            onThinkingLine: (line) => {
              if (activeTranscriptThinkingId === null) {
                activeTranscriptThinkingId = `transcript-thinking-${++legacyProgressSequence}`;
                activeTranscriptThinkingText = line;
              } else {
                activeTranscriptThinkingText = `${activeTranscriptThinkingText}\n${line}`;
              }
              handlers.onProgress?.({
                id: activeTranscriptThinkingId,
                source: "transcript",
                text: activeTranscriptThinkingText,
              });
            },
            onAssistantDelta: (chunk) => {
              resetTranscriptCoalescing();
              handlers.onAssistantDelta?.(chunk);
            },
            onToolActivity: (activity) => {
              resetTranscriptCoalescing();
              handlers.onToolActivity?.(activity);
            },
          });
          const transcriptStdoutSanitizer = createStdoutSanitizer();
          const transcriptStderrSanitizer = createStdoutSanitizer();
          const stdoutTitleStripper = createTerminalTitleSequenceStripper({
            source: "src/core/providers/codexSubprocess.ts:codex.stdout",
            stream: "stdout",
            origin: "codex-cli",
          });
          const stderrTitleStripper = createTerminalTitleSequenceStripper({
            source: "src/core/providers/codexSubprocess.ts:codex.stderr",
            stream: "stderr",
            origin: "codex-cli",
          });
          const jsonParser = createCodexJsonStreamParser({
            onThreadStarted: (sessionId) =>
              handlers.onNativeSession?.({ source: "codex", sessionId }),
            onProgress: (update) => handlers.onProgress?.(update),
            onAssistantDelta: (chunk) => handlers.onAssistantDelta?.(chunk),
            onFinalAnswerObserved: emitFinalAnswerObserved,
            onToolActivity: (activity) => handlers.onToolActivity?.(activity),
          });

          const feedTranscript = (text: string, stream: "stdout" | "stderr") => {
            const sanitizer =
              stream === "stdout" ? transcriptStdoutSanitizer : transcriptStderrSanitizer;
            const clean = sanitizer.process(text);
            if (clean) {
              transcriptParser.feed(clean);
            }
          };

          const switchToTranscriptFallback = () => {
            if (mode === "legacy") return;
            mode = "legacy";
            if (rawStdout) {
              feedTranscript(rawStdout, "stdout");
            }
            if (rawStderr) {
              feedTranscript(rawStderr, "stderr");
            }
            stdoutLineBuffer = "";
          };

          const processStructuredLines = (flush: boolean) => {
            while (true) {
              const newlineIndex = stdoutLineBuffer.indexOf("\n");
              if (newlineIndex === -1) {
                if (!flush) return;
                if (!stdoutLineBuffer) return;
              }

              const line =
                newlineIndex === -1 ? stdoutLineBuffer : stdoutLineBuffer.slice(0, newlineIndex);
              stdoutLineBuffer =
                newlineIndex === -1 ? "" : stdoutLineBuffer.slice(newlineIndex + 1);
              const normalizedLine = line.replace(/\r$/, "");
              if (!normalizedLine.trim()) {
                continue;
              }

              const parsed = jsonParser.feedLine(normalizedLine);
              if (!parsed) {
                if (mode === "json") {
                  emitLegacyProgress("stdout", normalizedLine);
                  continue;
                }
                switchToTranscriptFallback();
                return;
              }
              if (mode !== "json") enterJsonMode();
            }
          };

          const enterJsonMode = () => {
            mode = "json";
            retainRawStreams = false;
            rawStdout = "";
            rawStderr = "";
            const bounded = createOutputBuffer({ maxChars: JSON_MODE_RAW_OUTPUT_CHARS });
            bounded.append(currentRawOutput.text());
            currentRawOutput = bounded;
          };

          const ingestStdoutText = (text: string) => {
            if (!text) return;
            currentRawOutput.append(text);
            if (retainRawStreams) rawStdout += text;

            if (mode === "legacy") {
              feedTranscript(text, "stdout");
              return;
            }

            stdoutLineBuffer += text;
            processStructuredLines(false);
          };

          const ingestStderrText = (text: string) => {
            if (!text) return;
            currentRawOutput.append(text);
            currentRawStderr.append(text);
            if (retainRawStreams) rawStderr += text;

            if (mode === "legacy") {
              feedTranscript(text, "stderr");
              return;
            }

            const lines = normalizeLineBreaks(stripNonPrintableControls(stripAnsi(text))).split(
              "\n",
            );
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || isStderrNoise(trimmed) || isProcessTerminationNoise(trimmed))
                continue;
              emitLegacyProgress("stderr", trimmed);
            }
          };

          handlers.onProcessLifecycle?.("before-spawn");
          proc = spawnCodexProcess(launchPlan.executable, launchPlan.args, {
            stdio: ["pipe", "pipe", "pipe"],
            detached: process.platform !== "win32",
          });
          control.track(
            new Promise<void>((resolve) => {
              proc!.once("close", resolve);
            }),
          );
          procExited = false;
          handlers.onProcessLifecycle?.("spawned");
          handlers.benchmarkHooks?.onCodexProcessSpawned?.({
            executable: launchPlan.executable,
            argv: launchPlan.args,
          });
          perf.mark("spawn_done");

          proc.stdout?.on("data", (chunk: Buffer) => {
            if (cancelled || done) return;
            if (!firstChunkSeen) {
              firstChunkSeen = true;
              perf.mark("first_chunk");
              handlers.benchmarkHooks?.onFirstStdout?.();
            }
            perf.mark("last_chunk");
            ingestStdoutText(stdoutTitleStripper.process(chunk));
          });

          proc.stderr?.on("data", (chunk: Buffer) => {
            if (cancelled || done) return;
            if (!firstStderrSeen) {
              firstStderrSeen = true;
              handlers.benchmarkHooks?.onFirstStderr?.();
            }
            ingestStderrText(stderrTitleStripper.process(chunk));
          });

          proc.on("close", (code) => {
            procExited = true;
            handlers.onProcessLifecycle?.("exit");
            if (cancelled || done) return;
            ingestStdoutText(stdoutTitleStripper.flush());
            ingestStderrText(stderrTitleStripper.flush());
            if (!firstChunkSeen) {
              handlers.benchmarkHooks?.onFirstStdout?.(false);
            }
            if (!firstStderrSeen) {
              handlers.benchmarkHooks?.onFirstStderr?.(false);
            }

            if (mode !== "legacy") {
              processStructuredLines(true);
            }

            if (mode === "legacy") {
              const remainingStdout = transcriptStdoutSanitizer.flush();
              if (remainingStdout) transcriptParser.feed(remainingStdout);
              const remainingStderr = transcriptStderrSanitizer.flush();
              if (remainingStderr) transcriptParser.feed(remainingStderr);
              transcriptParser.flush();
            }

            handlers.benchmarkHooks?.onCodexProcessExit?.(code);

            if (
              structuredOutput &&
              code !== 0 &&
              !jsonParser.hasStructuredEvents() &&
              looksLikeUnsupportedStructuredOutput(`${rawStdout}\n${rawStderr}`)
            ) {
              currentRawOutput = createOutputBuffer();
              currentRawStderr = createOutputBuffer({ maxChars: RAW_STDERR_CHARS });
              startAttempt(false, true);
              return;
            }

            const structuredFailure = jsonParser.getFailureMessage();
            if (structuredFailure) {
              finishError(structuredFailure);
              return;
            }

            if (code === 0) {
              const finalResponse =
                mode === "json"
                  ? jsonParser.getFinalResponse().trim() ||
                    sanitizeCodexTranscript(currentRawOutput.text())
                  : sanitizeCodexTranscript(currentRawOutput.text());
              emitFinalAnswerObserved(finalResponse);
              finishSuccess(finalResponse);
              return;
            }

            finishError(`Process exited with code ${code}`);
          });

          proc.on("error", (err) => {
            handlers.onProcessLifecycle?.("error");
            if (cancelled || done) return;
            const errno = err as NodeJS.ErrnoException;
            finishError(formatCodexLaunchError(errno));
          });

          const promptPolicy = options.promptPolicy ?? "wrapped";
          const history = options.conversationHistory?.length
            ? `Previous conversation:\n${formatConversationHistory(options.conversationHistory)}\n\n`
            : "";
          const baseProviderPrompt =
            promptPolicy === "raw"
              ? prompt
              : buildCodexPrompt(prompt, options.runtime, undefined, {
                  projectInstructions: options.projectInstructions,
                });
          const providerPrompt = history ? `${history}${baseProviderPrompt}` : baseProviderPrompt;
          handlers.benchmarkHooks?.onProviderPromptPrepared?.({
            policy: promptPolicy,
            characterCount: providerPrompt.length,
          });
          proc.stdin?.write(providerPrompt);
          proc.stdin?.end();
        })
        .catch((error) => {
          const errno = error as NodeJS.ErrnoException;
          finishError(formatCodexLaunchError(errno));
        });
    };

    startAttempt(true);

    return () => {
      cancelled = true;
      done = true;
      handlers.benchmarkHooks?.onCleanupStart?.();
      handlers.onProcessLifecycle?.("cleanup");
      if (!proc || procExited || proc.killed) {
        control.finish();
        handlers.benchmarkHooks?.onCleanupComplete?.({ skipped: true });
        return;
      }
      const stopping = proc;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && stopping.pid) process.kill(-stopping.pid, signal);
          else if (process.platform === "win32" && stopping.pid)
            spawn("taskkill", ["/pid", String(stopping.pid), "/T", "/F"], {
              stdio: "ignore",
              shell: false,
            }).on("error", () => stopping.kill(signal));
          else stopping.kill(signal);
        } catch {
          try {
            stopping.kill(signal);
          } catch {
            /* Already stopped. */
          }
        }
      };
      const shutdown = new Promise<void>((resolve) => {
        let closed = false;
        const groupAlive = () => {
          if (process.platform === "win32" || !stopping.pid) return false;
          try {
            process.kill(-stopping.pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        const escalation = setTimeout(() => {
          kill("SIGKILL");
          if (closed) resolve();
        }, 1500);
        stopping.once("close", () => {
          closed = true;
          if (!groupAlive()) {
            clearTimeout(escalation);
            resolve();
          }
        });
        kill("SIGTERM");
      });
      control.track(shutdown);
      control.finish();
      handlers.benchmarkHooks?.onCleanupComplete?.({ skipped: false });
    };
  },
};
