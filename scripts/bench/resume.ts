/** Offline session metadata/hydration benchmark; artifacts remain under ignored reports. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../../src/core/workspace/conversationStore.js";
import { hydrateConversationEvents } from "../../src/session/restoreConversation.js";
import { createTestEnvironment, withEnvironment } from "../../src/test/environment.js";
import { buildStaticTranscript, createStaticTranscriptCache } from "../../src/ui/timeline/staticTranscriptCache.js";
import { buildStaticRenderItems, buildTimelineItems } from "../../src/ui/timeline/timelineItems.js";
const reportRoot = join(import.meta.dir, "../../docs/_reports/performance/resume-session-2026-10-21");
mkdirSync(reportRoot, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "ubume-resume-bench-"));
const measurements: unknown[] = [];
const time = <T>(run: () => T) => { const start = performance.now(); const result = run(); return { result, ms: Number((performance.now() - start).toFixed(2)) }; };
try {
  await withEnvironment(createTestEnvironment(root), () => {
    for (const count of [10, 100, 1000]) {
      const workspace = join(root, `project-${count}`); mkdirSync(workspace);
      let id = 0;
      const store = new ConversationStore(workspace, { idFactory: () => String(++id) });
      for (let index = 0; index < count; index++) {
        const record = store.createConversation({ providerId: "openai", modelId: "fixture", backendKind: "codex-cli-auth" });
        record.messages = [{ role: "user", content: `question ${index}` }, { role: "assistant", content: "x".repeat(4096) }];
        store.save(record);
      }
      const samples = Array.from({ length: 7 }, () => time(() => store.list()).ms).sort((a, b) => a - b);
      const entries = store.list();
      for (const entry of entries) unlinkSync(join(store.location(entry.id), "../summary.json"));
      const cold = time(() => store.list());
      measurements.push({ sessions: count, cachedListMedianMs: samples[3], cachedListMaxMs: samples.at(-1), missingSummariesMs: cold.ms, listed: cold.result.length });
    }
    const store = new ConversationStore(join(root, "large"));
    const record = store.createConversation({ providerId: "openai", modelId: "fixture", backendKind: "codex-cli-auth" });
    record.messages = Array.from({ length: 240 }, (_, index) => [{ role: "user" as const, content: `question ${index}` }, { role: "assistant" as const, content: `answer ${index}\n` + "long response content ".repeat(50) }]).flat();
    store.save(record);
    const load = time(() => store.load(record.metadata.id)!);
    const hydrate = time(() => hydrateConversationEvents(load.result));
    const items = buildTimelineItems(hydrate.result);
    const renderItems = buildStaticRenderItems(items, items.flatMap((item) => item.type === "turn" ? [item.turnId] : []), null, null, null);
    const cache = createStaticTranscriptCache();
    const render = time(() => buildStaticTranscript(cache, renderItems, { totalWidth: 100, verboseMode: false, workspaceRoot: root }));
    const cached = time(() => buildStaticTranscript(cache, renderItems, { totalWidth: 100, verboseMode: false, workspaceRoot: root }));
    measurements.push({ turns: 240, bytes: readFileSync(store.location(record.metadata.id)).length, loadMs: load.ms, hydrateMs: hydrate.ms, firstRenderMs: render.ms, cachedRenderMs: cached.ms, cachedTurns: cache.entries.size, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  });
  writeFileSync(join(reportRoot, "results.json"), JSON.stringify(measurements, null, 2) + "\n");
  console.log(JSON.stringify(measurements, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
