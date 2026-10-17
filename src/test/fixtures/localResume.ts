/**
 * Process entrypoint for durable Local Harness restart tests.
 * The caller provides an isolated workspace/data home and a loopback backend.
 * Each successful turn saves its conversation before shutting down the Harness.
 */
import { normalizeRuntimeConfig, resolveRuntimeConfig } from "../../config/runtimeConfig.js";
import type { LocalBackendId } from "../../core/providerLauncher/types.js";
import { localRuntime } from "../../core/providerRuntime/local.js";
import { shutdownLocalHarness } from "../../core/providerRuntime/localHarness/runtime.js";
import { ConversationStore } from "../../core/workspace/conversationStore.js";

const backend: LocalBackendId = parseBackend(process.argv[2]);
const turnArgument = process.argv[3];
const turn = Number(turnArgument);
if (!turnArgument || !/^\d+$/.test(turnArgument) || !Number.isSafeInteger(turn) || turn < 1) {
  throw new Error("localResume requires a positive integer turn number");
}

function parseBackend(value: string | undefined): LocalBackendId {
  if (value === "lm-studio" || value === "unsloth") return value;
  throw new Error("localResume requires backend lm-studio or unsloth");
}

const store = new ConversationStore(process.cwd());
const route = {
  providerId: "local" as const,
  modelId: "fixture",
  backendKind: "local-openai-compatible" as const,
  localBackend: backend,
};
try {
  const existing = turn === 1 ? undefined : store.list()[0];
  if (turn !== 1 && !existing) {
    throw new Error(`Cannot resume turn ${turn}: no saved conversation in the fixture workspace`);
  }
  const record = existing ? store.load(existing.id) : store.createConversation(route);
  if (!record) throw new Error(`Cannot load saved conversation ${existing?.id}`);
  const run = localRuntime.run;
  if (!run) throw new Error("Local runtime does not support fixture execution");
  const prompt = `turn ${turn}`;
  const answer = await new Promise<string>((resolve, reject) => {
    run(
      {
        prompt,
        workspaceRoot: process.cwd(),
        route,
        conversationHistory: record.messages,
        localHarnessSession: record.metadata.localHarnessSession,
        runtime: resolveRuntimeConfig(
          normalizeRuntimeConfig({ mode: "full-auto", model: "fixture" }),
        ),
      },
      {
        onResponse: resolve,
        onError: (error) => reject(new Error(error)),
        onLocalHarnessSession: (metadata) => {
          if (metadata) record.metadata.localHarnessSession = metadata;
        },
      },
    );
  });
  record.messages.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
  store.save(record);
  console.log(
    JSON.stringify({
      id: record.metadata.id,
      harness: record.metadata.localHarnessSession,
      answer,
    }),
  );
} finally {
  try {
    await shutdownLocalHarness();
  } finally {
    store.release();
  }
}
