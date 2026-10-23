/**
 * Verifies the Local Harness inside an *installed* package (npm tarball),
 * not the checkout.
 *
 * Root-checkout tests cannot catch differences in the consumer's resolved
 * dependency graph, so this smoke is run after `npm install`-ing the packed
 * tarball into a clean directory: `bun scripts/release/verify-packaged-harness.ts <installed-package-root>`.
 *
 * What it does: starts a loopback-only fake OpenAI-compatible server, points the
 * packaged Local Harness at it, runs one streamed prompt and asserts the exact
 * final text. Everything stays on loopback; no provider, credential or
 * external service is involved. Fails after a 25 s timeout.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RESPONSE_TIMEOUT_MS = 25_000;

const packageRoot = resolve(process.argv[2] ?? ".");
const load = (path: string) => import(pathToFileURL(join(packageRoot, path)).href);
const { localRuntime } = await load("src/core/providerRuntime/local.ts");
const { shutdownLocalHarness } = await load("src/core/providerRuntime/localHarness/runtime.ts");
const { normalizeRuntimeConfig, resolveRuntimeConfig } = await load("src/config/runtimeConfig.ts");

const workspace = mkdtempSync(join(tmpdir(), "ubume-packed-harness-"));

/** Loopback-only fake LM Studio: one model, one SSE completion response. */
const server = Bun.serve({ port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/models")) return Response.json({ data: [{ id: "fixture", loaded: true }] });
  if (path === "/api/inference/status") return Response.json({ active_model: "fixture", supports_tools: true, context_length: 8192 });
  if (path === "/v1/chat/completions") return new Response(
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Packaged Harness works"},"finish_reason":null}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
  return new Response("Not found", { status: 404 });
} });

process.env.UBUME_DATA_DIR = join(workspace, "data");
process.env.UNSLOTH_STUDIO_URL = server.url.toString();
process.env.UNSLOTH_API_KEY = "sk-unsloth-fixture";

let cancel: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const text = await new Promise<string>((resolveResponse, reject) => {
    timer = setTimeout(() => {
      cancel?.();
      reject(new Error("Packaged Harness timed out"));
    }, RESPONSE_TIMEOUT_MS);
    cancel = localRuntime.run({
      prompt: "Hi",
      workspaceRoot: workspace,
      route: { providerId: "local", modelId: "fixture", backendKind: "local-openai-compatible", localBackend: "unsloth" },
      runtime: resolveRuntimeConfig(normalizeRuntimeConfig({ mode: "full-auto", model: "fixture" })),
    }, {
      onResponse: resolveResponse,
      onError: (error: string) => reject(new Error(error)),
    });
  });
  assert.equal(text, "Packaged Harness works");
  console.log("Packaged Harness inference passed");
} finally {
  clearTimeout(timer);
  cancel?.();
  await shutdownLocalHarness();
  server.stop(true);
  rmSync(workspace, { recursive: true, force: true });
}
