import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../test/environment.js";
import { sendJson, startLoopbackServer } from "../test/loopbackServer.js";
import { runTerminalCommand } from "./commands.js";
import { redact } from "./diagnostics.js";
import { parseHeadlessExecArgs } from "./execArgs.js";
import { readStdinPrompt } from "./execCommand.js";
import { parseInspectionArgs } from "./inspectCommands.js";

const launcher = fileURLToPath(new URL("../../bin/ubume.js", import.meta.url));
const provider = fileURLToPath(new URL("../test/fixtures/headlessProvider.mjs", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ubume-cli-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const chatRoot = join(root, "data/chats", key);
  const dataRoot = join(root, "data/workspaces", key);
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(workspace, "demo.ts"), "export const result = 0;\n");
  const env: NodeJS.ProcessEnv = createTestEnvironment(root, {
    UBUME_DATA_DIR: join(root, "data"),
    CODEX_EXECUTABLE: provider,
    AGY_EXECUTABLE: join(root, "absent-agy"),
    UBUME_TEST_PROMPT_LOG: join(root, "prompts.jsonl"),
    UBUME_TEST_PID_FILE: join(root, "pid"),
  });
  const run = (args: string[], input?: string) =>
    spawnSync("node", [launcher, ...args], {
      cwd: workspace,
      env,
      encoding: "utf8",
      input,
      timeout: 20000,
    });
  return {
    root,
    workspace,
    dataRoot,
    chatRoot,
    env,
    run,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function tree(path: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(path)) return files;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[file] = readFileSync(file).toString("base64");
    }
  };
  walk(path);
  return files;
}
test("new exec options parse after the prompt and prompt sources conflict clearly", () => {
  const parsed = parseHeadlessExecArgs([
    "hello",
    "--json",
    "--file",
    "demo.ts",
    "--provider",
    "anthropic",
  ]);
  assert(parsed.ok);
  assert.equal(parsed.value.json, true);
  assert.deepEqual(parsed.value.files, ["demo.ts"]);
  assert.equal(parseHeadlessExecArgs(["--stdin", "hello"]).ok, false);
  assert.equal(parseHeadlessExecArgs(["--resume", "chat_example", "--no-save", "hello"]).ok, false);
});
test("diagnostic redaction removes key fields, URL credentials, and known secret values", () => {
  const result = JSON.stringify(
    redact(
      {
        apiKey: "example-secret",
        message: "example-secret",
        endpoint: "https://user:password@host/v1?token=hidden",
      },
      ["example-secret"],
    ),
  );
  assert.doesNotMatch(result, /example-secret|user:password|hidden/);
});
test("all inspection commands work without TTY and leave disk unchanged", () => {
  const f = fixture();
  try {
    const before = tree(f.root);
    for (const command of [
      ["status"],
      ["config"],
      ["providers"],
      ["models"],
      ["sessions", "list"],
      ["doctor"],
    ]) {
      const result = f.run([...command, "--json"]);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      const value = JSON.parse(result.stdout);
      assert.equal(value.schemaVersion, 1);
      assert.equal(value.ok, true);
      assert.doesNotMatch(result.stdout, /\x1b/);
    }
    assert.deepEqual(tree(f.root), before);
    const probe = f.run(["doctor", "--probe", "--json"]);
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(
      existsSync(join(f.root, "prompts.jsonl")),
      false,
      "doctor submitted an inference prompt",
    );
  } finally {
    f.close();
  }
});
test("exec saves, resumes across processes, exposes transcript/diff and preserves draft/queue", () => {
  const f = fixture();
  try {
    const first = f.run(["exec", "CHANGE_FILE", "--json", "--file", "demo.ts"]);
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.data.text, "fixture final answer");
    const id = result.data.sessionId as string;
    const snapshotPath = join(f.chatRoot, "conversations", id, "snapshot.json");
    const saved = JSON.parse(readFileSync(snapshotPath, "utf8"));
    saved.session.draft = "unsent draft";
    saved.session.cursor = 3;
    saved.session.queue = [
      {
        id: "queued",
        display: "queued draft",
        submitted: "queued draft",
        images: [],
        createdAt: 1,
      },
    ];
    writeFileSync(snapshotPath, JSON.stringify(saved));
    const before = tree(f.root);
    const transcript = f.run(["sessions", "transcript", id, "--json"]);
    assert.equal(transcript.status, 0);
    assert.match(transcript.stdout, /fixture output/);
    const diff = f.run(["sessions", "diff", id]);
    assert.equal(diff.status, 0, diff.stderr);
    assert.match(diff.stdout, /\+export const result = 1/);
    assert.deepEqual(tree(f.root), before);
    const resumed = f.run(["exec", "--resume", id, "continue", "--json"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).data.sessionId, id);
    const next = JSON.parse(readFileSync(snapshotPath, "utf8"));
    assert.equal(next.messages.length, 4);
    assert.equal(next.session.draft, "unsent draft");
    assert.equal(next.session.cursor, 3);
    assert.equal(next.session.queue[0].id, "queued");
    const prompts = readFileSync(join(f.root, "prompts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Previous conversation:/);
    assert.match(prompts[1], /fixture final answer/);
    const transient = f.run(["exec", "--stdin", "--no-save", "--json"], "stdin instruction");
    assert.equal(transient.status, 0, transient.stderr);
    assert.equal(JSON.parse(transient.stdout).data.sessionId, null);
    assert.equal(readdirSync(join(f.chatRoot, "conversations")).length, 1);
    assert.equal(existsSync(resolve(launcher, "../codexa.js")), false);
  } finally {
    f.close();
  }
});
test("JSON errors, explicit unavailable provider, cwd selection and help are predictable", () => {
  const f = fixture();
  try {
    for (const args of [
      ["exec", "--stdin", "also positional", "--json"],
      ["sessions", "show", "../bad", "--json"],
      ["status", "--probe", "--json"],
      ["status", "--cwd", join(f.root, "absent"), "--json"],
    ]) {
      const result = f.run(args);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
    const unavailable = f.run(["exec", "--provider", "google", "hello", "--json"]);
    assert.equal(unavailable.status, 3);
    assert.equal(JSON.parse(unavailable.stdout).ok, false);
    const cwd = f.run(["--cwd", "..", "status", "--json"]);
    assert.equal(cwd.status, 0);
    assert.equal(JSON.parse(cwd.stdout).data.workspace, f.root);
    const help = f.run(["exec", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--resume/);
    const empty = f.run(["exec", "--stdin", "--json"], "");
    assert.equal(empty.status, 2);
  } finally {
    f.close();
  }
});
test("interrupt through installed launcher stops provider and saves partial answer", async () => {
  const f = fixture();
  const child = spawn("node", [launcher, "exec", "WAIT_FOR_INTERRUPT", "--json"], {
    cwd: f.workspace,
    env: f.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise<number | null>((resolve) => child.once("close", resolve));
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.root, "pid"))) {
      if (Date.now() > deadline) throw new Error(`Provider did not start: ${stderr}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const pid = Number(readFileSync(join(f.root, "pid"), "utf8"));
    child.kill("SIGINT");
    assert.equal(await completed, 130, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.error.code, "INTERRUPTED");
    assert.equal(result.data.text, "partial reply");
    const saved = JSON.parse(
      readFileSync(
        join(f.chatRoot, "conversations", result.data.sessionId, "snapshot.json"),
        "utf8",
      ),
    );
    assert.equal(
      saved.session.events.find((event: { type: string }) => event.type === "run").status,
      "canceled",
    );
    assert.match(saved.messages.at(-1).content, /partial reply/);
    assert.throws(() => process.kill(pid, 0));
    assert.equal(readdirSync(join(f.dataRoot, "locks")).length, 0);
  } finally {
    child.kill("SIGKILL");
    f.close();
  }
});

test("busy session/workspace refuse writes; dead local ownership can be reclaimed", () => {
  const f = fixture();
  try {
    const first = f.run(["exec", "hello", "--json"]);
    assert.equal(first.status, 0, first.stderr);
    const id = JSON.parse(first.stdout).data.sessionId;
    const snapshot = join(f.chatRoot, "conversations", id, "snapshot.json");
    const before = readFileSync(snapshot, "utf8");
    const locks = join(f.dataRoot, "locks");
    const owner = {
      pid: process.pid,
      host: hostname(),
      token: "owner",
      createdAt: new Date().toISOString(),
    };
    const sessionLock = join(locks, `${id}.lock`);
    mkdirSync(sessionLock);
    writeFileSync(join(sessionLock, "owner.json"), JSON.stringify(owner));
    const refused = f.run(["exec", "--resume", id, "more", "--json"]);
    assert.equal(refused.status, 3);
    assert.match(refused.stdout, /busy/);
    assert.equal(readFileSync(snapshot, "utf8"), before);
    rmSync(sessionLock, { recursive: true });
    const executionLock = join(locks, "execution.lock");
    mkdirSync(executionLock);
    writeFileSync(join(executionLock, "owner.json"), JSON.stringify(owner));
    const executionRefused = f.run(["exec", "hello", "--json"]);
    assert.equal(executionRefused.status, 3);
    const status = f.run(["status", "--json"]);
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).data.execution.locked, true);
    const dead = spawnSync("node", ["-e", "process.exit(0)"]);
    assert(dead.pid);
    writeFileSync(join(executionLock, "owner.json"), JSON.stringify({ ...owner, pid: dead.pid }));
    const recovered = f.run(["exec", "--resume", id, "after crash", "--json"]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readdirSync(locks).length, 0);
  } finally {
    f.close();
  }
});

test("headless execution honors workspace provider selection and saved routes", () => {
  const f = fixture();
  try {
    f.env.ANTHROPIC_API_KEY = "";
    const config = {
      activeRoute: { providerId: "anthropic", modelId: "sonnet", backendKind: "claude-code-auth" },
      providers: { anthropic: { claudeCommandPath: provider } },
    };
    writeFileSync(join(f.dataRoot, "providers.json"), JSON.stringify(config));
    const first = f.run(["exec", "first", "--json"]);
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.data.text, "anthropic fixture answer");
    const saved = JSON.parse(
      readFileSync(
        join(f.chatRoot, "conversations", result.data.sessionId, "snapshot.json"),
        "utf8",
      ),
    );
    assert.equal(
      saved.metadata.reasoning,
      undefined,
      "a Claude route must not inherit OpenAI's default High effort",
    );
    writeFileSync(
      join(f.dataRoot, "providers.json"),
      JSON.stringify({
        ...config,
        activeRoute: { providerId: "openai", modelId: "gpt-5.4", backendKind: "codex-cli-auth" },
      }),
    );
    const resumed = f.run(["exec", "--resume", result.data.sessionId, "second", "--json"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).data.text, "anthropic fixture answer");
    const explicit = f.run(["exec", "--provider", "openai", "third", "--json"]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(JSON.parse(explicit.stdout).data.text, "fixture final answer");
  } finally {
    f.close();
  }
});

test("pending restore journals are inspectable and block new execution", () => {
  const f = fixture();
  try {
    const directory = join(f.dataRoot, "checkpoints", "chat_interrupted");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "restore.json"), JSON.stringify({ version: 1, operations: [] }));
    const before = tree(f.root);
    const status = f.run(["status", "--json"]);
    assert.equal(status.status, 0);
    assert.deepEqual(JSON.parse(status.stdout).data.pendingRecoverySessions, ["chat_interrupted"]);
    assert.deepEqual(tree(f.root), before);
    const blocked = f.run(["exec", "hello", "--json"]);
    assert.equal(blocked.status, 3);
    assert.match(blocked.stdout, /Pending file recovery/);
    assert.equal(existsSync(join(f.root, "prompts.jsonl")), false);
  } finally {
    f.close();
  }
});

test("explicit quoted executable paths remain usable in headless execution", () => {
  const f = fixture();
  try {
    f.env.CODEX_EXECUTABLE = `"${provider}"`;
    const result = f.run(["exec", "hello", "--no-save", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.text, "fixture final answer");
  } finally {
    f.close();
  }
});

test("command API interrupts idle custom stdin without waiting for another chunk", async () => {
  const controller = new AbortController();
  const input: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  };
  let stdout = "";
  const result = runTerminalCommand(
    ["exec", "--stdin", "--json"],
    {
      stdout: {
        write: (text: string) => {
          stdout += text;
          return true;
        },
      },
      stderr: { write: () => true },
    },
    { signal: controller.signal, stdin: input },
  );
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(
      await Promise.race([
        result,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 1000);
        }),
      ]),
      130,
    );
    assert.equal(JSON.parse(stdout).error.code, "INTERRUPTED");
  } finally {
    if (timer) clearTimeout(timer);
  }
});

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write: (text: string) => {
          stdout += text;
          return true;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
async function inProcess(
  argv: string[],
  options: Parameters<typeof runTerminalCommand>[2] = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), "ubume-cli-inproc-"));
  const previous = process.env.UBUME_DATA_DIR;
  process.env.UBUME_DATA_DIR = join(root, "data");
  try {
    const capture = captureIo();
    const code = await runTerminalCommand(argv, capture.io, options);
    return { code, stdout: capture.stdout(), stderr: capture.stderr() };
  } finally {
    if (previous === undefined) delete process.env.UBUME_DATA_DIR;
    else process.env.UBUME_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
function stdinOf(...chunks: Buffer[]): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

test("usage errors exit 2: JSON envelopes on stdout, human messages on stderr", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ubume-cli-cwd-"));
  try {
    const cases: [string[], string, string][] = [
      [["bogus"], "bogus", "Unknown command: bogus"],
      [["status", "--nope"], "status", "Unknown option: --nope"],
      [["status", "--cwd"], "status", "Missing value for --cwd."],
      [["status", "--json=1"], "status", "Unexpected value for --json."],
      [["status", "extra", "--cwd", cwd], "status", "Unexpected arguments for status."],
      [
        ["sessions", "--cwd", cwd],
        "sessions",
        "Use sessions list, show ID, transcript ID, or diff ID.",
      ],
      [
        ["sessions", "list", "extra", "--cwd", cwd],
        "sessions",
        "Use sessions list, show ID, transcript ID, or diff ID.",
      ],
      [["sessions", "show", "bad", "--cwd", cwd], "sessions", "Invalid session ID."],
      [
        ["sessions", "list", "--turn", "1", "--cwd", cwd],
        "sessions",
        "--turn and --file apply only to sessions diff.",
      ],
      [["models", "--provider", "nope", "--cwd", cwd], "models", "Unknown provider: nope"],
      [["exec", "--bogus"], "exec", "Unknown option for ubume exec: --bogus"],
    ];
    for (const [argv, command, message] of cases) {
      const human = await inProcess(argv);
      assert.equal(human.code, 2, argv.join(" "));
      assert.equal(human.stdout, "", argv.join(" "));
      assert.equal(human.stderr, `${message}\n`, argv.join(" "));

      const json = await inProcess([...argv, "--json"]);
      assert.equal(json.code, 2, argv.join(" "));
      assert.equal(json.stderr, "", argv.join(" "));
      assert.deepEqual(JSON.parse(json.stdout), {
        schemaVersion: 1,
        command,
        ok: false,
        data: null,
        error: { code: "USAGE", message },
      });
      assert.equal(json.stdout.split("\n").length, 2, "one envelope line");
    }
    // A well-formed but unknown session is unavailable (3), not a usage error.
    const missing = await inProcess(["sessions", "show", "chat_missing", "--cwd", cwd, "--json"]);
    assert.equal(missing.code, 3);
    assert.deepEqual(JSON.parse(missing.stdout).error, {
      code: "UNAVAILABLE",
      message: "Session chat_missing could not be loaded.",
    });
    // A leading --json is moved behind the command name.
    const leading = await inProcess(["--json", "bogus"]);
    assert.equal(leading.code, 2);
    assert.equal(JSON.parse(leading.stdout).command, "bogus");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("help is available in human and JSON form from every entry spelling", async () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"], ["exec", "--help"], ["status", "-h"]]) {
    const human = await inProcess(argv);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /^Ubume .*\nUsage:/);
    assert.equal(human.stdout.endsWith("\n\n"), false, "help is trimmed before printing");
  }
  const json = await inProcess(["--json"]);
  assert.equal(json.code, 0);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.command, "help");
  assert.equal(envelope.ok, true);
  assert.match(envelope.data.help, /ubume exec --stdin/);
});

test("stdin prompts reject empty, oversized and non-UTF-8 input", async () => {
  const empty = await inProcess(["exec", "--stdin", "--json"], {
    stdin: stdinOf(Buffer.from(" \n")),
  });
  assert.equal(empty.code, 2);
  assert.equal(JSON.parse(empty.stdout).error.message, "Stdin prompt is empty.");

  const oversized = await inProcess(["exec", "--stdin", "--json"], {
    stdin: stdinOf(Buffer.alloc(4 * 1024 * 1024, 97), Buffer.alloc(4 * 1024 * 1024 + 1, 97)),
  });
  assert.equal(oversized.code, 2);
  assert.equal(JSON.parse(oversized.stdout).error.message, "Stdin prompt exceeds 8 MiB.");

  const invalid = await inProcess(["exec", "--stdin", "--json"], {
    stdin: stdinOf(Buffer.from([0xff, 0xfe])),
  });
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, "FAILED");
});

test("an aborted signal turns an otherwise successful command into an interruption", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await inProcess(["help", "--json"], { signal: controller.signal });
  assert.equal(result.code, 130);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.deepEqual(envelope.error, { code: "INTERRUPTED", message: "Command interrupted." });
});

test("stdin prompts accept string chunks and keep surrounding whitespace", async () => {
  const chunks: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      yield "  hello ";
      yield "world\n";
    },
  };
  assert.equal(await readStdinPrompt(chunks), "  hello world\n");
});

test("inspection argument parsing separates flags, values and positionals", () => {
  const parsed = parseInspectionArgs("sessions", [
    "diff",
    "chat_1",
    "--turn=2",
    "--file",
    "a.ts",
    "--json",
  ]);
  assert.deepEqual(parsed.positional, ["diff", "chat_1"]);
  assert.deepEqual(
    [...parsed.values],
    [
      ["--turn", "2"],
      ["--file", "a.ts"],
    ],
  );
  assert.deepEqual([...parsed.flags], ["--json"]);
  assert.throws(() => parseInspectionArgs("status", ["--probe"]), /Unknown option: --probe/);
  assert.throws(() => parseInspectionArgs("models", ["--provider", "--json"]), /Missing value/);
});

test("headless Claude discovers explicit high efforts and sends them without downgrading", () => {
  const f = fixture();
  try {
    f.env.ANTHROPIC_API_KEY = "";
    f.env.UBUME_TEST_ARGV_LOG = join(f.root, "claude-args.jsonl");
    writeFileSync(
      join(f.dataRoot, "providers.json"),
      JSON.stringify({
        activeRoute: {
          providerId: "anthropic",
          modelId: "sonnet",
          backendKind: "claude-code-auth",
        },
        providers: { anthropic: { claudeCommandPath: provider } },
      }),
    );
    for (const effort of ["xhigh", "max"]) {
      const result = f.run(["exec", "--reasoning", effort, "Plan the fix", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const args: string[] = JSON.parse(
        readFileSync(f.env.UBUME_TEST_ARGV_LOG!, "utf8").trim().split("\n").at(-1)!,
      );
      assert.equal(args[args.indexOf("--effort") + 1], effort);
    }
    const before = readFileSync(f.env.UBUME_TEST_ARGV_LOG!, "utf8");
    const invalid = f.run(["exec", "--reasoning", "ultra", "Do not run", "--json"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /does not advertise effort/);
    assert.equal(readFileSync(f.env.UBUME_TEST_ARGV_LOG!, "utf8"), before);
  } finally {
    f.close();
  }
});

/** Runs the launcher without blocking this process, so loopback servers keep serving. */
function runAsync(f: ReturnType<typeof fixture>, args: string[]) {
  const child = spawn("node", [launcher, ...args], {
    cwd: f.workspace,
    env: f.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.once("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
}

function fakeCodex(f: ReturnType<typeof fixture>, body: string): { path: string; log: string } {
  const path = join(f.root, "configured-codex.mjs");
  const log = join(f.root, "configured-codex.log");
  writeFileSync(
    path,
    `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from "node:fs";\n` +
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n${body}\n`,
    { mode: 0o700 },
  );
  return { path, log };
}

test("models --refresh discovers through the configured Codex executable", async () => {
  const f = fixture();
  try {
    const codex = fakeCodex(f, "process.exit(1);");
    writeFileSync(
      join(f.dataRoot, "providers.json"),
      JSON.stringify({ providers: { openai: { codexCommandPath: codex.path } } }),
    );
    const result = await runAsync(f, ["models", "--provider", "openai", "--refresh", "--json"])
      .done;
    const invocations = readFileSync(codex.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      invocations.some((argv: string[]) => argv.includes("app-server")),
      "refresh must use providers.openai.codexCommandPath, not CODEX_EXECUTABLE",
    );
    // A failed refresh keeps the documented contract: exit 3 unless the list is ready.
    assert.equal(result.code, 3, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data.freshness, "unverified");
  } finally {
    f.close();
  }
});

test("models --refresh uses the configured Anthropic endpoint and key, and redacts the key", async () => {
  const f = fixture();
  const seen: Array<string | string[] | undefined> = [];
  const server = await startLoopbackServer((request, response) => {
    seen.push(request.headers["x-api-key"]);
    sendJson(response, 200, {
      data: [{ id: "claude-fixture-1", display_name: "Fixture One", type: "model" }],
      has_more: false,
    });
  });
  try {
    f.env.ANTHROPIC_API_KEY = "";
    writeFileSync(
      join(f.dataRoot, "providers.json"),
      JSON.stringify({
        providers: {
          anthropic: {
            apiKey: "fixture-anthropic-key",
            baseUrl: server.url,
          },
        },
      }),
    );
    const result = await runAsync(f, ["models", "--provider", "anthropic", "--refresh", "--json"])
      .done;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(seen, ["fixture-anthropic-key"]);
    const envelope = JSON.parse(result.stdout);
    assert.ok(
      envelope.data.models.some(
        (model: { modelId: string }) => model.modelId === "claude-fixture-1",
      ),
    );
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-anthropic-key/);
  } finally {
    await server.close();
    f.close();
  }
});

test("models --refresh is cancelled by SIGINT and stops the discovery process", async () => {
  const f = fixture();
  try {
    const pidFile = join(f.root, "discovery.pid");
    const codex = fakeCodex(
      f,
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);`,
    );
    writeFileSync(
      join(f.dataRoot, "providers.json"),
      JSON.stringify({ providers: { openai: { codexCommandPath: codex.path } } }),
    );
    const run = runAsync(f, ["models", "--provider", "openai", "--refresh", "--json"]);
    const deadline = Date.now() + 10000;
    while (!existsSync(pidFile)) {
      if (Date.now() > deadline) throw new Error("discovery process did not start");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const pid = Number(readFileSync(pidFile, "utf8"));
    run.child.kill("SIGINT");
    const result = await run.done;
    assert.equal(result.code, 130, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, "INTERRUPTED");
    const stopDeadline = Date.now() + 5000;
    while (Date.now() < stopDeadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    process.kill(pid, "SIGKILL");
    assert.fail("discovery process outlived the interrupted command");
  } finally {
    f.close();
  }
});
