/** Deterministic offline fixtures; launched only through run.py's namespace and preload. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  readSync,
  writeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { PassThrough } from "node:stream";
import type { BackendProvider } from "../../src/core/providers/types.js";
import type { ProviderId } from "../../src/core/providerLauncher/types.js";
import type {
  ProviderModelDiscoveryResult,
  ProviderRuntime,
} from "../../src/core/providerRuntime/types.js";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const caseName = process.argv[2];
if (process.env.UBUME_BENCH_CLOCK_READ && process.env.UBUME_BENCH_CLOCK_WRITE) {
  for (let i = 0; i < 10; i++) {
    readSync(Number(process.env.UBUME_BENCH_CLOCK_READ), Buffer.alloc(1), 0, 1, null);
    writeSync(Number(process.env.UBUME_BENCH_CLOCK_WRITE), `${process.hrtime.bigint()}\n`);
  }
}

function childMemory(
  pid = process.pid,
  seen = new Set<number>(),
): Array<{ pid: number; pssKiB: number }> {
  if (seen.has(pid)) return [];
  seen.add(pid);
  const children = new Set<number>();
  try {
    for (const task of readdirSync(`/proc/${pid}/task`)) {
      for (const value of readFileSync(`/proc/${pid}/task/${task}/children`, "utf8")
        .trim()
        .split(/\s+/)) {
        if (value) children.add(Number(value));
      }
    }
  } catch {
    return [];
  }
  return [...children].flatMap((child) => {
    try {
      const memory = readFileSync(`/proc/${child}/smaps_rollup`, "utf8");
      return [
        { pid: child, pssKiB: Number(memory.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0) },
        ...childMemory(child, seen),
      ];
    } catch {
      return [];
    }
  });
}

const sample = () => ({
  t: performance.now(),
  children: childMemory(),
  usage: process.memoryUsage(),
  smaps: readFileSync("/proc/self/smaps_rollup", "utf8"),
  listeners: Object.fromEntries(
    ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].map((name) => [
      name,
      process.listenerCount(name),
    ]),
  ),
  resources: process.getActiveResourcesInfo?.() ?? [],
});
async function heap() {
  const jsc = await import("bun:jsc");
  jsc.fullGC();
  await sleep(5);
  jsc.fullGC();
  return jsc.heapStats();
}
function report(value: unknown) {
  console.log(JSON.stringify(value));
}

if (caseName === "imports") {
  const graph = process.env.IMPORT_GRAPH;
  const before = sample();
  if (graph === "ink") await import("ink");
  if (graph === "app") await import("../../src/app/App.js");
  if (graph === "harness-module")
    await import("../../src/core/providerRuntime/localHarness/runtime.js");
  const afterImport = sample();
  const stats = await heap();
  const snapshot = Bun.generateHeapSnapshot() as { nodes: number[]; nodeClassNames: string[] };
  const classes = new Map<string, { count: number; shallowBytes: number }>();
  for (let i = 0; i < snapshot.nodes.length; i += 4) {
    const name = snapshot.nodeClassNames[snapshot.nodes[i + 2]];
    const entry = classes.get(name) ?? { count: 0, shallowBytes: 0 };
    entry.count++;
    entry.shallowBytes += snapshot.nodes[i + 1];
    classes.set(name, entry);
  }
  report({
    graph,
    before,
    afterImport,
    diagnosticHeap: {
      heapSize: stats.heapSize,
      heapCapacity: stats.heapCapacity,
      extraMemorySize: stats.extraMemorySize,
      objectCount: stats.objectCount,
    },
    topClasses: [...classes].sort((a, b) => b[1].shallowBytes - a[1].shallowBytes).slice(0, 20),
  });
} else if (caseName === "safety") {
  assert.throws(() => spawn("/usr/bin/false", []), /OFFLINE EXECUTABLE BLOCKED/);
  assert.throws(() => spawn("/home/not-exposed/codex", []), /OFFLINE EXECUTABLE BLOCKED/);
  assert.throws(() => spawn("codex", []), /OFFLINE EXECUTABLE BLOCKED/);
  assert.throws(() => fetch("https://example.invalid"), /OFFLINE NETWORK BLOCKED/);
  const resolved = await import("../../src/core/executables/codexExecutable.js");
  const fake = await resolved.resolveCodexExecutable();
  assert.equal(fake, "/bench/fakes/provider");
  const child = spawnSync(fake, ["--version"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.match(child.stdout, /offline-fake/);
  const { normalizeRuntimeConfig, resolveRuntimeConfig } = await import(
    "../../src/config/runtimeConfig.js"
  );
  const { codexSubprocessProvider } = await import("../../src/core/providers/codexSubprocess.js");
  // Missing explicit target must fail before any prompt child is spawned.
  const message = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("missing executable did not fail")), 3000);
    codexSubprocessProvider.run!(
      "never send",
      {
        workspaceRoot: process.cwd(),
        runtime: resolveRuntimeConfig(
          normalizeRuntimeConfig({ codexCommandPath: "/missing/explicit/codex" }),
        ),
      },
      {
        onResponse: () => reject(new Error("unexpected response")),
        onError: (m) => {
          clearTimeout(timeout);
          resolve(m);
        },
      },
    );
  });
  assert.match(message, /does not exist/);
  const answer = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fake execution timed out")), 5000);
    codexSubprocessProvider.run!(
      "offline test",
      {
        workspaceRoot: process.cwd(),
        runtime: resolveRuntimeConfig(normalizeRuntimeConfig({ codexCommandPath: fake })),
      },
      {
        onResponse: (text) => {
          clearTimeout(timeout);
          resolve(text);
        },
        onError: (m) => {
          clearTimeout(timeout);
          reject(new Error(m));
        },
      },
    );
  });
  assert.equal(answer, "offline fake answer");
  report({
    ok: true,
    answer,
    rejected: [
      "absolute executable",
      "hidden home executable",
      "bare provider",
      "external fetch",
      "missing explicit path",
    ],
    fake,
  });
} else if (caseName === "throughput") {
  const { runCommand } = await import("../../src/core/process/commandRunner.js");
  const cases = [];
  for (const kind of ["ascii", "utf8"]) {
    const value = kind === "ascii" ? "x".repeat(65536) : "你好🌸".repeat(8192);
    const code = `const b=Buffer.from(${JSON.stringify(value)}); let n=0;function next(){while(n++<160){if(!process.stdout.write(b)){process.stdout.once('drain',next);return}}}next()`;
    const before = sample();
    let bytes = 0;
    const runner = runCommand(
      { executable: "/usr/bin/node", args: ["-e", code], cwd: process.cwd() },
      { onStdout: (t) => (bytes += Buffer.byteLength(t)) },
    );
    const result = await runner.result;
    await runner.stopped;
    assert.equal(result.stdout, value.repeat(160));
    assert.equal(result.stdout.includes("�"), false);
    cases.push({ kind, wallMs: performance.now() - before.t, bytes, before, after: sample() });
  }
  report(cases);
} else if (caseName === "headless") {
  const bytes = 20 * 1024 * 1024;
  const start = performance.now();
  const child = spawn(
    "/runtime/bun",
    [
      "--preload",
      "/workspace/perf/phase1_1/guard.cjs",
      "/workspace/src/cli.ts",
      "exec",
      "--no-save",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4",
      "offline fixture",
    ],
    { env: { ...process.env, HEADLESS_BYTES: String(bytes) }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let received = 0;
  let bad = false;
  let errors = "";
  let peakRssKiB = 0;
  const poll = setInterval(() => {
    try {
      const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
      peakRssKiB = Math.max(peakRssKiB, Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0));
    } catch {
      /* Child exited between procfs reads. */
    }
  }, 2);
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    received += (text.match(/x/g) ?? []).length;
    bad ||= /[^x\r\n]/.test(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4000);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  clearInterval(poll);
  assert.equal(code, 0, errors);
  assert.equal(received, bytes + 65536);
  assert.equal(bad, false);
  report({ bytes, received, peakRssKiB, wallMs: performance.now() - start });
} else if (caseName === "storage") {
  const { runCommand } = await import("../../src/core/process/commandRunner.js");
  const { sanitizeTerminalLines } = await import("../../src/core/terminal/terminalSanitize.js");
  const bytes = Number(process.env.SHELL_BYTES);
  const mode = process.env.STORAGE_MODE;
  const output = "x".repeat(99) + "\n";
  const count = Math.ceil(bytes / output.length);
  const code = `const b=Buffer.from(${JSON.stringify(output)});let i=0;function next(){while(i++<${count}){if(!process.stdout.write(b)){process.stdout.once('drain',next);return}}}next()`;
  const spool = "/bench/output-spool";
  writeFileSync(spool, "");
  const start = performance.now();
  let peak = process.memoryUsage().rss;
  const poll = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 2);
  const runner = runCommand(
    {
      executable: "/usr/bin/node",
      args: ["-e", code],
      cwd: process.cwd(),
      capture: mode === "spool" ? { maxChars: 4096 } : "full",
    },
    mode === "spool" ? { onStdout: (t) => appendFileSync(spool, t) } : {},
  );
  const result = await runner.result;
  await runner.stopped;
  const complete = mode === "spool" ? readFileSync(spool, "utf8") : result.stdout;
  const lines = sanitizeTerminalLines(complete.split(/\r?\n/));
  assert.equal(lines.length, count);
  assert.equal(complete, output.repeat(count));
  peak = Math.max(peak, process.memoryUsage().rss);
  clearInterval(poll);
  unlinkSync(spool);
  assert.equal(existsSync(spool), false);
  assert.throws(
    () => writeFileSync("/workspace/perf/phase1_1/read-only-spool-probe", "fixture"),
    /EROFS|EACCES/,
  );
  report({
    mode,
    bytes,
    lines: lines.length,
    wallMs: performance.now() - start,
    peakRss: peak,
    final: sample(),
  });
} else if (caseName === "switch") {
  const { ModelCatalog } = await import("../../src/core/models/modelCatalog.js");
  const { SelectionCoordinator } = await import("../../src/core/models/selectionCoordinator.js");
  const ids: ProviderId[] = ["openai", "anthropic", "google", "mistral", "local"];
  const scenarios = [
    "cycle",
    "alternate",
    "local",
    "missing",
    "discovery-failure",
    "cancel",
    "rapid",
    "stale",
    "execution-failure",
  ];
  const results = [];
  for (const scenario of scenarios) {
    const catalog = new ModelCatalog(undefined, 50);
    const coordinator = new SelectionCoordinator();
    let notifications = 0;
    const unsubscribe = catalog.subscribe(() => notifications++);
    const off = coordinator.subscribe(() => {});
    const points = [];
    const start = await heap();
    for (let i = 0; i < 400; i++) {
      const id =
        ids[scenario === "alternate" ? i % 2 : scenario === "local" ? (i % 2 ? 0 : 4) : i % 4];
      const modelId = `${id}-fake`;
      const route = { providerId: id, modelId, backendKind: "codex-cli-auth" as const };
      const snapshot: ProviderModelDiscoveryResult = {
        status: "ready",
        providerId: id,
        backendKind: route.backendKind,
        complete: true,
        models: [
          {
            id: modelId,
            modelId,
            label: modelId,
            description: null,
            defaultReasoningLevel: null,
            supportedReasoningLevels: null,
            source: "discovered",
          },
        ],
      };
      const runtime: ProviderRuntime = {
        providerId: id,
        label: id,
        backendKind: route.backendKind,
        routeAvailable: true,
        routeStatus: "offline",
        launchAvailable: true,
        discoverModels: () => snapshot,
        refreshModels: async () => {
          if (scenario === "discovery-failure") throw new Error("offline discovery failure");
          await sleep(scenario === "rapid" ? 2 : 0);
          return snapshot;
        },
      };
      coordinator.navigate(id);
      const attempt = coordinator.begin(route, id);
      const controller = new AbortController();
      const pending = catalog.refresh(runtime, {
        cwd: process.cwd(),
        signal: controller.signal,
        forceRefresh: scenario === "stale" || scenario === "discovery-failure",
      });
      if (scenario === "cancel") {
        controller.abort();
        coordinator.cancel();
      }
      if (scenario === "rapid") {
        coordinator.begin(route, id);
        catalog.invalidate(id);
      }
      await pending;
      if (coordinator.isCurrent(attempt)) {
        coordinator.commit(attempt);
        if (scenario === "missing")
          coordinator.reject(id, modelId, {
            kind: "model-unavailable",
            message: "synthetic unavailable",
            retryable: false,
          });
        else if (scenario === "execution-failure")
          coordinator.reject(id, modelId, {
            kind: "network",
            message: "synthetic network failure",
            retryable: true,
          });
        else coordinator.validate(id, route);
        coordinator.finish(attempt);
      }
      if (i % 100 === 99) points.push({ cycle: i + 1, heap: (await heap()).heapSize, ...sample() });
    }
    const settled = await heap();
    unsubscribe();
    off();
    catalog.dispose();
    coordinator.cancel();
    results.push({
      scenario,
      startHeap: start.heapSize,
      settledHeap: settled.heapSize,
      afterDisposeHeap: (await heap()).heapSize,
      notifications,
      points,
    });
  }
  report(results);
} else if (
  caseName === "pty" ||
  caseName === "memory" ||
  caseName === "shell" ||
  caseName === "app-switch"
) {
  const { loadSettings, saveSettings } = await import("../../src/config/persistence.js");
  const scenario = process.env.UBUME_BENCH_SCENARIO ?? "normal";
  const settings = loadSettings();
  saveSettings({
    ...settings,
    updateCheck: { ...settings.updateCheck!, enabled: scenario.startsWith("update") },
  });
  const { saveProviderWorkspaceConfig } = await import(
    "../../src/core/providerLauncher/workspaceConfig.js"
  );
  saveProviderWorkspaceConfig(process.cwd(), {
    activeRoute: { providerId: "openai", modelId: "gpt-5.4", backendKind: "codex-cli-auth" },
    providers: {
      openai: { codexCommandPath: "/bench/fakes/provider" },
      anthropic: { claudeCommandPath: "/bench/fakes/provider" },
    },
  });
  let resumeId: string | undefined;
  if (scenario === "history") {
    const { ConversationStore } = await import("../../src/core/workspace/conversationStore.js");
    const store = new ConversationStore(process.cwd());
    const record = store.createConversation({
      providerId: "openai",
      modelId: "gpt-5.4",
      backendKind: "codex-cli-auth",
    });
    for (let i = 0; i < 500; i++)
      record.messages.push(
        { role: "user", content: `history-${i} prompt` },
        { role: "assistant", content: `history-${i} ` + "synthetic history ".repeat(12) },
      );
    store.save(record);
    resumeId = record.metadata.id;
    store.release();
  }
  const trace = await import("../../src/core/perf/benchTrace.js");
  const provider: BackendProvider = {
    id: "codex-subprocess",
    label: "Offline",
    description: "synthetic",
    authState: "delegated",
    authLabel: "fake",
    statusMessage: "fake",
    supportsModels: () => true,
    run(_prompt, _options, handlers) {
      let canceled = false;
      let stopped!: () => void;
      const done = new Promise<void>((r) => (stopped = r));
      handlers.onRunControl?.({ stopped: done });
      void (async () => {
        const total =
          scenario === "rapid" || scenario === "slow-reader"
            ? 200
            : scenario === "table" || scenario === "code"
              ? 80
              : 30;
        let response = "";
        if (scenario === "table") {
          response = "| n | value |\n|---|---|\n";
          handlers.onAssistantDelta?.(response);
        }
        if (scenario === "code") {
          response = "```ts\n";
          handlers.onAssistantDelta?.(response);
        }
        for (let i = 0; i < total && !canceled; i++) {
          const token = `⟦${i}⟧`;
          const chunk =
            scenario === "table"
              ? `| ${i} | ${token} |\n`
              : scenario === "code"
                ? `const n${i} = "${token}";\n`
                : `${token} synthetic text\n`;
          trace.streamMark("emit", chunk);
          if (scenario === "tools")
            handlers.onToolActivity?.({
              id: `tool-${i}`,
              command: chunk,
              status: "completed",
              startedAt: Date.now(),
            });
          else {
            handlers.onAssistantDelta?.(chunk);
            response += chunk;
          }
          await sleep(scenario === "rapid" || scenario === "slow-reader" ? 0 : 12);
        }
        if (scenario === "code") {
          handlers.onAssistantDelta?.("```\n");
          response += "```\n";
        }
        stopped();
        if (!canceled) {
          handlers.onAssistantDelta?.("\nBENCH_COMPLETE");
          handlers.onResponse(response + "\nBENCH_COMPLETE");
        }
      })().catch((e) => {
        stopped();
        handlers.onError(String(e));
      });
      return () => {
        canceled = true;
        stopped();
      };
    },
  };
  if (scenario.startsWith("update")) {
    delete process.env.UBUME_SKIP_UPDATE_CHECK;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await sleep(scenario === "update-slow" ? 2000 : 50);
        return Response.json({
          latest:
            scenario === "update-available"
              ? "99.0.0"
              : (await import("../../src/config/settings.js")).APP_VERSION,
        });
      },
    });
    process.env.UBUME_UPDATE_DIST_TAGS_URL = `http://127.0.0.1:${server.port}/dist-tags`;
  }
  if (caseName === "pty") {
    const { startApp } = await import("../../src/index.js");
    trace.startupMarkProcessStart();
    trace.startupMark("modules-loaded");
    startApp({
      argv: resumeId ? ["--resume", resumeId] : [],
      providerOverride: scenario.startsWith("update") ? undefined : provider,
    });
  } else {
    if (caseName === "app-switch") {
      const { getProviderRuntime } = await import("../../src/core/providerRuntime/registry.js");
      for (const id of ["openai", "anthropic", "google", "mistral"] as const) {
        const native = getProviderRuntime(id);
        const modelId = `${id}-fake`;
        const snapshot: ProviderModelDiscoveryResult = {
          status: "ready",
          providerId: id,
          backendKind: native.backendKind,
          freshness: "verified",
          complete: true,
          models: [
            {
              id: modelId,
              modelId,
              label: modelId,
              description: null,
              defaultReasoningLevel: null,
              supportedReasoningLevels: null,
              source: "discovered",
            },
          ],
        };
        native.discoverModels = () => snapshot;
        native.refreshModels = async () => snapshot;
        native.isRouteConfigured = () => true;
        native.validateRoute = async () => ({
          status: "ready",
          providerId: id,
          backendKind: native.backendKind,
        });
        native.run = () => {
          throw new Error("Switch-only fixture must not generate");
        };
      }
      saveProviderWorkspaceConfig(process.cwd(), {
        activeRoute: {
          providerId: "openai",
          modelId: "openai-fake",
          backendKind: "codex-cli-auth",
        },
        providers: Object.fromEntries(
          ["openai", "anthropic", "google", "mistral"].map((id) => [
            id,
            {
              currentModel: `${id}-fake`,
              codexCommandPath: "/bench/fakes/provider",
              claudeCommandPath: "/bench/fakes/provider",
            },
          ]),
        ),
      });
    }
    const { App } = await import("../../src/app/App.js");
    const { parseLaunchArgs } = await import("../../src/config/launchArgs.js");
    const { render } = await import("ink");
    class Input extends PassThrough {
      isTTY = true;
      setRawMode() {
        return this;
      }
      ref() {
        return this;
      }
      unref() {
        return this;
      }
    }
    class Output extends PassThrough {
      isTTY = true;
      columns = 120;
      rows = 36;
    }
    const stdin = new Input();
    const stdout = new Output();
    let frame = "";
    stdout.on("data", (b) => (frame = b.toString()));
    const parsed = parseLaunchArgs([]);
    assert(parsed.ok);
    const instance = render(
      <App
        launchArgs={parsed.value}
        providerOverride={caseName === "app-switch" ? undefined : provider}
      />,
      {
        stdin: stdin as never,
        stdout: stdout as never,
        stderr: stdout as never,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    async function until(check: () => boolean) {
      const end = Date.now() + 15000;
      while (!check()) {
        if (Date.now() > end) throw new Error("timeout: " + frame.slice(-1500));
        await sleep(20);
      }
    }
    async function command(s: string) {
      stdin.write(s);
      await sleep(30);
      stdin.write("\r");
      await sleep(100);
    }
    await until(() => frame.includes("Ask Ubume"));
    const states: Array<{ stage: string; [key: string]: unknown }> = [
      { stage: "initialized", ...sample() },
    ];
    if (caseName === "memory") {
      await sleep(10000);
      states.push({ stage: "idle-10s", ...sample() });
      await sleep(50000);
      states.push({ stage: "idle-60s", ...sample() });
      await command("synthetic run");
      await until(() => frame.includes("BENCH_COMPLETE"));
      states.push({ stage: "after-run", ...sample() });
      await command("/clear");
      await sleep(200);
      states.push({ stage: "after-clear", ...sample() });
    } else if (caseName === "app-switch") {
      const { loadProviderWorkspaceConfig } = await import(
        "../../src/core/providerLauncher/workspaceConfig.js"
      );
      const { providerCatalog } = await import("../../src/core/models/modelCatalog.js");
      const ids = ["openai", "anthropic", "google", "mistral"];
      for (let i = 0; i < 100; i++) {
        const target = (i + 1) % 4;
        await command("/providers");
        await until(() => frame.includes("Enter use"));
        stdin.write("\x1b[H");
        await sleep(30);
        for (let j = 0; j < target; j++) {
          stdin.write("\x1b[B");
          await sleep(20);
        }
        stdin.write("\r");
        await sleep(100);
        await until(
          () => loadProviderWorkspaceConfig(process.cwd()).activeRoute?.providerId === ids[target],
        );
        const route = loadProviderWorkspaceConfig(process.cwd()).activeRoute!;
        assert.equal(route.modelId, `${ids[target]}-fake`);
        if (i % 25 === 24)
          states.push({
            stage: `after-${i + 1}-switches`,
            heap: (await heap()).heapSize,
            diagnostics: providerCatalog.getDiagnostics(),
            ...sample(),
          });
      }
      await command("/clear");
      await sleep(200);
      states.push({
        stage: "after-clear",
        heap: (await heap()).heapSize,
        diagnostics: providerCatalog.getDiagnostics(),
        ...sample(),
      });
    } else {
      const bytes = Number(process.env.SHELL_BYTES ?? 10485760);
      const start = performance.now();
      await command(
        `!node -e "const b=Buffer.from('x'.repeat(99)+'\\n');let n=0;function next(){while(n++<${Math.ceil(bytes / 100)}){if(!process.stdout.write(b)){process.stdout.once('drain',next);return}}}next()"`,
      );
      await until(() => frame.includes("Produced") || frame.includes("Executed shell"));
      states.push({
        stage: "shell-complete",
        wallMs: performance.now() - start,
        bytes,
        ...sample(),
      });
    }
    const diagnosticHeap = await heap();
    instance.unmount();
    await instance.waitUntilExit();
    instance.cleanup();
    stdin.destroy();
    stdout.destroy();
    await sleep(100);
    const { providerCatalog } = await import("../../src/core/models/modelCatalog.js");
    const resources = providerCatalog.getDiagnostics();
    assert.equal(resources.listeners, 0);
    assert.equal(resources.pending, 0);
    states.push({ stage: "disposed", diagnostics: resources, ...sample() });
    report({ states, diagnosticHeap });
  }
} else throw new Error("Unknown fixture " + caseName);
