/**
 * Persistent Local Harness process and active-run owner. Coordinates profile startup, session
 * resume/flush, tool approvals, browser calls, output-window continuation and shutdown.
 * Notifications and policy stay in their extracted modules; stale child/run generations must not
 * affect a replacement.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
  saveImageFile,
} from "@deepseek-ai/dsh-attachment-local";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import {
  browserDescription,
  browserInteractions,
  isBrowserTool,
  validateBrowserArguments,
} from "../../../../bin/ubume-local-browser-tools.js";
import { BrowserManager } from "../../computerUse/browser.js";
import { resolveBrowserCapability } from "../../computerUse/capability.js";
import { traceLocalStream } from "../../perf/debugLog.js";
import type { BackendRunHandlers, ToolApprovalDecision } from "../../providers/types.js";
import { errorMessage } from "../../shared/values.js";
import type { LocalHarnessSessionMetadata } from "../../workspace/conversationStore.js";
import {
  ensureSessionScratchDir,
  removeUnusedSessionScratchDir,
} from "../../workspace/scratchDir.js";
import type { ProviderChatRequest } from "../types.js";
import { commandFrom, decideToolPolicy, normalizedArgs, pathsFrom } from "./bridgePolicy.js";
import {
  buildHarnessEnv,
  HARNESS_MAX_RSS_BYTES,
  HARNESS_VERSION,
  type HarnessConfig,
  hashJson,
  INTERNAL_PROVIDER,
  PROFILE_NAME,
  resolveDshBin,
  resolveHarnessConfig,
  resolveHarnessSandboxMode,
  routeFingerprint,
  sanitizedEndpoint,
  secretFingerprint,
  transcriptHash,
} from "./config.js";
import {
  abortError,
  describeLocalRoute,
  formatTokens,
  harnessMemoryLimitMessage,
  redactStderr,
} from "./messages.js";
import type { HarnessNotification, HarnessRunState } from "./notifications.js";
import { routeNotification } from "./notifications.js";
import { ensureProfile, prepareSessionScratch, profilePatch } from "./profile.js";

const HARNESS_MEMORY_POLL_MS = 500;

function readLinuxProcessRssBytes(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** Builds prompt blocks and imports image bytes into Harness-owned storage before submission. */
export async function buildLocalHarnessPromptContentBlocks(
  dshHome: string,
  prompt: string,
  attachments: readonly NonNullable<ProviderChatRequest["imageAttachments"]>[number][],
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
  if (attachments.length === 0) return blocks;
  if (!dshHome) throw new Error("Local Harness image storage is unavailable.");
  const limits = {
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
    maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
    maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
    maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
    mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] as const,
  };
  if (attachments.length > limits.maxImagesPerMessage) {
    throw new Error(
      `Local Harness accepts at most ${limits.maxImagesPerMessage} images in one prompt.`,
    );
  }
  for (const attachment of attachments) {
    const data = await readFile(attachment.path);
    const ref = await saveImageFile(
      join(dshHome, "attachments", "v1"),
      { data, mediaType: attachment.mediaType, name: attachment.name },
      limits,
      {
        maxPixels: DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
        maxDimension: DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
        maxBytes: DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
      },
    );
    blocks.push({ type: "image", attachment: ref });
  }
  return blocks;
}

export interface LocalHarnessRunner {
  /**
   * Runs one app-serialized request, reusing only compatible persisted state. Success waits
   * for durable session flush; cancellation/failure invalidates session metadata.
   */
  run(
    request: ProviderChatRequest,
    handlers: BackendRunHandlers,
    signal: AbortSignal,
  ): Promise<string>;
  /**
   * Stops polling/browser work, requests graceful shutdown and waits through child termination
   * before process reuse.
   */
  shutdown(): Promise<void>;
  /**
   * Requests immediate transport/browser teardown with delayed kill escalation; does not await
   * process exit.
   */
  terminate(): void;
  closeSession?(sessionId: string): Promise<void>;
}

/**
 * Owns one reusable Harness child and one app-serialized active run. Child identity and session
 * checks reject stale callbacks; the caller must await cleanup/shutdown before reusing ownership.
 */
export class LocalHarnessProcess implements LocalHarnessRunner {
  private browser = new BrowserManager();
  private browserGrants = new Map<
    string,
    { sessionId: string; digest: string; identity?: string; description: string; allowed: boolean }
  >();
  private browserCalls = new Map<string, AbortController>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private transport: JsonRpcLineTransport | null = null;
  private fingerprint = "";
  private active: HarnessRunState | null = null;
  private stderr = "";
  private redactions: string[] = [];
  private dshHome = "";
  private memoryPoll: ReturnType<typeof setInterval> | null = null;
  private failedSessionCleanup: Promise<void> = Promise.resolve();

  private stopMemoryPoll(): void {
    if (this.memoryPoll) clearInterval(this.memoryPoll);
    this.memoryPoll = null;
  }

  private checkMemory(child: ChildProcessWithoutNullStreams, rssBytes: number | null): void {
    if (this.child !== child || rssBytes === null || rssBytes < HARNESS_MAX_RSS_BYTES) return;
    this.failActive(new Error(harnessMemoryLimitMessage()));
    this.terminate();
  }

  /**
   * Runs one app-serialized request, reusing only compatible persisted state. Success waits
   * for durable session flush; cancellation/failure invalidates session metadata.
   */
  async run(
    request: ProviderChatRequest,
    handlers: BackendRunHandlers,
    signal: AbortSignal,
  ): Promise<string> {
    await this.failedSessionCleanup;
    if (signal.aborted) throw abortError();
    const config = resolveHarnessConfig(request);
    const fingerprint = routeFingerprint(config, request);
    const browserCapability = resolveBrowserCapability();
    const processFingerprint = `${fingerprint}:${secretFingerprint(config.apiKey)}:${JSON.stringify(browserCapability)}`;
    try {
      await this.ensureStarted(
        request,
        config,
        processFingerprint,
        handlers,
        browserCapability,
        signal,
      );
    } catch (error) {
      await this.shutdown();
      throw error;
    }
    const metadata = request.localHarnessSession;
    let canResume =
      metadata?.harnessVersion === HARNESS_VERSION &&
      metadata.routeFingerprint === fingerprint &&
      metadata.throughMessageCount === (request.conversationHistory?.length ?? 0) &&
      metadata.transcriptHash === transcriptHash(request);
    if (metadata && !canResume) {
      await this.closeSession(metadata.sessionId);
      if (!this.transport)
        throw new Error(
          "Local Harness disconnected while closing the previous session. Retry to start a fresh session.",
        );
    }
    let sessionId = canResume && metadata ? metadata.sessionId : randomUUID();

    traceLocalStream("harness.session.open", {
      sessionId,
      model: config.model,
      resumed: canResume,
      endpoint: sanitizedEndpoint(config.baseUrl),
    });
    try {
      const opened = (await this.requestBounded(
        "session/open",
        { sessionId, resume: canResume },
        signal,
      )) as { resumeUnavailable?: string };
      if (opened.resumeUnavailable === "missing" || opened.resumeUnavailable === "incompatible") {
        canResume = false;
        sessionId = randomUUID();
        handlers.onProgress?.({
          id: "local-harness-recovery",
          source: "transcript",
          text: `Saved Local Harness state is ${opened.resumeUnavailable}; recovering the saved conversation into a fresh session.`,
        });
        await this.requestBounded("session/open", { sessionId, resume: false }, signal);
      }
    } catch (error) {
      const child = this.child;
      await this.shutdown();
      if (signal.aborted) throw abortError();
      const stderr = redactStderr(this.stderr, this.redactions);
      throw new Error(
        `Local Harness session/open failed: ${errorMessage(error)}\nExit: ${child?.exitCode ?? child?.signalCode ?? "unknown"}${stderr ? `\n${stderr}` : ""}\nYour next prompt will start a fresh Harness session.`,
      );
    }

    if (signal.aborted) {
      await this.shutdown();
      throw abortError();
    }

    const scratchNote = prepareSessionScratch(request, sessionId, canResume);
    const sessionMetadata: LocalHarnessSessionMetadata = {
      version: 1,
      sessionId,
      harnessVersion: HARNESS_VERSION,
      routeFingerprint: fingerprint,
      throughMessageCount: request.conversationHistory?.length ?? 0,
      transcriptHash: transcriptHash(request),
      updatedAt: new Date().toISOString(),
    };
    handlers.onLocalHarnessSession?.(sessionMetadata, sessionId);

    return new Promise<string>((resolveRun, rejectRun) => {
      const state: HarnessRunState = {
        sessionId,
        handlers,
        request,
        text: "",
        runningSeen: false,
        settled: false,
        toolArguments: new Map(),
        reasoningText: new Map(),
        approvals: new Set(),
        continuationCount: 0,
        windowStartTextLength: 0,
        windowStartToolEventCount: 0,
        toolEventCount: 0,
        reasoningEventCount: 0,
        windowStartReasoningEventCount: 0,
        consecutiveNoProgressWindows: 0,
        cancelled: false,
        sessionMetadata,
        resolve: resolveRun,
        reject: rejectRun,
        abortCleanup: () => undefined,
      };
      this.active = state;
      const abort = () => {
        traceLocalStream("harness.request.cancel", { sessionId });
        state.cancelled = true;
        this.failActive(abortError());
        void this.transport?.request("session/cancel", { sessionId }).catch(() => this.terminate());
      };
      signal.addEventListener("abort", abort, { once: true });
      state.abortCleanup = () => signal.removeEventListener("abort", abort);
      const history = request.conversationHistory ?? [];
      const conversationContent =
        !canResume && history.length > 0
          ? [
              "Ubume restored the following visible conversation into a new Local Harness session.",
              "Treat it as prior dialogue; prior ephemeral tool state is unavailable.",
              "",
              ...history.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
              "",
              `USER: ${request.prompt}`,
            ].join("\n")
          : request.prompt;
      const browserNote =
        !canResume || !this.browser.hasSession(state.sessionId)
          ? browserCapability.status === "available"
            ? "Browser state is ephemeral. Use browser_open to initialize it; previous browser references and logins are unavailable. Browser interaction tools follow Ubume permissions; network-off permits localhost only."
            : `Browser tools unavailable: ${browserCapability.reason}`
          : "";
      const promptContent = [scratchNote, browserNote, conversationContent]
        .filter(Boolean)
        .join("\n\n");
      if (!canResume && history.length > 0) {
        handlers.onProgress?.({
          id: "local-harness-session-migration",
          source: "transcript",
          text: "Restored visible Ubume history into a new Local Harness session; prior ephemeral tool state was not available.",
        });
      }
      void buildLocalHarnessPromptContentBlocks(
        this.dshHome,
        promptContent,
        request.imageAttachments ?? [],
      )
        .then((contentBlocks) =>
          this.transport!.request("session/prompt", { sessionId, contentBlocks }, signal),
        )
        .catch((error) =>
          this.failActive(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }

  private async ensureStarted(
    request: ProviderChatRequest,
    config: HarnessConfig,
    fingerprint: string,
    handlers: BackendRunHandlers,
    browserCapability: ReturnType<typeof resolveBrowserCapability>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    if (this.child && this.transport && this.fingerprint === fingerprint) return;
    await this.shutdown();
    if (signal.aborted) throw abortError();
    handlers.onProcessLifecycle?.("before-spawn");
    const dshHome = ensureProfile(request.workspaceRoot, config);
    this.dshHome = dshHome;
    this.browser = new BrowserManager(browserCapability);
    const env = buildHarnessEnv(request, config, dshHome);
    const child = spawn(
      process.env.UBUME_NODE_PATH?.trim() || "node",
      [resolveDshBin(), "--profile", PROFILE_NAME],
      {
        cwd: request.workspaceRoot,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.stopMemoryPoll();
    if (child.pid && process.platform === "linux") {
      this.memoryPoll = setInterval(
        () => this.checkMemory(child, readLinuxProcessRssBytes(child.pid!)),
        HARNESS_MEMORY_POLL_MS,
      );
      this.memoryPoll.unref?.();
    }
    traceLocalStream("harness.start", {
      model: config.model,
      endpoint: sanitizedEndpoint(config.baseUrl),
      workspaceRoot: request.workspaceRoot,
    });
    this.stderr = "";
    this.redactions = [config.apiKey].filter((value) => value.length >= 6);
    let startupSettled = false;
    let rejectStartup: (error: Error) => void = () => undefined;
    const startupFailure = new Promise<never>((_resolve, reject) => {
      rejectStartup = reject;
    });
    // Every listener below guards on `this.child === child`: shutdown() and
    // terminate() null `this.child` before the outgoing child can emit, so a
    // stale generation must never mutate state owned by its replacement.
    child.stderr.on("data", (chunk) => {
      // Drain outgoing stderr during shutdown, but never mix generations.
      if (this.child && this.child !== child) return;
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-12_000);
    });
    child.once("spawn", () => handlers.onProcessLifecycle?.("spawned"));
    child.once("error", (error) => {
      if (this.child !== child) return;
      handlers.onProcessLifecycle?.("error");
      if (!startupSettled) rejectStartup(error);
      this.failActive(error);
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.stopMemoryPoll();
      handlers.onProcessLifecycle?.("exit");
      this.child = null;
      void this.browser.shutdown();
      this.browserGrants.clear();
      this.transport?.close();
      this.transport = null;
      if (!startupSettled)
        rejectStartup(new Error(`Local Harness exited during startup (${code ?? "signal"}).`));
      if (this.active && !this.active.settled) {
        const safeStderr = redactStderr(this.stderr, this.redactions);
        const memoryFailure =
          code === 85 || /heap out of memory|allocation failed.*heap/i.test(safeStderr);
        const backpressureFailure = code === 86;
        this.failActive(
          new Error(
            memoryFailure
              ? harnessMemoryLimitMessage()
              : backpressureFailure
                ? "Local Harness output exceeded its 16 MiB safety buffer. The turn was stopped; your next prompt will start a fresh Harness session."
                : `Local Harness exited unexpectedly (${code ?? "signal"}).${safeStderr ? `\n${safeStderr}` : ""}`,
          ),
        );
      }
    });
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    this.transport = transport;
    transport.onNotification((method, params) => {
      if (
        method === "browser.cancel" &&
        this.child === child &&
        params.sessionId === this.active?.sessionId
      ) {
        this.browserCalls.get(String(params.callId))?.abort();
        return;
      }
      this.onNotification(method, params as HarnessNotification, child);
    });
    transport.onRequest((method, params) => this.onBridgeRequest(method, params, child));
    transport.start();
    try {
      await Promise.race([
        this.requestBounded(
          "initialize",
          {
            cwd: request.workspaceRoot,
            provider: INTERNAL_PROVIDER,
            model: config.model,
            maxTokens: config.maxTokens,
            browserCapability,
            supportsVision: config.supportsVision,
          },
          signal,
        ),
        startupFailure,
      ]);
      startupSettled = true;
      this.fingerprint = fingerprint;
    } catch (error) {
      startupSettled = true;
      await this.shutdown();
      if (signal.aborted) throw abortError();
      const message = errorMessage(error);
      const safeStderr = redactStderr(this.stderr, this.redactions);
      throw new Error(
        `Local Harness startup failed.\n\nModel: ${config.model}\nEndpoint: ${sanitizedEndpoint(config.baseUrl)}\n\n${message}${safeStderr ? `\n${safeStderr}` : ""}`,
      );
    }
  }

  private onNotification(
    method: string,
    params: HarnessNotification,
    sourceChild?: ChildProcessWithoutNullStreams,
  ): void {
    routeNotification(
      method,
      params,
      {
        child: this.child,
        active: this.active,
        checkMemory: (child, rss) => this.checkMemory(child, rss),
        failActive: (error) => this.failActive(error),
        tryRecoverExhaustedTurn: (state) => this.tryRecoverExhaustedTurn(state),
        completeActive: () => this.completeActive(),
        emitUsage: (state, usage) => this.emitUsage(state, usage),
      },
      sourceChild,
    );
  }

  private emitUsage(state: HarnessRunState, usage: Record<string, unknown>): void {
    // Usage without token counts (e.g. a failed request) would reset the context meter to 0.
    if (typeof usage.inputTokens !== "number" && typeof usage.outputTokens !== "number") return;
    const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
    const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
    const normalized = {
      inputTokens,
      outputTokens,
      contextTokens: inputTokens + outputTokens,
      contextWindow:
        state.request.localConfig?.models?.[state.request.route.modelId]?.contextLength ?? null,
      exact: true,
    };
    state.lastUsage = normalized;
    state.handlers.onContextUsage?.(normalized);
  }

  private async onBridgeRequest(
    method: string,
    params: Record<string, unknown>,
    sourceChild?: ChildProcessWithoutNullStreams,
  ): Promise<unknown> {
    const state = this.active;
    if (
      !state ||
      state.settled ||
      (sourceChild && sourceChild !== this.child) ||
      params.sessionId !== state.sessionId
    )
      return method === "approval/request"
        ? { outcome: "rejected" }
        : method === "browser/execute"
          ? {
              ok: false,
              error: {
                code: "BROWSER_PERMISSION_DENIED",
                message: "No active Local run owns this browser call.",
              },
            }
          : { kind: "deny", reason: "No active Ubume Local run owns this tool call." };
    if (method === "browser/execute") {
      const tool = String(params.tool);
      const callId = String(params.callId);
      const grant = this.browserGrants.get(callId);
      this.browserGrants.delete(callId);
      const args = normalizedArgs(params.arguments);
      if (
        !isBrowserTool(tool) ||
        !grant?.allowed ||
        grant.sessionId !== state.sessionId ||
        grant.digest !== hashJson([tool, args])
      )
        return {
          ok: false,
          error: {
            code: "BROWSER_PERMISSION_DENIED",
            message: "This browser action has no matching permission decision.",
          },
        };
      const controller = new AbortController();
      this.browserCalls.set(callId, controller);
      try {
        if (grant.identity) {
          const current = await this.browser.approvalState(
            state.sessionId,
            args,
            tool === "browser_type",
            controller.signal,
          );
          if (current.identity !== grant.identity)
            return {
              ok: false,
              error: {
                code: "BROWSER_PERMISSION_DENIED",
                message:
                  "Browser target changed after approval. Inspect again and request fresh approval.",
              },
            };
        }
        if (this.active !== state || state.settled) controller.abort();
        return await this.browser.execute(
          { sessionId: state.sessionId, callId, tool, arguments: args },
          {
            signal: controller.signal,
            networkAccess: state.request.runtime.policy.networkAccess,
            dshHome: this.dshHome,
          },
        );
      } catch {
        return {
          ok: false,
          error: {
            code: "BROWSER_STALE_REFERENCE",
            message: "Browser target is no longer available. Inspect the page again.",
          },
        };
      } finally {
        this.browserCalls.delete(callId);
      }
    }
    if (method === "tool/policy") {
      const tool = String(params.tool ?? "tool");
      const callId = String(params.callId ?? "");
      const args = normalizedArgs(params.arguments);
      if (isBrowserTool(tool)) {
        try {
          validateBrowserArguments(tool, args);
        } catch {
          return { kind: "deny", reason: "Invalid browser arguments." };
        }
        const interactive = browserInteractions.has(tool);
        if (
          interactive &&
          (state.request.runIntent === "plan" ||
            state.request.runtime.policy.sandboxMode === "read-only")
        )
          return { kind: "deny", reason: "Ubume's current runtime policy is read-only." };
        let description = browserDescription(tool, args);
        let identity: string | undefined;
        if (interactive) {
          const controller = new AbortController();
          this.browserCalls.set(callId, controller);
          try {
            const target = await this.browser.approvalState(
              state.sessionId,
              args,
              tool === "browser_type",
              controller.signal,
            );
            identity = target.identity;
            description += ` — ${target.description}`;
          } catch {
            return {
              kind: "deny",
              reason: "Browser target unavailable. Open/inspect the page again.",
            };
          } finally {
            this.browserCalls.delete(callId);
          }
        }
        if (this.active !== state || state.settled)
          return { kind: "deny", reason: "Local run cancelled." };
        const ask = interactive && state.request.runtime.policy.approvalPolicy === "on-request";
        this.browserGrants.set(callId, {
          sessionId: state.sessionId,
          digest: hashJson([tool, args]),
          identity,
          description,
          allowed: !ask,
        });
        state.toolArguments.set(callId, { tool, arguments: { description } });
        return ask ? { kind: "ask", reason: description } : { kind: "allow" };
      }
      if (callId) state.toolArguments.set(callId, { tool, arguments: args });
      const { decision, ensureScratch } = decideToolPolicy(
        tool,
        args,
        state.request,
        state.approvals,
      );
      if (ensureScratch) {
        try {
          ensureSessionScratchDir(state.request.workspaceRoot, state.sessionId);
        } catch (error) {
          traceLocalStream("harness.scratch.unavailable", {
            sessionId: state.sessionId,
            error: errorMessage(error),
          });
        }
      }
      return decision;
    }
    if (method === "approval/request") {
      const callId = String(params.callId ?? "");
      const browserGrant = this.browserGrants.get(callId);
      if (browserGrant) {
        if (!state.handlers.onToolApproval) return { outcome: "rejected" };
        const decision = await state.handlers.onToolApproval({
          tool: String(params.tool),
          signature: `browser:${callId}`,
          description: browserGrant.description,
          allowForRun: false,
          paths: [],
        });
        if (
          this.active !== state ||
          state.settled ||
          this.browserGrants.get(callId) !== browserGrant
        )
          return { outcome: "cancelled" };
        browserGrant.allowed = decision === "allow-once";
        return { outcome: browserGrant.allowed ? "allowed-once" : "rejected" };
      }
      const known = state.toolArguments.get(callId);
      const tool = String(params.tool ?? known?.tool ?? "tool");
      const args = known?.arguments ?? {};
      if (!state.handlers.onToolApproval) return { outcome: "rejected" };
      const signature = `${tool}:${commandFrom(tool, args)}`;
      const decision: ToolApprovalDecision = await state.handlers.onToolApproval({
        tool,
        signature,
        command: typeof args.command === "string" ? args.command : undefined,
        paths: pathsFrom(args),
      });
      if (decision === "allow-for-run")
        state.approvals.add(
          `${tool}:${typeof args.command === "string" ? args.command : pathsFrom(args).join(",")}`,
        );
      return { outcome: decision === "deny" ? "rejected" : "allowed-once" };
    }
    throw new Error(`Unknown Local Harness bridge request: ${method}`);
  }

  private outputBudgetExhausted(state: HarnessRunState): boolean {
    if (state.stopReason === "max-tokens") return true;
    const cap = this.outputBudget(state);
    return cap !== null && (state.lastUsage?.outputTokens ?? 0) >= cap;
  }

  private outputBudget(state: HarnessRunState): number | null {
    try {
      return resolveHarnessConfig(state.request).maxTokens;
    } catch {
      return null;
    }
  }

  /** Continue max-token turns inside the same Harness session and Ubume run. */
  private tryRecoverExhaustedTurn(state: HarnessRunState): boolean {
    if (state.cancelled || !this.outputBudgetExhausted(state) || !this.transport) return false;

    const textProgress = state.text.length > (state.windowStartTextLength ?? 0);
    const toolProgress = (state.toolEventCount ?? 0) > (state.windowStartToolEventCount ?? 0);
    state.consecutiveNoProgressWindows =
      textProgress || toolProgress ? 0 : (state.consecutiveNoProgressWindows ?? 0) + 1;
    if (state.consecutiveNoProgressWindows >= 2) {
      this.failActive(
        new Error(
          [
            "Local agent request failed: automatic continuation stopped after two output windows made no visible progress.",
            "",
            `Backend: ${state.request.resolvedLocalAgentConfig?.localBackend ?? state.request.route.localBackend ?? "local"}`,
            `Model: ${state.request.route.modelId}`,
            `Endpoint: ${sanitizedEndpoint(state.request.resolvedLocalAgentConfig?.baseUrl ?? state.request.localConfig?.baseUrl ?? "")}`,
            "",
            "The partial response remains visible. Lower the reasoning effort or raise max_output_tokens if the model supports a larger per-request limit.",
          ].join("\n"),
        ),
      );
      return true;
    }

    state.continuationCount = (state.continuationCount ?? 0) + 1;
    state.windowStartTextLength = state.text.length;
    state.windowStartToolEventCount = state.toolEventCount ?? 0;
    const reasoningProgress = state.reasoningEventCount > state.windowStartReasoningEventCount;
    state.windowStartReasoningEventCount = state.reasoningEventCount;
    state.runningSeen = false;
    state.stopReason = undefined;
    state.turnFailure = undefined;
    state.lastUsage = undefined;
    const reasoningOnly = !textProgress && !toolProgress && reasoningProgress;
    state.handlers.onProgress?.({
      id: "local-harness-output-recovery",
      source: "transcript",
      text: `Output window reached; continuing automatically (window ${state.continuationCount + 1}).`,
    });
    traceLocalStream("harness.request.recovery", {
      sessionId: state.sessionId,
      continuationCount: state.continuationCount,
      responseCharacters: state.text.length,
      reasoningOnly,
    });
    void this.transport
      .request("session/prompt", {
        sessionId: state.sessionId,
        contentBlocks: [
          {
            type: "text",
            text: reasoningOnly
              ? [
                  "Your previous turn ran out of output budget while reasoning and produced no answer.",
                  "Do not restart the analysis. Keep reasoning to a few sentences and begin the work now with tool calls, or give the answer directly.",
                ].join(" ")
              : [
                  "Continue the current task exactly where the previous response stopped.",
                  "Do not repeat text already emitted or mention output limits or continuation.",
                  "If work remains, perform it with tools instead of describing what you will do.",
                  "Finish validation and give the final result only when the task is complete.",
                ].join(" "),
          },
        ],
      })
      .catch((error) => this.failActive(error instanceof Error ? error : new Error(String(error))));
    return true;
  }

  private async completeActive(): Promise<void> {
    const state = this.active;
    if (!state || state.settled || state.completing) return;
    state.completing = true;
    if (!state.text.trim()) {
      const backendLines = describeLocalRoute(state.request);
      const usage = state.lastUsage;
      const usageLine = usage
        ? `Usage: ${formatTokens(usage.inputTokens)} input tokens, ${formatTokens(usage.outputTokens)} output tokens.`
        : null;
      if (this.outputBudgetExhausted(state)) {
        const cap = this.outputBudget(state) ?? usage?.outputTokens ?? 0;
        this.failActive(
          new Error(
            [
              `Local agent request failed: the model used its entire output budget (${formatTokens(cap)} tokens) on reasoning and never started its answer.`,
              "",
              ...backendLines,
              ...(usageLine ? [usageLine] : []),
              "",
              "Raise max_output_tokens for this model in providers.json, or lower its reasoning effort (set supports_reasoning_effort: true for the model and pick a lower reasoning level).",
            ].join("\n"),
          ),
        );
        return;
      }
      if (state.reasoningText.size > 0) {
        this.failActive(
          new Error(
            [
              "Local agent request failed: the model produced reasoning only and no answer or tool calls.",
              "",
              ...backendLines,
              ...(usageLine ? [usageLine] : []),
              "",
              "The turn ended normally, so the server delivered no assistant text after the reasoning channel. Check the model's chat template and whether the server streams the final message.",
            ].join("\n"),
          ),
        );
        return;
      }
      this.failActive(
        new Error(
          [
            "Local agent request failed: the Harness turn completed without visible assistant output.",
            "",
            ...backendLines,
            "Verify the model chat template, streaming response format, and native tool/function-calling support.",
          ].join("\n"),
        ),
      );
      return;
    }
    try {
      const flushed = (await this.requestBounded("session/flush", {
        sessionId: state.sessionId,
      })) as { durable?: boolean };
      if (flushed.durable !== true)
        throw new Error("Local Harness did not acknowledge durable session storage.");
    } catch (error) {
      if (this.active === state && !state.settled)
        this.failActive(
          new Error(`Local chat checkpoint could not be saved: ${errorMessage(error)}`),
        );
      return;
    }
    if (this.active !== state || state.settled) return;
    state.settled = true;
    state.abortCleanup();
    this.active = null;
    if (state.request?.workspaceRoot)
      removeUnusedSessionScratchDir(state.request.workspaceRoot, state.sessionId);
    const completedMessages = [
      ...(state.request.conversationHistory ?? []),
      { role: "user", content: state.request.prompt },
      { role: "assistant", content: state.text },
    ];
    state.handlers.onLocalHarnessSession?.(
      {
        ...state.sessionMetadata,
        throughMessageCount: completedMessages.length,
        transcriptHash: hashJson(completedMessages),
        updatedAt: new Date().toISOString(),
      },
      state.sessionId,
    );
    state.handlers.onFinalAnswerObserved?.(state.text);
    traceLocalStream("harness.request.complete", {
      sessionId: state.sessionId,
      responseCharacters: state.text.length,
    });
    state.resolve(state.text);
  }

  private failActive(error: Error): void {
    const state = this.active;
    if (!state || state.settled) return;
    state.settled = true;
    state.abortCleanup();
    this.active = null;
    for (const controller of this.browserCalls.values()) controller.abort();
    this.browserGrants.clear();
    const browserCleanup = this.browser.closeSession(state.sessionId);
    // Best-effort cleanup must never keep a failed run from settling.
    if (state.request?.workspaceRoot)
      removeUnusedSessionScratchDir(state.request.workspaceRoot, state.sessionId);
    state.handlers.onLocalHarnessSession?.(null, state.sessionId);
    const child = this.child;
    const transport = this.transport;
    if (child && transport) {
      this.failedSessionCleanup = new Promise<void>((resolveCleanup) => {
        const timer = setTimeout(() => {
          if (this.child === child) void this.shutdown().then(resolveCleanup, resolveCleanup);
          else resolveCleanup();
        }, 1_500);
        void transport
          .request("session/close", { sessionId: state.sessionId })
          .then(() => {
            clearTimeout(timer);
            resolveCleanup();
          })
          .catch(() => {
            clearTimeout(timer);
            if (this.child === child) void this.shutdown().then(resolveCleanup, resolveCleanup);
            else resolveCleanup();
          });
      });
    }
    this.failedSessionCleanup = Promise.allSettled([
      this.failedSessionCleanup,
      browserCleanup,
    ]).then(() => undefined);
    traceLocalStream("harness.request.error", {
      sessionId: state.sessionId,
      error: error.message,
      stopReason: state.stopReason ?? null,
      outputTokens: state.lastUsage?.outputTokens ?? null,
    });
    state.reject(error);
  }

  /**
   * Stops polling/browser work, requests graceful shutdown and waits through child termination
   * before process reuse.
   */
  async shutdown(): Promise<void> {
    this.stopMemoryPoll();
    for (const controller of this.browserCalls.values()) controller.abort();
    this.browserGrants.clear();
    await this.browser.shutdown();
    const transport = this.transport;
    const child = this.child;
    this.transport = null;
    this.child = null;
    this.fingerprint = "";
    this.dshHome = "";
    if (!child) return;
    if (!child.pid) {
      transport?.close();
      return;
    }
    traceLocalStream("harness.shutdown", {});
    try {
      await Promise.race([
        transport?.request("shutdown", {}) ?? Promise.resolve(),
        new Promise((resolveWait) => setTimeout(resolveWait, 1_500)),
      ]);
    } catch {
      /* terminate below */
    }
    transport?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    // Wait for the child to actually exit so the next ensureStarted() never
    // overlaps a dying generation with a freshly spawned one.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = await new Promise<boolean>((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveWait(true);
        });
      });
      if (!exited) {
        const killed = new Promise<void>((resolveWait) => child.once("exit", () => resolveWait()));
        child.kill("SIGKILL");
        await killed;
      }
    }
  }

  /**
   * Waits for failed-session/browser cleanup before the app releases or reuses run ownership.
   */
  async waitForCleanup(): Promise<void> {
    await this.failedSessionCleanup;
  }

  /**
   * Returns stderr with active connection secrets redacted.
   */
  failureDetails(): string {
    return redactStderr(this.stderr, this.redactions);
  }

  private async requestBounded(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const transport = this.transport;
    if (!transport) throw new Error(`Local Harness disconnected during ${method}.`);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new Error(`Local Harness ${method} timed out after 10 seconds.`)),
      10_000,
    );
    try {
      return await transport.request(method, params, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /**
   * Closes ephemeral browser/Harness session state; a failed RPC shuts down the process and
   * rejects.
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.browser.closeSession(sessionId);
    for (const [callId, grant] of this.browserGrants)
      if (grant.sessionId === sessionId) this.browserGrants.delete(callId);
    if (!this.transport || !sessionId) return;
    try {
      await this.requestBounded("session/close", { sessionId });
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  /**
   * Requests immediate transport/browser teardown with delayed kill escalation; does not await
   * process exit.
   */
  terminate(): void {
    this.stopMemoryPoll();
    for (const controller of this.browserCalls.values()) controller.abort();
    this.browserGrants.clear();
    this.browser.terminate();
    this.transport?.close();
    this.transport = null;
    const child = this.child;
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
      timer.unref?.();
      child.once?.("exit", () => clearTimeout(timer));
    }
    this.child = null;
    this.fingerprint = "";
  }
}

let sharedProcess: LocalHarnessRunner = new LocalHarnessProcess();

/**
 * Terminates the previous shared runner and installs the supplied test runner.
 */
export function resetLocalHarnessProcessForTests(
  processOverride: LocalHarnessRunner = new LocalHarnessProcess(),
): void {
  sharedProcess.terminate();
  sharedProcess = processOverride;
}

/**
 * Runs through the shared Harness owner, waits for failed-session cleanup, and shuts down on
 * cancellation. A disconnected failed turn is not replayed automatically.
 */
export async function runLocalHarness(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
  signal: AbortSignal,
): Promise<string> {
  const runner = sharedProcess;
  try {
    return await runner.run(request, handlers, signal);
  } catch (error) {
    if (
      !signal.aborted &&
      runner instanceof LocalHarnessProcess &&
      /^JSON-RPC.*(?:closed|disconnect)/i.test(errorMessage(error))
    ) {
      await runner.shutdown();
      const detail = runner.failureDetails();
      throw new Error(
        `Local Harness disconnected during session/prompt. ${errorMessage(error)}${detail ? `\n${detail}` : ""}\nYour next prompt will start a fresh Harness session. The failed turn was not retried.`,
      );
    }
    throw error;
  } finally {
    if (runner instanceof LocalHarnessProcess) {
      await runner.waitForCleanup();
      if (signal.aborted) await runner.shutdown();
    }
  }
}

/** Requests graceful shutdown of the shared Harness and waits for its cleanup. */
export function shutdownLocalHarness(): Promise<void> {
  return sharedProcess.shutdown();
}

/** Closes saved ephemeral session/browser state when supported; an absent session is a no-op. */
export function closeLocalHarnessSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId || !sharedProcess.closeSession) return Promise.resolve();
  return sharedProcess.closeSession(sessionId);
}

export const localHarnessTestUtils = {
  resolveHarnessConfig,
  resolveHarnessSandboxMode,
  prepareSessionScratch,
  routeFingerprint,
  secretFingerprint,
  profilePatch,
};
