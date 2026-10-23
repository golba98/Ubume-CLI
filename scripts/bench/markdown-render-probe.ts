/**
 * Provider-free rendering probe. Run with Bun; JSON goes to stdout only.
 * Wall/CPU numbers measure presentation work, not provider transport or the full TUI.
 */
import { fullGC, heapStats } from "bun:jsc";
import { resolveRuntimeConfig } from "../../src/config/runtimeConfig.js";
import { createRunEvent } from "../../src/session/chatLifecycle.js";
import { parseMarkdown } from "../../src/ui/render/markdownParser.js";
import { resetTimelineMeasureCaches } from "../../src/ui/timeline/measure/caches.js";
import { buildMarkdownRows } from "../../src/ui/timeline/measure/markdownRows.js";
import { buildCodexResponseRows } from "../../src/ui/timeline/measure/streamRows.js";

const fixtures = [
  {
    name: "table_200x5",
    text: [
      "|A|B|C|D|E|",
      "|---|---|---|---|---|",
      ...Array.from(
        { length: 200 },
        (_, i) => `|Row ${i}|Long cell content for wrapping|漢字 emoji 👩🏽‍💻|value|description|`,
      ),
    ].join("\n"),
  },
  {
    name: "code_1000_lines",
    text: [
      "```typescript",
      ...Array.from(
        { length: 1000 },
        (_, i) => `  const value${i} = { count: ${i}, description: "sample" };`,
      ),
      "```",
    ].join("\n"),
  },
  {
    name: "prose_20k",
    text: "Markdown prose **bold** and `code` with a long paragraph. ".repeat(350),
  },
];
const round = (n: number) => Number(n.toFixed(3));
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length * fraction)]!;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const results = [];

for (const fixture of fixtures) {
  resetTimelineMeasureCaches();
  const samples: number[] = [];
  let cold = 0;
  for (let i = 0; i < 12; i += 1) {
    const start = performance.now();
    buildMarkdownRows(parseMarkdown(fixture.text), 80);
    const elapsed = performance.now() - start;
    if (i === 0) cold = elapsed;
    if (i >= 2) samples.push(elapsed);
  }
  resetTimelineMeasureCaches();
  const active = fixture.name.startsWith("code")
    ? fixture.text.slice(0, -4)
    : fixture.name.startsWith("table")
      ? fixture.text.slice(0, -1)
      : fixture.text;
  const appends: number[] = [];
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  for (let i = 0; i < 40; i += 1) {
    const start = performance.now();
    buildMarkdownRows(
      parseMarkdown(active + "a".repeat(i), {
        streaming: true,
        cacheKey: fixture.name,
      }),
      80,
    );
    if (i >= 5) appends.push(performance.now() - start);
  }
  const cpu = process.cpuUsage(cpuStart);
  results.push({
    fixture: fixture.name,
    bytes: Buffer.byteLength(fixture.text),
    width: 80,
    coldMs: round(cold),
    warmMedianMs: round(percentile(samples, 0.5)),
    warmMaxMs: round(Math.max(...samples)),
    appendMedianMs: round(percentile(appends, 0.5)),
    appendP95Ms: round(percentile(appends, 0.95)),
    appendFrames: 40,
    appendCpuMs: round((cpu.user + cpu.system) / 1000),
    appendWallMs: round(performance.now() - wallStart),
  });
}

async function checkpoint() {
  // Let temporary parser/layout frames unwind before measuring reachable objects.
  await sleep(0);
  fullGC();
  await sleep(0);
  fullGC();
  const stats = heapStats();
  return {
    processHeapUsed: process.memoryUsage().heapUsed,
    liveHeapSize: stats.heapSize,
    heapCapacity: stats.heapCapacity,
    objectCount: stats.objectCount,
  };
}
function memoryBatch(batch: number) {
  for (let i = 0; i < 150; i += 1) {
    const source = fixtures[0]!.text.replaceAll("description", `description ${batch * 150 + i}`);
    buildMarkdownRows(parseMarkdown(source, { cacheKey: `turn-${batch * 150 + i}` }), 80);
  }
}
resetTimelineMeasureCaches();
const heapAtStart = await checkpoint();
const heapAfterEach150Turns = [];
for (let batch = 0; batch < 4; batch += 1) {
  memoryBatch(batch);
  heapAfterEach150Turns.push(await checkpoint());
}
resetTimelineMeasureCaches();
const heapAfterClear = await checkpoint();

const run = createRunEvent({
  id: 1,
  turnId: 1,
  backendId: "codex-subprocess",
  backendLabel: "Rendering fixture",
  runtime: resolveRuntimeConfig(),
  prompt: "fixture",
  startedAtMs: 0,
});
const activeTable = fixtures[0]!.text.slice(0, -1);
const paced: number[] = [];
const pacedStart = performance.now();
const pacedCpu = process.cpuUsage();
for (let frame = 0; frame < 40; frame += 1) {
  const start = performance.now();
  buildCodexResponseRows({
    keyPrefix: "paced",
    width: 84,
    run,
    event: {
      kind: "response",
      streamSeq: 1,
      segment: {
        id: "paced",
        streamSeq: 1,
        startedAt: 0,
        status: "active",
        chunks: [activeTable + "a".repeat(frame)],
      },
    },
    streaming: true,
    isLastEvent: true,
    isLive: true,
    verbose: false,
  });
  const elapsed = performance.now() - start;
  if (frame >= 5) paced.push(elapsed);
  await sleep(Math.max(0, 33 - elapsed));
}
const cpu = process.cpuUsage(pacedCpu);
console.log(
  JSON.stringify(
    {
      runtime: Bun.version,
      method:
        "80-column fixtures; 12 invocations (first two excluded from warm statistics); " +
        "40 append frames (first five excluded); memory at 150/300/450/600 unique tables after " +
        "event-loop yields and full GC; response rows paced at 33ms. Caches cold, JIT shared.",
      baselineMedianMs: { table_200x5: 73.35, code_1000_lines: 68.24, prose_20k: 1.83 },
      results,
      memory: { heapAtStart, heapAfterEach150Turns, heapAfterClear },
      pacedSharedResponseRows: {
        fixture: "table_200x5_shared_response_rows",
        frames: 40,
        cadenceMs: 33,
        medianMs: round(percentile(paced, 0.5)),
        p95Ms: round(percentile(paced, 0.95)),
        wallMs: round(performance.now() - pacedStart),
        cpuMs: round((cpu.user + cpu.system) / 1000),
      },
    },
    null,
    2,
  ),
);
