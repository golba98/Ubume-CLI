/**
 * Bounded interactive-provider qualification for the local Codexa native models.
 *
 * Runs the real `codexaNativeRuntime` against the configured local checkpoints:
 * one normal generation, one cancelled generation, one more model. No training
 * and no checkpoint writes. A 10-minute aggregate deadline stops the whole
 * script and unloads the runtime even if a generation hangs.
 *
 * Usage: bun scripts/providers/smoke-codexa-native.ts <fresh-output-directory>
 * Safety: local-only (in-process PyTorch); the output directory must not
 * already exist so results cannot be overwritten.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { codexaNativeRuntime, unloadCodexaNative } from "../../src/core/providerRuntime/codexaNative.js";
import { DEFAULT_RUNTIME_CONFIG, resolveRuntimeConfig } from "../../src/config/runtimeConfig.js";
import type { GenerationMetadata, ProviderRunControl } from "../../src/core/providers/types.js";
import type { ProviderChatRequest } from "../../src/core/providerRuntime/types.js";

const AGGREGATE_DEADLINE_MS = 600_000;

const output = process.argv[2];
if (!output || existsSync(output)) throw new Error("Supply a fresh isolated output directory.");
mkdirSync(output, { recursive: true });

// Keep the smoke's app data inside the fresh output directory.
process.env.UBUME_CHANNEL = "local-dev";
process.env.UBUME_DATA_DIR = join(output, "user-data");

let stop: (() => void) | undefined;
let expired = false;
const started = performance.now();
const deadline = setTimeout(() => {
  expired = true;
  stop?.();
  void unloadCodexaNative("Bounded smoke deadline reached.");
}, AGGREGATE_DEADLINE_MS);

const records: unknown[] = [];

function chatRequest(modelId: string, maxNewTokens: number): ProviderChatRequest {
  return {
    prompt: "Reply with only the word READY.",
    route: { providerId: "codexa-native", modelId, backendKind: "codexa-native-pytorch" },
    runtime: resolveRuntimeConfig(DEFAULT_RUNTIME_CONFIG),
    workspaceRoot: process.cwd(),
    providerConfig: { codexaNative: { generation: { preset: "custom", do_sample: false, max_new_tokens: maxNewTokens, repetition_penalty: 1, seed: 42 } } },
  };
}

/**
 * One qualification run. `cancel` requests a run that is interrupted after the
 * first streamed delta. Every run records its observations into smoke.json
 * immediately so evidence survives even a later failure.
 */
async function run(modelId: string, cancel = false) {
  if (expired) throw new Error("Aggregate smoke deadline expired.");

  let control: ProviderRunControl | undefined;
  let metadata: GenerationMetadata | undefined;
  let firstDeltaMs: number | null = null;
  let error = "";
  let text = "";
  let deltaCount = 0;
  const begin = performance.now();

  stop = codexaNativeRuntime.run!(chatRequest(modelId, cancel ? 128 : 32), {
    onRunControl: (value) => { control = value; },
    onAssistantDelta: (delta) => {
      if (firstDeltaMs === null) firstDeltaMs = performance.now() - begin;
      deltaCount++;
      text += delta;
      if (cancel && deltaCount === 1) setTimeout(() => stop?.(), 0);
    },
    onGenerationMetadata: (value) => { metadata = value; },
    onProgress: (event) => console.error(event.text),
    onResponse: () => {},
    onError: (value) => { error = value; },
  });

  await control!.stopped;

  const record = { modelId, canceled: cancel, elapsedMs: performance.now() - begin, firstDeltaMs, deltaCount, text, metadata, error };
  records.push(record);
  writeFileSync(join(output, "smoke.json"), `${JSON.stringify({ started, elapsedMs: performance.now() - started, records }, null, 2)}\n`);

  if (error) throw new Error(error);
  if (!cancel && (!metadata || metadata.modelId !== modelId || text !== metadata.rawOutput || deltaCount < 1)) {
    throw new Error("Real streamed output or model identity failed.");
  }
  if (cancel && metadata) throw new Error("Cancellation did not interrupt generation.");
}

try {
  await run("codexa-934m-balanced");
  await run("codexa-934m-balanced", true);
  await run("codexa-934m-end3");
  console.log(JSON.stringify({ status: "passed", output, records }));
} finally {
  clearTimeout(deadline);
  await unloadCodexaNative("Smoke complete.");
}
