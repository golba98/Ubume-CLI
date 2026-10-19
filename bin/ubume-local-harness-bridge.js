/**
 * Local Harness bridge: the cordis plugin that lets Ubume's Local provider run
 * against an in-process DeepSeek Harness.
 *
 * Protocol contract (JSON-RPC over line transport on stdin/stdout):
 *   - Requests from Ubume:  initialize, session/open, session/prompt,
 *     session/flush, session/cancel, session/close, shutdown.
 *   - Notifications to Ubume: session.event, session.status, subagent.started,
 *     subagent.finished, harness.memory.
 *   - Requests to Ubume: tool/policy, approval/request.
 *
 * Assumptions worth stating explicitly:
 *   - One bridge process per Ubume-side runtime; session records are keyed by
 *     the Ubume session id and owned by this process.
 *   - Events are projected (bounded, secret-free) before they cross the
 *     transport; raw Harness events never leave this process.
 *   - Browser tool arguments travel only on private policy/execution RPCs —
 *     never on display events (typing can contain secrets).
 *   - Cancellation: `session/cancel` cancels the agent run and waits for idle
 *     before replying, so a cancel response means the run fully stopped.
 *   - Cleanup: `shutdown` awaits pending creations, disposes every session and
 *     every cordis listener before returning. Nothing is left registered.
 */

import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { carrierKeyOf } from "@deepseek-ai/dsh-scope";
import { browserDescription, isBrowserTool, registerBrowserTools } from "./ubume-local-browser-tools.js";

export const name = "ubume-local-harness-bridge";
export const inject = ["agents", "sessions"];

// Output safety limits. stdout backpressure beyond this budget aborts (86) so
// a runaway producer cannot wedge the bridge silently.
const MAX_PENDING_STDOUT_BYTES = 16 * 1024 * 1024;

// Display-side truncation for tool arguments/results that cross into UI events.
const MAX_TOOL_ARGUMENT_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 2_000;

// Error text is capped before crossing the transport.
const MAX_EVENT_ERROR_CHARS = 4_000;

// RAM guard: the memory watchdog aborts (85) once RSS passes this budget.
const configuredMaxRssBytes = Number(process.env.UBUME_DSH_MAX_RSS_BYTES);
const maxRssBytes = Number.isSafeInteger(configuredMaxRssBytes) && configuredMaxRssBytes > 0
  ? configuredMaxRssBytes
  : 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Event projection: raw Harness events -> bounded, secret-free UI events
// ---------------------------------------------------------------------------

/** Flattens nested content blocks into a single bounded preview string. */
function contentPreview(blocks, limit = MAX_TOOL_RESULT_CHARS) {
  if (!Array.isArray(blocks)) return "";
  let result = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const part = typeof block.text === "string" ? block.text : contentPreview(block.content, limit - result.length);
    result += part.slice(0, limit - result.length);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Tool arguments as shown in UI display events: browser tools get a
 * human-readable description only; other tools keep whitelisted string keys.
 * Anything unexpected or oversized renders as `{}`.
 */
function toolDisplayArguments(raw, tool) {
  try {
    if (typeof raw === "string" && raw.length > 1024 * 1024) return "{}";
    const args = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!args || typeof args !== "object") return "{}";
    if (isBrowserTool(tool)) return JSON.stringify({ description: browserDescription(tool, args) });
    return JSON.stringify(Object.fromEntries(
      ["command", "path", "file_path"]
        .filter((key) => typeof args[key] === "string")
        .map((key) => [key, args[key].slice(0, MAX_TOOL_ARGUMENT_CHARS)]),
    ));
  } catch {
    return "{}";
  }
}

/**
 * Arguments forwarded to Ubume's tool-policy decision. Browser tools need their
 * full arguments for a meaningful decision (they travel only on this private
 * RPC); other tools forward the whitelisted path-like keys only.
 */
export function policyArguments(args, tool) {
  if (!args || typeof args !== "object") return {};
  if (isBrowserTool(tool)) return args;
  return Object.fromEntries(
    ["command", "path", "file_path", "old_path", "new_path"]
      .filter((key) => typeof args[key] === "string")
      .map((key) => [key, args[key]]),
  );
}

/** Collects only textual output blocks from (possibly nested) message content. */
function outputContent(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    if ((block.type === "text" || block.type === "output_text") && typeof block.text === "string") return [block];
    return outputContent(block.content);
  });
}

/**
 * Projects one raw Harness event into the bounded shape Ubume renders, or null
 * when the event has no UI representation. Anything crossing the transport is
 * capped: error strings at 4k, tool results at 2k, arguments via
 * toolDisplayArguments.
 */
export function projectHarnessEvent(event) {
  const data = event?.data ?? {};
  if (event?.type?.startsWith("compaction/")) {
    return data.error === undefined
      ? { type: event.type }
      : { type: event.type, data: { error: String(data.error).slice(0, MAX_EVENT_ERROR_CHARS) } };
  }
  if (event?.type === "turn/end") {
    const reason = data.reason ?? {};
    return { type: event.type, data: { reason: {
      kind: reason.kind,
      ...(reason.error ? { error: {
        message: String(reason.error.message ?? "").slice(0, MAX_EVENT_ERROR_CHARS),
        ...(typeof reason.error.code === "string" ? { code: reason.error.code } : {}),
      } } : {}),
    } } };
  }
  if (event?.type === "llm/retry") {
    return { type: event.type, data: {
      retry: data.retry,
      maxRetries: data.maxRetries,
      delayMs: data.delayMs,
      failure: { message: String(data.failure?.message ?? "").slice(0, MAX_EVENT_ERROR_CHARS), code: data.failure?.code },
    } };
  }
  if (event?.type === "assistant/chunk") {
    const chunk = data.chunk;
    if (!chunk || !["text-delta", "reasoning-delta", "usage", "finish"].includes(chunk.type)) return null;
    if (chunk.type === "finish") {
      return { type: event.type, data: { chunk: {
        type: "finish",
        reason: chunk.reason,
        replayState: { response: { stopReason: chunk.replayState?.response?.stopReason } },
      } } };
    }
    return { type: event.type, data: { step: data.step, chunk } };
  }
  if (event?.type === "assistant/message") {
    const content = outputContent(data.message?.content);
    return { type: event.type, data: { usage: data.usage, message: { content } } };
  }
  if (event?.type === "tool/call") {
    return { type: event.type, seq: event.seq, data: {
      callId: data.callId,
      name: data.name,
      arguments: toolDisplayArguments(data.arguments, data.name),
    } };
  }
  if (event?.type === "tool/result") {
    return { type: event.type, seq: event.seq, data: {
      message: { source: { callId: data.message?.source?.callId }, content: [{ type: "text", text: typeof data.meta?.browserSummary === "string" ? data.meta.browserSummary.slice(0, 500) : contentPreview(data.message?.content) }] },
      ...(data.error ? { error: { message: "Tool failed" } } : {}),
    } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output backpressure guard
// ---------------------------------------------------------------------------

/**
 * Sends a notification and then enforces the stdout budget. When the transport
 * has more than MAX_PENDING_STDOUT_BYTES waiting, the bridge aborts with the
 * configured exit code instead of silently wedging the pipe.
 */
export function notifyBounded(transport, method, params, output = process.stdout, abort = (code) => {
  process.stderr.write("Ubume Local Harness output safety buffer exceeded.\n");
  process.exit(code);
}) {
  transport.notify(method, params);
  if (output.writableLength > MAX_PENDING_STDOUT_BYTES) abort(86);
}

// ---------------------------------------------------------------------------
// Bridge server
// ---------------------------------------------------------------------------

export class UbumeHarnessServer {
  constructor(ctx, transport) {
    this.ctx = ctx;
    this.transport = transport;
    this.cwd = process.cwd();
    this.provider = "ubume-local";
    this.model = "";
    this.maxTokens = undefined;
    this.sessions = new Map();
    this.creations = new Map();
    this.disposers = [];
    this.shuttingDown = false;

    this.wireHarnessEvents();
  }

  /**
   * Registers every cordis listener the bridge needs. Each listener is pushed
   * onto `this.disposers` so shutdown can unregister all of them.
   *
   * Listener semantics:
   *   - session/event / agent/status: only for sessions this bridge owns;
   *     everything else belongs to another consumer and is left alone.
   *   - tools/pre-execute: converts Ubume's tool/policy decision
   *     (allow/ask/deny) into the Harness's middleware result.
   *   - approval/request: maps Ubume's outcome onto the Harness's approval
   *     vocabulary; unknown responses degrade to "rejected" (fail closed).
   */
  wireHarnessEvents() {
    const ctx = this.ctx;

    this.disposers.push(ctx.on("session/event", (session, event) => {
      if (!this.sessions.has(String(session.id))) return;
      const projected = projectHarnessEvent(event);
      if (projected) notifyBounded(this.transport, "session.event", { sessionId: String(session.id), event: projected });
    }));

    this.disposers.push(ctx.on("agent/status", ({ agent, status }) => {
      notifyBounded(this.transport, "session.status", { sessionId: String(agent.id), status });
    }));

    this.disposers.push(ctx.on("session/created", (session) => {
      if (session.header.parentSession === undefined) return;
      notifyBounded(this.transport, "subagent.started", {
        parentSessionId: String(session.header.parentSession),
        childSessionId: String(session.id),
      });
    }));

    // `subagent/end` handlers are invoked with the carrier as `this`, so this
    // listener cannot be an arrow function.
    const notificationTransport = this.transport;
    this.disposers.push(ctx.on("subagent/end", function(info) {
      if (!info.local) return;
      const parent = carrierKeyOf(this);
      notifyBounded(notificationTransport, "subagent.finished", {
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: info.stopReason === "completed" ? "ok" : "error",
        stopReason: info.stopReason,
      });
    }));

    this.disposers.push(ctx.on("tools/pre-execute", async (execution, next) => {
      const agent = execution.agent;
      if (!agent || !this.sessions.has(String(agent.id))) return next();
      const result = await this.transport.request("tool/policy", {
        sessionId: String(agent.id),
        callId: execution.callId === undefined ? undefined : String(execution.callId),
        tool: execution.name,
        arguments: policyArguments(execution.arguments, execution.name),
      });
      if (!result || typeof result !== "object") {
        return { kind: "deny", reason: "Ubume returned an invalid tool-policy decision." };
      }
      if (result.kind === "allow") return { kind: "allow" };
      if (result.kind === "ask") {
        return { kind: "ask", ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
      }
      return {
        kind: "deny",
        reason: typeof result.reason === "string" ? result.reason : "Ubume denied this tool call.",
      };
    }));

    this.disposers.push(ctx.on("approval/request", async (request, next) => {
      if (!this.sessions.has(String(request.agent.id))) return next();
      const result = await this.transport.request("approval/request", {
        sessionId: String(request.agent.id),
        tool: request.toolName,
        callId: request.callId === undefined ? undefined : String(request.callId),
        reason: request.reason,
      });
      if (!result || typeof result !== "object") return "unavailable";
      if (result.outcome === "allowed-once") return "allowed-once";
      if (result.outcome === "cancelled") return "cancelled";
      return "rejected";
    }));
  }

  /** Applies the launch configuration supplied by Ubume. */
  async initialize(params) {
    this.cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
    this.provider = typeof params.provider === "string" ? params.provider : "ubume-local";
    this.model = typeof params.model === "string" ? params.model : "";
    this.maxTokens = Number.isSafeInteger(params.maxTokens) && params.maxTokens > 0
      ? params.maxTokens
      : undefined;
    this.browserCapability = params.browserCapability;
    this.supportsVision = params.supportsVision === true;
    return { serverInfo: { name: "ubume-local-harness-runtime", version: "1" } };
  }

  /**
   * Opens (or resumes) a session. Resume failures that mean "cannot be
   * recovered here" are reported as resumeUnavailable; permission, corruption
   * and I/O failures propagate — they are never masked as recovery.
   */
  async open(params) {
    const sessionId = String(params.sessionId ?? "");
    if (!sessionId) throw new Error("session/open requires a sessionId");
    try {
      const record = await this.getOrCreate(
        sessionId,
        params.resume === true,
        Array.isArray(params.seed) ? params.seed : undefined,
      );
      return { sessionId: String(record.handle.agent.id), resumed: record.resumed };
    } catch (error) {
      if (params.resume === true && error?.name === "SessionFormatUnsupportedError") return { resumeUnavailable: "incompatible" };
      if (params.resume === true && /^session "[^"]+" not found$/.test(error?.message ?? "")) return { resumeUnavailable: "missing" };
      throw error;
    }
  }

  async prompt(params) {
    const record = await this.getOrCreate(String(params.sessionId ?? ""), params.resume === true);
    const content = Array.isArray(params.contentBlocks)
      ? params.contentBlocks
      : [{ type: "text", text: String(params.content ?? "") }];
    const message = createUserMessage({ content, source: { kind: "user" } });
    record.handle.agent.followup(message);
    return { messageId: String(message.id) };
  }

  async flush(params) {
    const session = this.ctx.sessions.get(SessionId(String(params.sessionId ?? "")));
    if (!session) throw new Error("No live Local Harness session to flush.");
    const durable = await this.ctx.sessions.flush(session);
    if (!durable) throw new Error("Local Harness has no session persistence backend.");
    return { durable: true };
  }

  async cancel(params) {
    const record = this.sessions.get(String(params.sessionId ?? ""));
    if (!record) return { cancelled: false };
    record.handle.agent.cancel({ kind: "user" });
    await record.handle.agent.whenIdle();
    return { cancelled: true };
  }

  async close(params) {
    const sessionId = String(params.sessionId ?? "");
    const record = this.sessions.get(sessionId);
    if (!record) return {};
    this.sessions.delete(sessionId);
    await record.handle.dispose();
    return {};
  }

  /**
   * Returns the existing session record, an in-flight creation, or starts a new
   * creation. Concurrent calls for the same id share one creation promise;
   * `this.creations` only holds pending entries and self-cleans on settle.
   */
  async getOrCreate(sessionId, resume = false, seed) {
    if (!sessionId) throw new Error("A non-empty Harness session id is required.");
    if (this.shuttingDown) throw new Error("Local Harness is shutting down.");
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const pending = this.creations.get(sessionId);
    if (pending) return pending;
    const creation = this.create(sessionId, resume, seed);
    this.creations.set(sessionId, creation);
    void creation.then(() => this.creations.delete(sessionId), () => this.creations.delete(sessionId));
    return creation;
  }

  /**
   * Creates the Harness agent for one session. A resume failure that the seed
   * could make irrelevant (missing/incompatible stored session) falls through
   * to a fresh seeded creation; every other resume failure propagates.
   */
  async create(sessionId, resume, seed) {
    const setup = (agentCtx) => {
      if (this.browserCapability?.status === "available") registerBrowserTools(agentCtx, this.transport, sessionId, this.supportsVision);
    };
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    };
    let handle;
    let resumed = false;
    if (resume) {
      try {
        handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup });
        resumed = true;
      } catch (error) {
        if (!seed || (error?.name !== "SessionFormatUnsupportedError" && !/^session "[^"]+" not found$/.test(error?.message ?? ""))) throw error;
      }
    }
    handle ??= await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd, ...(seed ? { seedLength: seed.length } : {}) },
      ...(seed ? { seed } : {}),
      agentOptions,
      setup,
    });
    const record = { handle, resumed };
    this.sessions.set(sessionId, record);
    return record;
  }

  /**
   * Tears the bridge down: stops accepting work, waits for pending creations,
   * disposes every session and unregisters every listener. Safe to call once;
   * every step settles even when individual disposals fail.
   */
  async shutdown() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.creations.values()]);
    this.creations.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    while (this.disposers.length > 0) this.disposers.pop()?.();
    await Promise.allSettled(records.map((record) => record.handle.dispose()));
    return {};
  }

  handle(method, params) {
    if (method === "initialize") return this.initialize(params);
    if (method === "session/open") return this.open(params);
    if (method === "session/prompt") return this.prompt(params);
    if (method === "session/flush") return this.flush(params);
    if (method === "session/cancel") return this.cancel(params);
    if (method === "session/close") return this.close(params);
    if (method === "shutdown") return this.shutdown();
    throw new Error(`Unknown Ubume Local Harness method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * cordis `apply`: serves the bridge over stdio until `shutdown` arrives.
 *
 * Lifecycle: the request handler awaits the plugin loader on `initialize`;
 * `shutdown` flushes the transport, disposes the cordis root and exits 0 from
 * a `setImmediate` so the response is written first. The effect cleanup
 * (plugin hot-reload/dispose) mirrors shutdown without exiting the process.
 * A 500 ms watchdog reports harness.memory and aborts (85) at the RSS limit.
 */
export function apply(ctx) {
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const server = new UbumeHarnessServer(ctx, transport);
  const rootFiber = ctx.root.fiber;

  transport.onRequest(async (method, params) => {
    if (method === "initialize") await ctx.get("loader")?.await();
    const result = await server.handle(method, params);
    if (method === "shutdown") {
      setImmediate(async () => {
        await Promise.allSettled([transport.flush(), rootFiber.dispose()]);
        process.exit(0);
      });
    }
    return result;
  });

  ctx.effect(() => {
    transport.start();
    const memoryTimer = setInterval(() => {
      const rssBytes = process.memoryUsage().rss;
      if (rssBytes >= maxRssBytes) {
        process.stderr.write("Ubume Local Harness RAM safety limit reached.\n");
        process.exit(85);
      }
      notifyBounded(transport, "harness.memory", { rssBytes });
    }, 500);
    memoryTimer.unref();
    return async () => {
      clearInterval(memoryTimer);
      await server.shutdown();
      transport.close();
    };
  }, "ubume-local-harness.serve");
}
