import { expect, test } from "bun:test";
import { createFakeClock } from "../../test/fakeClock.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import type {
  CommandResult,
  CommandSpec,
  CommandStreamHandlers,
} from "../process/commandRunner.js";
import {
  parseProviderWorkspaceConfig,
  serializeProviderWorkspaceConfig,
} from "../providerLauncher/workspaceConfig.js";
import { createProviderExecution } from "./execution.js";
import type { ProviderChatRequest } from "./types.js";

const request: ProviderChatRequest = {
  prompt: "fixture",
  workspaceRoot: "/tmp",
  runtime: TEST_RUNTIME,
  route: { providerId: "anthropic", modelId: "haiku", backendKind: "claude-code-auth" },
};

test("quiet tasks survive both historical task deadlines and remain cancellable", async () => {
  const clock = createFakeClock();
  const warnings: string[] = [];
  const spec: CommandSpec = { executable: "fixture", args: [], cwd: "/tmp" };
  let streams: CommandStreamHandlers = {};
  let canceled = false;
  const execution = createProviderExecution(
    request,
    { onResponse() {}, onError() {}, onProgress: (p) => warnings.push(p.text) },
    clock,
  );
  const runner = execution.run(spec, {}, (actual, handlers) => {
    expect(actual.timeoutMs).toBe(0);
    streams = handlers;
    return {
      result: new Promise<CommandResult>(() => {}),
      cancel: () => {
        canceled = true;
      },
    };
  });
  await clock.advance(120_001);
  expect(warnings).toHaveLength(1);
  await clock.advance(600_000);
  expect(canceled).toBe(false);
  streams.onStdout?.("still working");
  expect(clock.pending()).toHaveLength(1);
  runner.cancel();
  execution.finish();
  expect(canceled).toBe(true);
  expect(clock.pending()).toHaveLength(0);
});

test("compatibility attempts share one optional task budget", async () => {
  const clock = createFakeClock();
  const timeouts: number[] = [];
  const execution = createProviderExecution(
    { ...request, providerConfig: { executionTimeoutMs: 1000 } },
    { onResponse() {}, onError() {} },
    clock,
  );
  const launch = () =>
    execution.run({ executable: "fixture", args: [], cwd: "/tmp" }, {}, (spec) => {
      timeouts.push(spec.timeoutMs!);
      return { result: new Promise<CommandResult>(() => {}), cancel() {} };
    });
  launch();
  await clock.advance(700);
  launch();
  await clock.advance(500);
  launch();
  expect(timeouts).toEqual([1000, 300, 1]);
  execution.finish();
  expect(clock.pending()).toHaveLength(0);
});

test("execution deadline configuration preserves zero and rejects unsafe timer values", () => {
  for (const deadline of [0, 1, 600_000, 2_147_483_647]) {
    const config = parseProviderWorkspaceConfig({
      providers: { anthropic: { execution_timeout_ms: deadline } },
    });
    expect(
      parseProviderWorkspaceConfig(serializeProviderWorkspaceConfig(config)).providers?.anthropic
        ?.executionTimeoutMs,
    ).toBe(deadline);
  }
  for (const deadline of [-1, 1.5, NaN, Infinity, 2_147_483_648, "1000"]) {
    expect(
      parseProviderWorkspaceConfig({ providers: { anthropic: { executionTimeoutMs: deadline } } })
        .providers?.anthropic?.executionTimeoutMs,
    ).toBeUndefined();
  }
});

test("synchronous launch failures dispose the inactivity timer", () => {
  const clock = createFakeClock();
  const execution = createProviderExecution(request, { onResponse() {}, onError() {} }, clock);
  expect(() =>
    execution.run({ executable: "fixture", args: [], cwd: "/tmp" }, {}, () => {
      throw new Error("spawn failed");
    }),
  ).toThrow("spawn failed");
  expect(clock.pending()).toHaveLength(0);
});

test("a pending user approval suspends the quiet-provider notice until it is answered", async () => {
  const clock = createFakeClock();
  const warnings: string[] = [];
  const execution = createProviderExecution(
    request,
    { onResponse() {}, onError() {}, onProgress: (p) => warnings.push(p.text) },
    clock,
  );
  execution.run({ executable: "fixture", args: [], cwd: "/tmp" }, {}, () => ({
    result: new Promise<CommandResult>(() => {}),
    cancel: () => undefined,
  }));
  execution.awaitingUser(true);
  expect(clock.pending()).toHaveLength(0);
  await clock.advance(600_000);
  expect(warnings).toEqual([]);
  execution.awaitingUser(false);
  await clock.advance(120_001);
  expect(warnings).toHaveLength(1);
  execution.finish();
  expect(clock.pending()).toHaveLength(0);
});
