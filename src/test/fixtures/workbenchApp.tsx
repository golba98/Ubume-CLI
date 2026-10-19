/**
 * Process-isolated workbench scenarios against the real App and a controllable provider.
 * The save scenario intentionally exits during an active run to test crash-style restoration;
 * normal scenarios dispose the terminal/store. Parent tests own temporary workspace removal.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { App } from "../../app/App.js";
import { parseLaunchArgs } from "../../config/launchArgs.js";
import { loadSettings, saveSettings } from "../../config/persistence.js";
import { codexSubprocessProvider } from "../../core/providers/codexSubprocess.js";
import type { BackendProvider, BackendRunHandlers } from "../../core/providers/types.js";
import { resolveUbumeConversationDir } from "../../core/workspace/appData.js";
import { ConversationStore } from "../../core/workspace/conversationStore.js";
import { inspectOwnership } from "../../core/workspace/ownership.js";
import { waitFor } from "../async.js";
import { createTestTerminal } from "../terminal.js";

const scenario = process.argv[2];
assert(
  scenario &&
    [
      "save",
      "resume",
      "flow",
      "draft-only",
      "quit",
      "cancel-start",
      "plan-actions",
      "plan-warning-save",
      "plan-warning-resume",
      "usage-during-run",
      "shell-complete",
    ].includes(scenario),
  `Unknown workbench scenario: ${scenario}`,
);
// App startup must never check a real update service or use inherited provider credentials.
globalThis.fetch = () => {
  throw new Error("Network access is forbidden in workbench tests");
};
const settings = loadSettings();
saveSettings({ ...settings, updateCheck: { ...settings.updateCheck!, enabled: false } });
let cleanupPending = false;
let cancelCount = 0;
const runs: {
  prompt: string;
  handlers: BackendRunHandlers;
  stopped: () => void;
  history: readonly { content: string }[];
  mode: string;
  planMode: boolean;
}[] = [];
const provider: BackendProvider = {
  id: "codex-subprocess",
  label: "Test",
  description: "test",
  authState: "delegated",
  authLabel: "test",
  statusMessage: "test",
  supportsModels: () => true,
  run(prompt, options, handlers) {
    assert.equal(cleanupPending, false, "new run overlapped provider cleanup");
    let stop!: () => void;
    let ended = false;
    const stopped = new Promise<void>((resolve) => {
      stop = () => {
        ended = true;
        resolve();
      };
    });
    handlers.onRunControl?.({ stopped });
    runs.push({
      prompt,
      handlers,
      stopped: stop,
      history: options.conversationHistory ?? [],
      mode: options.runtime.mode,
      planMode: options.runtime.planMode,
    });
    return () => {
      if (ended) return;
      cancelCount += 1;
      cleanupPending = true;
      setTimeout(() => {
        cleanupPending = false;
        stop();
      }, 50);
    };
  },
};
const parsed = parseLaunchArgs(["--model", "gpt-5.4", "--no-clear"]);
assert(parsed.ok);
const delay = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
function until(check: () => boolean, label: string) {
  return waitFor(check, { label, diagnostics: () => terminal.lastFrame() });
}
const store = new ConversationStore(process.cwd());
if (scenario === "cancel-start")
  for (let i = 0; i < 800; i++) writeFileSync(`file-${i}.txt`, "checkpoint fixture");
if (scenario === "usage-during-run") {
  // A Codex stand-in that fails fast, so /usage never reaches a real account.
  writeFileSync("codex-usage-fixture", "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n", {
    mode: 0o700,
  });
  process.env.CODEX_EXECUTABLE = `${process.cwd()}/codex-usage-fixture`;
}
if (scenario === "plan-warning-save") {
  const fakePath = `${process.cwd()}/codex-plan-fixture`;
  writeFileSync(
    fakePath,
    [
      "#!/usr/bin/env node",
      'if (process.argv.includes("--version")) { console.log("codex-cli 0.0.0"); process.exit(0); }',
      'if (!process.argv.includes("exec")) process.exit(1);',
      'process.stdin.resume(); process.stdin.on("end", () => {',
      "const events = [",
      '{type:"item.completed",item:{id:"warning",type:"error",message:"Nonfatal planning warning"}},',
      '{type:"item.completed",item:{id:"plan",type:"agent_message",text:"<proposed_plan>\\n1. Inspect the code.\\n2. Repair it with tests.\\n</proposed_plan>"}},',
      '{type:"turn.completed"}];',
      'const text = events.map(JSON.stringify).join("\\n");',
      "process.stdout.write(text.slice(0, 33)); setTimeout(() => process.stdout.write(text.slice(33)), 10);",
      "});",
    ].join("\n"),
    { mode: 0o700 },
  );
  process.env.CODEX_EXECUTABLE = fakePath;
}
const terminal = createTestTerminal(
  <App
    launchArgs={parsed.value}
    providerOverride={scenario === "plan-warning-save" ? codexSubprocessProvider : provider}
  />,
);

async function savePlanAfterWarning(): Promise<void> {
  terminal.stdin.write("/plan on");
  await delay();
  terminal.stdin.write("\r");
  await delay(200);
  terminal.stdin.write("Plan a safe fix");
  await delay();
  terminal.stdin.write("\r");
  await until(
    () => terminal.lastFrame().includes("[R] Redo plan"),
    "review after successful Codex process with warning",
  );
  assert(!terminal.lastFrame().includes("Ask again or use /command"));
  // Check before the 300ms draft autosave, then exit without normal teardown.
  await waitFor(() => store.load(store.list()[0]!.id)?.session?.plan.kind === "awaiting_action", {
    timeoutMs: 200,
    label: "review persisted immediately",
  });
  process.exit(0);
}

async function resumePlanAfterWarning(): Promise<void> {
  const original = store.list()[0]!;
  assert.equal(store.load(original.id)?.session?.plan.kind, "awaiting_action");
  terminal.stdin.write(`/resume ${original.id}`);
  await delay();
  terminal.stdin.write("\r");
  await until(() => terminal.lastFrame().includes("[R] Redo plan"), "restored review picker");
  assert.equal(runs.length, 0);
  terminal.stdout.columns = 45;
  terminal.stdout.emit("resize");
  await until(() => terminal.lastFrame().includes("Plan ready"), "review survives narrow resize");
  terminal.stdout.columns = 100;
  terminal.stdout.emit("resize");
  await delay(150);
  terminal.stdin.write("r");
  await until(() => runs.length === 1, "restored review can revise");
  assert.match(runs[0]!.prompt, /Plan a safe fix/);
  runs[0]!.handlers.onAssistantDelta?.("1. Revised plan with tests.");
  runs[0]!.stopped();
  runs[0]!.handlers.onResponse("1. Revised plan with tests.");
  await until(() => terminal.lastFrame().includes("[R] Redo plan"), "streamed revision ready");
  await delay(100);
  terminal.stdin.write("\u001b");
  await until(
    () => terminal.lastFrame().includes("Plan review canceled"),
    "restored review can cancel",
  );
  assert.equal(runs.length, 1);
}

async function runPlanActions(): Promise<void> {
  terminal.stdin.write("/plan on");
  await delay();
  terminal.stdin.write("\r");
  await delay(200);
  terminal.stdin.write("Plan a safe fix");
  await delay();
  terminal.stdin.write("\r");
  await until(() => runs.length === 1, "planning run");
  runs[0]!.stopped();
  runs[0]!.handlers.onResponse("1. Inspect the code.\n2. Fix the error.\n3. Run tests.");
  await until(() => terminal.output().includes("[R] Redo plan"), "plan actions");
  await delay(150);
  terminal.stdin.write("r");
  await until(() => runs.length === 2, "redo without feedback modal");
  assert.equal(runs[1]!.mode, "suggest");
  assert.match(runs[1]!.prompt, /Plan a safe fix/);
  assert.match(runs[1]!.prompt, /Redo the plan/);
  runs[1]!.stopped();
  runs[1]!.handlers.onResponse("1. Inspect.\n2. Correct the error with tests.");
  await until(() => {
    const output = terminal.output();
    const index = output.lastIndexOf("Correct the error with tests.");
    return index >= 0 && output.slice(index).includes("[R] Redo plan");
  }, "revised plan actions rendered");
  await delay(150);
  terminal.stdin.write("i");
  await until(() => runs.length === 3, "implement in Auto");
  assert.equal(runs[2]!.mode, "auto-edit");
  assert.equal(runs[2]!.planMode, false);
  terminal.stdin.write("i");
  terminal.stdin.write("\x03");
  await delay(200);
  assert.equal(runs.length, 3, "double action must not start twice");
  await terminal.dispose();
  return;
}

async function saveInterruptedConversation(): Promise<void> {
  terminal.stdin.write("first instruction");
  await delay();
  terminal.stdin.write("\r");
  await until(() => runs.length === 1, "first run");
  runs[0]!.handlers.onAssistantDelta?.("partial reply");
  terminal.stdin.write("queued instruction");
  await delay();
  terminal.stdin.write("\r");
  await delay(250);
  terminal.stdin.write("unsent draft");
  await delay(1100);
  const entry = store.list()[0];
  assert(entry);
  const loaded = store.load(entry.id);
  assert(loaded?.session);
  assert.equal(loaded.session.draft, "unsent draft");
  assert.equal(loaded.session.queue.length, 1);
  assert.equal(loaded.session.queue[0]?.submitted, "queued instruction");
  assert.equal(loaded.messages[0]?.submittedContent, "first instruction");
  assert(
    loaded.session.events.some(
      (event) =>
        event.type === "assistant" && event.contentChunks.join("").includes("partial reply"),
    ),
  );
  // Abrupt exit exercises resume of a snapshot captured during a live run.
  process.exit(0);
}

async function verifyDraftOnly(): Promise<void> {
  // A fresh start that never sends a prompt must not leave a /resume entry.
  terminal.stdin.write("/model");
  await delay();
  terminal.stdin.write("\u0001");
  await delay();
  terminal.stdin.write("\u000b");
  await delay();
  terminal.stdin.write("unsent draft only");
  await delay(1100);
  await terminal.dispose();
  const conversationDir = resolveUbumeConversationDir(process.cwd());
  assert.deepEqual(existsSync(conversationDir) ? readdirSync(conversationDir) : [], []);
  assert.equal(store.list().length, 0);
  return;
}

async function verifyQuitWindow(): Promise<void> {
  // The exit hint is visible exactly while a second Ctrl+C would quit.
  const hint = "Press Ctrl+C again to exit";
  let exited = false;
  void terminal.instance.waitUntilExit().then(() => {
    exited = true;
  });
  terminal.stdin.write("\x03");
  await until(() => terminal.lastFrame().includes(hint), "exit armed");
  await until(() => !terminal.lastFrame().includes(hint), "armed exit expires");
  assert.equal(exited, false);
  terminal.stdin.write("\x03");
  await until(() => terminal.lastFrame().includes(hint), "exit re-armed after expiry");
  assert.equal(exited, false, "a press after the window must re-arm, not quit");
  terminal.stdin.write("\x03");
  await until(() => exited, "second press quits");
  return;
}

async function verifyUsageDuringRun(): Promise<void> {
  terminal.stdin.write("first instruction");
  await delay();
  terminal.stdin.write("\r");
  await until(() => runs.length === 1, "first run");
  runs[0]!.handlers.onAssistantDelta?.("partial reply");
  terminal.stdin.write("/usage");
  await delay();
  terminal.stdin.write("\r");
  await until(() => terminal.lastFrame().includes("Provider Usage"), "usage panel open");
  await until(
    () => terminal.output().includes("exited before Codex usage check completed"),
    "usage result rendered",
  );
  terminal.stdin.write("\u001b");
  await until(() => !terminal.lastFrame().includes("Provider Usage"), "usage panel closed");
  await delay(200);
  assert.equal(cancelCount, 0, "closing /usage must not cancel the active run");
  runs[0]!.stopped();
  runs[0]!.handlers.onResponse("partial reply and the rest");
  await until(() => terminal.output().includes("partial reply and the rest"), "run completed");
  await delay(1100);
  assert.equal(runs.length, 1, "/usage must not start a provider run");
  assert.ok(runs.every((run) => !run.prompt.includes("/usage")));
  const entry = store.list()[0];
  assert(entry);
  const loaded = store.load(entry.id);
  assert(loaded);
  assert.ok(!JSON.stringify(loaded.messages).includes("/usage"), "/usage must stay out of history");
  await terminal.dispose();
  return;
}

async function cancelDuringPreparation(): Promise<void> {
  terminal.stdin.write("cancel during preparation");
  await delay();
  terminal.stdin.write("\r");
  await delay(10);
  terminal.stdin.write("\x03");
  await delay(500);
  await until(
    () => !inspectOwnership(process.cwd(), "execution").locked,
    "preparation lock released",
  );
  assert.equal(runs.length, 0, "canceled preparation must not launch the provider");
  await terminal.dispose();
  return;
}

async function runQueueFlow(): Promise<void> {
  const send = async (value: string) => {
    terminal.stdin.write(value);
    await delay();
    terminal.stdin.write("\r");
    await delay();
  };
  await send("first");
  await until(() => runs.length === 1, "first running");
  await send("second");
  await until(
    () =>
      store.load(store.list()[0]!.id)?.session?.queue.length === 1 &&
      store.load(store.list()[0]!.id)?.session?.draft === "",
    "second queued and composer reset",
  );
  terminal.stdin.write("independent draft");
  await delay();
  assert.equal(runs.length, 1);
  runs[0]!.stopped();
  runs[0]!.handlers.onResponse("first response");
  await until(() => runs.length === 2, "FIFO automatic continuation");
  assert.equal(runs[1]?.prompt, "second");
  await delay(350);
  assert.equal(store.load(store.list()[0]!.id)?.session?.draft, "independent draft");
  terminal.stdin.write("\u0001");
  await delay();
  terminal.stdin.write("\u000b");
  await delay();
  await send("third");
  await until(
    () =>
      store.load(store.list()[0]!.id)?.session?.queue.length === 1 &&
      store.load(store.list()[0]!.id)?.session?.draft === "",
    "third queued and composer reset",
  );
  terminal.stdin.write("fourth");
  await delay();
  terminal.stdin.write("\u0018");
  await delay();
  terminal.stdin.write("\u0013");
  await until(() => runs.length === 3, "interrupt and continue");
  assert.equal(runs[2]?.prompt, "third\n\nfourth");
  // Late callbacks from the canceled run must not append an answer or clear the new draft.
  runs[1]!.handlers.onResponse("stale answer");
  terminal.stdin.write("retained after interrupt");
  await delay();
  runs[2]!.handlers.onAssistantDelta?.("last buffered partial reply");
  terminal.stdin.write("\u0014"); // Ctrl+T opens the transcript
  await delay();
  assert(terminal.output().includes("TRANSCRIPT"));
  terminal.stdin.write("\u0003");
  await delay(350);
  const record = store.load(store.list()[0]!.id);
  assert(record?.session);
  assert.equal(record.session.draft, "retained after interrupt");
  assert(
    record.session.events.some(
      (event) =>
        event.type === "assistant" &&
        (event.content + event.contentChunks.join("")).includes("last buffered partial reply"),
    ),
  );
  assert(!record.messages.some((message) => message.content === "stale answer"));
  await terminal.dispose();
  return;
}

async function resumeConversation(): Promise<void> {
  const original = store.list()[0];
  assert(original);
  terminal.stdin.write(`/resume ${original.id}`);
  await delay();
  terminal.stdin.write("\r");
  await until(() => terminal.output().includes("Conversation resumed"), "resume ready");
  assert.equal(runs.length, 0, "resuming must not dispatch queued work");
  const restored = store.load(original.id);
  assert.equal(restored?.session?.draft, "unsent draft");
  assert(terminal.output().includes("partial reply"));
  terminal.stdin.write("\u0001");
  await delay();
  terminal.stdin.write("\u000b");
  await delay(); // clear restored draft with conventional editing
  terminal.stdin.write("/queue");
  await delay();
  terminal.stdin.write("\r");
  await until(() => terminal.output().includes("QUEUE · paused"), "queue panel ready");
  await delay();
  terminal.stdin.write("s");
  await until(() => runs.length === 1, "continued queue");
  assert.equal(runs[0]?.prompt, "queued instruction");
  assert(runs[0]?.history.some((message) => message.content.includes("partial reply")));
  runs[0]!.stopped();
  runs[0]!.handlers.onResponse("completed queued instruction");
  await until(
    () => store.load(original.id)?.session?.queue.length === 0,
    "queue persisted removal",
  );
  await terminal.dispose();
  return;
}
/** `!shell` output reaches scrollback as a completed event, not a stuck "Executing" line. */
async function completeShellCommand(): Promise<void> {
  terminal.stdin.write("!printf 'one\\ntwo\\n'");
  await delay();
  terminal.stdin.write("\r");
  await until(
    () => terminal.output().includes("Executed shell") && terminal.output().includes("2 lines"),
    "completed shell event with its summary",
  );
  assert(terminal.lastFrame().includes("Ask Ubume"), "composer is usable again");
}

const runScenario = {
  "shell-complete": completeShellCommand,
  "plan-actions": runPlanActions,
  "plan-warning-save": savePlanAfterWarning,
  "plan-warning-resume": resumePlanAfterWarning,
  save: saveInterruptedConversation,
  "draft-only": verifyDraftOnly,
  quit: verifyQuitWindow,
  "usage-during-run": verifyUsageDuringRun,
  "cancel-start": cancelDuringPreparation,
  flow: runQueueFlow,
  resume: resumeConversation,
};

try {
  await until(() => terminal.lastFrame().includes("gpt-5.4"), "initial App frame");
  const run = runScenario[scenario as keyof typeof runScenario];
  assert(run, `Unknown workbench scenario: ${scenario}`);
  await run();
} finally {
  try {
    await terminal.dispose();
  } finally {
    store.release();
  }
}
