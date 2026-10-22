import assert from "node:assert/strict";
import { App } from "../../app/App.js";
import { parseLaunchArgs } from "../../config/launchArgs.js";
import { loadSettings, saveSettings } from "../../config/persistence.js";
import type { BackendProvider } from "../../core/providers/types.js";
import { CheckpointStore } from "../../core/workspace/checkpoints.js";
import { ConversationStore } from "../../core/workspace/conversationStore.js";
import { inspectOwnership } from "../../core/workspace/ownership.js";
import { waitFor } from "../async.js";
import { createTestTerminal } from "../terminal.js";

const scenario = process.argv[2];
globalThis.fetch = () => {
  throw new Error("Network forbidden in resume fixture");
};
const settings = loadSettings();
saveSettings({ ...settings, updateCheck: { ...settings.updateCheck!, enabled: false } });
const store = new ConversationStore(process.cwd());
for (const id of ["a", "b"]) {
  const entry = new ConversationStore(process.cwd(), { idFactory: () => id }).createConversation({
    providerId: "openai",
    modelId: "gpt-5.4",
    backendKind: "codex-cli-auth",
  });
  entry.metadata.title = `TITLE_${id.toUpperCase()}`;
  entry.messages = [
    { role: "user", content: `${id}_PROMPT` },
    {
      role: "assistant",
      content: `${id}_ANSWER\n\n\x60\x60\x60ts\nconst ${id} = true;\n\x60\x60\x60`,
    },
  ];
  store.save(entry);
}
const calls: { prompt: string; history: string; cwd: string }[] = [];
const provider: BackendProvider = {
  id: "codex-subprocess",
  label: "fixture",
  description: "offline",
  authState: "delegated",
  authLabel: "offline",
  statusMessage: "offline",
  supportsModels: () => true,
  run(prompt, options, handlers) {
    calls.push({
      prompt,
      history: JSON.stringify(options.conversationHistory),
      cwd: options.workspaceRoot,
    });
    handlers.onRunControl?.({ stopped: Promise.resolve() });
    const timer = setTimeout(() => handlers.onResponse("CONTINUED_ANSWER"), 30);
    return () => clearTimeout(timer);
  },
};
const parsed = parseLaunchArgs(["--no-clear"]);
assert(parsed.ok);
const terminal = createTestTerminal(<App launchArgs={parsed.value} providerOverride={provider} />, {
  columns: 100,
  rows: 22,
});
const delay = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));
const until = (check: () => boolean, label: string) =>
  waitFor(check, { label, diagnostics: () => terminal.lastFrame() });
const send = async (command: string) => {
  terminal.stdin.write(command);
  await delay();
  terminal.stdin.write("\r");
  await delay();
};
const resume = async (id: string) => {
  await send(`/resume chat_${id}`);
  await until(() => terminal.lastFrame().includes(`${id}_ANSWER`), `restored ${id}`);
};
const originalRecover = CheckpointStore.prototype.recover;
const originalSave = ConversationStore.prototype.save;
try {
  await until(() => terminal.lastFrame().includes("Ask Ubume"), "fresh empty startup ready");
  if (scenario === "picker") {
    await send("/resume");
    await until(() => terminal.lastFrame().includes("TITLE_A"), "first-command selector");
    terminal.stdin.write("/TITLE_A");
    await delay();
    terminal.stdin.write("\r");
    await delay();
    terminal.stdin.write("\r");
    await until(
      () => terminal.lastFrame().includes("a_ANSWER"),
      "picker restored complete dialogue",
    );
    assert.equal(calls.length, 0, "history restoration must never launch a provider");
    const baseline = terminal.stdin.listenerCount("data");
    for (let i = 0; i < 6; i++) {
      await send("/resume");
      terminal.stdin.write("\x1b");
      await delay();
    }
    assert.equal(
      terminal.stdin.listenerCount("data"),
      baseline,
      "reopening leaks no input listeners",
    );
    await send("continue A");
    await until(() => calls.length === 1, "continuation executes once");
    assert(calls[0]!.history.includes("a_ANSWER"));
    assert(!calls[0]!.history.includes("b_ANSWER"));
    assert.equal(calls[0]!.cwd, process.cwd());
    await until(
      () =>
        store.load("chat_a")?.messages.some((message) => message.content === "CONTINUED_ANSWER") ===
        true,
      "continuation persisted",
    );
    await resume("b");
    assert(!terminal.lastFrame().includes("a_ANSWER"), "old transcript cannot leak into session B");
    assert.equal(calls.length, 1);
    assert.equal(store.list().length, 2, "selection cannot create duplicate conversations");
  } else if (scenario === "cancel" || scenario === "recovery-failure") {
    await resume("a");
    let started = false;
    let release!: () => void;
    CheckpointStore.prototype.recover = async () => {
      started = true;
      if (scenario === "recovery-failure") throw new Error("FIXTURE_RECOVERY_FAILED");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return false;
    };
    await send("/resume chat_b");
    await until(() => started, "target preparation began");
    if (scenario === "cancel") {
      terminal.stdin.write("\x1b");
      await delay();
      release();
      await delay();
    } else {
      await until(
        () => terminal.lastFrame().includes("FIXTURE_RECOVERY_FAILED"),
        "failed preparation visible",
      );
      await delay();
    }
    assert(
      inspectOwnership(process.cwd(), "chat_a").locked,
      "active lease survives failure or cancellation",
    );
    assert(!inspectOwnership(process.cwd(), "chat_b").locked, "target lease released");
    assert.equal(calls.length, 0);
    CheckpointStore.prototype.recover = originalRecover;
    await send("continue original");
    await until(() => calls.length === 1, "original conversation remains usable");
    assert(calls[0]!.history.includes("a_ANSWER"));
    assert(!calls[0]!.history.includes("b_ANSWER"));
  } else if (scenario === "save-failure") {
    await resume("a");
    ConversationStore.prototype.save = function (record) {
      if (record.metadata.id === "chat_a") throw new Error("FIXTURE_DISK_FULL");
      return originalSave.call(this, record);
    };
    await send("/clear");
    await until(() => terminal.output().includes("Clear failed"), "clear failure visible");
    assert(inspectOwnership(process.cwd(), "chat_a").locked);
    ConversationStore.prototype.save = originalSave;
    await send("continue retained");
    await until(() => calls.length === 1, "failed clear retains active chat");
    assert(calls[0]!.history.includes("a_ANSWER"));
  } else throw new Error(`Unknown scenario ${scenario}`);
} finally {
  CheckpointStore.prototype.recover = originalRecover;
  ConversationStore.prototype.save = originalSave;
  await terminal.dispose();
  store.release();
}
