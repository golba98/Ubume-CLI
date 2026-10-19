import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ConversationStore } from "./conversationStore.js";
import { importLegacyData } from "./legacyDataMigration.js";

function fixture(
  run: (f: {
    root: string;
    source: string;
    target: string;
    put(path: string, content: string): void;
  }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "ubume-data-import-"));
  const source = join(root, "legacy");
  const target = join(root, "ubume");
  mkdirSync(source);
  const put = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  try {
    run({ root, source, target, put });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("imports missing artifacts, preserves current files and secrets, and never deletes originals", () => {
  fixture(({ source, target, put }) => {
    put(join(source, "providers.json"), '{"apiKey":"synthetic-secret","model":"codexa-934m-end3"}');
    put(join(source, "settings.json"), '{"theme":"old"}');
    put(join(target, "settings.json"), '{"theme":"current"}');
    assert.equal(importLegacyData(source, target), true);
    assert.equal(readFileSync(join(target, "settings.json"), "utf8"), '{"theme":"current"}');
    assert.equal(
      readFileSync(join(target, "providers.json"), "utf8"),
      readFileSync(join(source, "providers.json"), "utf8"),
    );
    assert.ok(existsSync(join(source, "providers.json")));
    if (process.platform !== "win32")
      assert.equal(statSync(join(target, "providers.json")).mode & 0o777, 0o600);
    rmSync(join(target, "providers.json"));
    assert.equal(importLegacyData(source, target), true);
    assert.equal(
      existsSync(join(target, "providers.json")),
      false,
      "completed imports never resurrect deleted files",
    );
  });
});

test("retries failed entries after a partial import without recopying completed artifacts", () => {
  fixture(({ source, target, put }) => {
    put(join(source, "first.json"), '{"value":1}');
    put(join(source, "broken.json"), "{broken");
    assert.equal(importLegacyData(source, target), false);
    assert.ok(existsSync(join(target, "first.json")));
    assert.equal(existsSync(join(target, "broken.json")), false);
    rmSync(join(target, "first.json"));
    put(join(source, "broken.json"), '{"fixed":true}');
    assert.equal(importLegacyData(source, target), true);
    assert.equal(existsSync(join(target, "first.json")), false);
    assert.equal(readFileSync(join(target, "broken.json"), "utf8"), '{"fixed":true}');
  });
});

test("imports conversations as complete records and never combines conflicting generations", () => {
  fixture(({ source, target, put }) => {
    const record = join("workspaces", "workspace", "conversations", "chat_one");
    put(join(source, record, "messages.json"), '[{"role":"user","content":"original"}]');
    put(join(source, record, "metadata.json"), '{"title":"legacy"}');
    put(join(target, record, "snapshot.json"), '{"title":"current"}');
    const other = join("chats", "workspace", "conversations", "chat_two");
    put(join(source, other, "snapshot.json"), '{"modelId":"codexa-934m-base"}');
    assert.equal(importLegacyData(source, target), true);
    assert.equal(existsSync(join(target, record, "messages.json")), false);
    assert.equal(
      readFileSync(join(target, record, "snapshot.json"), "utf8"),
      '{"title":"current"}',
    );
    assert.equal(
      readFileSync(join(target, other, "snapshot.json"), "utf8"),
      '{"modelId":"codexa-934m-base"}',
    );
  });
});

test("does not publish incomplete or malformed conversation records", () => {
  fixture(({ source, target, put }) => {
    const record = join("conversations", "chat_one");
    put(join(source, record, "messages.json"), "[]");
    put(join(source, record, "metadata.json"), "broken");
    assert.equal(importLegacyData(source, target), false);
    assert.equal(existsSync(join(target, record)), false);
    put(join(source, record, "metadata.json"), "{}");
    assert.equal(importLegacyData(source, target), true);
    assert.ok(existsSync(join(target, record, "messages.json")));
  });
});

test("rejects source and destination symlinks and overlapping roots", () => {
  fixture(({ root, source, target, put }) => {
    put(join(source, "outside.json"), "{}");
    symlinkSync(join(source, "outside.json"), join(source, "linked.json"));
    assert.equal(importLegacyData(source, target), false);
    assert.equal(existsSync(join(target, "linked.json")), false);
    assert.equal(importLegacyData(source, join(source, "nested")), false);
    const linked = join(root, "linked");
    symlinkSync(source, linked, "dir");
    assert.equal(importLegacyData(linked, target), false);
    assert.equal(importLegacyData(source, linked), false);
  });
});

test("keeps blocked destinations intact and retries once filesystem obstruction is removed", () => {
  fixture(({ source, target, put }) => {
    put(join(source, "nested", "data.json"), "{}");
    put(join(target, "nested"), "current file");
    assert.equal(importLegacyData(source, target), false);
    assert.equal(readFileSync(join(target, "nested"), "utf8"), "current file");
    rmSync(join(target, "nested"));
    assert.equal(importLegacyData(source, target), true);
    assert.ok(existsSync(join(target, "nested", "data.json")));
  });
});

test("honors an active importer lock and excludes legacy process locks", () => {
  fixture(({ source, target, put }) => {
    put(join(source, "data.json"), "{}");
    put(join(source, "runtime.lock"), "old process");
    const key = createHash("sha256").update(source).digest("hex");
    const lock = join(target, ".identity-migration", `${key}.lock`);
    put(lock, String(process.pid));
    assert.equal(importLegacyData(source, target), false);
    assert.ok(existsSync(lock));
    rmSync(lock);
    assert.equal(importLegacyData(source, target), true);
    assert.equal(existsSync(join(target, "runtime.lock")), false);
  });
});

test("reclaims the lock left by a demonstrably exited local importer", () => {
  fixture(({ source, target, put }) => {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    });
    assert.equal(child.status, 0);
    const key = createHash("sha256").update(source).digest("hex");
    put(join(target, ".identity-migration", `${key}.lock`), child.stdout);
    put(join(source, "data.json"), "{}");
    assert.equal(importLegacyData(source, target), true);
    assert.ok(existsSync(join(target, "data.json")));
  });
});

test("permission failures retain originals and remain retryable", {
  skip: process.platform === "win32",
}, () => {
  fixture(({ source, target, put }) => {
    put(join(source, "data.json"), "{}");
    mkdirSync(target);
    chmodSync(target, 0o500);
    try {
      assert.equal(importLegacyData(source, target), false);
      assert.ok(existsSync(join(source, "data.json")));
    } finally {
      chmodSync(target, 0o700);
    }
    assert.equal(importLegacyData(source, target), true);
    assert.ok(existsSync(join(target, "data.json")));
  });
});

test("imported canonical conversation snapshots retain model identity, messages and conversation metadata", () => {
  fixture(({ source, target }) => {
    const original = new ConversationStore("/fixture/workspace", {
      rootDir: join(source, "conversations"),
      now: () => new Date("2026-10-19T00:00:00Z"),
    });
    const record = original.createConversation({
      providerId: "codexa-native",
      modelId: "codexa-934m-end3",
      backendKind: "codexa-native-pytorch",
    });
    record.messages.push(
      { role: "user", content: "retained prompt" },
      { role: "assistant", content: "retained answer" },
    );
    original.save(record);
    assert.equal(importLegacyData(source, target), true);
    const current = new ConversationStore("/fixture/workspace", {
      rootDir: join(target, "conversations"),
    }).load(record.metadata.id);
    assert.equal(current?.metadata.modelId, "codexa-934m-end3");
    assert.equal(current?.metadata.providerId, "codexa-native");
    assert.deepEqual(current?.messages, original.load(record.metadata.id)?.messages);
    assert.ok(existsSync(join(source, "conversations", record.metadata.id, "snapshot.json")));
  });
});
