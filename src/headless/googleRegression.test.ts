import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../test/environment.js";

const launcher = fileURLToPath(new URL("../../bin/ubume.js", import.meta.url));
const fixtureSource = fileURLToPath(
  new URL("../test/fixtures/antigravityProvider.mjs", import.meta.url),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ubume-google-regression-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const data = join(root, "data");
  const providersFile = join(data, "workspaces", key, "providers.json");
  mkdirSync(join(providersFile, ".."), { recursive: true });
  const agy = join(root, "agy-fixture");
  writeFileSync(agy, readFileSync(fixtureSource), { mode: 0o700 });
  const gemini = join(root, "gemini");
  const legacyMarker = join(root, "legacy-was-invoked");
  writeFileSync(
    gemini,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(legacyMarker)}, 'invoked');\n`,
    { mode: 0o700 },
  );
  const log = join(root, "agy.jsonl");
  const pidFile = join(root, "pid");
  const env = createTestEnvironment(root, {
    UBUME_DATA_DIR: data,
    CODEXA_DATA_DIR: join(root, "legacy"),
    AGY_EXECUTABLE: agy,
    GEMINI_EXECUTABLE: gemini,
    UBUME_TEST_AGY_LOG: log,
    UBUME_TEST_PID_FILE: pidFile,
    PATH: `${root}:${process.env.PATH}`,
  });
  const run = (args: string[]) =>
    spawnSync("node", [launcher, ...args], {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 20000,
    });
  const entries = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const metadataFile = (id: string) =>
    join(data, "chats", key, "conversations", id, "snapshot.json");
  return {
    root,
    workspace,
    env,
    agy,
    gemini,
    legacyMarker,
    log,
    pidFile,
    providersFile,
    run,
    entries,
    metadataFile,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("installed launcher routes Google and its compatibility alias to AGY, preserving native models and multi-turn history", () => {
  const f = fixture();
  try {
    const first = f.run([
      "exec",
      "--provider",
      "google",
      "--model",
      "gemini-fixture-high",
      "first turn",
      "--json",
    ]);
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.data.text, "AGY_REPLY:gemini-fixture-high");
    const file = f.metadataFile(result.data.sessionId);
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    const saved = snapshot.metadata;
    assert.equal(saved.providerId, "google");
    assert.equal(saved.backendKind, "antigravity-cli-auth");
    saved.providerId = "antigravity";
    saved.reasoning = "high";
    writeFileSync(file, JSON.stringify(snapshot));
    const resumed = f.run([
      "exec",
      "--resume",
      result.data.sessionId,
      "--model",
      "gemini-fixture-low",
      "second turn",
      "--json",
    ]);
    assert.equal(JSON.parse(resumed.stdout).data.text, "AGY_REPLY:gemini-fixture-low");
    assert.equal(resumed.status, 0, resumed.stderr);
    const calls = f.entries();
    assert.deepEqual(calls[0].args, [
      "--model",
      "gemini-fixture-high",
      "--mode",
      "auto",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "0",
      "-p",
      "first turn",
    ]);
    assert.match(calls[1].args.at(-1), /first turn/);
    assert.match(calls[1].args.at(-1), /AGY_REPLY:gemini-fixture-high/);
    assert.match(calls[1].args.at(-1), /second turn/);
    assert.equal(existsSync(f.legacyMarker), false);
  } finally {
    f.close();
  }
});

test("explicit Antigravity CLI alias selects the canonical Google backend", () => {
  const f = fixture();
  try {
    const result = f.run([
      "exec",
      "--provider",
      "antigravity",
      "--model",
      "claude-fixture",
      "alias",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.text, "AGY_REPLY:claude-fixture");
    assert.equal(existsSync(f.legacyMarker), false);
  } finally {
    f.close();
  }
});

test("conflicting legacy Google commands and credentials cannot change an Antigravity dispatch", () => {
  const f = fixture();
  try {
    const original = JSON.stringify({
      workspaceDefaultProviderId: "antigravity",
      activeRoute: {
        providerId: "antigravity",
        modelId: "gemini-fixture-high",
        backendKind: "antigravity-cli-auth",
      },
      providers: {
        google: { api_key: "legacy-key", command: f.gemini, current_model: "legacy-model" },
        antigravity: { antigravity_command_path: f.agy, current_model: "gemini-fixture-high" },
      },
    });
    writeFileSync(f.providersFile, original);
    const result = f.run(["exec", "migration", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.text, "AGY_REPLY:gemini-fixture-high");
    assert.equal(
      readFileSync(f.providersFile, "utf8"),
      original,
      "loading does not rewrite credentials",
    );
    assert.equal(existsSync(f.legacyMarker), false);
  } finally {
    f.close();
  }
});

test("legacy-only Google selections block execution until an explicit Antigravity selection", () => {
  const f = fixture();
  try {
    writeFileSync(
      f.providersFile,
      JSON.stringify({
        workspaceDefaultProviderId: "google",
        activeRoute: {
          providerId: "google",
          modelId: "gemini-fixture-high",
          backendKind: "gemini-cli-auth",
        },
        providers: { google: { command: f.gemini, api_key: "legacy-key" } },
      }),
    );
    const blocked = f.run(["exec", "blocked", "--json"]);
    assert.equal(blocked.status, 3, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).error.code, "MIGRATION_REQUIRED");
    assert.equal(f.entries().length, 0);
    const explicit = f.run([
      "exec",
      "--provider",
      "google",
      "--model",
      "gemini-fixture-high",
      "chosen",
      "--json",
    ]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(existsSync(f.legacyMarker), false);
  } finally {
    f.close();
  }
});

test("unavailable models, invalid reasoning, expired auth, and missing AGY fail without a Gemini fallback", () => {
  const f = fixture();
  try {
    for (const extra of [
      ["--model", "unknown"],
      ["--model", "gemini-fixture-high", "--reasoning", "ultra"],
    ]) {
      const result = f.run(["exec", "--provider", "google", ...extra, "blocked", "--json"]);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(JSON.parse(result.stdout).error.message, /unavailable|supported selector/);
    }
    assert.equal(f.entries().length, 0);
    const auth = f.run([
      "exec",
      "--provider",
      "google",
      "--model",
      "claude-fixture",
      "AUTH_FAILURE",
      "--json",
    ]);
    assert.notEqual(auth.status, 0);
    assert.match(JSON.parse(auth.stdout).error.message, /authentication expired/);
    f.env.AGY_EXECUTABLE = f.gemini;
    const legacy = f.run([
      "exec",
      "--provider",
      "google",
      "--model",
      "gemini-fixture-high",
      "blocked",
      "--json",
    ]);
    assert.notEqual(legacy.status, 0);
    assert.equal(existsSync(f.legacyMarker), false, "even Gemini --help is forbidden");
    f.env.AGY_EXECUTABLE = join(f.root, "missing-agy");
    assert.equal(f.run(["exec", "--provider", "google", "hello", "--json"]).status, 3);
    assert.equal(existsSync(f.legacyMarker), false);
  } finally {
    f.close();
  }
});

test("Google cancellation through the installed launcher stops AGY and saves the interrupted session", async () => {
  const f = fixture();
  const child = spawn(
    "node",
    [
      launcher,
      "exec",
      "--provider",
      "google",
      "--model",
      "claude-fixture",
      "WAIT_FOR_INTERRUPT",
      "--json",
    ],
    { cwd: f.workspace, env: f.env, stdio: ["ignore", "pipe", "pipe"] },
  );
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
    while (!existsSync(f.pidFile)) {
      if (Date.now() > deadline) throw new Error(`AGY never started: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const pid = Number(readFileSync(f.pidFile, "utf8"));
    child.kill("SIGINT");
    assert.equal(await completed, 130, stderr);
    assert.throws(() => process.kill(pid, 0), "provider teardown completes before the CLI returns");
    const result = JSON.parse(stdout);
    assert.equal(result.error.code, "INTERRUPTED");
    assert.equal(
      JSON.parse(readFileSync(f.metadataFile(result.data.sessionId), "utf8")).metadata.backendKind,
      "antigravity-cli-auth",
    );
    assert.equal(existsSync(f.legacyMarker), false);
  } finally {
    child.kill("SIGKILL");
    f.close();
  }
});
