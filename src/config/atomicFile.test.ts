import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonFileAtomic, writeTextFileAtomic, writeTextFileIfAbsent } from "./atomicFile.js";

test("atomicFile writes text content atomically and creates nested directories", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ubume-atomic-test-"));
  try {
    const targetFile = join(tempDir, "nested", "dir", "test.txt");
    writeTextFileAtomic(targetFile, "hello atomic world");

    assert.ok(existsSync(targetFile));
    assert.equal(readFileSync(targetFile, "utf-8"), "hello atomic world");

    // Overwrite existing file
    writeTextFileAtomic(targetFile, "updated content");
    assert.equal(readFileSync(targetFile, "utf-8"), "updated content");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("atomicFile writes JSON content with custom formatting", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ubume-atomic-json-"));
  try {
    const targetFile = join(tempDir, "data.json");
    const payload = { key: "value", numbers: [1, 2, 3] };
    writeJsonFileAtomic(targetFile, payload, 2);

    assert.ok(existsSync(targetFile));
    const content = readFileSync(targetFile, "utf-8");
    assert.deepEqual(JSON.parse(content), payload);
    assert.ok(content.includes('  "key": "value"'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migration publication preserves a destination created by another writer", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-exclusive-import-"));
  try {
    const path = join(root, "settings.json");
    assert.equal(writeTextFileIfAbsent(path, '{"current":true}'), true);
    assert.equal(writeTextFileIfAbsent(path, '{"legacy":true}'), false);
    assert.equal(readFileSync(path, "utf8"), '{"current":true}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomicFile performs rapid successive writes without colliding temporary files", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ubume-atomic-rapid-"));
  try {
    const targetFile = join(tempDir, "rapid.txt");
    for (let i = 0; i < 50; i++) {
      writeTextFileAtomic(targetFile, `iteration ${i}`);
    }
    assert.equal(readFileSync(targetFile, "utf-8"), "iteration 49");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
