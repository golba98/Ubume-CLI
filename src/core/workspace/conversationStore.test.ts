import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { ConversationStore } from "./conversationStore.js";

const temporaryRoots: string[] = [];

function store(now: string, id = "abc") {
  const root = mkdtempSync(join(tmpdir(), "ubume-conversations-"));
  temporaryRoots.push(root);
  return new ConversationStore("/workspace", {
    rootDir: root,
    now: () => new Date(now),
    idFactory: () => id,
  });
}

afterEach(() => {
  // Tests use unique OS temporary directories; leaving them avoids destructive
  // cleanup and keeps interrupted test runs recoverable.
  temporaryRoots.length = 0;
});

test("ConversationStore creates and reloads a stable conversation", () => {
  const conversations = store("2026-08-16T10:00:00.000Z");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "qwen",
    backendKind: "local-openai-compatible",
  });
  created.messages.push({ role: "user", content: "Help me debug this." });
  conversations.save(created);

  const loaded = conversations.load(created.metadata.id);
  assert.equal(loaded?.metadata.id, created.metadata.id);
  assert.equal(loaded?.metadata.messageCount, 1);
  assert.equal(loaded?.metadata.title, "Help me debug this.");
  assert.equal(loaded?.messages[0]?.content, "Help me debug this.");
});

test("ConversationStore preserves the selected Local backend", () => {
  const conversations = store("2026-08-16T10:00:00.000Z", "unsloth-route");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "qwen",
    backendKind: "local-openai-compatible",
    localBackend: "unsloth",
  });
  conversations.save(created);
  assert.equal(conversations.load(created.metadata.id)?.metadata.localBackend, "unsloth");
});

test("ConversationStore persists the opaque Local Harness session used by /resume", () => {
  const conversations = store("2026-08-16T10:00:00.000Z", "local-harness");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "qwen",
    backendKind: "local-openai-compatible",
  });
  created.metadata.localHarnessSession = {
    version: 1,
    sessionId: "session-123",
    harnessVersion: "0.1.2-rc.1",
    routeFingerprint: "route-hash",
    throughMessageCount: 2,
    transcriptHash: "transcript-hash",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
  conversations.save(created);

  assert.deepEqual(
    conversations.load(created.metadata.id)?.metadata.localHarnessSession,
    created.metadata.localHarnessSession,
  );
});

test("ConversationStore persists invisible Local context checkpoints", () => {
  const conversations = store("2026-08-16T10:00:00.000Z", "local-checkpoint");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "ornith",
    backendKind: "local-openai-compatible",
  });
  created.messages.push({ role: "user", content: "Continue this task." });
  created.metadata.localContextCheckpoint = {
    version: 1,
    modelId: "ornith",
    contextLength: 2_024,
    throughMessageCount: 1,
    transcriptHash: "abc123",
    summary: "Objective: continue the task.",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
  conversations.save(created);

  assert.deepEqual(
    conversations.load(created.metadata.id)?.metadata.localContextCheckpoint,
    created.metadata.localContextCheckpoint,
  );
});

test("ConversationStore ignores malformed Local context checkpoints", () => {
  const conversations = store("2026-08-16T10:00:00.000Z", "invalid-checkpoint");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "ornith",
    backendKind: "local-openai-compatible",
  });
  conversations.save(created);

  const rootDir = (conversations as unknown as { rootDir: string }).rootDir;
  const metadataPath = join(rootDir, created.metadata.id, "snapshot.json");
  const snapshot = JSON.parse(readFileSync(metadataPath, "utf8"));
  const metadata = snapshot.metadata as Record<string, unknown>;
  metadata.localContextCheckpoint = {
    version: 1,
    modelId: "ornith",
    contextLength: -1,
    throughMessageCount: -1,
    transcriptHash: "abc123",
    summary: "Invalid checkpoint",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
  writeFileSync(metadataPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  assert.equal(conversations.load(created.metadata.id)?.metadata.localContextCheckpoint, undefined);
});

test("ConversationStore lists newest activity first and ignores malformed conversations", () => {
  const conversations = store("2026-08-16T12:00:00.000Z", "first");
  const first = conversations.createConversation({
    providerId: "local",
    modelId: "one",
    backendKind: "local-openai-compatible",
  });
  first.messages.push({ role: "user", content: "Older" });
  conversations.save(first);

  const newer = new ConversationStore("/workspace", {
    rootDir: (conversations as unknown as { rootDir: string }).rootDir,
    now: () => new Date("2026-08-16T13:00:00.000Z"),
    idFactory: () => "second",
  });
  const second = newer.createConversation({
    providerId: "anthropic",
    modelId: "sonnet",
    backendKind: "anthropic-api-key",
  });
  second.messages.push({ role: "user", content: "Newer" });
  newer.save(second);
  mkdirSync(join((conversations as unknown as { rootDir: string }).rootDir, "chat_bad"));
  writeFileSync(
    join((conversations as unknown as { rootDir: string }).rootDir, "chat_bad", "messages.json"),
    "invalid",
  );

  const listed = newer.list();
  assert.deepEqual(
    listed.map((entry) => entry.id),
    [second.metadata.id, first.metadata.id],
  );
});

test("ConversationStore does not leave temporary files after a successful atomic save", () => {
  const conversations = store("2026-08-16T10:00:00.000Z");
  const created = conversations.createConversation({
    providerId: "openai",
    modelId: "gpt",
    backendKind: "codex-cli-auth",
  });
  created.messages.push({ role: "user", content: "Atomic" });
  conversations.save(created);
  const rootDir = (conversations as unknown as { rootDir: string }).rootDir;
  assert.equal(existsSync(join(rootDir, created.metadata.id, "messages.json.tmp")), false);
  assert.equal(existsSync(join(rootDir, created.metadata.id, "metadata.json.tmp")), false);
});

test("ConversationStore round-trips assistant activity summaries and loads messages saved without them", () => {
  const conversations = store("2026-09-12T10:00:00.000Z", "activity-summary");
  const created = conversations.createConversation({
    providerId: "local",
    modelId: "qwen",
    backendKind: "local-openai-compatible",
  });
  created.messages.push(
    { role: "user", content: "Build it" },
    { role: "assistant", content: "Done.", activitySummary: "Files changed: index.html (created)" },
    { role: "user", content: "Thanks" },
  );
  conversations.save(created);

  const loaded = conversations.load(created.metadata.id);
  assert.deepEqual(loaded?.messages, [
    { role: "user", content: "Build it" },
    { role: "assistant", content: "Done.", activitySummary: "Files changed: index.html (created)" },
    { role: "user", content: "Thanks" },
  ]);
  assert.equal("activitySummary" in (loaded?.messages[0] ?? {}), false);
});

test("atomic snapshots preserve submitted context and ignore stale legacy dialogue", () => {
  const conversations = store("2026-09-30T12:00:00Z", "snapshot");
  const record = conversations.createConversation({
    providerId: "openai",
    modelId: "gpt-5.4",
    backendKind: "cli-delegated",
  });
  record.messages.push({
    role: "user",
    content: "[Pasted Content 2000 chars]",
    submittedContent: "exact immutable source",
    turnId: 12,
  });
  record.session = {
    version: 1,
    events: [],
    uiState: { kind: "IDLE" },
    plan: { kind: "idle" },
    draft: "unsent",
    cursor: 6,
    history: [],
    pastes: [],
    images: [],
    files: [],
    queue: [],
    checkpoints: [],
  };
  conversations.save(record);
  const root = (conversations as unknown as { rootDir: string }).rootDir;
  writeFileSync(
    join(root, record.metadata.id, "messages.json"),
    JSON.stringify([{ role: "user", content: "stale" }]),
  );
  const restored = conversations.load(record.metadata.id);
  assert.equal(restored?.messages[0]?.submittedContent, "exact immutable source");
  assert.equal(restored?.session?.draft, "unsent");
  const snapshotPath = join(root, record.metadata.id, "snapshot.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  snapshot.session.queue = [null];
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  assert.equal(conversations.load(record.metadata.id)?.session, undefined);
  assert.equal(
    conversations.load(record.metadata.id)?.messages[0]?.submittedContent,
    "exact immutable source",
  );
});

test("ConversationStore list hides conversations that never received a message", () => {
  const conversations = store("2026-09-30T10:00:00.000Z", "empty");
  conversations.save(
    conversations.createConversation({
      providerId: "openai",
      modelId: "gpt",
      backendKind: "codex-cli-auth",
    }),
  );

  const withMessage = new ConversationStore("/workspace", {
    rootDir: (conversations as unknown as { rootDir: string }).rootDir,
    now: () => new Date("2026-09-30T11:00:00.000Z"),
    idFactory: () => "real",
  });
  const real = withMessage.createConversation({
    providerId: "openai",
    modelId: "gpt",
    backendKind: "codex-cli-auth",
  });
  real.messages.push({ role: "user", content: "Hello" });
  withMessage.save(real);

  assert.deepEqual(
    withMessage.list().map((entry) => entry.id),
    ["chat_real"],
  );
  // Hidden, not deleted: an explicit resume by id still loads it.
  assert.equal(withMessage.load("chat_empty")?.metadata.messageCount, 0);
});

test("ConversationStore round-trips the external session a conversation was imported from", () => {
  const conversations = store("2026-09-30T10:00:00.000Z", "imported");
  const created = conversations.createConversation({
    providerId: "anthropic",
    modelId: "sonnet",
    backendKind: "anthropic-cli-auth",
  });
  created.metadata.importedFrom = {
    source: "claude",
    sessionId: "8b442d14-cec1-417d-b1de-917c24801914",
  };
  created.messages.push({ role: "user", content: "Imported" });
  conversations.save(created);

  assert.deepEqual(conversations.load(created.metadata.id)?.metadata.importedFrom, {
    source: "claude",
    sessionId: "8b442d14-cec1-417d-b1de-917c24801914",
  });
  assert.deepEqual(conversations.list()[0]?.importedFrom, {
    source: "claude",
    sessionId: "8b442d14-cec1-417d-b1de-917c24801914",
  });
});

function storeWithDiagnostics(id: string) {
  const root = mkdtempSync(join(tmpdir(), "ubume-conversations-"));
  temporaryRoots.push(root);
  const diagnostics: string[] = [];
  const conversations = new ConversationStore("/workspace", {
    rootDir: root,
    now: () => new Date("2026-10-18T10:00:00.000Z"),
    idFactory: () => id,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  const record = conversations.createConversation({
    providerId: "openai",
    modelId: "gpt-test",
    backendKind: "codex-cli-auth",
  });
  record.messages.push({ role: "user", content: "First message" });
  conversations.save(record);
  return { root, conversations, record, diagnostics, dir: join(root, record.metadata.id) };
}

test("a failed canonical write leaves the previous snapshot intact and no temporary files", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, () => {
  const { conversations, record, dir } = storeWithDiagnostics("interrupted");
  const before = readFileSync(join(dir, "snapshot.json"), "utf8");
  record.messages.push({ role: "assistant", content: "Never persisted" });
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => conversations.save(record));
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(readFileSync(join(dir, "snapshot.json"), "utf8"), before);
  assert.equal(conversations.load(record.metadata.id)?.messages.length, 1);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("summary cache failures are isolated and list() falls back to the snapshot", () => {
  const { conversations, record, diagnostics, dir } = storeWithDiagnostics("cache-failure");
  // A directory where the cache file belongs makes every cache write fail.
  rmSync(join(dir, "summary.json"));
  mkdirSync(join(dir, "summary.json"));
  record.messages.push({ role: "assistant", content: "Saved despite cache" });
  conversations.save(record);
  assert.match(diagnostics.join("\n"), /Summary cache unavailable/);
  assert.equal(conversations.load(record.metadata.id)?.messages.length, 2);
  assert.equal(conversations.list()[0]?.messageCount, 2);
});

test("a stale or truncated summary cache is never trusted", () => {
  const { conversations, record, dir } = storeWithDiagnostics("stale-cache");
  const stale = readFileSync(join(dir, "summary.json"), "utf8");
  record.messages.push({ role: "assistant", content: "Second" });
  conversations.save(record);
  // Simulates a crash that kept an older cache (or lost the unsynced latest one).
  writeFileSync(join(dir, "summary.json"), stale);
  assert.equal(conversations.list()[0]?.messageCount, 2);
  writeFileSync(join(dir, "summary.json"), stale.slice(0, 10));
  assert.equal(conversations.list()[0]?.messageCount, 2);
});
