import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_RUNTIME_CONFIG, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import type { GenerationMetadata, ProviderRunControl } from "../providers/types.js";
import {
  codexaNativeRuntime,
  discoverCodexaNativeModels,
  nativeCompleteHistory,
  unloadCodexaNative,
} from "./codexaNative.js";
import {
  CODEXA_MODELS,
  CODEXA_TOKENIZER_SHA256,
  codexaPreset,
  resolveCodexaNativeConfig,
  validateCodexaGeneration,
} from "./codexaNativeConfig.js";
import type { ProviderChatRequest } from "./types.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ubume-native-test-"));
  mkdirSync(join(root, "scripts"));
  const checkpoints = Object.fromEntries(
    CODEXA_MODELS.map((model) => {
      const path = join(root, `${model.id}.pt`);
      writeFileSync(path, "fixture");
      writeFileSync(`${path}.sha256`, `${model.sha256}  ${model.id}.pt\n`);
      return [model.id, path];
    }),
  );
  const tokenizer = join(root, "tokenizer.json");
  writeFileSync(tokenizer, "fixture");
  const registry = join(root, "artifacts.codexa-native.local.json");
  writeFileSync(
    registry,
    JSON.stringify({
      format: "codexa-native-registry-v1",
      tokenizer,
      tokenizer_sha256: CODEXA_TOKENIZER_SHA256,
      models: Object.fromEntries(
        CODEXA_MODELS.map((model) => [
          model.id,
          { path: checkpoints[model.id], sha256: model.sha256 },
        ]),
      ),
    }),
  );
  writeFileSync(
    join(root, "scripts", "native_chat_bridge.py"),
    `const readline = require('node:readline');
const argv = process.argv; const arg = key => argv[argv.indexOf(key)+1];
const model = arg('--model-id'), sha = arg('--expected-checkpoint-sha256'); const protocol = 'codexa-native-jsonl-v2';
const emit = value => console.log(JSON.stringify({protocol,...value}));
emit({type:'ready',model_id:model,checkpoint_sha256:sha,tokenizer_sha256:arg('--expected-tokenizer-sha256'),context_length:2048});
readline.createInterface({input:process.stdin}).on('line', line => { const req = JSON.parse(line); const prompt = req.messages.at(-1).content;
 if(prompt==='hang') return;
 if(prompt==='crash') {process.exit(2); return;}
 if(prompt==='malformed') { console.log('not json'); return; }
 let sequence=0; const event=(type,fields)=>emit({id:req.id,sequence:++sequence,type,...fields});
 event('context',{input_tokens:16,context_length:2048,dropped_turns:0});
 if(prompt==='order') sequence++;
 event('delta',{text:'Hi '});
 setTimeout(()=>{event('delta',{text:'🌍'});event('done',{text:'Hi 🌍',model_id:model,checkpoint_sha256:sha,finish_reason:'stop',termination_cause:'stop_token',generated_tokens:3,input_tokens:16,elapsed_seconds:0.01,first_token_seconds:0.001,tokens_per_second:300});},15);
});`,
  );
  return {
    root,
    config: resolveCodexaNativeConfig({
      CODEXA_NATIVE_MODEL_ROOT: root,
      CODEXA_NATIVE_PYTHON: process.execPath,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function request(
  root: string,
  modelId = "codexa-934m-balanced",
  prompt = "hello",
): ProviderChatRequest {
  return {
    prompt,
    route: { providerId: "codexa-native", modelId, backendKind: "codexa-native-pytorch" },
    runtime: resolveRuntimeConfig(DEFAULT_RUNTIME_CONFIG),
    workspaceRoot: root,
    providerConfig: { codexaNative: { modelRoot: root, python: process.execPath } },
  };
}
async function run(req: ProviderChatRequest, cancel = false) {
  const chunks: string[] = [];
  let metadata: GenerationMetadata | undefined;
  let control: ProviderRunControl | undefined;
  let error = "";
  let response = "";
  const stop = codexaNativeRuntime.run!(req, {
    onRunControl: (value) => {
      control = value;
    },
    onAssistantDelta: (chunk) => chunks.push(chunk),
    onGenerationMetadata: (value) => {
      metadata = value;
    },
    onResponse: (value) => {
      response = value;
    },
    onError: (value) => {
      error = value;
    },
  });
  if (cancel) setTimeout(stop, 30);
  await control!.stopped;
  return { chunks, metadata, error, response, stop };
}

test("five native variants are visible; production excludes them", () => {
  const f = fixture();
  try {
    const dev = discoverCodexaNativeModels(f.config, { UBUME_CHANNEL: "local-dev" });
    assert.deepEqual(
      dev.models.map((model) => model.modelId),
      CODEXA_MODELS.map((model) => model.id),
    );
    assert.ok(
      dev.models.every(
        (model) =>
          model.available && model.capabilities?.tools === false && model.contextWindow === 2048,
      ),
    );
    assert.equal(
      discoverCodexaNativeModels(f.config, { UBUME_CHANNEL: "published" }).models.length,
      0,
    );
  } finally {
    f.cleanup();
  }
});
test("missing models remain visible with unavailable status; no substitution", () => {
  const f = fixture();
  try {
    delete f.config.checkpoints[CODEXA_MODELS[1].id];
    const result = discoverCodexaNativeModels(f.config, { UBUME_CHANNEL: "local-dev" });
    assert.equal(result.models.length, CODEXA_MODELS.length);
    assert.equal(result.models[1]?.available, false);
  } finally {
    f.cleanup();
  }
});
test("preset defaults and validation are effective", () => {
  assert.equal(codexaPreset().do_sample, false);
  assert.equal(codexaPreset("conversation").do_sample, true);
  for (const bad of [
    { max_new_tokens: 2048 },
    { seed: -1 },
    { temperature: NaN },
    { top_p: 2 },
    { top_k: 20000 },
  ])
    assert.throws(() => validateCodexaGeneration(bad));
});
test("native managed transport streams, switches, cancels and recovers from broken protocol", async () => {
  const f = fixture();
  const before = process.env.UBUME_CHANNEL;
  process.env.UBUME_CHANNEL = "local-dev";
  try {
    const first = await run(request(f.root));
    assert.equal(first.error, "");
    assert.deepEqual(first.chunks, ["Hi ", "🌍"]);
    assert.equal(first.metadata?.modelId, "codexa-934m-balanced");
    assert.equal(first.response, "Hi 🌍");
    first.stop();
    const switched = await run(request(f.root, "codexa-934m-end3"));
    assert.equal(switched.metadata?.modelId, "codexa-934m-end3");
    for (const prompt of ["malformed", "order", "crash"]) {
      const failed = await run(request(f.root, "codexa-934m-end3", prompt));
      assert.ok(failed.error, prompt);
      const retry = await run(request(f.root));
      assert.equal(retry.response, "Hi 🌍");
    }
    const canceled = await run(request(f.root, "codexa-934m-balanced", "hang"), true);
    assert.equal(canceled.response, "");
    assert.equal(canceled.error, "");
    const last = await run(request(f.root));
    assert.equal(last.response, "Hi 🌍");
    const unknown = await run(request(f.root, "codexa-unknown"));
    assert.match(unknown.error, /Select/);
  } finally {
    await unloadCodexaNative();
    if (before === undefined) delete process.env.UBUME_CHANNEL;
    else process.env.UBUME_CHANNEL = before;
    f.cleanup();
  }
});

test("generation deadline kills owned worker and next request recovers", async () => {
  const f = fixture();
  const before = process.env.UBUME_CHANNEL;
  process.env.UBUME_CHANNEL = "local-dev";
  try {
    const req = request(f.root, "codexa-934m-balanced", "hang");
    req.providerConfig!.codexaNative!.generationTimeoutMs = 1000;
    const result = await run(req);
    assert.match(result.error, /timed out/);
    assert.equal((await run(request(f.root))).response, "Hi 🌍");
  } finally {
    await unloadCodexaNative();
    if (before === undefined) delete process.env.UBUME_CHANNEL;
    else process.env.UBUME_CHANNEL = before;
    f.cleanup();
  }
});

test("failed unanswered turns do not poison the next native prompt", () => {
  const result = nativeCompleteHistory([
    { role: "user", content: "unanswered" },
    { role: "user", content: "question" },
    { role: "assistant", content: "raw answer  " },
    { role: "user", content: "empty response" },
    { role: "assistant", content: "" },
  ]);
  assert.equal(result.omitted, 3);
  assert.deepEqual(result.messages, [
    { role: "user", content: "question" },
    { role: "assistant", content: "raw answer  " },
  ]);
});
