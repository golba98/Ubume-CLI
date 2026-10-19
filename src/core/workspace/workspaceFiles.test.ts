import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createContainedFileResolver,
  expandFileAttachments,
  FILE_TEXT_LIMIT,
  listWorkspaceFiles,
} from "./workspaceFiles.js";

test("expanded UTF-8 bytes count every attachment occurrence and original text", async () => {
  const registry = new Map([
    ["[file]", { path: "sample.txt", content: "x".repeat(FILE_TEXT_LIMIT) }],
  ]);
  await assert.rejects(expandFileAttachments("[file]".repeat(8), registry, "."), /8 MiB/);
  await assert.rejects(
    expandFileAttachments("字".repeat(3 * FILE_TEXT_LIMIT), new Map(), "."),
    /8 MiB/,
  );
  const literal = new Map([
    ["first", { path: "one", content: "second" }],
    ["second", { path: "two", content: "unexpected" }],
  ]);
  assert.doesNotMatch(await expandFileAttachments("first", literal, "."), /unexpected/);
});

test("non-Git nested negation follows Git ignore precedence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-ignore-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "hidden"));
    writeFileSync(join(root, ".gitignore"), "*.log\nhidden/\n");
    writeFileSync(join(root, "src/.gitignore"), "!keep.log\n");
    writeFileSync(join(root, "src/keep.log"), "keep");
    writeFileSync(join(root, "src/omit.log"), "omit");
    writeFileSync(join(root, "hidden/.gitignore"), "!inside.log\n");
    writeFileSync(join(root, "hidden/inside.log"), "hidden");
    const withoutGit = await listWorkspaceFiles(root);
    assert(withoutGit.includes("src/keep.log"));
    assert(!withoutGit.includes("src/omit.log"));
    assert(!withoutGit.includes("hidden/inside.log"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    assert.deepEqual(await listWorkspaceFiles(root), withoutGit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint path resolution rechecks a directory replaced by a symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-path-recheck-"));
  try {
    const workspace = join(root, "workspace");
    const directory = join(workspace, "nested");
    const outside = join(root, "outside");
    mkdirSync(directory, { recursive: true });
    mkdirSync(outside);
    const resolveFile = createContainedFileResolver(workspace);
    assert.equal(await resolveFile("nested/one.txt"), join(directory, "one.txt"));
    rmSync(directory, { recursive: true });
    symlinkSync(outside, directory, "dir");
    await assert.rejects(resolveFile("nested/two.txt"), /Symlink paths are unsupported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
