import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { waitFor } from "../../test/async.js";
import {
  captureWorkspaceSnapshot,
  captureWorkspaceSnapshotAsync,
  createTextDiffExcerpt,
  createWorkspaceActivityTracker,
  createWorkspaceContentCache,
  diffWorkspaceSnapshots,
  type RunFileActivity,
} from "./workspaceActivity.js";

function createTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "codex-workspace-activity-"));
}

test("detects created files in the workspace snapshot diff", () => {
  const root = createTempWorkspace();
  try {
    const before = captureWorkspaceSnapshot(root);
    writeFileSync(join(root, "new-file.ts"), "const value = 1;\n", "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 123);

    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.operation, "created");
    assert.equal(activity[0]?.path, "new-file.ts");
    assert.equal(activity[0]?.addedLines, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects modified files with diff preview", () => {
  const root = createTempWorkspace();
  try {
    const file = join(root, "edited.py");
    writeFileSync(file, "print('before')\nvalue = 1\n", "utf8");
    const before = captureWorkspaceSnapshot(root);

    writeFileSync(file, "print('after')\nvalue = 2\nextra = True\n", "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 456);

    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.operation, "modified");
    assert.equal(activity[0]?.path, "edited.py");
    assert.equal(activity[0]?.addedLines, 3);
    assert.equal(activity[0]?.removedLines, 2);
    assert.equal(activity[0]?.diffLines?.[0]?.kind, "removed");
    assert.equal(activity[0]?.diffLines?.at(-1)?.kind, "added");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects deleted files", () => {
  const root = createTempWorkspace();
  try {
    const file = join(root, "gone.txt");
    writeFileSync(file, "goodbye\n", "utf8");
    const before = captureWorkspaceSnapshot(root);

    unlinkSync(file);
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 789);

    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.operation, "deleted");
    assert.equal(activity[0]?.path, "gone.txt");
    assert.equal(activity[0]?.removedLines, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores excluded directories like node_modules and .git", () => {
  const root = createTempWorkspace();
  try {
    const before = captureWorkspaceSnapshot(root);
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "node_modules", "ignored.js"), "console.log('x')", "utf8");
    writeFileSync(join(root, ".git", "ignored.txt"), "internal", "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 111);

    assert.equal(activity.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace activity tracker can reuse a provided initial snapshot", async () => {
  const root = createTempWorkspace();
  try {
    writeFileSync(join(root, "edited.txt"), "before\n", "utf8");
    writeFileSync(join(root, "gone.txt"), "delete me\n", "utf8");
    const before = captureWorkspaceSnapshot(root);

    writeFileSync(join(root, "new-file.ts"), "const value = 1;\n", "utf8");
    writeFileSync(join(root, "edited.txt"), "after\n", "utf8");
    unlinkSync(join(root, "gone.txt"));

    const activity = await new Promise<ReturnType<typeof diffWorkspaceSnapshots>>(
      (resolve, reject) => {
        let tracker: ReturnType<typeof createWorkspaceActivityTracker> | null = null;
        const timeout = setTimeout(() => {
          tracker?.stop();
          reject(new Error("Timed out waiting for workspace activity."));
        }, 500);
        tracker = createWorkspaceActivityTracker({
          rootDir: root,
          initialSnapshot: before,
          pollIntervalMs: 10,
          onActivity: (items) => {
            clearTimeout(timeout);
            tracker?.stop();
            resolve(items);
          },
        });
      },
    );

    const operationsByPath = new Map(activity.map((item) => [item.path, item.operation]));
    assert.equal(operationsByPath.get("new-file.ts"), "created");
    assert.equal(operationsByPath.get("edited.txt"), "modified");
    assert.equal(operationsByPath.get("gone.txt"), "deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips inline diff previews for oversized files", () => {
  const root = createTempWorkspace();
  try {
    const file = join(root, "large.txt");
    const largeContent = `${"a".repeat(129 * 1024)}\n`;
    writeFileSync(file, largeContent, "utf8");
    const before = captureWorkspaceSnapshot(root);

    writeFileSync(file, `${largeContent}tail\n`, "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 222);

    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.operation, "modified");
    assert.equal(activity[0]?.diffLines, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates green/red diff excerpts for mixed edits", () => {
  const diff = createTextDiffExcerpt(
    ["alpha", "beta", "gamma"].join("\n"),
    ["alpha", "beta-2", "gamma", "delta"].join("\n"),
  );

  assert(diff);
  assert.equal(diff.addedLines, 2);
  assert.equal(diff.removedLines, 1);
  assert.equal(
    diff.diffLines?.some((line) => line.kind === "added"),
    true,
  );
  assert.equal(
    diff.diffLines?.some((line) => line.kind === "removed"),
    true,
  );
});

test("ignores agent scratch files under .ubume/scratch", () => {
  const root = createTempWorkspace();
  try {
    const before = captureWorkspaceSnapshot(root);
    mkdirSync(join(root, ".ubume", "scratch", "session-1"), { recursive: true });
    writeFileSync(
      join(root, ".ubume", "scratch", "session-1", "_test_harness.html"),
      "<html></html>\n",
      "utf8",
    );
    writeFileSync(join(root, "index.html"), "<html></html>\n", "utf8");
    const after = captureWorkspaceSnapshot(root);
    const activity = diffWorkspaceSnapshots(before, after, 789);

    assert.deepEqual(
      activity.map((item) => item.path),
      ["index.html"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Deterministic fixture covering every scanner rule. */
function createScannerFixture(): string {
  const root = createTempWorkspace();
  for (let i = 0; i < 60; i += 1) {
    const dir = join(root, "src", `pkg${i % 4}`, `mod${i % 3}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file${i}.ts`), `export const v${i} = ${i};\r\nline two\n`);
  }
  for (const ignored of ["node_modules/pkg", ".git/objects", "dist", ".ubume/scratch"]) {
    mkdirSync(join(root, ignored), { recursive: true });
    writeFileSync(join(root, ignored, "ignored.js"), "ignored\n");
  }
  mkdirSync(join(root, ".ubume"), { recursive: true });
  writeFileSync(join(root, ".ubume", "notes.txt"), "tracked\n");
  writeFileSync(join(root, ".env"), "TRACKED=1\n");
  writeFileSync(join(root, "image.png"), Buffer.alloc(64, 1));
  writeFileSync(join(root, "nul.txt"), Buffer.from([0x61, 0x00, 0x62]));
  writeFileSync(join(root, "large.txt"), "z".repeat(129 * 1024));
  symlinkSync(join(root, "src"), join(root, "src-link"));
  symlinkSync(root, join(root, "src", "loop"));
  symlinkSync(join(root, ".env"), join(root, "env-link"));
  return root;
}

function sorted(snapshot: Map<string, unknown>) {
  return [...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b));
}

test("async, cached and uncached captures produce identical snapshots", async () => {
  const root = createScannerFixture();
  try {
    const uncached = captureWorkspaceSnapshot(root);
    const cache = createWorkspaceContentCache();
    const cachedFirst = captureWorkspaceSnapshot(root, cache);
    const cachedSecond = captureWorkspaceSnapshot(root, cache);
    const asynchronous = await captureWorkspaceSnapshotAsync(root, cache);
    const asynchronousUncached = await captureWorkspaceSnapshotAsync(root);
    for (const candidate of [cachedFirst, cachedSecond, asynchronous, asynchronousUncached]) {
      assert.deepEqual(sorted(candidate), sorted(uncached));
    }
    assert.equal(uncached.has("src-link/pkg0/mod0/file0.ts"), false, "symlinks are not followed");
    assert.equal(uncached.has("env-link"), false);
    assert.equal(uncached.has("node_modules/pkg/ignored.js"), false);
    assert.equal(uncached.has(".ubume/scratch/ignored.js"), false);
    assert.equal(uncached.get(".ubume/notes.txt")?.content, "tracked\n");
    assert.equal(uncached.get("image.png")?.content, undefined);
    assert.equal(uncached.get("nul.txt")?.content, undefined);
    assert.equal(uncached.get("large.txt")?.content, undefined);
    assert.equal(
      uncached.get("src/pkg0/mod0/file0.ts")?.content,
      "export const v0 = 0;\nline two\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cached captures detect create, modify, delete and rename", async () => {
  const root = createScannerFixture();
  try {
    const cache = createWorkspaceContentCache();
    const before = await captureWorkspaceSnapshotAsync(root, cache);
    writeFileSync(join(root, "created.ts"), "new\n");
    writeFileSync(join(root, "src/pkg0/mod0/file0.ts"), "export const v0 = 1;\n");
    unlinkSync(join(root, "src/pkg1/mod1/file1.ts"));
    renameSync(join(root, "src/pkg2/mod2/file2.ts"), join(root, "src/pkg2/mod2/renamed.ts"));
    const after = await captureWorkspaceSnapshotAsync(root, cache);
    const activity = diffWorkspaceSnapshots(before, after, 1).map(
      ({ path, operation }) => `${operation}:${path}`,
    );
    assert.deepEqual(activity, [
      "created:created.ts",
      "modified:src/pkg0/mod0/file0.ts",
      "deleted:src/pkg1/mod1/file1.ts",
      "deleted:src/pkg2/mod2/file2.ts",
      "created:src/pkg2/mod2/renamed.ts",
    ]);
    assert.deepEqual(sorted(after), sorted(captureWorkspaceSnapshot(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a same-size rewrite with a restored mtime is still read again", () => {
  const root = createTempWorkspace();
  try {
    const file = join(root, "same.txt");
    writeFileSync(file, "aaaa\n");
    const original = statSync(file);
    const cache = createWorkspaceContentCache();
    const before = captureWorkspaceSnapshot(root, cache);
    writeFileSync(file, "bbbb\n");
    utimesSync(file, original.atime, original.mtime);
    const after = captureWorkspaceSnapshot(root, cache);
    assert.equal(after.get("same.txt")?.content, "bbbb\n", "ctime invalidates the cache");
    const [change] = diffWorkspaceSnapshots(before, after, 1);
    assert.equal(change?.operation, "modified");
    assert.equal(change?.addedLines, 1);
    assert.equal(change?.removedLines, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a touch without content change is reported as modified without line counts", () => {
  const root = createTempWorkspace();
  try {
    const file = join(root, "touched.txt");
    writeFileSync(file, "same\n");
    const cache = createWorkspaceContentCache();
    const before = captureWorkspaceSnapshot(root, cache);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    const [change] = diffWorkspaceSnapshots(before, captureWorkspaceSnapshot(root, cache), 1);
    assert.equal(change?.operation, "modified");
    assert.equal(change?.addedLines, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable directories are skipped by both scanners", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const root = createTempWorkspace();
  const locked = join(root, "locked");
  try {
    mkdirSync(locked);
    writeFileSync(join(locked, "secret.txt"), "hidden\n");
    writeFileSync(join(root, "visible.txt"), "visible\n");
    chmodSync(locked, 0o000);
    const syncSnapshot = captureWorkspaceSnapshot(root);
    const asyncSnapshot = await captureWorkspaceSnapshotAsync(root);
    assert.deepEqual([...syncSnapshot.keys()], ["visible.txt"]);
    assert.deepEqual([...asyncSnapshot.keys()], ["visible.txt"]);
  } finally {
    chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracker reports rapid consecutive writes and nothing after stop", async () => {
  const root = createTempWorkspace();
  try {
    const seen: RunFileActivity[] = [];
    const tracker = createWorkspaceActivityTracker({
      rootDir: root,
      pollIntervalMs: 15,
      onActivity: (activity) => seen.push(...activity),
    });
    for (let i = 0; i < 5; i += 1) writeFileSync(join(root, "rapid.txt"), `write ${i}\n`);
    await waitFor(() => seen.some((item) => item.path === "rapid.txt"), { label: "rapid write" });
    tracker.stop();
    const count = seen.length;
    writeFileSync(join(root, "after-stop.txt"), "late\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(seen.length, count, "no activity after stop");
    assert.equal(seen.find((item) => item.path === "rapid.txt")?.operation, "created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracker keeps polling after a display callback throws", async () => {
  const root = createTempWorkspace();
  try {
    const paths: string[] = [];
    const tracker = createWorkspaceActivityTracker({
      rootDir: root,
      pollIntervalMs: 10,
      onActivity: (activity) => {
        paths.push(...activity.map((item) => item.path));
        if (paths.length === 1) throw new Error("display callback failure");
      },
    });
    writeFileSync(join(root, "first.txt"), "1\n");
    await waitFor(() => paths.includes("first.txt"), { label: "first change" });
    writeFileSync(join(root, "second.txt"), "2\n");
    await waitFor(() => paths.includes("second.txt"), { label: "change after a failure" });
    tracker.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
