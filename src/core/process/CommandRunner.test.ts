import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type CommandResult,
  runCommand,
  runShellCommand,
  summarizeCommandResult,
} from "./commandRunner.js";

function makeResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    userMessage: "Command completed.",
    ...overrides,
  };
}

test("summarizes ripgrep file listings without flooding the UI", () => {
  const result = makeResult({
    stdout: "src/app.tsx\nsrc/ui/BottomComposer.tsx\n",
  });

  assert.equal(summarizeCommandResult("rg --files", result), "Found 2 files.");
});

test("keeps a concise fallback summary for generic successful commands", () => {
  const result = makeResult({
    stdout: "alpha\nbeta\ngamma\n",
  });

  assert.equal(summarizeCommandResult("node script.js", result), "Produced 3 lines of output.");
});

test("preserves the failure message for unsuccessful commands", () => {
  const result = makeResult({
    status: "failed",
    exitCode: 1,
    userMessage: "git exited with code 1.",
    stderr: "fatal: not a git repository",
  });

  assert.equal(summarizeCommandResult("git status", result), "git exited with code 1.");
});

test("runCommand executes a direct executable with argument array", async () => {
  const runner = runCommand({
    executable: process.execPath,
    args: ["-e", "console.log(process.argv[1])", "direct-ok"],
    cwd: process.cwd(),
  });

  const result = await runner.result;
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "direct-ok");
});

test("runCommand pipes stdinData to the child process", async () => {
  const runner = runCommand({
    executable: process.execPath,
    args: [
      "-e",
      "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => process.stdout.write(d));",
    ],
    cwd: process.cwd(),
    stdinData: "stdin-payload",
  });

  const result = await runner.result;
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "stdin-payload");
});

test("runCommand without stdinData keeps stdin closed so children do not hang", async () => {
  const runner = runCommand({
    executable: process.execPath,
    args: [
      "-e",
      "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => process.stdout.write('closed:' + d));",
    ],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });

  const result = await runner.result;
  assert.equal(result.status, "completed");
  assert.equal(result.stdout.trim(), "closed:");
});

test("runCommand rejects obvious executable injection", () => {
  assert.throws(
    () =>
      runCommand({
        executable: "node & echo injected",
        args: ["--version"],
        cwd: process.cwd(),
      }),
    /single executable name|shell metacharacters/i,
  );
});

test("runShellCommand is the explicit shell execution path", async () => {
  const runner = runShellCommand("echo shell-ok", { cwd: process.cwd() });
  const result = await runner.result;

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /shell-ok/);
});

test("command runner reports lifecycle boundaries for terminal title reassertion", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./commandRunner.ts", import.meta.url)),
    "utf8",
  );
  const beforeSpawnIndex = source.indexOf('handlers.onProcessLifecycle?.("before-spawn")');
  const spawnIndex = source.indexOf("child = spawn(");
  const spawnedIndex = source.indexOf('handlers.onProcessLifecycle?.("spawned")', spawnIndex);
  const errorIndex = source.indexOf('child.once("error"', spawnIndex);
  const lifecycleErrorIndex = source.indexOf('handlers.onProcessLifecycle?.("error")', errorIndex);
  const closeIndex = source.indexOf('child.once("close"', spawnIndex);
  const exitIndex = source.indexOf('handlers.onProcessLifecycle?.("exit")', closeIndex);
  const cancelIndex = source.indexOf("const cancel = () =>");
  const lifecycleCancelIndex = source.indexOf(
    'handlers.onProcessLifecycle?.("cancel")',
    cancelIndex,
  );

  assert.ok(beforeSpawnIndex >= 0 && beforeSpawnIndex < spawnIndex);
  assert.ok(spawnedIndex > spawnIndex);
  assert.ok(lifecycleErrorIndex > errorIndex);
  assert.ok(exitIndex > closeIndex);
  assert.ok(lifecycleCancelIndex > cancelIndex);
});

test("generic command runner does not expose shell mode", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./commandRunner.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(source.includes("shell?: boolean"), false);
  assert.equal(source.includes("spec.shell"), false);
});

test("cancel waits for an ignoring descendant even after the group leader closes", {
  skip: process.platform === "win32",
}, async () => {
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "ubume-group-"));
  const marker = join(root, "writes");
  const descendant = `const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(Date.now())),20)`;
  const parent = `require('child_process').spawn('node',['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
  const runner = runCommand({ executable: "node", args: ["-e", parent], cwd: root });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error("Descendant did not start.");
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.cancel();
    await runner.stopped;
    const final = readFileSync(marker, "utf8");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      readFileSync(marker, "utf8"),
      final,
      "descendant kept writing after stopped resolved",
    );
  } finally {
    try {
      process.kill(-runner.child.pid!, "SIGKILL");
    } catch {
      /* Already stopped. */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const UTF8_SAMPLE = "é漢字👩🏽‍💻ñ€";
// Writes UTF-8 in 7-byte pieces with a pause between them, so code points span reads.
const SPLIT_UTF8_WRITER = `const b=Buffer.from(${JSON.stringify(UTF8_SAMPLE)}.repeat(200));let o=0;const next=()=>{if(o>=b.length)return;process.stdout.write(b.subarray(o,o+7));process.stderr.write(b.subarray(o,o+7));o+=7;setTimeout(next,0)};next();`;
const STRESS = process.env.UBUME_STRESS_TESTS === "1";

/** Writes `megabytes` MiB honoring backpressure, then `tail` once every block is queued. */
function writer(megabytes: number, tail = ""): string {
  return `const block="x".repeat(65535)+"\\n";let left=${megabytes}*16;const w=()=>{while(left>0){left--;if(!process.stdout.write(block)){process.stdout.once("drain",w);return}}process.stdout.write(${JSON.stringify(tail)})};w();`;
}

test("multibyte characters split across reads are decoded exactly", async () => {
  const chunks: string[] = [];
  const errors: string[] = [];
  const runner = runCommand(
    { executable: "node", args: ["-e", SPLIT_UTF8_WRITER], cwd: process.cwd() },
    { onStdout: (text) => chunks.push(text), onStderr: (text) => errors.push(text) },
  );
  const result = await runner.result;
  const expected = UTF8_SAMPLE.repeat(200);
  assert.equal(result.status, "completed");
  assert.equal(chunks.join(""), expected);
  assert.equal(errors.join(""), expected);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, expected);
});

test("full capture returns 10 MB of streamed output intact and in order", async () => {
  let streamed = 0;
  const runner = runCommand(
    { executable: "node", args: ["-e", writer(10)], cwd: process.cwd() },
    { onStdout: (text) => (streamed += text.length) },
  );
  const result = await runner.result;
  assert.equal(result.status, "completed");
  assert.equal(streamed, 10 * 1024 * 1024);
  assert.equal(result.stdout.length, 10 * 1024 * 1024);
  assert.equal(result.omittedOutputChars, undefined);
});

test("bounded capture streams everything but retains only head and tail", async () => {
  let streamed = 0;
  const runner = runCommand(
    {
      executable: "node",
      args: ["-e", writer(STRESS ? 100 : 10, "TAIL-MARKER")],
      cwd: process.cwd(),
      capture: { maxChars: 64 * 1024 },
    },
    { onStdout: (text) => (streamed += text.length) },
  );
  const result = await runner.result;
  const total = (STRESS ? 100 : 10) * 1024 * 1024 + "TAIL-MARKER".length;
  assert.equal(streamed, total);
  assert.ok(result.stdout.length < 70 * 1024);
  assert.ok(result.stdout.endsWith("TAIL-MARKER"));
  assert.match(result.stdout, /characters of output omitted/);
  assert.equal(result.omittedOutputChars?.stdout, total - 64 * 1024);
});

test("interleaved stdout and stderr keep per-stream order", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const script =
    "let i=0;const t=setInterval(()=>{process.stdout.write(`o${i},`);process.stderr.write(`e${i},`);if(++i===50){clearInterval(t)}},1)";
  const result = await runCommand(
    { executable: "node", args: ["-e", script], cwd: process.cwd() },
    { onStdout: (text) => out.push(text), onStderr: (text) => err.push(text) },
  ).result;
  const expected = (prefix: string) =>
    Array.from({ length: 50 }, (_, i) => `${prefix}${i},`).join("");
  assert.equal(out.join(""), expected("o"));
  assert.equal(err.join(""), expected("e"));
  assert.equal(result.stdout, expected("o"));
  assert.equal(result.stderr, expected("e"));
});

test("timeout during continuous output reports timeout and stops the process", {
  skip: process.platform === "win32",
}, async () => {
  let streamed = 0;
  const runner = runCommand(
    {
      executable: "node",
      args: ["-e", "setInterval(()=>process.stdout.write('tick\\n'),2)"],
      cwd: process.cwd(),
      timeoutMs: 200,
    },
    { onStdout: (text) => (streamed += text.length) },
  );
  const result = await runner.result;
  await runner.stopped;
  assert.equal(result.status, "timeout");
  assert.ok(streamed > 0, "partial output was streamed before the deadline");
  assert.throws(() => process.kill(runner.child.pid!, 0));
});

test("cancel during output resolves canceled with the partial output", {
  skip: process.platform === "win32",
}, async () => {
  let streamed = "";
  const runner = runCommand(
    {
      executable: "node",
      args: ["-e", "let i=0;setInterval(()=>process.stdout.write(`line ${i++}\\n`),2)"],
      cwd: process.cwd(),
    },
    { onStdout: (text) => (streamed += text) },
  );
  while (!streamed.includes("line 5")) await new Promise((r) => setTimeout(r, 5));
  runner.cancel();
  const result = await runner.result;
  await runner.stopped;
  assert.equal(result.status, "canceled");
  assert.ok(result.stdout.startsWith("line 0\nline 1\n"));
  assert.throws(() => process.kill(runner.child.pid!, 0));
});

test("unexpected termination keeps an incomplete final line", async () => {
  const result = await runCommand({
    executable: "node",
    args: ["-e", "process.stdout.write('{\"partial\":');process.kill(process.pid,'SIGKILL')"],
    cwd: process.cwd(),
  }).result;
  assert.equal(result.status, "failed");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.stdout, '{"partial":');
});
