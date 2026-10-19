/// <reference path="../../../node_modules/bun-types/test.d.ts" />
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, type FileCheckpoint } from "./checkpoints.js";
import {
  expandFileAttachments,
  fuzzyFiles,
  listWorkspaceFiles,
  readFileAttachment,
} from "./workspaceFiles.js";

async function fixture(action: (root: string, store: CheckpointStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ubume-checkpoints-"));
  const root = join(directory, "project");
  await mkdir(root);
  try {
    await action(root, new CheckpointStore(root, "chat_test", join(directory, "data")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("exact byte recovery preserves dirty baseline, CRLF, mode, additions and deletions", async () =>
  fixture(async (root, store) => {
    await writeFile(join(root, "dirty.ts"), "dirty\r\nline\r\n");
    await chmod(join(root, "dirty.ts"), 0o755);
    await writeFile(join(root, "deleted.ts"), "restore me");
    const before = await store.capture();
    await writeFile(join(root, "dirty.ts"), "new\n");
    await writeFile(join(root, "created.ts"), "new");
    await unlink(join(root, "deleted.ts"));
    const after = await store.capture();
    const point: FileCheckpoint = {
      id: "1",
      turnId: 1,
      messageCount: 0,
      prompt: "edit",
      before,
      after,
    };
    expect(await store.patch(before, after, "dirty.ts")).toContain("+new");
    const operations = await store.preview([point]);
    await store.restore(operations);
    expect(await readFile(join(root, "dirty.ts"), "utf8")).toBe("dirty\r\nline\r\n");
    expect((await lstat(join(root, "dirty.ts"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(root, "deleted.ts"), "utf8")).toBe("restore me");
    expect(await lstat(join(root, "created.ts")).catch(() => null)).toBeNull();
  }));
test("created then modified files still rewind to absence", async () =>
  fixture(async (root, store) => {
    const before = await store.capture();
    await writeFile(join(root, "a"), "first");
    const after = await store.capture();
    await writeFile(join(root, "a"), "second");
    const last = await store.capture();
    const base = { id: "one", turnId: 1, messageCount: 0, prompt: "edit" };
    await store.restore(
      await store.preview([
        { ...base, before, after },
        { ...base, id: "two", before: after, after: last },
      ]),
    );
    expect(await lstat(join(root, "a")).catch(() => null)).toBeNull();
  }));
test("later manual edits block restoration without changing any file", async () =>
  fixture(async (root, store) => {
    await writeFile(join(root, "a"), "old");
    const before = await store.capture();
    await writeFile(join(root, "a"), "agent");
    const after = await store.capture();
    const point = { id: "1", turnId: 1, messageCount: 0, prompt: "edit", before, after };
    const preview = await store.preview([point]);
    await writeFile(join(root, "a"), "manual");
    await expect(store.restore(preview)).rejects.toThrow("Later edits");
    expect(await readFile(join(root, "a"), "utf8")).toBe("manual");
  }));
test("manual changes between turn boundaries block rewind", async () =>
  fixture(async (root, store) => {
    await writeFile(join(root, "a"), "old");
    const before = await store.capture();
    await writeFile(join(root, "a"), "agent");
    const after = await store.capture();
    await writeFile(join(root, "a"), "manual");
    const nextBefore = await store.capture();
    await writeFile(join(root, "a"), "agent again");
    const nextAfter = await store.capture();
    const base = { id: "one", turnId: 1, messageCount: 0, prompt: "edit" };
    await expect(
      store.preview([
        { ...base, before, after },
        { ...base, id: "two", before: nextBefore, after: nextAfter },
      ]),
    ).rejects.toThrow("Manual edits");
  }));
test("file recovery rejects symlink escapes and incomplete boundaries", async () =>
  fixture(async (root, store) => {
    await writeFile(join(root, "a"), "old");
    const before = await store.capture();
    await writeFile(join(root, "a"), "new");
    const after = await store.capture();
    const point = { id: "1", turnId: 1, messageCount: 0, prompt: "edit", before, after };
    await expect(
      store.preview([{ ...point, before: { ...before, complete: false } }]),
    ).rejects.toThrow("incomplete");
    await unlink(join(root, "a"));
    await symlink(join(root, ".."), join(root, "a"));
    await expect(store.preview([point])).rejects.toThrow("Symlink");
  }));
test("failed restore rolls back earlier writes and clears its journal", async () =>
  fixture(async (root, store) => {
    await writeFile(join(root, "a"), "old");
    await writeFile(join(root, "b"), "old");
    const before = await store.capture();
    await writeFile(join(root, "a"), "new");
    await writeFile(join(root, "b"), "new");
    const after = await store.capture();
    const operations = await store.preview([
      { id: "1", turnId: 1, messageCount: 0, prompt: "edit", before, after },
    ]);
    const internal = store as unknown as {
      apply: (path: string, target: unknown) => Promise<void>;
    };
    const apply = internal.apply.bind(store);
    let calls = 0;
    internal.apply = async (path, target) => {
      if (++calls === 2) throw new Error("injected write failure");
      await apply(path, target);
    };
    await expect(store.restore(operations)).rejects.toThrow("injected write failure");
    expect(await readFile(join(root, "a"), "utf8")).toBe("new");
    expect(await store.recover()).toBe(false);
  }));
test("startup recovery rolls back a journal and verifies blob hashes", async () =>
  fixture(async (root, store) => {
    await writeFile(join(root, "a"), "old");
    const before = await store.capture();
    await writeFile(join(root, "a"), "new");
    const after = await store.capture();
    const operations = await store.preview([
      { id: "1", turnId: 1, messageCount: 0, prompt: "edit", before, after },
    ]);
    await writeFile(
      join(store.directory, "restore.json"),
      JSON.stringify({ version: 1, operations }),
    );
    await writeFile(join(root, "a"), "old");
    expect(await store.recover()).toBe(true);
    expect(await readFile(join(root, "a"), "utf8")).toBe("new");
    await writeFile(join(store.directory, "blobs", before.files.a!.hash), "corrupt");
    await expect(store.patch(before, after, "a")).rejects.toThrow("corrupt");
  }));
test("nested ignore rules, binary/oversize exclusions and file context snapshots", async () =>
  fixture(async (root, store) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), "*.log\n");
    await writeFile(join(root, "src", ".gitignore"), "secret.ts\n");
    await writeFile(join(root, "src", "visible.ts"), "old context");
    await writeFile(join(root, "src", "secret.ts"), "secret");
    await writeFile(join(root, "out.log"), "ignored");
    await writeFile(join(root, ".env"), "secret");
    await writeFile(join(root, "image.bin"), Buffer.from([0, 1]));
    await writeFile(join(root, "large"), "x".repeat(1024 * 1024 + 1));
    const paths = await listWorkspaceFiles(root);
    expect(paths).toContain("src/visible.ts");
    expect(paths).not.toContain("src/secret.ts");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("out.log");
    const snapshot = await store.capture();
    expect(snapshot.skipped).toContain("image.bin");
    expect(snapshot.skipped).toContain("large");
    const attachment = await readFileAttachment(root, "src/visible.ts");
    await writeFile(join(root, "src", "visible.ts"), "new context");
    expect(
      await expandFileAttachments("[File]", new Map([["[File]", attachment]]), root),
    ).toContain("old context");
    expect(fuzzyFiles(paths, "svts")).toContain("src/visible.ts");
  }));

test("tracked deletions are valid boundaries and can be restored", async () =>
  fixture(async (root, store) => {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "tracked.ts"), "original\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: root });
    const before = await store.capture();
    await unlink(join(root, "tracked.ts"));
    const after = await store.capture();
    expect(after.complete).toBe(true);
    expect(after.files["tracked.ts"]).toBeUndefined();
    await store.restore(
      await store.preview([
        { id: "1", turnId: 1, messageCount: 0, prompt: "delete", before, after },
      ]),
    );
    expect(await readFile(join(root, "tracked.ts"), "utf8")).toBe("original\n");
  }));

test("file names matching Object prototype keys retain exact checkpoint behavior", async () =>
  fixture(async (root, store) => {
    const before = await store.capture();
    await writeFile(join(root, "__proto__"), "first");
    await writeFile(join(root, "constructor"), "second");
    const after = JSON.parse(JSON.stringify(await store.capture()));
    expect(store.changed(before, after)).toEqual(["__proto__", "constructor"]);
    await store.restore(
      await store.preview([
        { id: "1", turnId: 1, messageCount: 0, prompt: "create", before, after },
      ]),
    );
    expect(await lstat(join(root, "__proto__")).catch(() => null)).toBeNull();
    expect(await lstat(join(root, "constructor")).catch(() => null)).toBeNull();
  }));

test("capture across batches records every file in listing order with shared blobs", async () =>
  fixture(async (root, store) => {
    await mkdir(join(root, "nested", "deep"), { recursive: true });
    for (let i = 0; i < 75; i += 1) {
      // Every third file shares content, so one blob backs several paths (also within a batch).
      const content = i % 3 === 0 ? "shared content\n" : `unique ${i}\n`;
      await writeFile(
        join(root, "nested", "deep", `file${String(i).padStart(3, "0")}.ts`),
        content,
      );
    }
    const boundary = await store.capture();
    expect(boundary.complete).toBe(true);
    expect(boundary.skipped).toEqual([]);
    const paths = Object.keys(boundary.files);
    expect(paths).toEqual([...paths].sort());
    expect(paths.length).toBe(75);
    const shared = new Set(
      paths.filter((_, i) => i % 3 === 0).map((path) => boundary.files[path]!.hash),
    );
    expect(shared.size).toBe(1);
    const again = await store.capture();
    expect(again).toEqual(boundary);
  }));

test("capture skips paths below a symlinked directory and marks the boundary incomplete", async () =>
  fixture(async (root, store) => {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "a.ts"), "a\n");
    await writeFile(join(root, "plain.ts"), "plain\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "real/a.ts", "plain.ts"], { cwd: root });
    // Replace the tracked directory with a symlink: git still lists real/a.ts.
    await rm(join(root, "real"), { recursive: true });
    const outside = join(root, "..", "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "a.ts"), "outside\n");
    await symlink(outside, join(root, "real"));
    const boundary = await store.capture();
    expect(Object.keys(boundary.files)).toEqual(["plain.ts"]);
    // git lists the symlink itself (untracked) and the tracked path beneath it.
    expect(boundary.skipped).toEqual(["real", "real/a.ts"]);
    expect(boundary.complete).toBe(false);
  }));
