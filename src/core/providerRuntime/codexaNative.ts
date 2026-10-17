import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getHomeDir } from "../../config/settings.js";
import { formatConversationHistory } from "../../session/conversation.js";
import { createRunControl } from "../providers/runControl.js";
import type { BackendRunHandlers } from "../providers/types.js";
import { errorMessage } from "../shared/values.js";
import { isLocalDevChannel } from "../version/channel.js";
import { resolveUbumeDataDir } from "../workspace/appData.js";
import {
  CODEXA_MODELS,
  CODEXA_TOKENIZER_SHA256,
  type CodexaNativeConfig,
  type CodexaNativeOptions,
  resolveCodexaNativeConfig,
  validateCodexaGeneration,
  validateCodexaOptions,
} from "./codexaNativeConfig.js";
import type {
  ProviderChatRequest,
  ProviderModelDiscoveryResult,
  ProviderRouteValidationResult,
  ProviderRuntime,
} from "./types.js";

export {
  DEFAULT_CODEXA_NATIVE_MODEL_ROOT,
  resolveCodexaNativeConfig,
} from "./codexaNativeConfig.js";
export const CODEXA_NATIVE_MODEL_ID = ""; // No implicit initializer selection.
export const CODEXA_PROTOCOL = "codexa-native-jsonl-v2";
const TIMEOUT_MS = 180_000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

/** Native serialization accepts complete alternating turns, not orphaned failed requests. */
export function nativeCompleteHistory(
  history: NonNullable<ProviderChatRequest["conversationHistory"]>,
) {
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  let omitted = 0;
  for (let index = 0; index < history.length; index++) {
    const user = history[index]!;
    const assistant = history[index + 1];
    if (
      user.role === "user" &&
      assistant?.role === "assistant" &&
      user.content.trim() &&
      assistant.content.trim()
    ) {
      messages.push(
        { role: "user", content: user.content },
        { role: "assistant", content: assistant.content },
      );
      index++;
    } else omitted++;
  }
  return { messages, omitted };
}

type Event = Record<string, unknown> & {
  type: string;
  id?: string;
  text?: string;
  message?: string;
};
interface Pending {
  handlers: BackendRunHandlers;
  resolve: (event: Event) => void;
  reject: (error: Error) => void;
  sequence: number;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}
interface NativeBridge {
  child: ChildProcessWithoutNullStreams;
  key: string;
  ready: Promise<Event>;
  rejectReady: (error: Error) => void;
  pending: Map<string, Pending>;
  closed: Promise<void>;
  stopping: boolean;
}
let bridge: NativeBridge | null = null;
let shutdown: Promise<void> = Promise.resolve();
function diagnostic(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const root = join(resolveUbumeDataDir(), "diagnostics");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "codexa-native.jsonl");
    if (existsSync(path) && statSync(path).size >= 1024 * 1024) return;
    appendFileSync(
      path,
      `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* Diagnostics cannot break chat; no prompt or generated text is logged. */
  }
}
let requestSequence = 0;
let runActive = false;
let configuredOptions: CodexaNativeOptions | undefined;
export function setCodexaNativeConfig(options?: CodexaNativeOptions): void {
  configuredOptions = options;
}
let exitHookInstalled = false;

function missingNativePaths(config: CodexaNativeConfig): string[] {
  return [config.python, config.bridgeScript, config.tokenizer].filter(
    (path) => !path || !existsSync(path),
  );
}
export function discoverCodexaNativeModels(
  config = resolveCodexaNativeConfig(process.env, configuredOptions),
  env: NodeJS.ProcessEnv = process.env,
): ProviderModelDiscoveryResult {
  if (!isLocalDevChannel(env))
    return {
      status: "not-configured",
      providerId: "codexa-native",
      backendKind: "unavailable",
      models: [],
      message: "Codexa Native is only available on ubume-dev.",
    };
  const missing = missingNativePaths(config);
  const runtimeError =
    config.configurationError ||
    (missing.length ? `Missing native runtime files: ${missing.join(", ")}` : undefined);
  const models = CODEXA_MODELS.map((model) => {
    const path = config.checkpoints[model.id];
    const reason =
      runtimeError ||
      (!path || !existsSync(path)
        ? "Checkpoint unavailable in local registry."
        : !existsSync(`${path}.sha256`)
          ? "Checkpoint checksum sidecar is missing."
          : null);
    return {
      id: model.id,
      modelId: model.id,
      label: model.label,
      description:
        reason || "Experimental local checkpoint; conversational quality is unqualified.",
      available: !reason,
      executionVerified: false,
      deployment: "local" as const,
      contextWindow: 2048,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
      source: "config" as const,
      capabilities: { chat: true, tools: false, vision: false, reasoning: false },
      raw: {
        context_length: 2048,
        max_output_tokens: 128,
        supportsStreaming: true,
        supportsToolCalls: false,
        supportsSystemPrompt: true,
        supportsVision: false,
        unavailableReason: reason,
      },
    };
  });
  return {
    status: models.some((model) => model.available) ? "ready" : "not-configured",
    providerId: "codexa-native",
    backendKind: "codexa-native-pytorch",
    models,
    message: runtimeError,
    diagnostics: {
      modelRoot: config.modelRoot,
      registry: config.registry,
      device: config.device,
      runtime: bridge ? "loaded" : "not-loaded",
    },
  };
}

export function unloadCodexaNative(message = "Codexa Native unloaded."): Promise<void> {
  const active = bridge;
  if (!active) return shutdown;
  bridge = null;
  active.stopping = true;
  const error = new Error(message);
  active.rejectReady(error);
  for (const pending of active.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  active.pending.clear();
  diagnostic("unload", { message });
  active.child.kill("SIGTERM");
  const escalation = setTimeout(() => {
    if (active.child.exitCode === null) active.child.kill("SIGKILL");
  }, 5000);
  shutdown = active.closed.finally(() => clearTimeout(escalation));
  return shutdown;
}

async function startBridge(
  config: CodexaNativeConfig,
  modelId: string,
  handlers: BackendRunHandlers,
  signal: AbortSignal,
  startupTimeoutMs = TIMEOUT_MS,
): Promise<NativeBridge> {
  const model = CODEXA_MODELS.find((value) => value.id === modelId);
  const checkpoint = config.checkpoints[modelId];
  if (!model || !checkpoint)
    throw new Error("Select an available Codexa 934M checkpoint explicitly.");
  if (config.configurationError || missingNativePaths(config).length || !existsSync(checkpoint))
    throw new Error(
      config.configurationError || "Codexa runtime or selected checkpoint is missing.",
    );
  const key = JSON.stringify([
    config.python,
    config.bridgeScript,
    checkpoint,
    model.sha256,
    config.tokenizer,
    config.device,
  ]);
  if (bridge?.key === key && !bridge.stopping && bridge.child.exitCode === null) return bridge;
  await unloadCodexaNative("Codexa checkpoint changed.");
  if (signal.aborted) throw new Error("Codexa loading canceled.");
  const child = spawn(
    config.python,
    [
      config.bridgeScript,
      "--protocol-version",
      "2",
      "--model-id",
      model.id,
      "--checkpoint",
      checkpoint,
      "--expected-checkpoint-sha256",
      model.sha256,
      "--tokenizer",
      config.tokenizer,
      "--expected-tokenizer-sha256",
      CODEXA_TOKENIZER_SHA256,
      "--device",
      config.device,
    ],
    {
      cwd: config.modelRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    },
  );
  handlers.onProcessLifecycle?.("spawned");
  let resolveReady: (event: Event) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<Event>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A canceled startup can reject before the caller attaches its await.
  void ready.catch(() => undefined);
  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const active: NativeBridge = {
    child,
    key,
    ready,
    rejectReady,
    pending: new Map(),
    closed,
    stopping: false,
  };
  bridge = active;
  const fail = (message: string) => {
    diagnostic("error", { message });
    rejectReady(new Error(message));
    if (bridge === active) void unloadCodexaNative(message);
  };
  const startupTimer = setTimeout(
    () => fail("Codexa checkpoint loading timed out."),
    startupTimeoutMs,
  );
  let buffer = "";
  child.stdout.setEncoding("utf8");
  let readyReceived = false;
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) {
      fail("Oversized native protocol event.");
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as Event;
        if (!event || event.protocol !== CODEXA_PROTOCOL || typeof event.type !== "string")
          throw new Error("Invalid native protocol version or event.");
        if (event.type === "ready") {
          if (readyReceived) throw new Error("Duplicate native readiness event.");
          readyReceived = true;
          if (
            event.model_id !== model.id ||
            event.checkpoint_sha256 !== model.sha256 ||
            event.tokenizer_sha256 !== CODEXA_TOKENIZER_SHA256 ||
            event.context_length !== 2048
          )
            throw new Error("Native process loaded a different model or tokenizer.");
          diagnostic("ready", {
            modelId: model.id,
            checkpointSha256: model.sha256,
            loadingSeconds: event.loading_seconds,
            device: event.device,
          });
          clearTimeout(startupTimer);
          resolveReady(event);
        } else if (!event.id && event.type === "status") {
          handlers.onProgress?.({
            id: "codexa-native-load",
            source: "stdout",
            text: `Codexa: ${String(event.stage)}`,
          });
        } else if (!event.id && event.type === "error") {
          throw new Error(event.message || "Codexa startup failed.");
        } else {
          const pending = active.pending.get(String(event.id));
          if (!pending) throw new Error("Unexpected native request identity.");
          if (event.type === "error") throw new Error(event.message || "Codexa generation failed.");
          if (event.sequence !== pending.sequence + 1)
            throw new Error("Native stream event order is invalid.");
          pending.sequence++;
          if (event.type === "delta") {
            if (typeof event.text !== "string") throw new Error("Invalid native text delta.");
            pending.text += event.text;
            pending.handlers.onAssistantDelta?.(event.text);
          } else if (event.type === "context") {
            if (
              !Number.isInteger(event.input_tokens) ||
              Number(event.input_tokens) < 1 ||
              event.context_length !== 2048
            )
              throw new Error("Invalid native context accounting.");
            pending.handlers.onContextUsage?.({
              inputTokens: Number(event.input_tokens),
              outputTokens: 0,
              contextTokens: Number(event.input_tokens),
              contextWindow: 2048,
              exact: true,
              compacted: Number(event.dropped_turns) > 0,
            });
            if (Number(event.dropped_turns) > 0)
              pending.handlers.onProgress?.({
                id: "codexa-native-context",
                source: "stdout",
                text: `Context: omitted ${event.dropped_turns} oldest complete turns; 2048-token limit.`,
              });
          } else if (event.type === "status") {
            pending.handlers.onProgress?.({
              id: "codexa-native-stage",
              source: "stdout",
              text: `Codexa: ${String(event.stage)}`,
            });
          } else if (event.type === "done") {
            if (
              event.text !== pending.text ||
              event.model_id !== model.id ||
              event.checkpoint_sha256 !== model.sha256
            )
              throw new Error("Native final output or model identity differs from the stream.");
            clearTimeout(pending.timer);
            active.pending.delete(String(event.id));
            pending.resolve(event);
          } else throw new Error("Unknown native protocol event.");
        }
      } catch (error) {
        fail(errorMessage(error, "Broken native streaming protocol."));
        return;
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", () => {
    /* Diagnostics stay local; never render arbitrary stderr or conversation contents. */
  });
  child.on("error", (error) => {
    clearTimeout(startupTimer);
    fail(`Native Python process could not start: ${error.message}`);
    resolveClosed();
  });
  child.on("close", (code, signal) => {
    clearTimeout(startupTimer);
    rejectReady(new Error(`Native Python process exited (${signal ?? code}).`));
    for (const pending of active.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Native Python process exited (${signal ?? code}).`));
    }
    active.pending.clear();
    if (bridge === active) bridge = null;
    resolveClosed();
    handlers.onProcessLifecycle?.("exit");
  });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => bridge?.child.kill("SIGTERM"));
  }
  return active;
}

export const codexaNativeRuntime: ProviderRuntime = {
  providerId: "codexa-native",
  label: "Codexa Native",
  modelPickerLabel: "Codexa Native",
  backendKind: "codexa-native-pytorch",
  routeAvailable: true,
  routeStatus: "Local experimental Codexa 934M checkpoints; conversation only, no tools.",
  routeSetupMessage: "Configure the local Codexa model registry.",
  launchAvailable: false,
  isRouteConfigured: () => isLocalDevChannel() && discoverCodexaNativeModels().status === "ready",
  discoverModels: discoverCodexaNativeModels,
  refreshModels: async (options) => {
    setCodexaNativeConfig(options.providerConfig?.codexaNative);
    return discoverCodexaNativeModels();
  },
  validateRoute: async (request) => {
    const config = resolveCodexaNativeConfig(process.env, request.providerConfig?.codexaNative);
    const discovery = discoverCodexaNativeModels(config);
    const selected = discovery.models.find((model) => model.modelId === request.route.modelId);
    return {
      status: selected?.available ? "ready" : "not-configured",
      providerId: "codexa-native",
      backendKind: "codexa-native-pytorch",
      message: selected?.available
        ? undefined
        : selected?.description || "Select a Codexa 934M variant explicitly.",
    };
  },
  run: (request: ProviderChatRequest, handlers: BackendRunHandlers) => {
    const control = createRunControl(handlers);
    let canceled = false;
    let completed = false;
    let claimed = false;
    const abort = new AbortController();
    const work = (async () => {
      if (runActive)
        throw new Error(
          "Codexa is already generating; cancel or wait before sending another request.",
        );
      runActive = true;
      claimed = true;
      if (!isLocalDevChannel()) throw new Error("Codexa Native is only available on ubume-dev.");
      if (request.imageAttachments?.length)
        throw new Error("Codexa does not support image attachments or tools.");
      const options = request.providerConfig?.codexaNative;
      validateCodexaOptions(options ?? {});
      const generation = validateCodexaGeneration(options?.generation);
      const config = resolveCodexaNativeConfig(process.env, options);
      const active = await startBridge(
        config,
        request.route.modelId,
        handlers,
        abort.signal,
        options?.startupTimeoutMs,
      );
      const ready = await active.ready;
      handlers.onProgress?.({
        id: "codexa-native-ready",
        source: "stdout",
        text: `${request.route.modelId} loaded on ${String(ready.device ?? config.device)}; ${String(generation.preset)} preset.`,
      });
      if (canceled) {
        await unloadCodexaNative("Codexa loading canceled.");
        return;
      }
      if (active.pending.size)
        throw new Error(
          "Codexa is already generating; cancel or wait before sending another request.",
        );
      const id = `native-${++requestSequence}`;
      const history = nativeCompleteHistory(request.conversationHistory ?? []);
      if (history.omitted)
        handlers.onProgress?.({
          id: "codexa-native-incomplete-history",
          source: "stdout",
          text: `Context: omitted ${history.omitted} incomplete messages from failed or unanswered turns.`,
        });
      const messages = [
        ...(options?.systemPrompt ? [{ role: "system", content: options.systemPrompt }] : []),
        ...history.messages,
        { role: "user", content: request.prompt },
      ];
      const { preset: _preset, ...decoding } = generation;
      const response = await new Promise<Event>((resolve, reject) => {
        const timer = setTimeout(() => {
          void unloadCodexaNative("Codexa generation timed out.");
        }, options?.generationTimeoutMs ?? TIMEOUT_MS);
        active.pending.set(id, { resolve, reject, timer, sequence: 0, text: "", handlers });
        const payload = `${JSON.stringify({ protocol: CODEXA_PROTOCOL, type: "chat", id, messages, generation: decoding })}\n`;
        if (Buffer.byteLength(payload) > MAX_EVENT_BYTES) {
          clearTimeout(timer);
          active.pending.delete(id);
          reject(new Error("Codexa request exceeds the 2 MiB protocol limit."));
          return;
        }
        active.child.stdin.write(payload, (error) => {
          if (error) void unloadCodexaNative(`Native stdin failed: ${error.message}`);
        });
      });
      if (canceled) return;
      completed = true;
      diagnostic("done", {
        modelId: request.route.modelId,
        finishReason: response.finish_reason,
        terminationCause: response.termination_cause,
        tokens: response.generated_tokens,
        elapsedSeconds: response.elapsed_seconds,
      });
      handlers.onGenerationMetadata?.({
        providerId: "codexa-native",
        modelId: request.route.modelId,
        checkpointSha256: String(response.checkpoint_sha256),
        preset: generation.preset,
        finishReason: String(response.finish_reason),
        terminationCause: String(response.termination_cause),
        generatedTokens: Number(response.generated_tokens),
        elapsedSeconds: Number(response.elapsed_seconds),
        firstTokenSeconds:
          response.first_token_seconds === null ? null : Number(response.first_token_seconds),
        tokensPerSecond: Number(response.tokens_per_second),
        rawOutput: String(response.text),
        generation: decoding,
        loadingSeconds:
          typeof ready.loading_seconds === "number" ? ready.loading_seconds : undefined,
        gpuPeakAllocatedBytes:
          typeof response.gpu_peak_allocated_bytes === "number"
            ? response.gpu_peak_allocated_bytes
            : undefined,
        gpuPeakReservedBytes:
          typeof response.gpu_peak_reserved_bytes === "number"
            ? response.gpu_peak_reserved_bytes
            : undefined,
        hostPeakBytes: typeof response.VmHWM === "number" ? response.VmHWM : undefined,
      });
      handlers.onContextUsage?.({
        inputTokens: Number(response.input_tokens),
        outputTokens: Number(response.generated_tokens),
        contextTokens: Number(response.input_tokens) + Number(response.generated_tokens),
        contextWindow: 2048,
        exact: true,
      });
      handlers.onProgress?.({
        id: "codexa-native-complete",
        source: "stdout",
        text: `${request.route.modelId} · ${response.termination_cause} · ${response.generated_tokens} tokens · ${Number(response.tokens_per_second).toFixed(1)} tok/s`,
      });
      if (!String(response.text).trim()) {
        handlers.onError(
          "Codexa stopped without visible answer text; the raw empty result is recorded in generation metadata.",
        );
        return;
      }
      handlers.onFinalAnswerObserved?.(String(response.text));
      handlers.onResponse(String(response.text));
    })()
      .catch(async (error) => {
        if (claimed) await shutdown;
        if (!canceled) handlers.onError(errorMessage(error, "Codexa Native failed."));
      })
      .finally(() => {
        if (claimed) runActive = false;
      });
    control.track(work);
    void work.finally(() => control.finish());
    return () => {
      if (completed) return;
      canceled = true;
      abort.abort();
      if (claimed) {
        const stopping = unloadCodexaNative("Codexa generation canceled.");
        control.track(stopping);
      }
    };
  },
};

export const CODEXA_CUPY_MODEL_ID = "codexa-250m-cupy";

interface Config {
  modelRoot: string;
  python: string;
  bridgeScript: string;
  checkpoint: string;
  tokenizer: string;
  device: string;
}
interface Response {
  type: string;
  id?: string;
  text?: string;
  message?: string;
  device?: string;
  context_length?: number;
}
interface Bridge {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<Response>;
  pending: Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>;
}

let codexaCupyBridge: Bridge | null = null;
let sequence = 0;

function resolveCodexaCupyConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const modelRoot =
    env.CODEXA_CUPY_MODEL_ROOT?.trim() ||
    join(getHomeDir(), "Development", "2-Python", "32-LLM (NumPy)");
  return {
    modelRoot,
    python: env.CODEXA_CUPY_PYTHON?.trim() || "python3",
    bridgeScript: join(modelRoot, "scripts", "codexa_cupy_bridge.py"),
    checkpoint:
      env.CODEXA_CUPY_CHECKPOINT?.trim() ||
      join(
        modelRoot,
        "runs",
        "pretraining",
        "pretrain_250m_fineweb_followup_10m",
        "target_final.npz",
      ),
    tokenizer:
      env.CODEXA_CUPY_TOKENIZER?.trim() ||
      join(modelRoot, "data", "tokenized", "general-fineweb-10m-v1", "tokenizer.json"),
    device: env.CODEXA_CUPY_DEVICE?.trim() || "cuda",
  };
}

function missing(config: Config): string[] {
  const executableMissing = config.python.includes("/") && !existsSync(config.python);
  return [config.bridgeScript, config.checkpoint, config.tokenizer]
    .filter((path) => !existsSync(path))
    .concat(executableMissing ? [config.python] : []);
}

export function discoverCodexaCupyModels(
  config = resolveCodexaCupyConfig(),
  env: NodeJS.ProcessEnv = process.env,
): ProviderModelDiscoveryResult {
  if (!isLocalDevChannel(env))
    return {
      status: "not-configured",
      providerId: "codexa-cupy",
      backendKind: "unavailable",
      models: [],
      message: "CuPy is only available on ubume-dev.",
    };
  const missingPaths = missing(config);
  if (missingPaths.length)
    return {
      status: "not-configured",
      providerId: "codexa-cupy",
      backendKind: "unavailable",
      models: [],
      message: `CuPy is missing required files:\n${missingPaths.join("\n")}`,
      diagnostics: { modelRoot: config.modelRoot, missingPaths: missingPaths.join(", ") },
    };
  return {
    status: "ready",
    providerId: "codexa-cupy",
    backendKind: "codexa-cupy",
    models: [
      {
        id: CODEXA_CUPY_MODEL_ID,
        modelId: CODEXA_CUPY_MODEL_ID,
        label: "CuPy 250M",
        description: "NumPy model with CuPy/CUDA inference.",
        defaultReasoningLevel: null,
        supportedReasoningLevels: null,
        source: "config",
        raw: {
          context_length: 128,
          supportsStreaming: false,
          supportsToolCalls: false,
          supportsSystemPrompt: true,
          supportsVision: false,
        },
      },
    ],
    diagnostics: {
      modelRoot: config.modelRoot,
      checkpoint: config.checkpoint,
      tokenizer: config.tokenizer,
      device: config.device,
      runtime: codexaCupyBridge ? "loaded" : "not-loaded",
    },
  };
}

function codexaCupyStopBridge(message = "CuPy process stopped."): void {
  const active = codexaCupyBridge;
  codexaCupyBridge = null;
  if (!active) return;
  for (const pending of active.pending.values()) pending.reject(new Error(message));
  active.pending.clear();
  if (!active.child.killed) active.child.kill("SIGTERM");
}

function codexaCupyStartBridge(config: Config, handlers: BackendRunHandlers): Bridge {
  if (
    codexaCupyBridge &&
    !codexaCupyBridge.child.killed &&
    codexaCupyBridge.child.exitCode === null
  )
    return codexaCupyBridge;
  const child = spawn(
    config.python,
    [
      config.bridgeScript,
      "--checkpoint",
      config.checkpoint,
      "--tokenizer",
      config.tokenizer,
      "--device",
      config.device,
    ],
    {
      cwd: config.modelRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    },
  );
  const pending = new Map<
    string,
    { resolve: (text: string) => void; reject: (error: Error) => void }
  >();
  let readyResolve: (response: Response) => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<Response>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const active: Bridge = { child, ready, pending };
  codexaCupyBridge = active;
  const timeout = setTimeout(() => {
    readyReject(new Error("CuPy timed out while loading the checkpoint."));
    codexaCupyStopBridge();
  }, 60_000);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let response: Response;
    try {
      response = JSON.parse(line) as Response;
    } catch {
      return;
    }
    if (response.type === "ready") {
      clearTimeout(timeout);
      readyResolve(response);
      return;
    }
    if (!response.id) return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.type === "response" && typeof response.text === "string")
      request.resolve(response.text);
    else request.reject(new Error(response.message || "CuPy returned an invalid response."));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) handlers.onProgress?.({ id: "codexa-cupy-load", source: "stderr", text });
  });
  child.on("error", (error) => {
    clearTimeout(timeout);
    readyReject(error);
    codexaCupyStopBridge(error.message);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    const message = `CuPy process exited (${signal ?? code ?? "unknown"}).`;
    readyReject(new Error(message));
    codexaCupyStopBridge(message);
  });
  return active;
}

async function codexaCupySendPrompt(prompt: string, handlers: BackendRunHandlers): Promise<string> {
  const config = resolveCodexaCupyConfig();
  const missingPaths = missing(config);
  if (missingPaths.length)
    throw new Error(`CuPy is missing required files:\n${missingPaths.join("\n")}`);
  const active = codexaCupyStartBridge(config, handlers);
  const ready = await active.ready;
  handlers.onProgress?.({
    id: "codexa-cupy-ready",
    source: "stdout",
    text: `CuPy loaded on ${ready.device ?? config.device}`,
  });
  const id = `cupy-${Date.now()}-${++sequence}`;
  const response = new Promise<string>((resolve, reject) =>
    active.pending.set(id, { resolve, reject }),
  );
  active.child.stdin.write(`${JSON.stringify({ type: "chat", id, prompt })}\n`);
  return response;
}

export const codexaCupyRuntime: ProviderRuntime = {
  providerId: "codexa-cupy",
  label: "CuPy",
  modelPickerLabel: "CuPy",
  backendKind: "codexa-cupy",
  routeAvailable: true,
  routeStatus: "Runs the NumPy checkpoint through CuPy/CUDA.",
  routeSetupMessage: "CuPy model files are unavailable.",
  launchAvailable: false,
  isRouteConfigured: () => isLocalDevChannel() && discoverCodexaCupyModels().status === "ready",
  discoverModels: discoverCodexaCupyModels,
  refreshModels: async () => discoverCodexaCupyModels(),
  validateRoute: async (): Promise<ProviderRouteValidationResult> => {
    const discovery = discoverCodexaCupyModels();
    return {
      status: discovery.status,
      providerId: "codexa-cupy",
      backendKind: discovery.backendKind,
      message: discovery.message,
      diagnostics: discovery.diagnostics,
    };
  },
  run: (request, handlers) => {
    const control = createRunControl(handlers);
    let canceled = false;
    handlers.onProgress?.({
      id: "codexa-cupy-route",
      source: "stdout",
      text: codexaCupyBridge ? "Using loaded CuPy model" : "Loading CuPy checkpoint",
    });
    const prompt = request.conversationHistory?.length
      ? `Previous conversation:\n${formatConversationHistory(request.conversationHistory)}\n\nCurrent request:\n${request.prompt}`
      : request.prompt;
    const work = codexaCupySendPrompt(prompt, handlers)
      .then((text) => {
        if (canceled) return;
        handlers.onAssistantDelta?.(text);
        handlers.onFinalAnswerObserved?.(text);
        handlers.onResponse(text);
      })
      .catch((error) => {
        if (!canceled) handlers.onError(errorMessage(error, "CuPy failed."));
      });
    control.track(work);
    void work.finally(() => control.finish());
    return () => {
      control.finish();
      canceled = true;
      codexaCupyStopBridge("CuPy request canceled.");
    };
  },
};
