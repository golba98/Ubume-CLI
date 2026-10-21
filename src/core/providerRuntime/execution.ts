import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CommandResult,
  CommandSpec,
  CommandStreamHandlers,
} from "../process/commandRunner.js";
import type { BackendRunHandlers } from "../providers/types.js";
import { resolveUbumeDataDir, workspaceStorageKey } from "../workspace/appData.js";
import type { ProviderFailure } from "./failures.js";
import type { ProviderChatRequest } from "./types.js";

export interface ExecutionDiagnostic {
  runId: string;
  providerId: string;
  phase: string;
  elapsedMs: number;
  pid: number;
  workspaceKey: string;
}

interface Runner {
  result: Promise<CommandResult>;
  stopped?: Promise<void>;
  cancel: () => void;
}

interface ExecutionClock {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
const realClock: ExecutionClock = {
  now: () => performance.now(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One logical task owns its optional deadline, including compatibility retries. */
export function createProviderExecution(
  request: ProviderChatRequest,
  handlers: BackendRunHandlers,
  clock: ExecutionClock = realClock,
) {
  const runId = randomUUID();
  let startedAt: number | undefined;
  let quietTimer: unknown;
  let finished = false;
  const configured = request.providerConfig?.executionTimeoutMs ?? 0;
  const timeoutMs =
    Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647
      ? configured
      : 0;
  const observe = (phase: string) => {
    const event = {
      runId,
      providerId: request.route.providerId,
      phase,
      elapsedMs: Math.round(clock.now() - (startedAt ?? clock.now())),
      pid: process.pid,
      workspaceKey: workspaceStorageKey(request.workspaceRoot),
    };
    handlers.onExecutionDiagnostic?.(event);
    if (process.env.UBUME_PROVIDER_TRACE === "1") {
      try {
        const dir = join(resolveUbumeDataDir(), "debug");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "provider-execution.jsonl"), `${JSON.stringify(event)}\n`, {
          mode: 0o600,
        });
      } catch {
        /* Diagnostics must not fail a provider run. */
      }
    }
  };
  let awaitingUser = false;
  const activity = () => {
    if (quietTimer) clock.clearTimer(quietTimer);
    quietTimer = undefined;
    // A provider blocked on a user approval is waiting, not stalled.
    if (finished || awaitingUser) return;
    quietTimer = clock.setTimer(() => {
      observe("quiet");
      handlers.onProgress?.({
        id: `${runId}-quiet`,
        source: "stderr",
        text: "Provider has been quiet for 120 seconds. The task is still running; interrupt it to cancel.",
      });
    }, 120_000);
  };
  return {
    observe,
    failure: (result: CommandResult) =>
      commandFailure(
        result,
        Math.max(result.durationMs, Math.round(clock.now() - (startedAt ?? clock.now()))),
      ),
    handlers: {
      ...handlers,
      onToolActivity: (tool) => {
        observe(`tool-${tool.status}`);
        activity();
        handlers.onToolActivity?.(tool);
      },
    } satisfies BackendRunHandlers,
    /** Suspends the quiet-provider notice while a tool approval waits on the user. */
    awaitingUser(active: boolean) {
      awaitingUser = active;
      observe(active ? "approval-wait" : "approval-done");
      activity();
    },
    finish() {
      finished = true;
      if (quietTimer) clock.clearTimer(quietTimer);
    },
    run<T extends Runner>(
      spec: CommandSpec,
      streams: CommandStreamHandlers,
      run: (spec: CommandSpec, handlers: CommandStreamHandlers) => T,
    ): T {
      startedAt ??= clock.now();
      const remaining = timeoutMs
        ? Math.max(1, timeoutMs - Math.round(clock.now() - startedAt))
        : 0;
      observe("attempt");
      activity();
      let runner: T;
      try {
        runner = run(
          { ...spec, timeoutMs: remaining, capture: spec.capture ?? { maxChars: 65536 } },
          {
            onStdout: (chunk) => {
              if (!finished) {
                observe("stdout");
                activity();
                streams.onStdout?.(chunk);
              }
            },
            onStderr: (chunk) => {
              if (!finished) {
                observe("stderr");
                activity();
                streams.onStderr?.(chunk);
              }
            },
            onProcessLifecycle: (event) => {
              observe(event);
              streams.onProcessLifecycle?.(event);
              handlers.onProcessLifecycle?.(event === "cancel" ? "cleanup" : event);
            },
          },
        );
      } catch (error) {
        if (quietTimer) clock.clearTimer(quietTimer);
        throw error;
      }
      void runner.result.then(
        () => {
          if (quietTimer) clock.clearTimer(quietTimer);
          observe("result");
        },
        () => {
          if (quietTimer) clock.clearTimer(quietTimer);
        },
      );
      void (runner.stopped ?? runner.result).then(
        () => observe("stopped"),
        () => observe("stopped"),
      );
      return runner;
    },
  };
}

function commandFailure(result: CommandResult, elapsedMs: number): ProviderFailure | undefined {
  if (result.status !== "timeout") return undefined;
  return {
    kind: "timeout",
    retryable: false,
    message: `Provider task exceeded its configured deadline after ${elapsedMs} ms.`,
    elapsedMs,
    timeoutPhase: "task",
  };
}
