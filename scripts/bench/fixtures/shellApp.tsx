/**
 * Offline `!shell` output fixture: the real App in Ink's in-memory terminal runs
 * `!node -e <writer>` producing `BENCH_SHELL_BYTES` of output, and reports wall time, peak
 * RSS and retained live heap (after full GC) once the shell event completes. No provider runs.
 */
import { App } from "../../../src/app/App.js";
import { parseLaunchArgs } from "../../../src/config/launchArgs.js";
import { loadSettings, saveSettings } from "../../../src/config/persistence.js";
import type { BackendProvider } from "../../../src/core/providers/types.js";
import { createTestTerminal } from "../../../src/test/terminal.js";

const bytes = Number(process.env.BENCH_SHELL_BYTES ?? 1024 * 1024);
const settings = loadSettings();
saveSettings({ ...settings, updateCheck: { ...settings.updateCheck!, enabled: false } });
const idle: BackendProvider = {
  id: "codex-subprocess",
  label: "Idle provider",
  description: "never used",
  authState: "delegated",
  authLabel: "offline",
  statusMessage: "offline",
  supportsModels: () => true,
  run: (_prompt, _options, handlers) => {
    handlers.onResponse("unused");
    return () => undefined;
  },
};
const parsed = parseLaunchArgs([]);
if (!parsed.ok) throw new Error(parsed.error);
const terminal = createTestTerminal(<App launchArgs={parsed.value} providerOverride={idle} />, {
  columns: 120,
  rows: 40,
});
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeoutMs = 120_000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error(`timed out: ${label}\n${strip(terminal.lastFrame()).slice(-1500)}`);
    await pause(10);
  }
}
const jscModule = "bun:jsc";
const jsc = (await import(jscModule)) as { fullGC(): void; heapStats(): { heapSize: number } };
const result: Record<string, unknown> = { bytes };
try {
  await until(() => strip(terminal.lastFrame()).includes("Ask Ubume"), "initial frame", 15_000);
  await pause(300);
  jsc.fullGC();
  const heapBefore = jsc.heapStats().heapSize;
  const lines = Math.max(1, Math.round(bytes / 100));
  // 99 characters plus newline per line, written with backpressure.
  const writer = `const l='x'.repeat(99)+'\\n';let n=${lines};const w=()=>{while(n>0){n--;if(!process.stdout.write(l)){process.stdout.once('drain',w);return}}};w()`;
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  const started = performance.now();
  terminal.stdin.write(`!node -e "${writer}"`);
  await pause(80);
  terminal.stdin.write("\r");
  await until(
    () => /Produced [\d,]+ lines? of output|Completed with no output/.test(strip(terminal.output())),
    "shell completion",
    Number(process.env.BENCH_SHELL_TIMEOUT_MS ?? 120_000),
  );
  result.wallMs = performance.now() - started;
  clearInterval(sampler);
  result.peakRss = peakRss;
  await pause(200);
  jsc.fullGC();
  result.retainedHeap = jsc.heapStats().heapSize - heapBefore;
  const summary = /Produced ([\d,]+) lines? of output/.exec(strip(terminal.output()));
  result.reportedLines = summary ? Number(summary[1]!.replaceAll(",", "")) : 0;
  result.expectedLines = lines;
  result.ok = result.reportedLines === lines;
} catch (error) {
  result.ok = false;
  result.error = String(error).slice(0, 500);
} finally {
  terminal.dispose();
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
