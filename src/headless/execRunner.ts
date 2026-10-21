/**
 * Runs one provider turn without Ink and maps it onto stdout, stderr and an exit code.
 *
 * This is the lowest headless layer. It knows nothing about sessions or the JSON
 * envelope: `savedExec.ts` wraps it with persistence, and `commands.ts` with output
 * formatting. It never prompts. Tool-approval requests are denied unless the caller's
 * `handlers.onToolApproval` approves them, so a run can never block waiting for a human.
 *
 * Lifecycle guarantees:
 * - The result settles exactly once: on the final response, an error, an approval
 *   denial, or an abort. Provider callbacks that arrive after that are ignored, so
 *   nothing is written to stdout after the result is decided.
 * - The provider's cancel function runs at most once, and `runHeadlessExec` only
 *   returns after the provider reports its subprocess stopped (`ProviderRunControl.stopped`),
 *   so no child process outlives the call.
 * - The abort listener is always removed before returning.
 */
import type { LaunchArgs } from "../config/launchArgs.js";
import { type LayeredConfigResult, resolveLayeredConfig } from "../config/layeredConfig.js";
import {
  mergeRuntimeConfig,
  type ResolvedRuntimeConfig,
  resolveRuntimeConfig,
} from "../config/runtimeConfig.js";
import { isNoiseLine } from "../core/providers/codexTranscript.js";
import { getBackendProvider } from "../core/providers/registry.js";
import type {
  BackendProvider,
  BackendRunHandlers,
  ProviderRunControl,
} from "../core/providers/types.js";
import { errorMessage } from "../core/shared/values.js";
import type { ConversationRecord } from "../core/workspace/conversationStore.js";
import {
  loadProjectInstructions,
  type ProjectInstructionsLoadResult,
} from "../core/workspace/projectInstructions.js";
import { resolveWorkspaceRoot } from "../core/workspace/workspaceRoot.js";
import { toProviderConversationHistory } from "../session/conversation.js";
import { EXIT_CODE } from "./commandResult.js";
import { type HeadlessExecutionContext, resolveExecutionContext } from "./context.js";
import {
  formatDiagnosticText,
  formatRuntimeStartup,
  formatToolActivity,
  isProcessTerminationNoise,
  sanitizeAssistantText,
  shouldSuppressAssistantChunk,
  writeDiagnostic,
} from "./execOutput.js";
import type { HeadlessExecTiming } from "./execTiming.js";

// Compatibility re-exports: timing moved to execTiming.ts.
export { createHeadlessExecTiming, type HeadlessExecTiming } from "./execTiming.js";

// ─── Types & constants ────────────────────────────────────────────────────────

/** Exit code when the provider cannot run, or a tool approval was denied. */
export const HEADLESS_EXEC_PROVIDER_UNAVAILABLE = EXIT_CODE.UNAVAILABLE;
/** Exit code when the provider reported an error or threw while starting. */
export const HEADLESS_EXEC_RUN_FAILED = EXIT_CODE.FAILED;

const APPROVAL_DENIED_MESSAGE =
  "This tool requires interactive approval. Use the TUI or configure an explicit approval policy.";

/** The two output channels. Only `write` is used, so tests can pass plain objects. */
export interface HeadlessExecIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface HeadlessExecOptions {
  /** The exact prompt to send (attachments already expanded by the caller). */
  prompt: string;
  launchArgs: LaunchArgs;
  /** Defaults to the detected workspace root. */
  workspaceRoot?: string;
  /** Phase timing sink, which also enables the provider's benchmark hooks. */
  benchmarkDiagnostics?: HeadlessExecTiming;
  /** `raw` sends the prompt verbatim; `wrapped` adds project instructions. Default `raw`. */
  promptPolicy?: "raw" | "wrapped";
  providerId?: string;
  /** Conversation being continued; its messages become provider history. */
  saved?: ConversationRecord;
  /** Aborting settles the run with exit code 130 and cancels the provider. */
  signal?: AbortSignal;
  /**
   * Observers for the sanitised stream (used by savedExec for persistence). They see
   * the same filtered text that is written to stdout. `onToolApproval` decides
   * approvals; when it is absent, every approval is denied.
   */
  handlers?: Partial<BackendRunHandlers>;
  /** A context the caller already resolved; skips `resolveExecutionContext`. */
  context?: HeadlessExecutionContext;
}

export interface HeadlessExecResult {
  exitCode: number;
  /** The final response if one arrived, else whatever was streamed before settling. */
  text?: string;
  error?: string;
}

/** Injection seam for tests; production code always uses the defaults. */
interface HeadlessExecDependencies {
  resolveWorkspaceRoot: () => string;
  resolveLayeredConfig: (options: {
    workspaceRoot: string;
    launchArgs: LaunchArgs;
  }) => LayeredConfigResult;
  resolveRuntimeConfig: typeof resolveRuntimeConfig;
  getBackendProvider: (id: string) => BackendProvider;
  loadProjectInstructions: (workspaceRoot: string) => ProjectInstructionsLoadResult;
}

const DEFAULT_DEPENDENCIES: HeadlessExecDependencies = {
  resolveWorkspaceRoot,
  resolveLayeredConfig,
  resolveRuntimeConfig,
  getBackendProvider,
  loadProjectInstructions,
};

// ─── Preparation ──────────────────────────────────────────────────────────────

interface RunInputs {
  workspaceRoot: string;
  context: HeadlessExecutionContext | undefined;
  layeredConfig: LayeredConfigResult;
  runtime: ResolvedRuntimeConfig;
  promptPolicy: "raw" | "wrapped";
  projectInstructionsLoad: ProjectInstructionsLoadResult;
  provider: BackendProvider;
}

/**
 * Resolves the workspace, config, runtime, project instructions and provider, marking
 * a timing phase after each step.
 *
 * When a test injects `getBackendProvider`, the full context (which reads real config
 * and checks executables) is skipped and the injected pieces are used instead.
 *
 * @throws {CommandError} from `resolveExecutionContext` when the route cannot execute.
 */
function resolveRunInputs(
  options: HeadlessExecOptions,
  dependencies: Partial<HeadlessExecDependencies>,
): RunInputs {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const timing = options.benchmarkDiagnostics;
  const promptPolicy = options.promptPolicy ?? "raw";

  timing?.mark("run_headless_start");
  const workspaceRoot = options.workspaceRoot ?? deps.resolveWorkspaceRoot();
  timing?.mark("workspace_resolved", { workspace_root: workspaceRoot });

  const context =
    options.context ??
    (dependencies.getBackendProvider
      ? undefined
      : resolveExecutionContext(workspaceRoot, options.launchArgs, {
          providerId: options.providerId,
          saved: options.saved,
        }));
  const layeredConfig =
    context?.layered ??
    deps.resolveLayeredConfig({ workspaceRoot, launchArgs: options.launchArgs });
  timing?.mark("layered_config_loaded");

  // Headless runs cannot stop for plan review, so plan mode is forced off.
  const runtime =
    context?.runtime ??
    deps.resolveRuntimeConfig(mergeRuntimeConfig(layeredConfig.runtime, { planMode: false }));
  timing?.mark("runtime_config_resolved", {
    effective_model: runtime.model,
    effective_reasoning_effort: runtime.reasoningLevel,
    prompt_policy: promptPolicy,
  });

  // Raw policy sends the prompt byte-for-byte, so instructions are not even read.
  const projectInstructionsLoad: ProjectInstructionsLoadResult =
    promptPolicy === "wrapped"
      ? deps.loadProjectInstructions(workspaceRoot)
      : { status: "missing" };
  const projectInstructions =
    projectInstructionsLoad.status === "loaded" ? projectInstructionsLoad.instructions : null;
  timing?.mark("project_instructions_resolved", {
    whether_project_instructions_loaded: projectInstructionsLoad.status === "loaded",
    project_instructions_path:
      projectInstructions?.path ??
      ("path" in projectInstructionsLoad ? projectInstructionsLoad.path : null),
    project_instructions_character_count: projectInstructions?.content.length ?? 0,
  });

  const provider = context?.provider ?? deps.getBackendProvider(runtime.provider);
  timing?.mark("provider_created", { provider_id: provider.id, provider_label: provider.label });

  return {
    workspaceRoot,
    context,
    layeredConfig,
    runtime,
    promptPolicy,
    projectInstructionsLoad,
    provider,
  };
}

/** Writes the startup line plus any config or instruction-loading warnings to stderr. */
function reportStartup(stderr: HeadlessExecIo["stderr"], inputs: RunInputs): void {
  const { runtime, workspaceRoot, provider, context, layeredConfig, projectInstructionsLoad } =
    inputs;
  writeDiagnostic(
    stderr,
    "startup",
    formatRuntimeStartup(runtime, workspaceRoot, provider, context?.route.backendKind),
  );
  if (layeredConfig.diagnostics.ignoredEntries.length > 0) {
    writeDiagnostic(
      stderr,
      "config",
      `ignored ${layeredConfig.diagnostics.ignoredEntries.join("; ")}`,
    );
  }
  if (projectInstructionsLoad.status === "error") {
    writeDiagnostic(
      stderr,
      "config",
      `could not load project instructions at ${projectInstructionsLoad.path}: ${projectInstructionsLoad.message}`,
    );
  }
}

// ─── Streaming ────────────────────────────────────────────────────────────────

/** Mutable state shared by one run's provider callbacks. */
interface RunState {
  settled: boolean;
  streamedText: string;
  finalText: string;
  /** Resolves the run result; calls after the first are ignored. */
  settle: (exitCode: number, error?: string) => void;
  /** Cancels the provider (at most once; a no-op before `run` has returned). */
  cancel: () => void;
  onRunControl: (control: ProviderRunControl) => void;
}

/** Forwards the provider's benchmark hooks to the timing sink. Only attached when timing is on. */
function createBenchmarkHooks(
  timing: HeadlessExecTiming,
  prompt: string,
): BackendRunHandlers["benchmarkHooks"] {
  return {
    onProviderPrepStart: () => timing.mark("provider_prep_start"),
    onProviderPrepComplete: () => timing.mark("provider_prep_complete"),
    onProviderPromptPrepared: ({ policy, characterCount }) =>
      timing.mark("provider_prompt_prepared", {
        prompt_policy: policy,
        prompt_character_count_before_wrapping: prompt.length,
        prompt_character_count_after_wrapping: characterCount,
      }),
    onCodexProcessSpawned: ({ executable, argv }) =>
      timing.mark("codex_process_spawned", { codex_argv_preview: [executable, ...argv].join(" ") }),
    onFirstStdout: (observed = true) => timing.mark("first_stdout", { observed }),
    onFirstStderr: (observed = true) => timing.mark("first_stderr", { observed }),
    onCodexProcessExit: (exitCode) => timing.mark("codex_process_exit", { exit_code: exitCode }),
    onCleanupStart: () => timing.mark("cleanup_start"),
    onCleanupComplete: ({ skipped }) => timing.mark("cleanup_complete", { skipped }),
  };
}

/**
 * Builds the provider callbacks: assistant text goes to stdout, while progress, tool
 * activity and errors go to stderr. Each callback is forwarded to the matching caller
 * observer.
 */
function createProviderHandlers(
  state: RunState,
  options: HeadlessExecOptions,
  io: HeadlessExecIo,
): BackendRunHandlers {
  const observers = options.handlers;
  const timing = options.benchmarkDiagnostics;
  // Tool rows are reported through onToolActivity; skip progress updates that echo them.
  const toolActivityIds = new Set<string>();

  return {
    onRunControl: (control) => {
      state.onRunControl(control);
      observers?.onRunControl?.(control);
    },
    onToolApproval: async (request) => {
      const decision = (await observers?.onToolApproval?.(request)) ?? "deny";
      if (decision === "deny") {
        writeDiagnostic(io.stderr, "approval", APPROVAL_DENIED_MESSAGE);
        // Settle before cancelling, so that the provider's teardown callbacks see a
        // settled run and are ignored.
        state.settle(EXIT_CODE.UNAVAILABLE, APPROVAL_DENIED_MESSAGE);
        state.cancel();
      }
      return decision;
    },
    onLocalContextCheckpoint: observers?.onLocalContextCheckpoint,
    onLocalHarnessSession: observers?.onLocalHarnessSession,
    onNativeSession: observers?.onNativeSession,
    onAssistantDelta: (chunk) => {
      const safeChunk = sanitizeAssistantText(chunk);
      if (shouldSuppressAssistantChunk(safeChunk) || !safeChunk || state.settled) return;
      state.streamedText += safeChunk;
      observers?.onAssistantDelta?.(safeChunk);
      io.stdout.write(safeChunk);
    },
    onProgress: (update) => {
      if (state.settled) return;
      observers?.onProgress?.(update);
      const safeText = formatDiagnosticText(update.text);
      if (!safeText || isNoiseLine(safeText) || isProcessTerminationNoise(safeText)) return;
      if (update.source === "tool" && toolActivityIds.has(update.id)) return;
      writeDiagnostic(io.stderr, update.source, safeText);
    },
    onToolActivity: (activity) => {
      if (state.settled) return;
      observers?.onToolActivity?.(activity);
      toolActivityIds.add(activity.id);
      writeDiagnostic(io.stderr, "tool", formatToolActivity(activity));
    },
    onFinalAnswerObserved: (response) => {
      timing?.mark("final_answer_observed", { final_answer_character_count: response.length });
    },
    onResponse: (response) => {
      if (state.settled) return;
      const safeResponse = sanitizeAssistantText(response);
      state.finalText = safeResponse;
      // Keep stdout a faithful copy of the answer: print only the unstreamed suffix
      // when the final text extends the stream. If the provider rewrote the answer,
      // print the final text on a new line after the draft.
      if (safeResponse.startsWith(state.streamedText)) {
        io.stdout.write(safeResponse.slice(state.streamedText.length));
      } else if (safeResponse && safeResponse !== state.streamedText) {
        io.stdout.write(`${state.streamedText ? "\n" : ""}${safeResponse}`);
      }
      observers?.onResponse?.(safeResponse);
      state.settle(EXIT_CODE.OK);
    },
    onError: (message, rawOutput) => {
      const details =
        [message, rawOutput].filter((value) => value?.trim()).join("\n") || "Provider run failed.";
      writeDiagnostic(io.stderr, "error", details);
      state.settle(EXIT_CODE.FAILED, details);
    },
    onExecutionDiagnostic: (event) => {
      timing?.mark(`provider_${event.phase}`, {
        provider_id: event.providerId,
        run_id: event.runId,
        provider_elapsed_ms: event.elapsedMs,
      });
      observers?.onExecutionDiagnostic?.(event);
    },
    benchmarkHooks: timing?.enabled ? createBenchmarkHooks(timing, options.prompt) : undefined,
  };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Executes one non-interactive provider turn.
 *
 * Streams sanitised assistant text to `io.stdout` and `[ubume exec]` diagnostics to
 * `io.stderr`. It never writes the trailing newline or the JSON envelope; the command
 * layer owns those.
 *
 * Exit codes: 0 when the provider responds; 1 on a provider error or a failed start;
 * 3 when the provider cannot run or an approval is denied; 130 on abort.
 *
 * @param options - Prompt, route inputs, cancellation signal and stream observers.
 * @param io - Output channels; defaults to the process streams.
 * @param dependencies - Test seams; see {@link resolveRunInputs}.
 * @returns The exit code, the answer text (final, or partial if interrupted) and any error.
 *   Provider failures are reported in the result, not thrown.
 * @throws {CommandError} only while the route is resolved, before the provider starts.
 */
export async function runHeadlessExec(
  options: HeadlessExecOptions,
  io: HeadlessExecIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: Partial<HeadlessExecDependencies> = {},
): Promise<HeadlessExecResult> {
  const inputs = resolveRunInputs(options, dependencies);
  const { provider, runtime, workspaceRoot, promptPolicy, context } = inputs;
  reportStartup(io.stderr, inputs);

  if (!provider.run) {
    writeDiagnostic(io.stderr, "error", `${provider.label} is unavailable for headless execution.`);
    return { exitCode: HEADLESS_EXEC_PROVIDER_UNAVAILABLE };
  }
  const startRun = provider.run.bind(provider);
  const projectInstructions =
    inputs.projectInstructionsLoad.status === "loaded"
      ? inputs.projectInstructionsLoad.instructions
      : null;

  let control: ProviderRunControl | undefined;
  let cancelProvider: (() => void) | undefined;
  let interrupt: () => void = () => undefined;

  const result = await new Promise<HeadlessExecResult>((resolve) => {
    const state: RunState = {
      settled: false,
      streamedText: "",
      finalText: "",
      settle: (exitCode, error) => {
        if (state.settled) return;
        state.settled = true;
        resolve({
          exitCode,
          text: state.finalText || state.streamedText,
          ...(error ? { error } : {}),
        });
      },
      cancel: () => cancelProvider?.(),
      onRunControl: (value) => {
        control = value;
      },
    };

    // Cancel first, so the provider starts tearing down, then settle, so that any
    // output the provider emits while stopping is ignored.
    interrupt = () => {
      if (state.settled) return;
      state.cancel();
      state.settle(EXIT_CODE.INTERRUPTED, "Run interrupted.");
    };
    options.signal?.addEventListener("abort", interrupt, { once: true });
    if (options.signal?.aborted) {
      interrupt();
      return;
    }

    try {
      const cancel = startRun(
        options.prompt,
        {
          runtime,
          workspaceRoot,
          projectInstructions,
          promptPolicy,
          conversationHistory: options.saved
            ? toProviderConversationHistory(options.saved.messages, {
                // Local and Mistral replay their own tool context; summaries would duplicate it.
                includeActivitySummaries:
                  context?.route.providerId !== "local" && context?.route.providerId !== "mistral",
              })
            : undefined,
          localContextCheckpoint: options.saved?.metadata.localContextCheckpoint,
        },
        createProviderHandlers(state, options, io),
      );
      let canceled = false;
      cancelProvider = () => {
        if (canceled) return;
        canceled = true;
        cancel();
      };
      // The signal may have fired while `run` was starting, before a cancel function existed.
      if (options.signal?.aborted) cancelProvider();
    } catch (error) {
      writeDiagnostic(io.stderr, "error", errorMessage(error));
      state.settle(EXIT_CODE.FAILED, errorMessage(error));
    }
  });

  try {
    // Always invoke the provider's cancel, even after a normal response, so that its
    // subprocess teardown runs on every path. `stopped` resolves once that is complete.
    cancelProvider?.();
    if (control) await control.stopped;
    return result;
  } finally {
    options.signal?.removeEventListener("abort", interrupt);
  }
}
