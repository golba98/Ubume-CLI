/**
 * Offline workspace and persistence benchmark: activity-tracker scans, event-loop
 * delay while tracking, checkpoint capture, and conversation saves, on synthetic
 * temporary repositories. Nothing outside the temporary roots is read or written.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointStore } from "../../src/core/workspace/checkpoints.js";
import {
  type ConversationRecord,
  ConversationStore,
} from "../../src/core/workspace/conversationStore.js";
import * as activityModule from "../../src/core/workspace/workspaceActivity.js";
import {
  captureWorkspaceSnapshot,
  createWorkspaceActivityTracker,
} from "../../src/core/workspace/workspaceActivity.js";
import {
  type BenchReport,
  createIsolatedRoot,
  environmentInfo,
  finishSuite,
  type Metric,
  metric,
  parseBenchArgs,
  sleep,
  startEventLoopProbe,
} from "./lib.js";

const args = parseBenchArgs();
const isolated = createIsolatedRoot("workspace", {}, { onDisk: true });
const metrics: Metric[] = [];
const details: Record<string, unknown> = {};

/**
 * Deterministic repository: source files spread over nested directories, plus
 * ignored directories, a binary file, an oversized text file and symlinks.
 */
function createRepository(root: string, files: number): void {
  mkdirSync(root, { recursive: true });
  // A real git repository, so checkpoint capture lists files with `git ls-files` exactly as
  // in a user's project (the scratch base itself sits inside this repo's ignored folder).
  const init = spawnSync("git", ["init", "-q"], { cwd: root });
  if (init.status !== 0) throw new Error("git init failed for the benchmark repository");
  writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n");
  for (let i = 0; i < files; i += 1) {
    const dir = join(root, "src", `pkg${i % 20}`, `mod${Math.floor(i / 20) % 25}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `file${i}.ts`),
      Array.from({ length: 40 }, (_, line) => `export const v${i}_${line} = ${line};`).join("\n"),
    );
  }
  for (const ignored of ["node_modules/dep", "dist", "build"]) {
    mkdirSync(join(root, ignored), { recursive: true });
    for (let i = 0; i < 200; i += 1) writeFileSync(join(root, ignored, `x${i}.js`), "ignored\n");
  }
  writeFileSync(join(root, "image.png"), Buffer.alloc(4096, 1));
  writeFileSync(join(root, "large.txt"), "y".repeat(256 * 1024));
  symlinkSync(join(root, "src"), join(root, "src-link"));
  symlinkSync(root, join(root, "src", "loop"));
}

/**
 * Models a provider run: the run session captures the baseline (asynchronously where the
 * code under test provides it, synchronously in older code) and hands it to the tracker.
 * The baseline capture is inside the probed window because the UI is live at that point.
 */
async function trackerScenario(id: string, root: string, durationMs: number) {
  const probe = startEventLoopProbe();
  let polls = 0;
  const detections: number[] = [];
  let writtenAt = 0;
  const asyncModule: Partial<typeof activityModule> = activityModule;
  const contentCache = asyncModule.createWorkspaceContentCache?.();
  const initialSnapshot = asyncModule.captureWorkspaceSnapshotAsync
    ? await asyncModule.captureWorkspaceSnapshotAsync(root, contentCache)
    : captureWorkspaceSnapshot(root);
  const tracker = createWorkspaceActivityTracker({
    rootDir: root,
    initialSnapshot,
    ...(contentCache ? { contentCache } : {}),
    pollIntervalMs: 400,
    onActivity: () => {
      polls += 1;
      if (writtenAt) detections.push(performance.now() - writtenAt);
      writtenAt = 0;
    },
  });
  const end = performance.now() + durationMs;
  let edit = 0;
  while (performance.now() < end) {
    await sleep(700);
    if (writtenAt === 0) {
      edit += 1;
      writeFileSync(join(root, "src", "pkg0", "mod0", "file0.ts"), `export const edit = ${edit};\n`);
      writtenAt = performance.now();
    }
  }
  tracker.stop();
  const delays = probe.stop();
  metrics.push(metric(`${id}.event_loop_delay`, "ms", delays));
  if (detections.length) metrics.push(metric(`${id}.change_detected_after`, "ms", detections));
  details[`${id}.activity_callbacks`] = polls;
}

const sizes = args.large ? [100, 1_000, 10_000, 50_000] : [100, 1_000, 10_000];
for (const files of sizes) {
  const root = join(isolated.root, `repo-${files}`);
  createRepository(root, files);

  const captures: number[] = [];
  for (let i = 0; i < (files >= 10_000 ? 8 : 20); i += 1) {
    const start = performance.now();
    captureWorkspaceSnapshot(root);
    captures.push(performance.now() - start);
  }
  metrics.push(metric(`workspace.${files}.snapshot_capture`, "ms", captures));
  await trackerScenario(`workspace.${files}.tracking`, root, files >= 10_000 ? 6_000 : 4_000);

  // Checkpoint capture lists files through git (untracked files included).
  const store = new CheckpointStore(root, "chat_bench-1", join(isolated.root, `data-${files}`));
  const checkpoint: number[] = [];
  for (let i = 0; i < (files >= 10_000 ? 4 : 10); i += 1) {
    const start = performance.now();
    await store.capture();
    checkpoint.push(performance.now() - start);
  }
  metrics.push(
    metric(`workspace.${files}.checkpoint_capture`, "ms", checkpoint, {
      note: "first sample writes blobs; later samples reuse them",
    }),
  );
}

function conversation(turns: number): ConversationRecord {
  const now = new Date(0).toISOString();
  const messages = Array.from({ length: turns * 2 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${i} ${"lorem ipsum dolor sit amet ".repeat(80)}`,
    turnId: Math.floor(i / 2) + 1,
    createdAt: i,
  }));
  return {
    metadata: {
      version: 1,
      id: `chat_bench-${turns}`,
      title: "Benchmark",
      createdAt: now,
      updatedAt: now,
      providerId: "openai",
      modelId: "gpt-bench",
      backendKind: "codex-subprocess",
      messageCount: messages.length,
    },
    messages,
  };
}

const conversationStore = new ConversationStore(join(isolated.root, "project"), {
  rootDir: join(isolated.root, "conversations"),
});
for (const turns of [10, 100, 1_000]) {
  const record = conversation(turns);
  const saves: number[] = [];
  for (let i = 0; i < 15; i += 1) {
    const start = performance.now();
    conversationStore.save(record);
    saves.push(performance.now() - start);
  }
  metrics.push(
    metric(`persistence.save_unchanged.${turns}_turns`, "ms", saves.slice(1), {
      note: "repeated save of an identical record (busy autosave cadence)",
    }),
  );
  const changed: number[] = [];
  for (let i = 0; i < 15; i += 1) {
    record.messages[record.messages.length - 1]!.content += ` edit ${i}`;
    const start = performance.now();
    conversationStore.save(record);
    changed.push(performance.now() - start);
  }
  metrics.push(metric(`persistence.save_changed.${turns}_turns`, "ms", changed));
}

const report: BenchReport = {
  suite: "workspace",
  createdAt: new Date().toISOString(),
  environment: environmentInfo(),
  method:
    "Synthetic repos (nested .ts files, 600 ignored files, binary, 256 KiB text, symlinks " +
    "including a loop). snapshot_capture times captureWorkspaceSnapshot; tracking models a run " +
    "(baseline capture, async where available, then the activity tracker at its 400ms default) while editing one file every ~700ms and samples " +
    "main-thread delay with a 5ms timer; checkpoint_capture times CheckpointStore.capture " +
    "(git ls-files listing in a fresh git repo); persistence times ConversationStore.save. Roots live on " +
    "the repository's disk (docs/_reports/performance/bench-results/tmp), not tmpfs, so fsync and stat costs are real.",
  metrics,
  details,
};
try {
  finishSuite(report, args.outDir, args.quiet);
} finally {
  isolated.dispose();
}
