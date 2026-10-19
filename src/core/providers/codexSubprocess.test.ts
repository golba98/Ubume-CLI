import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RunToolActivity } from "../../session/types.js";
import { createTestRuntime } from "../../test/runtimeTestUtils.js";
import { codexSubprocessProvider } from "./codexSubprocess.js";
import { sanitizeCodexTranscript } from "./codexTranscript.js";

test("codex subprocess attaches output handlers before writing stdin", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./codexSubprocess.ts", import.meta.url)),
    "utf8",
  );
  const spawnIndex = source.indexOf("proc = spawnCodexProcess");
  const stdoutIndex = source.indexOf('proc.stdout?.on("data"', spawnIndex);
  const stderrIndex = source.indexOf('proc.stderr?.on("data"', spawnIndex);
  const closeIndex = source.indexOf('proc.on("close"', spawnIndex);
  const errorIndex = source.indexOf('proc.on("error"', spawnIndex);
  const stdinWriteIndex = source.indexOf("proc.stdin?.write", spawnIndex);

  assert.notEqual(spawnIndex, -1);
  assert.notEqual(stdoutIndex, -1);
  assert.notEqual(stderrIndex, -1);
  assert.notEqual(closeIndex, -1);
  assert.notEqual(errorIndex, -1);
  assert.notEqual(stdinWriteIndex, -1);
  assert.ok(stdoutIndex < stdinWriteIndex);
  assert.ok(stderrIndex < stdinWriteIndex);
  assert.ok(closeIndex < stdinWriteIndex);
  assert.ok(errorIndex < stdinWriteIndex);
});

test("codex subprocess supports raw prompt passthrough before wrapped prompt fallback", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./codexSubprocess.ts", import.meta.url)),
    "utf8",
  );

  assert.match(source, /const promptPolicy = options\.promptPolicy \?\? "wrapped"/);
  assert.match(source, /promptPolicy === "raw"\s+\?\s+prompt\s+:\s+buildCodexPrompt/s);
});

test("codex subprocess cleanup skips kill after process close", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./codexSubprocess.ts", import.meta.url)),
    "utf8",
  );
  const closeIndex = source.indexOf('proc.on("close"', source.indexOf("proc = spawnCodexProcess"));
  const exitedIndex = source.indexOf("procExited = true", closeIndex);
  const cleanupIndex = source.indexOf("return () =>", exitedIndex);
  const skipIndex = source.indexOf("!proc || procExited || proc.killed", cleanupIndex);
  const killIndex = source.indexOf('kill("SIGTERM")', cleanupIndex);

  assert.notEqual(closeIndex, -1);
  assert.notEqual(exitedIndex, -1);
  assert.notEqual(cleanupIndex, -1);
  assert.notEqual(skipIndex, -1);
  assert.notEqual(killIndex, -1);
  assert.ok(exitedIndex < cleanupIndex);
  assert.ok(skipIndex < killIndex);
});

test("codex subprocess reports lifecycle boundaries for terminal title reassertion", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./codexSubprocess.ts", import.meta.url)),
    "utf8",
  );
  const beforeSpawnIndex = source.indexOf('handlers.onProcessLifecycle?.("before-spawn")');
  const spawnIndex = source.indexOf("proc = spawnCodexProcess");
  const spawnedIndex = source.indexOf('handlers.onProcessLifecycle?.("spawned")', spawnIndex);
  const closeIndex = source.indexOf('proc.on("close"', spawnIndex);
  const exitIndex = source.indexOf('handlers.onProcessLifecycle?.("exit")', closeIndex);
  const errorIndex = source.indexOf('proc.on("error"', spawnIndex);
  const lifecycleErrorIndex = source.indexOf('handlers.onProcessLifecycle?.("error")', errorIndex);
  const cleanupIndex = source.indexOf("return () =>", spawnedIndex);
  const lifecycleCleanupIndex = source.indexOf(
    'handlers.onProcessLifecycle?.("cleanup")',
    cleanupIndex,
  );

  assert.ok(beforeSpawnIndex >= 0 && beforeSpawnIndex < spawnIndex);
  assert.ok(spawnedIndex > spawnIndex);
  assert.ok(exitIndex > closeIndex);
  assert.ok(lifecycleErrorIndex > errorIndex);
  assert.ok(lifecycleCleanupIndex > cleanupIndex);
});

interface FakeRun {
  response?: string;
  error?: string;
  rawStderr?: string;
  deltas: string;
  tools: RunToolActivity[];
}

/**
 * Runs the real adapter against a generated fake `codex` script. The script body sees
 * `args` (argv after the executable) and `out(text)`/`err(text)` writers with backpressure.
 */
async function runFakeCodex(body: string): Promise<FakeRun> {
  const root = mkdtempSync(join(tmpdir(), "ubume-fake-codex-"));
  const executable = join(root, "codex");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (t) => new Promise((r) => (process.stdout.write(t) ? r() : process.stdout.once("drain", r)));
const err = (t) => new Promise((r) => (process.stderr.write(t) ? r() : process.stderr.once("drain", r)));
const event = (type, item) => out(JSON.stringify({ type, item }) + "\\n");
if (args.includes("--help")) { console.log("Usage: codex exec [OPTIONS]\\n  -c, --config <key=value>"); process.exit(0); }
if (args.includes("--version")) { console.log("codex-cli 0.200.0"); process.exit(0); }
for await (const _ of process.stdin);
${body}
`,
    { mode: 0o700 },
  );
  const run: FakeRun = { deltas: "", tools: [] };
  try {
    await new Promise<void>((resolve) => {
      codexSubprocessProvider.run!(
        "fixture prompt",
        {
          runtime: { ...createTestRuntime(), codexCommandPath: executable },
          workspaceRoot: root,
          promptPolicy: "raw",
        },
        {
          onResponse: (response) => {
            run.response = response;
            resolve();
          },
          onError: (message, rawStderr) => {
            run.error = message;
            run.rawStderr = rawStderr;
            resolve();
          },
          onAssistantDelta: (chunk) => {
            run.deltas += chunk;
          },
          onToolActivity: (activity) => {
            run.tools.push(activity);
          },
        },
      );
    });
    return run;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("JSON mode reassembles multibyte answers split across reads", async () => {
  const answer = "Résumé 漢字 👩🏽‍💻 done";
  const run = await runFakeCodex(`
const line = Buffer.from(JSON.stringify({ type: "item.completed", item: { id: "a", type: "agent_message", text: ${JSON.stringify(answer)} } }) + "\\n");
for (let i = 0; i < line.length; i += 3) { await out(line.subarray(i, i + 3)); await new Promise((r) => setTimeout(r, 1)); }
await out(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
  assert.equal(run.error, undefined);
  assert.equal(run.response, answer);
  assert.equal(run.deltas, answer);
});

test("JSON mode streams large tool output and still returns the parsed answer", async () => {
  const run = await runFakeCodex(`
const output = "o".repeat(64 * 1024);
for (let i = 0; i < 160; i++) await event("item.completed", { id: "tool-" + i, type: "command_execution", command: "cat", status: "completed", aggregated_output: output, exit_code: 0 });
await event("item.completed", { id: "a", type: "agent_message", text: "large run answer" });
await out(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
  assert.equal(run.response, "large run answer");
  assert.equal(run.tools.length >= 160, true);
  assert.equal(
    run.tools.every((tool) => (tool.output?.length ?? 0) === 64 * 1024),
    true,
  );
});

test("JSON mode without an answer keeps the transcript fallback", async () => {
  const script = `
await event("item.completed", { id: "t", type: "command_execution", command: "ls", status: "completed", aggregated_output: "a.txt", exit_code: 0 });
await err("warning: something odd\\n");
`;
  const run = await runFakeCodex(script);
  assert.equal(run.error, undefined);
  const raw =
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "t",
        type: "command_execution",
        command: "ls",
        status: "completed",
        aggregated_output: "a.txt",
        exit_code: 0,
      },
    }) + "\nwarning: something odd\n";
  assert.equal(run.response, sanitizeCodexTranscript(raw));
});

test("an unsupported JSON flag falls back to the legacy transcript", async () => {
  const run = await runFakeCodex(`
if (args.includes("--experimental-json")) { await err("error: unexpected argument '--experimental-json' found\\n"); process.exit(2); }
await out("codex\\nLegacy transcript answer\\n");
`);
  assert.equal(run.error, undefined);
  assert.match(run.response ?? "", /Legacy transcript answer/);
});

test("failure diagnostics keep the start and end of very large stderr", async () => {
  const run = await runFakeCodex(`
await err("FIRST-LINE\\n");
const block = "e".repeat(64 * 1024 - 1) + "\\n";
for (let i = 0; i < 48; i++) await err(block);
await err("LAST-LINE\\n");
process.exit(1);
`);
  assert.match(run.error ?? "", /exited with code 1/);
  assert.ok(run.rawStderr?.startsWith("FIRST-LINE"));
  assert.ok(run.rawStderr?.trimEnd().endsWith("LAST-LINE"));
  assert.match(run.rawStderr ?? "", /characters of output omitted/);
  assert.ok((run.rawStderr?.length ?? 0) < 1.1 * 1024 * 1024);
});
