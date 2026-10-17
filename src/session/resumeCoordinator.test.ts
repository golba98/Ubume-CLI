import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationStore } from "../core/workspace/conversationStore.js";
import {
  assessSavedRoute,
  createSessionWorkspaceRelaunch,
  importNativeConversation,
} from "./sessionCatalog.js";

test("saved routes keep model, reasoning and backend and require explicit choice for missing routes", () => {
  const saved = {
    version: 1 as const,
    id: "chat_a",
    title: "chat",
    createdAt: "",
    updatedAt: "",
    messageCount: 2,
    providerId: "local",
    modelId: "fixture",
    backendKind: "local-openai-compatible",
    localBackend: "unsloth" as const,
    reasoning: "high",
  };
  const discovery = {
    providerId: "local" as const,
    backendKind: "local-openai-compatible" as const,
    status: "ready" as const,
    freshness: "verified" as const,
    complete: true,
    models: [
      {
        id: "fixture",
        modelId: "fixture",
        label: "fixture",
        description: "",
        defaultReasoningLevel: null,
        supportedReasoningLevels: null,
      },
    ],
  };
  const ready = assessSavedRoute(saved, discovery);
  assert.equal(ready.status, "ready");
  if (ready.status === "ready") {
    assert.equal(ready.route.localBackend, "unsloth");
    assert.equal(ready.route.reasoning, "high");
  }
  assert.equal(assessSavedRoute(saved, discovery, false).status, "unavailable");
  assert.equal(
    assessSavedRoute({ ...saved, localBackend: undefined }, discovery).status,
    "unavailable",
  );
  assert.equal(
    assessSavedRoute(saved, { ...discovery, status: "not-configured", models: [] }).status,
    "unavailable",
  );
  assert.equal(assessSavedRoute({ ...saved, modelId: "removed" }, discovery).status, "unavailable");
  assert.equal(assessSavedRoute({ ...saved, providerId: "unknown" }, null).status, "unavailable");
  // Historical Antigravity identities remain usable without rewriting saved data.
  assert.equal(
    assessSavedRoute(
      {
        ...saved,
        providerId: "antigravity",
        backendKind: "antigravity-cli-auth",
        localBackend: undefined,
      },
      null,
    ).status,
    "ready",
  );
});

test("saved Antigravity routes resume as Google and legacy Gemini sessions require an explicit selection", () => {
  const metadata = {
    version: 1 as const,
    id: "chat_old",
    title: "old",
    createdAt: "",
    updatedAt: "",
    messageCount: 2,
    providerId: "antigravity",
    backendKind: "antigravity-cli-auth",
    modelId: "exact-native-high",
    reasoning: "high",
  };
  const assessment = assessSavedRoute(metadata, null);
  assert.equal(assessment.status, "ready");
  assert.deepEqual(assessment.route, {
    providerId: "google",
    backendKind: "antigravity-cli-auth",
    modelId: "exact-native-high",
    reasoning: "high",
  });
  assert.equal(
    metadata.providerId,
    "antigravity",
    "assessment does not overwrite the source record",
  );
  const oldGoogle = assessSavedRoute(
    { ...metadata, providerId: "google", backendKind: "gemini-cli-auth" },
    null,
  );
  assert.equal(oldGoogle.status, "unavailable");
  if (oldGoogle.status === "unavailable") assert.match(oldGoogle.message, /removed Gemini CLI/);
});

test("native imports deduplicate Google and Antigravity provenance without discarding continued turns", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-google-import-"));
  try {
    const store = new ConversationStore(root, { rootDir: join(root, "chats") });
    const transcript = {
      summary: {
        source: "antigravity" as const,
        id: "native-agy",
        title: "old",
        cwd: root,
        updatedAt: "",
      },
      entries: [{ id: "one", kind: "user" as const, title: "You", text: "original" }],
    };
    const original = importNativeConversation(store, transcript, "native-model");
    original.messages.push({ role: "assistant", content: "continued" });
    store.save(original);
    const imported = importNativeConversation(
      store,
      { ...transcript, summary: { ...transcript.summary, source: "google" } },
      "native-model",
    );
    assert.equal(imported.metadata.id, original.metadata.id);
    assert.deepEqual(imported.messages, original.messages);
    assert.equal(imported.metadata.importedFrom?.source, "antigravity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native imports reuse provenance, retain new owned turns, and workspace relaunch carries a single resume target", () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-import-"));
  try {
    const store = new ConversationStore(root, { rootDir: join(root, "chats") });
    const transcript = {
      summary: {
        source: "vibe" as const,
        id: "native",
        title: "Mistral chat",
        cwd: root,
        model: "chosen",
        updatedAt: "",
      },
      entries: [
        { id: "1", kind: "user" as const, title: "You", text: "first" },
        { id: "2", kind: "assistant" as const, title: "Vibe", text: "reply" },
      ],
    };
    const record = importNativeConversation(store, transcript, "fallback");
    record.messages.push({ role: "user", content: "owned continuation" });
    store.save(record);
    const again = importNativeConversation(store, transcript, "fallback");
    assert.equal(again.metadata.id, record.metadata.id);
    assert.equal(again.messages.length, 3);
    assert.equal(again.metadata.modelId, "chosen");
    const plan = createSessionWorkspaceRelaunch(
      root,
      {
        workspaceRoot: "/current",
        packageRoot: "/package",
        launchKind: "installed-bin",
        relaunchExecutable: "/bin/bun",
        relaunchArgs: ["/package/bin/ubume.js"],
      },
      { conversationId: record.metadata.id },
    );
    assert.equal(plan.ok, true);
    if (plan.ok) {
      assert.equal(plan.plan.cwd, root);
      assert.deepEqual(plan.plan.args.slice(-2), ["--resume", record.metadata.id]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
