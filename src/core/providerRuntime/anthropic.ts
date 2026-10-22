/**
 * Anthropic execution through authenticated Claude Code or the direct API. Owns CLI event
 * adaptation and bounded compatibility retries; runControl tracks subprocess teardown separately
 * from response delivery.
 */

import type { Writable } from "node:stream";
import { formatConversationHistory } from "../../session/conversation.js";
import {
  buildClaudeSpawnSpec,
  resetClaudeExecutableCacheForTests,
} from "../executables/executableResolver.js";
import { providerCatalog } from "../models/modelCatalog.js";
import { type CommandResult, runCommand } from "../process/commandRunner.js";
import type { ProviderWorkspaceOverride } from "../providerLauncher/types.js";
import { createRunControl } from "../providers/runControl.js";
import type { BackendRunHandlers } from "../providers/types.js";
import { errorMessage } from "../shared/values.js";
import { sanitizeTerminalOutput } from "../terminal/terminalSanitize.js";
import { buildUsageScopeKey } from "../usage/normalize.js";
import {
  parseAnthropicRateLimitHeaders,
  recordObservedRateLimits,
} from "../usage/observedRateLimits.js";
import { anthropicApiBase, fetchAnthropicModels } from "./anthropicDiscovery.js";
import {
  type ClaudeCodeCapabilityDiscovery,
  claudeCodeModelsToProviderModels,
  discoverClaudeCodeCapabilities,
  findClaudeModel,
  modelSupportsClaudeEffort,
} from "./claudeCodeDiscovery.js";
import { createClaudeApprovalBridge, resolveClaudePermissionMode } from "./claudePermissions.js";
import { createClaudeStreamParser } from "./claudeStream.js";
import {
  apiRequestError,
  classifyProviderFailure,
  failureFromError,
  ProviderRequestError,
  retryAfterDelay,
} from "./failures.js";

export { createClaudeToolParser, tryParseStreamJsonDelta } from "./claudeStream.js";

import { createProviderExecution } from "./execution.js";
import { ANTHROPIC_FALLBACK_MODELS } from "./models.js";
import {
  completedNativeSession,
  isMissingNativeSession,
  nativeContinuation,
} from "./nativeContinuation.js";
import type {
  ProviderBackendKind,
  ProviderChatRequest,
  ProviderModel,
  ProviderModelDiscoveryResult,
  ProviderRouteValidationResult,
  ProviderRuntime,
} from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 1024;
/**
 * Default deadline for one direct Messages API request, covering connection, response
 * headers and the full body. Override with `providers.anthropic.apiTimeoutMs`. A request
 * that exceeds it fails as a network timeout and is never retried automatically, since a
 * retried POST could repeat a paid generation.
 */
export const ANTHROPIC_API_TIMEOUT_MS = 120_000;
const ANTHROPIC_ROUTE_VALIDATION_TIMEOUT_MS = 15_000;
const DISCOVERY_FAILURE_MESSAGE =
  "Claude Code model version discovery failed; using fallback aliases with unknown versions.";
export const ANTHROPIC_ROUTE_SETUP_MESSAGE =
  "Anthropic/Claude is not configured for in-Ubume routing.\nSign in with Claude Code or set ANTHROPIC_API_KEY.";
export { parseClaudeAuthStatus } from "./claudeCodeDiscovery.js";

type CommandRunner = typeof runCommand;

let claudeCodeValidated = false;
let anthropicApiValidated = false;
let resolvedClaudeExecutable: string = "claude";
let discoveredAnthropicModels: readonly ProviderModel[] | null = null;
let claudeCapabilityDiscovery: ClaudeCodeCapabilityDiscovery | null = null;

function getAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

function isAnthropicRouteConfigured(): boolean {
  return getAnthropicApiKey() !== null || claudeCodeValidated || anthropicApiValidated;
}

/**
 * Resets process-local Claude validation/discovery state for isolated tests.
 */
export function resetAnthropicRouteValidationCacheForTests(
  models: readonly ProviderModel[] | null = null,
): void {
  claudeCodeValidated = false;
  anthropicApiValidated = false;
  resolvedClaudeExecutable = "claude";
  discoveredAnthropicModels = models;
  claudeCapabilityDiscovery = null;
  resetClaudeExecutableCacheForTests();
}

// ---------------------------------------------------------------------------
// Model / reasoning / permission-mode mapping
// ---------------------------------------------------------------------------

// Claude Code CLI accepts both short aliases ("sonnet", "opus", "haiku") and
// full versioned IDs ("claude-sonnet-4-20250514"). Pass through unchanged.
/** Preserves the native Claude model identifier passed to the CLI. */
export function mapModelIdToClaudeArg(modelId: string): string {
  return modelId;
}

/** Normalizes a requested Claude effort value, returning null for an absent preference. */
export function mapReasoningToEffort(reasoning: string | null | undefined): string | null {
  return reasoning?.trim() || null;
}

/**
 * True when this run can answer Claude's permission prompts in Ubume: an interactive surface
 * exists and the CLI did not report lacking stream-json input / host prompts.
 */
export function claudeUsesHostApprovals(request: ProviderChatRequest): boolean {
  return (
    request.approvalSurface === "interactive" &&
    claudeCapabilityDiscovery?.diagnostics?.hostApprovalsSupported !== false
  );
}

/** Claude's native permission mode for this run, honoring the CLI's advertised choices. */
export function claudePermissionModeFor(request: ProviderChatRequest) {
  const modes = claudeCapabilityDiscovery?.diagnostics?.permissionModes;
  return resolveClaudePermissionMode(
    request.runtime.mode,
    request.runIntent,
    typeof modes === "string" ? modes.split(",") : null,
  );
}

function claudePromptText(request: ProviderChatRequest): string {
  return !nativeContinuation(request, "claude") && request.conversationHistory?.length
    ? `Previous conversation:\n${formatConversationHistory(request.conversationHistory)}\n\nCurrent request:\n${request.prompt}`
    : request.prompt;
}

/** The stream-json stdin message carrying the user prompt when host approvals are active. */
export function buildClaudeStdinPrompt(request: ProviderChatRequest): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: claudePromptText(request) },
  })}\n`;
}

function buildClaudeCodeBaseArgs(request: ProviderChatRequest, hostApprovals: boolean): string[] {
  const effort = mapReasoningToEffort(request.route.reasoning ?? null);
  const models = request.modelDescriptor ? [request.modelDescriptor] : getActiveAnthropicModels();
  const supportedEffort =
    effort && modelSupportsClaudeEffort(request.route.modelId, effort, models) ? effort : null;
  if (effort && !supportedEffort)
    throw new Error(
      `Claude model ${request.route.modelId} does not advertise effort "${effort}". Refresh Claude models and select a supported effort or provider-managed reasoning.`,
    );
  return [
    ...(nativeContinuation(request, "claude")
      ? ["--resume", nativeContinuation(request, "claude")!.sessionId]
      : []),
    ...(request.route.modelId ? ["--model", mapModelIdToClaudeArg(request.route.modelId)] : []),
    ...(supportedEffort ? ["--effort", supportedEffort] : []),
    "--permission-mode",
    claudePermissionModeFor(request).mode,
    // Host approvals route prompts to Ubume over stdin; without a surface, say so explicitly
    // so Claude denies (and tells the model) instead of waiting on nobody.
    ...(hostApprovals
      ? ["--permission-prompt-tool", "stdio"]
      : claudeCapabilityDiscovery?.diagnostics?.permissionPromptsSupported === true
        ? ["--permission-prompts", "none"]
        : []),
    ...(hostApprovals ? [] : [claudePromptText(request)]),
  ];
}

/** Returns args with verbose output enabled when stream-json requires it. */
export function ensureClaudeStreamJsonVerbose(args: string[]): string[] {
  const outputFormatIndex = args.indexOf("--output-format");
  const usesStreamJson = outputFormatIndex >= 0 && args[outputFormatIndex + 1] === "stream-json";
  const usesPrint = args.includes("-p") || args.includes("--print");
  if (!usesStreamJson || !usesPrint || args.includes("--verbose")) return args;

  const printIndex = args.findIndex((arg) => arg === "-p" || arg === "--print");
  const next = [...args];
  next.splice(printIndex + 1, 0, "--verbose");
  return next;
}

/**
 * Builds streaming Claude CLI argv from prompt/history, model, effort and runtime permissions.
 */
export function buildClaudeCodeArgs(request: ProviderChatRequest): string[] {
  const hostApprovals = claudeUsesHostApprovals(request);
  return ensureClaudeStreamJsonVerbose([
    "-p",
    ...(hostApprovals ? ["--input-format", "stream-json"] : []),
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    ...buildClaudeCodeBaseArgs(request, hostApprovals),
  ]);
}

/**
 * Builds the compatibility plain-text invocation using the same model and policy as streaming
 * execution.
 */
export function buildClaudeCodePlainTextArgs(request: ProviderChatRequest): string[] {
  return ["-p", ...buildClaudeCodeBaseArgs(request, false)];
}

// ---------------------------------------------------------------------------
// Stream-JSON parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

/** Effective direct-API deadline: a positive configured `apiTimeoutMs`, else the default. */
export function anthropicApiTimeoutMs(providerConfig?: ProviderWorkspaceOverride): number {
  const configured = providerConfig?.apiTimeoutMs;
  return typeof configured === "number" &&
    Number.isSafeInteger(configured) &&
    configured > 0 &&
    configured <= 2_147_483_647
    ? configured
    : ANTHROPIC_API_TIMEOUT_MS;
}

async function runAnthropicApi(
  request: ProviderChatRequest,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = request.providerConfig?.apiKey || getAnthropicApiKey();
  if (!apiKey) {
    throw new Error(ANTHROPIC_ROUTE_SETUP_MESSAGE);
  }

  const timeoutMs = anthropicApiTimeoutMs(request.providerConfig);
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    return await requestAnthropicMessage(request, apiKey, requestSignal);
  } catch (error) {
    // User cancellation propagates unchanged; the caller already ignores it.
    if (deadline.aborted && !signal?.aborted) {
      const seconds = Number((timeoutMs / 1000).toFixed(3));
      throw new ProviderRequestError(
        classifyProviderFailure(`Anthropic API request timed out after ${seconds}s.`),
      );
    }
    throw error;
  }
}

async function requestAnthropicMessage(
  request: ProviderChatRequest,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${anthropicApiBase(request.providerConfig)}/messages`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: request.route.modelId,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      ...(request.route.reasoning &&
      request.modelDescriptor?.reasoningControl?.kind === "levels" &&
      request.modelDescriptor.reasoningControl.levels.some(
        (level) => level.id === request.route.reasoning,
      )
        ? { output_config: { effort: request.route.reasoning } }
        : {}),
      ...(request.projectInstructions?.content
        ? { system: request.projectInstructions.content }
        : {}),
      messages: request.conversationHistory?.length
        ? [
            ...request.conversationHistory.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            { role: "user", content: request.prompt },
          ]
        : [{ role: "user", content: request.prompt }],
    }),
  });

  // Rate-limit headers arrive on success and on 429s; keep them for /usage.
  recordObservedRateLimits(
    buildUsageScopeKey(
      { providerId: "anthropic", backendKind: "anthropic-api-key" },
      request.providerConfig,
    ),
    parseAnthropicRateLimitHeaders(response.headers, Date.now()),
  );
  const body = await response.text();
  if (!response.ok) {
    throw apiRequestError(
      response.status,
      body,
      retryAfterDelay(response.headers.get("retry-after")),
    );
  }

  let parsed: { content?: Array<{ type?: string; text?: string }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `Anthropic API returned an invalid response body (HTTP ${response.status}, not JSON).`,
    );
  }
  const text = parsed.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Anthropic API returned no assistant text.");
  }

  return text;
}

// ---------------------------------------------------------------------------
// Claude Code CLI execution (streaming)
// ---------------------------------------------------------------------------

function isClaudeStreamJsonRequiresVerboseError(result: CommandResult): boolean {
  return result.status === "failed" && /stream-json requires --verbose/i.test(result.stderr);
}

function isClaudeInvalidEffortError(result: CommandResult): boolean {
  // Only explicit process validation errors are capability evidence. Never scan model/tool text.
  if (result.status !== "failed") return false;
  return /(?:invalid|unsupported|unknown) (?:value[^\n]*for[^\n]*)?(?:effort|[^\n]*--effort)|effort[^\n]{0,100}(?:not supported|unsupported|invalid|valid (?:values|efforts)|allowed (?:values|efforts))/i.test(
    result.stderr,
  );
}

function disableClaudeEffortForSession(
  modelId: string,
  effort: string,
  expected?: ProviderModel,
): void {
  const models = getActiveAnthropicModels();
  const target = findClaudeModel(modelId, models);
  const disable = (model: ProviderModel): ProviderModel => {
    if (model.modelId !== (expected?.modelId ?? target?.modelId) || !model.supportedReasoningLevels)
      return model;
    const levels = model.supportedReasoningLevels.filter((level) => level.id !== effort);
    const preferred = levels.some((level) => level.id === model.defaultReasoningLevel)
      ? model.defaultReasoningLevel
      : (levels[0]?.id ?? null);
    return {
      ...model,
      supportedReasoningLevels: levels,
      defaultReasoningLevel: preferred,
      ...(model.reasoningControl?.kind === "levels"
        ? { reasoningControl: { ...model.reasoningControl, levels, default: preferred ?? "" } }
        : {}),
      description: `${model.description ?? model.label} - ${effort} disabled after Claude Code rejection this session`,
    };
  };
  // A late rejection must not amend a replacement discovery descriptor.
  if (!expected || target === expected) discoveredAnthropicModels = models.map(disable);
  providerCatalog.amendModel("anthropic", expected?.modelId ?? modelId, disable, expected);
}

function formatClaudeCommandDiagnostic(executable: string, args: string[], prompt: string): string {
  const safeArgs = args.map((arg) =>
    prompt && arg === prompt ? `<prompt redacted: ${prompt.length} chars>` : arg,
  );
  return `Claude Code command args: ${JSON.stringify([executable, ...safeArgs])}`;
}

/**
 * Tells the user Claude's real permission mode before the run, so Ubume's mode label is never
 * mistaken for it, and warns up front when approvals cannot be answered in this run.
 */
function announceClaudePermissions(
  request: ProviderChatRequest,
  hostApprovals: boolean,
  handlers: BackendRunHandlers,
): void {
  const { mode, requested } = claudePermissionModeFor(request);
  const fallback =
    mode !== requested ? ` (this Claude Code CLI does not offer "${requested}")` : "";
  handlers.onProgress?.({
    id: "claude-permissions",
    source: hostApprovals ? "stdout" : "stderr",
    text: hostApprovals
      ? `Claude Code permissions: ${mode}${fallback}. Actions Claude asks about are approved in Ubume.`
      : `Claude Code permissions: ${mode}${fallback}. No approval prompt is available in this run, so actions that need approval will be denied.`,
  });
}

/**
 * Starts Claude with bounded compatibility retries. The returned cancel function stops the
 * active attempt; run control includes every attempt's teardown.
 */
export function runClaudeCodeWithRunner(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
  runCommandImpl: CommandRunner = runCommand,
  executable: string = request.claudeCommandPath ??
    process.env.CLAUDE_EXECUTABLE?.trim() ??
    resolvedClaudeExecutable,
): () => void {
  const control = createRunControl(handlers);
  const execution = createProviderExecution(request, handlers);
  let currentCancel: (() => void) | null = null;
  let canceled = false;
  let finished = false;
  const finish = () => {
    finished = true;
    execution.finish();
    control.finish();
  };

  let allowResume = true;
  const runAttempt = (mode: "stream-json" | "plain-text") => {
    if (canceled || finished) return;
    const attemptRequest = allowResume ? request : { ...request, nativeSessions: [] };
    const args =
      mode === "stream-json"
        ? buildClaudeCodeArgs(attemptRequest)
        : buildClaudeCodePlainTextArgs(attemptRequest);
    const spawnSpec = buildClaudeSpawnSpec(executable, args);
    const hostApprovals = mode === "stream-json" && claudeUsesHostApprovals(attemptRequest);
    const promptArg = hostApprovals ? "" : (args.at(-1) ?? "");
    announceClaudePermissions(attemptRequest, hostApprovals, handlers);
    let stdin: Writable | null | undefined;
    const writeStdin = (line: string): boolean => {
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
      stdin.write(line);
      return true;
    };
    const bridge = createClaudeApprovalBridge({
      workspaceRoot: request.workspaceRoot,
      onToolApproval: handlers.onToolApproval,
      write: writeStdin,
      onAwaitingUser: (waiting) => execution.awaitingUser(waiting),
    });
    // Streaming input keeps Claude alive for more turns; closing stdin after the terminal
    // result lets it exit normally.
    const endStdin = () => {
      if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end();
    };
    const parser = createClaudeStreamParser(execution.handlers, {
      approvals: hostApprovals ? "interactive" : "none",
      ...(hostApprovals ? { onControl: bridge.handle, onResult: endStdin } : {}),
    });
    let received = false;
    const runner = execution.run(
      {
        executable: spawnSpec.executable,
        args: spawnSpec.args,
        cwd: request.workspaceRoot,
        ...(request.route.reasoning
          ? { env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: request.route.reasoning } }
          : {}),
        ...(hostApprovals
          ? { stdinData: buildClaudeStdinPrompt(attemptRequest), keepStdinOpen: true }
          : {}),
      },
      {
        onStdout: (chunk) => {
          if (canceled || finished || mode !== "stream-json") return;
          received = true;
          parser.push(chunk);
          if (parser.error) queueMicrotask(() => currentCancel?.());
        },
      },
      runCommandImpl,
    );
    stdin = (runner as { child?: { stdin?: Writable | null } }).child?.stdin;
    currentCancel = () => {
      bridge.dispose();
      runner.cancel();
    };
    control.track(runner.stopped ?? runner.result.then(() => undefined));
    void runner.result
      .then(async (result) => {
        // The process is gone: withdraw any visible approval and never write to its stdin.
        bridge.dispose();
        if (canceled || finished) return;
        if (mode === "stream-json") {
          if (!received) parser.push(result.stdout);
          parser.flush();
        }
        if (parser.error && result.status !== "timeout") {
          finish();
          handlers.onError(parser.error, result.stderr, {
            kind: "protocol",
            message: parser.error,
            retryable: false,
          });
          return;
        }
        if (result.status === "canceled") {
          finish();
          return;
        }
        if (
          allowResume &&
          nativeContinuation(request, "claude") &&
          !parser.productive &&
          isMissingNativeSession(result, parser.failure)
        ) {
          allowResume = false;
          handlers.onProgress?.({
            id: "claude-session-recovery",
            source: "stderr",
            text: "Saved Claude session is unavailable; recovering this chat into a fresh session.",
          });
          await runner.stopped;
          if (!canceled) runAttempt(mode);
          return;
        }
        if (result.status !== "completed" || result.exitCode !== 0) {
          if (
            mode === "stream-json" &&
            parser.records === 0 &&
            isClaudeStreamJsonRequiresVerboseError(result)
          ) {
            handlers.onProgress?.({
              id: "claude-output-retry",
              source: "stderr",
              text: `${formatClaudeCommandDiagnostic(spawnSpec.executable, spawnSpec.args, promptArg)}\nClaude Code rejected stream-json args; retrying once with plain text output.`,
            });
            await runner.stopped;
            if (!canceled) runAttempt("plain-text");
            return;
          }
          const effort = mapReasoningToEffort(request.route.reasoning);
          const rejected = effort && isClaudeInvalidEffortError(result);
          if (rejected)
            disableClaudeEffortForSession(request.route.modelId, effort, request.modelDescriptor);
          const failure = execution.failure(result);
          const message = rejected
            ? `${result.userMessage || result.stderr}\nClaude Code rejected effort "${effort}". Refresh models and choose a supported effort; Ubume did not retry at a lower level.`
            : (failure?.message ?? result.userMessage);
          finish();
          handlers.onError(
            message,
            formatClaudeCommandDiagnostic(spawnSpec.executable, spawnSpec.args, promptArg),
            failure,
          );
          return;
        }
        if (parser.failure) {
          const message = parser.failure;
          finish();
          handlers.onError(message, result.stderr, classifyProviderFailure(message));
          return;
        }
        const text =
          mode === "stream-json"
            ? parser.finalText()
            : sanitizeTerminalOutput(result.stdout).trim();
        if (mode === "plain-text") handlers.onAssistantDelta?.(text);
        if (parser.sessionId)
          handlers.onNativeSession?.(
            completedNativeSession(request, "claude", parser.sessionId, text),
          );
        finish();
        handlers.onFinalAnswerObserved?.(text);
        handlers.onResponse(text);
      })
      .catch((error) => {
        if (finished || canceled) return;
        finish();
        const message = errorMessage(error, "Claude Code execution failed.");
        handlers.onError(message, undefined, failureFromError(error, message));
      });
  };
  try {
    runAttempt("stream-json");
  } catch (error) {
    finish();
    handlers.onError(errorMessage(error));
  }
  return () => {
    if (finished || canceled) return;
    canceled = true;
    currentCancel?.();
    finish();
  };
}

function runClaudeCode(request: ProviderChatRequest, handlers: BackendRunHandlers): () => void {
  return runClaudeCodeWithRunner(request, handlers);
}

// ---------------------------------------------------------------------------
// Route validation
// ---------------------------------------------------------------------------

/**
 * Probes native Claude authentication/discovery and updates process-local route facts; API-key
 * configuration can provide a ready fallback.
 */
export async function validateAnthropicRoute(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runCommandImpl?: CommandRunner;
  timeoutMs?: number;
  configuredPath?: string | null;
}): Promise<ProviderRouteValidationResult> {
  let discovery: ClaudeCodeCapabilityDiscovery;
  try {
    discovery = await discoverClaudeCodeCapabilities({
      cwd: options.cwd,
      runCommandImpl: options.runCommandImpl,
      configuredPath: options.configuredPath,
      timeoutMs: options.timeoutMs ?? ANTHROPIC_ROUTE_VALIDATION_TIMEOUT_MS,
    });
  } catch (error) {
    const message = errorMessage(error, "Failed to resolve Claude executable.");
    return {
      status: "not-configured",
      providerId: "anthropic",
      backendKind: "unavailable",
      message,
      diagnostics: { resolvedCommand: null },
    };
  }

  resolvedClaudeExecutable = discovery.resolvedCommand;
  claudeCapabilityDiscovery = discovery;
  discoveredAnthropicModels = claudeCodeModelsToProviderModels(discovery.models);

  const diagnostics: Record<string, string | number | boolean | null> = {
    resolvedCommand: discovery.resolvedCommand,
    executablePath: discovery.resolvedCommand,
    authCommand: `${discovery.resolvedCommand} auth status`,
    modelSource: discovery.modelSource,
    discoveredAt: discovery.discoveredAt,
    loggedIn: discovery.auth.loggedIn,
    authMethod: discovery.auth.authMethod ?? null,
    apiProvider: discovery.auth.apiProvider ?? null,
    subscriptionType: discovery.auth.subscriptionType ?? null,
    settingsPath: discovery.settings?.path ?? null,
    settingsModel: discovery.settings?.model ?? null,
    settingsEffortLevel: discovery.settings?.effortLevel ?? null,
    ...(discovery.diagnostics ?? {}),
  };

  if (discovery.auth.loggedIn === true) {
    claudeCodeValidated = true;
    const authMethodLabel = discovery.auth.authMethod ?? null;
    return {
      status: "ready",
      providerId: "anthropic",
      backendKind: "claude-code-auth",
      message: authMethodLabel
        ? `Claude Code authenticated (${authMethodLabel}).`
        : "Claude Code auth is configured.",
      diagnostics,
    };
  }

  claudeCodeValidated = false;

  if (getAnthropicApiKey() !== null) {
    return {
      status: "ready",
      providerId: "anthropic",
      backendKind: "anthropic-api-key",
      message: "Anthropic API key is configured.",
      diagnostics,
    };
  }

  const authStatus = String(diagnostics["authStatus"] ?? "");
  const authExitCode = diagnostics["authExitCode"];
  const authJsonParsed = diagnostics["authJsonParsed"] === true;
  let message: string;
  if (authStatus === "spawn_error") {
    message = `\`${discovery.resolvedCommand}\` command not found. Install Claude Code from https://claude.ai/code or set CLAUDE_EXECUTABLE to the full path.`;
  } else if (authStatus === "timeout") {
    message = `Claude Code auth check timed out. Run: ${discovery.resolvedCommand} auth status`;
  } else if (authExitCode === 1) {
    message = `Claude Code is installed but not signed in. Run: ${discovery.resolvedCommand} auth login`;
  } else if (!authJsonParsed) {
    message = `Claude Code auth status did not return valid JSON. Run: ${discovery.resolvedCommand} auth status`;
  } else {
    message = `Claude Code is not signed in. Run: ${discovery.resolvedCommand} auth login`;
  }

  return {
    status: "not-configured",
    providerId: "anthropic",
    backendKind: "unavailable",
    message,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** The backend `run()` will actually use for this route, mirroring its branch order. */
export function resolveAnthropicExecutionBackend(
  route: { backendKind: ProviderBackendKind },
  providerConfig?: ProviderWorkspaceOverride,
): "claude-code-auth" | "anthropic-api-key" {
  if (claudeCodeValidated && route.backendKind !== "anthropic-api-key" && !providerConfig?.apiKey) {
    return "claude-code-auth";
  }
  if (providerConfig?.apiKey || getAnthropicApiKey()) return "anthropic-api-key";
  return "claude-code-auth";
}

function getAnthropicRuntimeBackendKind(): ProviderBackendKind {
  return claudeCodeValidated
    ? "claude-code-auth"
    : getAnthropicApiKey()
      ? "anthropic-api-key"
      : "claude-code-auth";
}

function getActiveAnthropicModels(): readonly ProviderModel[] {
  return discoveredAnthropicModels ?? ANTHROPIC_FALLBACK_MODELS;
}

export const anthropicRuntime: ProviderRuntime = {
  providerId: "anthropic",
  label: "Anthropic/Claude",
  modelPickerLabel: "Claude",
  backendKind: "claude-code-auth",
  routeAvailable: true,
  routeStatus:
    "Routes through Claude Code CLI when authenticated (`claude auth status` exit 0), or via ANTHROPIC_API_KEY.",
  routeSetupMessage: ANTHROPIC_ROUTE_SETUP_MESSAGE,
  launchAvailable: true,
  isRouteConfigured: isAnthropicRouteConfigured,
  validateRoute: async ({ workspaceRoot, claudeCommandPath, providerConfig, route, signal }) => {
    if (providerConfig?.apiKey || route.backendKind === "anthropic-api-key") {
      const discovery = await fetchAnthropicModels({ providerConfig, signal });
      anthropicApiValidated = discovery.freshness === "verified";
      if (anthropicApiValidated) discoveredAnthropicModels = discovery.models;
      const modelUnavailable =
        anthropicApiValidated && !discovery.models.some((model) => model.modelId === route.modelId);
      return {
        ...(modelUnavailable
          ? {
              failure: {
                kind: "model-unavailable" as const,
                message: `Model ${route.modelId} is unavailable.`,
                retryable: false,
              },
            }
          : {}),
        status:
          anthropicApiValidated && discovery.models.some((model) => model.modelId === route.modelId)
            ? "ready"
            : "not-configured",
        providerId: "anthropic",
        backendKind: "anthropic-api-key",
        message:
          discovery.message ??
          (anthropicApiValidated
            ? modelUnavailable
              ? `Model ${route.modelId} is unavailable.`
              : "Claude API model inventory verified."
            : ANTHROPIC_ROUTE_SETUP_MESSAGE),
      };
    }
    return validateAnthropicRoute({ cwd: workspaceRoot, configuredPath: claudeCommandPath });
  },
  discoverModels: (): ProviderModelDiscoveryResult => ({
    status: "ready",
    providerId: "anthropic",
    backendKind: getAnthropicRuntimeBackendKind(),
    models: getActiveAnthropicModels(),
    message:
      (claudeCapabilityDiscovery?.modelSource ?? "fallback") === "fallback"
        ? DISCOVERY_FAILURE_MESSAGE
        : undefined,
    diagnostics: claudeCapabilityDiscovery
      ? {
          resolvedCommand: claudeCapabilityDiscovery.resolvedCommand,
          modelSource: claudeCapabilityDiscovery.modelSource,
          discoveredAt: claudeCapabilityDiscovery.discoveredAt,
          loggedIn: claudeCapabilityDiscovery.auth.loggedIn,
          settingsPath: claudeCapabilityDiscovery.settings?.path ?? null,
        }
      : { modelSource: "fallback" },
  }),
  refreshModels: async ({ cwd, providerConfig, signal }): Promise<ProviderModelDiscoveryResult> => {
    if (
      providerConfig?.apiKey ||
      (getAnthropicApiKey() && !providerConfig?.claudeCommandPath && !claudeCodeValidated)
    ) {
      const result = await fetchAnthropicModels({ providerConfig, signal });
      if (!signal?.aborted) {
        anthropicApiValidated = result.freshness === "verified";
        if (anthropicApiValidated) discoveredAnthropicModels = result.models;
      }
      return result;
    }
    let discovery: ClaudeCodeCapabilityDiscovery;
    try {
      discovery = await discoverClaudeCodeCapabilities({
        cwd,
        configuredPath: providerConfig?.claudeCommandPath,
        runCommandImpl: (spec, handlers) => runCommand({ ...spec, signal }, handlers),
      });
    } catch (error) {
      const message = errorMessage(error, "Claude capability refresh failed.");
      return {
        status: "ready",
        providerId: "anthropic",
        backendKind: getAnthropicRuntimeBackendKind(),
        models: getActiveAnthropicModels(),
        message: `Refresh Claude capabilities failed; keeping previous Claude capability data. ${message}`,
        diagnostics: {
          resolvedCommand: resolvedClaudeExecutable,
          modelSource: claudeCapabilityDiscovery?.modelSource ?? "fallback",
          refreshFailed: true,
        },
      };
    }
    if (signal?.aborted)
      return {
        status: "not-configured",
        providerId: "anthropic",
        backendKind: getAnthropicRuntimeBackendKind(),
        models: [],
        freshness: "unverified",
        message: "Claude model discovery canceled.",
      };
    resolvedClaudeExecutable = discovery.resolvedCommand;
    claudeCapabilityDiscovery = discovery;
    claudeCodeValidated = discovery.auth.loggedIn;
    discoveredAnthropicModels = claudeCodeModelsToProviderModels(discovery.models);
    return {
      status: "ready",
      providerId: "anthropic",
      backendKind: getAnthropicRuntimeBackendKind(),
      models: discoveredAnthropicModels,
      freshness: discovery.modelSource === "fallback" ? "unverified" : "verified",
      complete: false,
      refreshState: discovery.modelSource === "fallback" ? "failed" : "refreshed",
      message:
        discovery.modelSource === "fallback"
          ? DISCOVERY_FAILURE_MESSAGE
          : `Refreshed Claude capabilities (${discovery.modelSource}).`,
      diagnostics: {
        resolvedCommand: discovery.resolvedCommand,
        modelSource: discovery.modelSource,
        discoveredAt: discovery.discoveredAt,
        loggedIn: discovery.auth.loggedIn,
      },
    };
  },
  run: (request, handlers: BackendRunHandlers) => {
    handlers.onProgress?.({
      id: "anthropic-route",
      source: "stdout",
      text: "Starting Claude Code",
    });

    if (
      claudeCodeValidated &&
      request.route.backendKind !== "anthropic-api-key" &&
      !request.providerConfig?.apiKey
    ) {
      return runClaudeCode(request, handlers);
    }

    if (request.providerConfig?.apiKey || getAnthropicApiKey()) {
      let cancelled = false;
      const controller = new AbortController();
      const control = createRunControl(handlers);
      const work = runAnthropicApi(request, controller.signal)
        .then((text) => {
          if (cancelled) return;
          handlers.onAssistantDelta?.(text);
          handlers.onFinalAnswerObserved?.(text);
          handlers.onResponse(text);
        })
        .catch((error) => {
          if (cancelled) return;
          const message = errorMessage(error, "Anthropic/Claude in-Ubume routing failed.");
          handlers.onError(message, undefined, failureFromError(error, message));
        });
      control.track(work);
      void work.finally(() => control.finish());
      return () => {
        cancelled = true;
        controller.abort();
        control.finish();
      };
    }

    return runClaudeCode(request, handlers);
  },
};
