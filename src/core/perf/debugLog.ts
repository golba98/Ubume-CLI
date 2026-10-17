/**
 * Opt-in input, Local stream, model-state and update-check diagnostics sharing a best-effort
 * writer. Each channel retains its flags, destination and record format; Local content fields
 * require a separate opt-in to bypass redaction.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHomeDir } from "../../config/settings.js";
import { resolveUbumeDataDir, resolveUbumeDebugLogPath } from "../workspace/appData.js";

type DebugDetails = Record<string, unknown>;

let sequence = 0;

function isInputDebugEnabled(): boolean {
  return process.env.UBUME_DEBUG_INPUT === "1";
}

function getInputDebugLogPath(): string {
  return process.env.UBUME_DEBUG_INPUT_LOG || join(getHomeDir(), ".ubume-input-debug.log");
}

/** Reads terminal input diagnostics without changing raw mode, flow or listener ownership. */
export function getStdinDebugState(stdin: unknown): DebugDetails {
  const input = stdin as
    | {
        isTTY?: boolean;
        isRaw?: boolean;
        readable?: boolean;
        destroyed?: boolean;
        isPaused?: () => boolean;
      }
    | null
    | undefined;

  return {
    isTTY: input?.isTTY ?? null,
    isRaw: input?.isRaw ?? null,
    readable: input?.readable ?? null,
    destroyed: input?.destroyed ?? null,
    paused: typeof input?.isPaused === "function" ? input.isPaused() : null,
  };
}

/**
 * Writes opt-in input diagnostics using the input channel's path and sequence; logging failures
 * are ignored.
 */
export function traceInputDebug(event: string, details: DebugDetails = {}): void {
  if (!isInputDebugEnabled()) {
    return;
  }

  try {
    const entry = {
      ts: new Date().toISOString(),
      seq: ++sequence,
      event,
      ...details,
    };
    inputLog(entry);
  } catch {
    // Debug tracing must never affect interactive input.
  }
}

function isLocalStreamDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.UBUME_DEBUG_LOCAL_STREAM === "1";
}

function getLocalStreamDebugLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.UBUME_DEBUG_LOCAL_STREAM_FILE?.trim() ||
    join(resolveUbumeDataDir(undefined, env), "debug", "local-stream.jsonl")
  );
}

const SENSITIVE_DETAIL_KEY = /(?:raw|content|reasoning|analysis|arguments|prompt)/i;

function redactStreamDetails(value: unknown, key = ""): unknown {
  if (typeof value === "string" && SENSITIVE_DETAIL_KEY.test(key)) {
    return `[redacted:${value.length} chars]`;
  }
  if (Array.isArray(value)) return value.map((item) => redactStreamDetails(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactStreamDetails(childValue, childKey),
      ]),
    );
  }
  return value;
}

/**
 * Writes opt-in Local trace records, redacting content-shaped fields unless the separate content
 * flag is enabled.
 */
export function traceLocalStream(
  event: string,
  details: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isLocalStreamDebugEnabled(env)) return;
  try {
    const safeDetails =
      env.UBUME_DEBUG_LOCAL_STREAM_CONTENT === "1" ? details : redactStreamDetails(details);
    createDebugLog(
      () => true,
      () => getLocalStreamDebugLogPath(env),
      { createParent: true },
    )(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...(safeDetails as Record<string, unknown>),
      })}\n`,
    );
  } catch {
    // Diagnostics must never interfere with a Local request or the TUI.
  }
}

function isUpdateCheckDebugEnabled(): boolean {
  return process.env.UBUME_DEBUG_UPDATE_CHECK === "1";
}

function getUpdateCheckDebugLogPath(): string {
  return (
    process.env.UBUME_DEBUG_UPDATE_CHECK_FILE?.trim() ||
    join(resolveUbumeDataDir(), "debug", "update-check.jsonl")
  );
}

const updateCheckLog = createDebugLog(isUpdateCheckDebugEnabled, getUpdateCheckDebugLogPath, {
  createParent: true,
});

/** Update-check diagnostics stay in the debug log; failures are never surfaced in the TUI. */
export function traceUpdateCheck(event: string, details: DebugDetails = {}): void {
  updateCheckLog({ ts: new Date().toISOString(), event, ...details });
}

type ModelStateDebugDetails = Record<string, unknown>;

let modelStateDebugSequence = 0;

function isModelStateDebugEnabled(): boolean {
  return process.env.UBUME_RENDER_DEBUG === "1" || process.env.UBUME_DEBUG_MODEL_STATE === "1";
}

function getModelStateDebugLogPath(): string {
  return (
    process.env.UBUME_RENDER_DEBUG_FILE?.trim() ||
    process.env.UBUME_DEBUG_MODEL_STATE_LOG?.trim() ||
    resolveUbumeDebugLogPath()
  );
}

/** Writes opt-in provider/model snapshots; callers must supply diagnostic-safe fields. */
export function traceModelStateDebug(event: string, details: ModelStateDebugDetails = {}): void {
  if (!isModelStateDebugEnabled()) return;

  try {
    const entry = {
      ts: new Date().toISOString(),
      seq: ++modelStateDebugSequence,
      event,
      ...details,
    };
    modelStateLog(entry);
  } catch {
    // Debug logging must never affect the TUI.
  }
}

/** Best-effort debug output; callers retain their record formats and flag semantics. */
export function createDebugLog(
  flag: string | (() => boolean),
  file: string | (() => string),
  options: { createParent?: boolean } = {},
): (record: string | Record<string, unknown>) => void {
  return (record) => {
    if (!(typeof flag === "function" ? flag() : process.env[flag] === "1")) return;
    try {
      const logPath = typeof file === "function" ? file() : file;
      if (options.createParent) mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        typeof record === "string" ? record : `${JSON.stringify(record)}\n`,
        "utf8",
      );
    } catch {
      // Diagnostics must never interfere with a request or terminal input.
    }
  };
}

const inputLog = createDebugLog(isInputDebugEnabled, getInputDebugLogPath);
const modelStateLog = createDebugLog(isModelStateDebugEnabled, getModelStateDebugLogPath, {
  createParent: true,
});
