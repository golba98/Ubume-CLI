import { expect, test } from "bun:test";
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import type { runCommand } from "../process/commandRunner.js";
import {
  applyAgyEffortMetadata,
  getAgyModelSelector,
  parseAgyModelsOutput,
  runAntigravityWithRunner,
} from "./antigravity.js";

const output =
  "gemini-99.8-flash-high\tGemini 99.8 Flash (High)\ngemini-99.8-flash-medium\tGemini 99.8 Flash (Medium)\ngemini-99.8-flash-low\tGemini 99.8 Flash (Low)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)";
test("single tabs preserve exact future AGY slugs and provider identities", () => {
  const models = parseAgyModelsOutput(output);
  expect(models.length).toBe(4);
  expect(models[0]?.modelId).toBe("gemini-99.8-flash-high");
  expect(models[0]?.providerId).toBe("google");
  expect(getAgyModelSelector(models[0]!.modelId, "low", models)).toBe("gemini-99.8-flash-low");
});
test("repeat refresh fixtures do not duplicate model identities", () =>
  expect(parseAgyModelsOutput(output + "\n" + output).length).toBe(4));
test("withdrawn variants cannot be synthesized", () => {
  const models = parseAgyModelsOutput("gemini-99.8-flash-low\tGemini 99.8 Flash (Low)");
  expect(getAgyModelSelector("gemini-99.8-flash-high", "high", models)).toBeNull();
  expect(models[0]?.reasoningControl?.kind).toBe("fixed");
});
test("Opus 4.6 is fixed only after provider confirms read-only effort metadata", () => {
  const model = parseAgyModelsOutput(output)[3]!;
  expect(model.reasoningControl?.kind).toBe("unknown");
  const fixed = applyAgyEffortMetadata(
    model,
    JSON.stringify({ command: { name: "effort", data: { adjustable: false } } }),
  );
  expect(fixed.reasoningControl?.kind).toBe("fixed");
  expect(fixed.supportedReasoningLevels).toBeNull();
});
test("provider-advertised parameter control and malformed metadata stay accurate", () => {
  const model = parseAgyModelsOutput(output)[3]!;
  const adjusted = applyAgyEffortMetadata(
    model,
    JSON.stringify({
      command: {
        name: "effort",
        data: { adjustable: true, current: "medium", available: ["low", "medium", "high"] },
      },
    }),
  );
  expect(adjusted.supportedReasoningLevels?.length).toBe(3);
  expect(applyAgyEffortMetadata(model, "bad")).toBe(model);
  expect(
    applyAgyEffortMetadata(
      model,
      JSON.stringify({ command: { name: "effort", data: { adjustable: true, available: [{}] } } }),
    ),
  ).toBe(model);
});
test("execution carries exact slug plus only verified parameter effort", async () => {
  const model = applyAgyEffortMetadata(
    parseAgyModelsOutput(output)[3]!,
    JSON.stringify({
      command: {
        name: "effort",
        data: { adjustable: true, current: "medium", available: ["low", "medium", "high"] },
      },
    }),
  );
  let args: string[] = [];
  const runner = ((spec: Parameters<typeof runCommand>[0]) => {
    args = spec.args;
    return {
      child: null,
      result: Promise.resolve({
        status: "completed",
        exitCode: 0,
        signal: null,
        stdout: "done",
        stderr: "",
        startedAt: 0,
        endedAt: 0,
        durationMs: 0,
        userMessage: "done",
      }),
      cancel: () => {},
    };
  }) as unknown as typeof runCommand;
  await new Promise<void>((resolve, reject) =>
    runAntigravityWithRunner(
      {
        prompt: "hello",
        route: {
          providerId: "google",
          modelId: model.modelId,
          reasoning: "low",
          backendKind: "antigravity-cli-auth",
        },
        workspaceRoot: "/tmp",
        runtime: resolveRuntimeConfig(normalizeRuntimeConfig({})),
      },
      { onResponse: () => resolve(), onError: reject },
      runner,
      "agy",
      process.platform,
      [model],
    ),
  );
  expect(args).toEqual([
    "--model",
    "claude-opus-4-6-thinking",
    "--effort",
    "low",
    "--mode",
    "auto",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "0",
    "-p",
    "hello",
  ]);
});

test("selected future AGY models resolve adjustable capabilities without requiring a Thinking label", async () => {
  const { resolveAgyReasoningCapability } = await import("./antigravity.js");
  const model = parseAgyModelsOutput("claude-future-99\tClaude Future 99")[0]!;
  let args: string[] = [];
  const runner = ((spec: Parameters<typeof runCommand>[0]) => {
    args = spec.args;
    return {
      child: null,
      cancel: () => {},
      result: Promise.resolve({
        status: "completed",
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          command: {
            name: "effort",
            data: { adjustable: true, current: "medium", available: ["low", "medium", "high"] },
          },
          num_turns: 0,
          usage: { total_tokens: 0 },
        }),
        stderr: "",
        startedAt: 0,
        endedAt: 0,
        durationMs: 0,
        userMessage: "done",
      }),
    };
  }) as unknown as typeof runCommand;
  const resolved = await resolveAgyReasoningCapability(model, {
    executable: "agy",
    cwd: "/tmp",
    runCommandImpl: runner,
  });
  expect(args).toEqual(["--model", model.modelId, "-p", "/effort", "--output-format", "json"]);
  expect(resolved.supportedReasoningLevels?.map((l) => l.id)).toEqual(["low", "medium", "high"]);
  expect(resolved.modelId).toBe(model.modelId);
});
