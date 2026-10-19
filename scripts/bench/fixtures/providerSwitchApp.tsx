/**
 * Offline provider-switching stress fixture: the real App and routing boundary in Ink's
 * in-memory terminal, with every provider runtime replaced by a local fake (synthetic
 * catalogs, scripted failures). Run by `scripts/bench/provider-switch.ts` in an isolated
 * sandbox; prints one JSON result line. Network and provider CLIs are unreachable.
 *
 *   bun providerSwitchApp.tsx <scenario> <iterations>
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { App } from "../../../src/app/App.js";
import { parseLaunchArgs } from "../../../src/config/launchArgs.js";
import { loadSettings, saveSettings } from "../../../src/config/persistence.js";
import { providerCatalog } from "../../../src/core/models/modelCatalog.js";
import {
  loadProviderWorkspaceConfig,
  saveProviderWorkspaceConfig,
} from "../../../src/core/providerLauncher/workspaceConfig.js";
import { getProviderRuntime } from "../../../src/core/providerRuntime/registry.js";
import type { ProviderModelDiscoveryResult } from "../../../src/core/providerRuntime/types.js";
import { createTestTerminal } from "../../../src/test/terminal.js";

// Loopback-only network: a stand-in LM Studio server makes Local a reachable backend.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") {
    return Promise.reject(new Error("network access is forbidden in the provider-switch benchmark"));
  }
  return realFetch(input, init);
}) as typeof fetch;
const lmStudio = createServer((request, response) => {
  const model = { id: "local-working", object: "model", type: "llm", state: "loaded", max_context_length: 8192 };
  const body = request.url?.startsWith("/api/v0/models/")
    ? model
    : request.url?.startsWith("/api/v0/models")
      ? { object: "list", data: [model] }
      : { object: "list", data: [{ id: "local-working", object: "model" }] };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
});
await new Promise<void>((resolve) => lmStudio.listen(0, "127.0.0.1", resolve));
const lmStudioUrl = `http://127.0.0.1:${(lmStudio.address() as AddressInfo).port}/v1`;
saveProviderWorkspaceConfig(process.cwd(), {
  providers: { local: { localBackend: "lm-studio", baseUrl: lmStudioUrl } },
});

// Active-timer accounting (setTimeout/setInterval minus cleared or fired one-shots).
const activeTimers = new Set<unknown>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const id: unknown = realSetTimeout(
    (...inner: unknown[]) => {
      activeTimers.delete(id);
      handler(...inner);
    },
    ms,
    ...args,
  );
  activeTimers.add(id);
  return id;
}) as typeof setTimeout;
globalThis.clearTimeout = ((id: unknown) => {
  activeTimers.delete(id);
  realClearTimeout(id as ReturnType<typeof setTimeout>);
}) as typeof clearTimeout;
globalThis.setInterval = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const id: unknown = realSetInterval(handler, ms, ...args);
  activeTimers.add(id);
  return id;
}) as typeof setInterval;
globalThis.clearInterval = ((id: unknown) => {
  activeTimers.delete(id);
  realClearInterval(id as ReturnType<typeof setInterval>);
}) as typeof clearInterval;

const scenario = process.argv[2] ?? "cycle";
const iterations = Number(process.argv[3] ?? 100);
const settings = loadSettings();
saveSettings({ ...settings, updateCheck: { ...settings.updateCheck!, enabled: false } });

const PROVIDERS = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
  { id: "mistral", label: "Mistral Vibe CLI" },
  { id: "local", label: "Local" },
] as const;
type ProviderIdLike = (typeof PROVIDERS)[number]["id"];

const counters = { discover: 0, refresh: 0, run: 0, validate: 0 };
let generation = 0;
for (const { id } of PROVIDERS) {
  const runtime = getProviderRuntime(id);
  const snapshot = (): ProviderModelDiscoveryResult => ({
    providerId: id,
    backendKind: runtime.backendKind,
    status: "ready",
    freshness: "verified",
    complete: true,
    models: [`${id}-working`, `${id}-alt`].map((modelId) => ({
      id: modelId,
      modelId,
      label: modelId,
      description: null,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
      source: "discovered" as const,
    })),
  });
  runtime.isRouteConfigured = () => true;
  runtime.discoverModels = () => {
    counters.discover += 1;
    return snapshot();
  };
  runtime.refreshModels = async () => {
    counters.refresh += 1;
    if (scenario === "during-discovery") await new Promise((resolve) => setTimeout(resolve, 400));
    if (scenario === "stale") {
      return { ...snapshot(), freshness: "unverified", refreshState: "failed", message: "stale" };
    }
    return snapshot();
  };
  runtime.validateRoute = async () => {
    counters.validate += 1;
    return { status: "ready", providerId: id, backendKind: runtime.backendKind };
  };
  runtime.run = (request, handlers) => {
    counters.run += 1;
    handlers.onRunControl?.({ stopped: Promise.resolve() });
    queueMicrotask(() => {
      if (scenario === "after-failure") handlers.onError("Temporary service outage (HTTP 503)");
      else if (scenario === "missing-model")
        handlers.onError(`MODEL_NOT_FOUND: model ${request.route.modelId} is unavailable.`);
      else handlers.onResponse(`SWITCH_OK:${id}:${generation}`);
    });
    return () => {};
  };
}

const parsed = parseLaunchArgs([]);
if (!parsed.ok) throw new Error(parsed.error);
const terminal = createTestTerminal(<App launchArgs={parsed.value} />, { columns: 120, rows: 40 });
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const frame = () => strip(terminal.lastFrame());
const pause = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
const keyPause = scenario === "rapid" ? 5 : 25;

async function until(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${label}\n${frame()}`);
    await pause(10);
  }
}

async function command(text: string): Promise<void> {
  terminal.stdin.write("\x15");
  await pause(keyPause);
  terminal.stdin.write(text);
  await pause(keyPause * 2);
  terminal.stdin.write("\r");
  await pause(keyPause);
}

const pickerOpen = () => frame().includes("Providers   Enter use");

/** Opens /providers and moves the cursor onto `label` by reading the picker frame. */
async function highlight(label: string): Promise<void> {
  await command("/providers");
  await until(pickerOpen, "provider picker");
  terminal.stdin.write("\x1b[H");
  await pause(keyPause);
  for (let step = 0; step < PROVIDERS.length + 1; step += 1) {
    if (new RegExp(`> ${label}\\b`).test(frame())) return;
    terminal.stdin.write("\x1b[B");
    await pause(keyPause);
  }
  throw new Error(`could not highlight ${label}`);
}

async function select(id: ProviderIdLike): Promise<void> {
  const target = PROVIDERS.find((provider) => provider.id === id)!;
  const started = performance.now();
  await highlight(target.label);
  terminal.stdin.write("\r");
  await until(() => !pickerOpen(), "picker closed after selection");
  // Local first asks for a backend (LM Studio / Unsloth).
  await pause(keyPause * 2);
  for (let attempt = 0; frame().includes("Local Backends") && attempt < 20; attempt += 1) {
    await pause(60);
    terminal.stdin.write("\r");
    await pause(150);
  }
  // Selection may open the model picker for a provider without a saved model.
  for (let attempt = 0; frame().includes("Select model") && attempt < 20; attempt += 1) {
    await pause(60); // focus moves to the picker a frame after it renders
    terminal.stdin.write("\r");
    await pause(120);
  }
  await until(() => !frame().includes("Select model"), "model picker closed");
  await until(
    () => loadProviderWorkspaceConfig(process.cwd()).activeRoute?.providerId === id,
    `saved route is ${id}`,
  );
  switchTimes.push(performance.now() - started);
  const route = loadProviderWorkspaceConfig(process.cwd()).activeRoute;
  // No silent fallback: the route never carries another provider's model. (A provider may
  // keep its configured default when its catalog is stale or still loading.)
  const foreign = PROVIDERS.find(
    (provider) => provider.id !== id && route?.modelId?.startsWith(`${provider.id}-`),
  );
  if (foreign) throw new Error(`route ${id} carries ${foreign.id}'s model ${route?.modelId}`);
}

async function abortSelection(): Promise<void> {
  const before = loadProviderWorkspaceConfig(process.cwd()).activeRoute?.providerId;
  await highlight("Mistral Vibe CLI");
  terminal.stdin.write("\x1b");
  await until(() => !pickerOpen(), "picker dismissed");
  const after = loadProviderWorkspaceConfig(process.cwd()).activeRoute?.providerId;
  if (before !== after) throw new Error("aborted selection changed the route");
}

async function runPrompt(): Promise<void> {
  generation += 1;
  const marker =
    scenario === "after-failure"
      ? "HTTP 503"
      : scenario === "missing-model"
        ? "unavailable"
        : "SWITCH_OK";
  const before = terminal.output().length;
  await command(`switch probe ${generation}`);
  await until(() => terminal.output().slice(before).includes(marker), "provider response");
}

function childProcessCount(): number {
  try {
    const out = execFileSync("ps", ["-o", "pid=", "--ppid", String(process.pid)], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.trim()).length - 1; // minus the ps itself
  } catch {
    return 0;
  }
}

const jscModule = "bun:jsc";
const jsc = (await import(jscModule)) as {
  fullGC(): void;
  heapStats(): { heapSize: number; objectCount: number };
};
async function checkpoint(label: string) {
  await pause(50);
  jsc.fullGC();
  await pause(0);
  jsc.fullGC();
  const heap = jsc.heapStats();
  const catalog = providerCatalog as unknown as { listeners?: Set<unknown>; entries?: Map<unknown, unknown> };
  return {
    label,
    liveHeap: heap.heapSize,
    objects: heap.objectCount,
    rss: process.memoryUsage().rss,
    activeTimers: activeTimers.size,
    childProcesses: childProcessCount(),
    catalogListeners: catalog.listeners?.size ?? null,
    catalogEntries: catalog.entries?.size ?? null,
    stdinListeners: terminal.stdin.listenerCount("data") + terminal.stdin.listenerCount("readable"),
    stdoutListeners: terminal.stdout.listenerCount("resize"),
  };
}

const switchTimes: number[] = [];
let peakRss = 0;
const sampler = realSetInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 20);

async function iteration(index: number): Promise<void> {
  switch (scenario) {
    case "cycle":
      for (const id of ["openai", "anthropic", "google", "mistral"] as const) await select(id);
      return;
    case "same":
      await select("anthropic");
      return;
    case "alternate":
      await select(index % 2 === 0 ? "openai" : "anthropic");
      return;
    case "local-to-external":
      await select("local");
      await select("openai");
      return;
    case "after-failure":
    case "missing-model":
      // OpenAI routes through the real Codex adapter (no codex on the sandbox PATH), so the
      // failing turn runs on a patched provider before switching away from it.
      await select("anthropic");
      await runPrompt();
      await select(index % 2 === 0 ? "google" : "mistral");
      return;
    case "during-discovery":
      // Select again while the previous provider's 400ms refresh is still running.
      await select(index % 2 === 0 ? "google" : "anthropic");
      return;
    case "stale":
      await select(index % 2 === 0 ? "mistral" : "openai");
      return;
    case "rapid":
      await select(PROVIDERS[index % 4]!.id);
      return;
    case "abort":
      await abortSelection();
      return;
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

const result: Record<string, unknown> = { scenario, iterations };
try {
  await until(() => frame().includes("Ask Ubume"), "initial frame", 15000);
  await select("openai");
  const checkpoints = [await checkpoint("start")];
  const every = Math.max(1, Math.floor(iterations / 4));
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    await iteration(index);
    if ((index + 1) % every === 0) checkpoints.push(await checkpoint(`after-${index + 1}`));
  }
  result.totalMs = performance.now() - started;
  await pause(500); // let in-flight refreshes settle before the final reading
  checkpoints.push(await checkpoint("settled"));
  result.checkpoints = checkpoints;
  result.switchTimesMs = switchTimes;
  result.peakRss = peakRss;
  result.counters = counters;
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = String(error).slice(0, 2000);
} finally {
  realClearInterval(sampler);
  terminal.dispose();
  lmStudio.close();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
