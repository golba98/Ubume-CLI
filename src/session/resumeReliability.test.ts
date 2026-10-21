import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workspaceStorageKey } from "../core/workspace/appData.js";
import { ConversationStore } from "../core/workspace/conversationStore.js";
import { inspectOwnership } from "../core/workspace/ownership.js";
import {
  canonicalWorkspaceRoot,
  resolveWorkspaceRoot,
  sameFolder,
} from "../core/workspace/workspaceRoot.js";
import { createTestEnvironment, withEnvironment } from "../test/environment.js";
import { TEST_RUNTIME } from "../test/runtimeTestUtils.js";
import { buildStaticRenderItems, buildTimelineItems } from "../ui/timeline/timelineItems.js";
import { buildNativeTranscriptParts } from "../ui/timeline/timelineMeasure.js";
import { createRunEvent, upsertRunToolActivity } from "./chatLifecycle.js";
import { advanceIdsPast } from "./eventIds.js";
import { createInitialPlanFlowState } from "./planFlow.js";
import { relocateConversation } from "./relocateConversation.js";
import { hydrateConversationEvents } from "./restoreConversation.js";
import { ResumeTransition } from "./resumeTransition.js";
import { createSessionWorkspaceRelaunch, listSessionCatalog } from "./sessionCatalog.js";
import { assessContinuation } from "./sessionContinuation.js";

const route = { providerId: "openai", modelId: "fixture", backendKind: "codex-cli-auth" } as const;
const emptySession = () => ({
  version: 1 as const,
  events: [],
  uiState: { kind: "IDLE" as const },
  plan: createInitialPlanFlowState(),
  draft: "",
  cursor: 0,
  history: [],
  pastes: [],
  images: [],
  files: [],
  queue: [],
  checkpoints: [],
});

async function sandbox(run: (root: string, workspace: string) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ubume-resume-regression-"));
  const workspace = join(root, "nested folder", "プロジェクト");
  mkdirSync(workspace, { recursive: true });
  try {
    await withEnvironment(createTestEnvironment(root, { CODEX_WORKSPACE_ROOT: workspace }), () =>
      run(root, workspace),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resume preparation cancels without allowing a stale commit or finish", () => {
  const transition = new ResumeTransition();
  const first = transition.begin();
  assert.throws(() => transition.begin(), /already/);
  assert.equal(transition.cancel(), true);
  assert.throws(() => first.commit(), /canceled/);
  first.finish();
  const second = transition.begin();
  first.finish();
  assert.equal(transition.phase, "preparing");
  second.commit();
  assert.equal(transition.cancel(), false);
  second.finish();
  assert.equal(transition.phase, "idle");
});

for (const turns of [1, 30, 240])
  test(`dialogue-only restoration renders all ${turns} answers and code without running tools`, () =>
    sandbox((_root, workspace) => {
      const store = new ConversationStore(workspace);
      const record = store.createConversation(route);
      record.messages = Array.from({ length: turns }, (_, index) => [
        { role: "user" as const, content: `PROMPT_${index}` },
        {
          role: "assistant" as const,
          content: `ANSWER_${index}\n\n\x60\x60\x60ts\nconst answer${index} = true;\n\x60\x60\x60`,
          activitySummary: "Failed command: historical-only",
        },
      ]).flat();
      const events = hydrateConversationEvents(record);
      const items = buildTimelineItems(events);
      const ids = items.flatMap((item) => (item.type === "turn" ? [item.turnId] : []));
      const rendered = buildNativeTranscriptParts(
        buildStaticRenderItems(items, ids, null, null, null),
        { totalWidth: 80 },
      );
      const text = rendered.staticItems
        .flatMap((item) => item.rows.flatMap((row) => row.spans.map((span) => span.text)))
        .join("\n");
      for (let i = 0; i < turns; i++) {
        assert(text.includes(`ANSWER_${i}`));
        assert(text.includes(`answer${i}`));
      }
      assert(text.includes("Failed command"));
      assert.equal(rendered.liveRows.length, 0);
    }));

test("hydration repairs missing answers while retaining failed and interrupted tool outcomes", () =>
  sandbox((_root, workspace) => {
    const record = new ConversationStore(workspace).createConversation(route);
    record.messages = [
      { role: "user", content: "question" },
      { role: "assistant", content: "retained answer" },
    ];
    let run = createRunEvent({
      id: 9001,
      turnId: 9000,
      backendId: "codex-subprocess",
      backendLabel: "fixture",
      runtime: TEST_RUNTIME,
      prompt: "question",
    });
    run = upsertRunToolActivity(run, {
      id: "historical-failure",
      command: "exit 4",
      status: "failed",
      startedAt: 1,
      completedAt: 2,
    });
    run = upsertRunToolActivity(run, {
      id: "interrupted",
      command: "sleep 100",
      status: "running",
      startedAt: 1,
    });
    record.session = {
      ...emptySession(),
      events: [{ id: 9000, type: "user", turnId: 9000, createdAt: 1, prompt: "question" }, run],
    };
    const before = JSON.stringify(record);
    const events = hydrateConversationEvents(record);
    assert.equal(JSON.stringify(record), before, "hydration never mutates stored events");
    const restored = events.find((event) => event.type === "run");
    assert(restored?.type === "run");
    assert.equal(restored.status, "canceled");
    assert.deepEqual(
      restored.toolActivities.map((tool) => tool.status),
      ["failed", "failed"],
    );
    assert(
      events.some((event) => event.type === "assistant" && event.content === "retained answer"),
    );
    assert.equal(new Set(events.map((event) => event.id)).size, events.length);
    advanceIdsPast(events);
  }));

test("Google native context, original workspace and semantic activity survive repeated autosaves", () =>
  sandbox((_root, workspace) => {
    let now = new Date("2026-10-01T00:00:00Z");
    const store = new ConversationStore(workspace, { now: () => now });
    const record = store.createConversation({ ...route, providerId: "google" });
    record.messages = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ];
    record.metadata.nativeSessions = [
      {
        source: "antigravity",
        sessionId: "native",
        modelId: "fixture",
        throughMessageCount: 2,
        transcriptHash: "fixture",
      },
    ];
    store.save(record);
    const first = store.load(record.metadata.id)!;
    now = new Date("2026-10-02T00:00:00Z");
    first.session = emptySession();
    store.save(first);
    const after = store.load(record.metadata.id)!;
    assert.equal(after.metadata.lastActivityAt, first.metadata.lastActivityAt);
    assert.notEqual(after.metadata.updatedAt, first.metadata.updatedAt);
    assert.equal(after.metadata.originalWorkspaceRoot, workspace);
    assert.equal(after.metadata.nativeSessions?.[0]?.sessionId, "native");
    assert.equal(assessContinuation(after), "native-candidate");
    after.messages.push({ role: "user", content: "new activity" });
    store.save(after);
    assert.equal(store.load(after.metadata.id)?.metadata.lastActivityAt, now.toISOString());
  }));

test("target lease preparation retains the active lease until commit and releases cancellation", () =>
  sandbox((_root, workspace) => {
    const store = new ConversationStore(workspace, { ownership: true });
    try {
      store.acquire("chat_old");
      const canceled = store.prepareLease("chat_new");
      assert(inspectOwnership(workspace, "chat_old").locked);
      assert(inspectOwnership(workspace, "chat_new").locked);
      canceled.release();
      assert(inspectOwnership(workspace, "chat_old").locked);
      assert(!inspectOwnership(workspace, "chat_new").locked);
      const committed = store.prepareLease("chat_new");
      committed.commit();
      committed.release();
      assert(!inspectOwnership(workspace, "chat_old").locked);
      assert(inspectOwnership(workspace, "chat_new").locked);
    } finally {
      store.release();
    }
  }));

test("invalid auxiliary snapshots are backed up byte-for-byte before dialogue recovery is saved", () =>
  sandbox((_root, workspace) => {
    const store = new ConversationStore(workspace);
    const record = store.createConversation(route);
    record.messages = [{ role: "user", content: "recoverable" }];
    store.save(record);
    const path = store.location(record.metadata.id);
    const damaged = JSON.parse(readFileSync(path, "utf8"));
    damaged.session = { version: 200, recoverableToolOutput: "keep this" };
    writeFileSync(path, JSON.stringify(damaged));
    const recoveredStore = new ConversationStore(workspace);
    const recovered = recoveredStore.load(record.metadata.id)!;
    const original = readFileSync(path);
    recoveredStore.save(recovered);
    const backup = readdirSync(join(path, "..")).find((name) =>
      name.startsWith("snapshot.recovery-"),
    );
    assert(backup);
    assert.deepEqual(readFileSync(join(path, "..", backup)), original);
  }));

test("all-project discovery keeps duplicate titles and basenames distinct and isolates corrupt records", () =>
  sandbox(async (root, workspace) => {
    const other = join(root, "other parent", "プロジェクト");
    mkdirSync(other, { recursive: true });
    for (const folder of [workspace, other]) {
      const store = new ConversationStore(folder);
      const record = store.createConversation(route);
      record.metadata.title = "same title";
      record.messages = [{ role: "user", content: folder }];
      store.save(record);
    }
    const malformed = join(
      root,
      "data/chats",
      workspaceStorageKey(workspace),
      "conversations/chat_bad",
    );
    mkdirSync(malformed);
    writeFileSync(join(malformed, "snapshot.json"), "interrupted JSON");
    const all = await listSessionCatalog(workspace, "all", { sources: [] });
    assert.equal(all.sessions.length, 2);
    assert.equal(new Set(all.sessions.map((entry) => entry.key)).size, 2);
    assert(all.errors.some((message) => message.includes("chat_bad")));
    assert.equal(
      (await listSessionCatalog(workspace, "workspace", { sources: [] })).sessions.length,
      1,
    );
  }));

test("symlink comparison discovers existing aliases without changing their storage identity", () =>
  sandbox(async (root, workspace) => {
    const alias = join(root, "alias folder");
    symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    assert(sameFolder(alias, workspace));
    const previousRoot = process.env.CODEX_WORKSPACE_ROOT;
    try {
      process.env.CODEX_WORKSPACE_ROOT = alias;
      assert.equal(resolveWorkspaceRoot(), workspace);
    } finally {
      process.env.CODEX_WORKSPACE_ROOT = previousRoot;
    }
    assert.equal(canonicalWorkspaceRoot(alias), workspace);
    const store = new ConversationStore(alias);
    const record = store.createConversation(route);
    record.messages = [{ role: "user", content: "alias history" }];
    store.save(record);
    const catalog = await listSessionCatalog(workspace, "workspace", { sources: [] });
    assert.equal(catalog.sessions.length, 1);
    assert.equal(
      catalog.sessions[0]?.ref.kind === "ubume" && catalog.sessions[0].ref.workspaceKey,
      workspaceStorageKey(alias),
    );
  }));

test("explicit relocation preserves the source and resets native sessions, checkpoints, grants and queue", () =>
  sandbox((root, workspace) => {
    const store = new ConversationStore(workspace);
    const original = store.createConversation(route);
    original.messages = [
      { role: "user", content: "keep source" },
      { role: "assistant", content: "historical reply" },
    ];
    original.metadata.nativeSessions = [{ source: "codex", sessionId: "source-session" }];
    original.session = { ...emptySession(), draft: "must not submit", cursor: 15 };
    store.save(original);
    const source = readFileSync(store.location(original.metadata.id));
    const destination = join(root, "moved repo");
    mkdirSync(destination);
    const relocated = relocateConversation(
      {
        kind: "ubume",
        workspaceRoot: workspace,
        workspaceKey: workspaceStorageKey(workspace),
        conversationId: original.metadata.id,
      },
      destination,
    );
    const copy = new ConversationStore(destination).load(relocated.id)!;
    assert.notEqual(copy.metadata.id, original.metadata.id);
    assert.deepEqual(readFileSync(store.location(original.metadata.id)), source);
    assert.equal(copy.metadata.originalWorkspaceRoot, workspace);
    assert.equal(copy.metadata.workspaceRoot, destination);
    assert.equal(copy.metadata.relocatedFrom?.conversationId, original.metadata.id);
    assert.equal(copy.metadata.nativeSessions, undefined);
    assert.equal(copy.session?.draft, "");
    assert.deepEqual(copy.session?.checkpoints, []);
    assert.deepEqual(copy.session?.queue, []);
    assert.deepEqual(copy.messages, original.messages);
  }));

for (const kind of ["installed-bin", "dev-run"] as const)
  test(`${kind} workspace relaunch replaces startup targets and removes prompts and source model overrides`, () =>
    sandbox((_root, workspace) => {
      const prefix =
        kind === "installed-bin"
          ? ["/package/bin/ubume.js"]
          : ["run", "--silent", "/package/src/index.tsx"];
      for (const prior of [
        ["--resume", "chat_old"],
        ["--import-session", "claude:old"],
        ["--model", "old", "initial prompt"],
      ]) {
        const result = createSessionWorkspaceRelaunch(
          workspace,
          {
            workspaceRoot: workspace,
            packageRoot: "/package",
            launchKind: kind,
            relaunchExecutable: process.execPath,
            relaunchArgs: [...prefix, ...prior],
          },
          { conversationId: "chat_new" },
        );
        assert(result.ok);
        assert.deepEqual(result.plan.args, [...prefix, "--resume", "chat_new"]);
      }
    }));

test("dev relaunch preserves the Bun separator, profile and sandbox policy while dropping source grants", () =>
  sandbox((_root, workspace) => {
    const result = createSessionWorkspaceRelaunch(
      workspace,
      {
        workspaceRoot: workspace,
        packageRoot: "/package",
        launchKind: "dev-run",
        relaunchExecutable: process.execPath,
        relaunchArgs: [
          "run",
          "--silent",
          "/package/src/index.tsx",
          "--",
          "--profile",
          "review",
          "-c",
          'sandbox_mode="read-only"',
          "-c",
          'sandbox_workspace_write.writable_roots=["/other"]',
          "--resume",
          "chat_old",
        ],
      },
      { conversationId: "chat_new" },
    );
    assert(result.ok);
    assert.deepEqual(result.plan.args, [
      "run",
      "--silent",
      "/package/src/index.tsx",
      "--",
      "--profile",
      "review",
      "--config",
      'sandbox_mode="read-only"',
      "--resume",
      "chat_new",
    ]);
  }));

test("legacy relative workspace metadata is view-only instead of being resolved against the launch folder", () =>
  sandbox(async (root, workspace) => {
    const relative = "same basename";
    const key = workspaceStorageKey(relative);
    const store = new ConversationStore(relative, {
      rootDir: join(root, "data/chats", key, "conversations"),
    });
    const record = store.createConversation(route);
    record.messages = [{ role: "user", content: "do not guess my original cwd" }];
    store.save(record);
    const catalog = await listSessionCatalog(workspace, "all", { sources: [] });
    const entry = catalog.sessions.find(
      (session) =>
        session.ref.kind === "ubume" && session.ref.conversationId === record.metadata.id,
    );
    assert(entry);
    assert.equal(entry.workspaceRoot, relative);
    assert.deepEqual(entry.actions, ["view"]);
  }));
