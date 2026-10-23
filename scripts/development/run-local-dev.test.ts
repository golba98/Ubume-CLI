import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createUbumeDevShim, SHIM_NAMES } from "./install-dev-shims.mjs";
import {
  DEFAULT_NATIVE_MODEL_ROOT,
  HEADLESS_COMMANDS,
  resolveLocalDevEntry,
  resolveNativeChatCommand,
  resolveNumpyChatCommand,
} from "./run-local-dev.mjs";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("resolveLocalDevEntry resolves interactive launches to the local repo src/index.tsx", () => {
  const resolved = resolveLocalDevEntry(repoRoot, []);
  assert.equal(resolved.isHeadlessMode, false);
  assert.equal(resolved.entry, join(repoRoot, "src", "index.tsx"));
  assert.deepEqual(resolved.entryArgs, []);
});

test("resolveLocalDevEntry forwards interactive prompt args to src/index.tsx", () => {
  const resolved = resolveLocalDevEntry(repoRoot, ["explain this repo", "--model", "x"]);
  assert.equal(resolved.entry, join(repoRoot, "src", "index.tsx"));
  assert.deepEqual(resolved.entryArgs, ["explain this repo", "--model", "x"]);
});

test("resolveLocalDevEntry resolves `exec` to the headless src/cli.ts", () => {
  const resolved = resolveLocalDevEntry(repoRoot, ["exec", "print the dir"]);
  assert.equal(resolved.isHeadlessMode, true);
  assert.equal(resolved.isHeadlessExec, true);
  assert.equal(resolved.entry, join(repoRoot, "src", "cli.ts"));
  assert.deepEqual(resolved.entryArgs, ["exec", "print the dir"]);
});

test("resolveLocalDevEntry keeps --headless-benchmark for src/cli.ts", () => {
  const resolved = resolveLocalDevEntry(repoRoot, ["--headless-benchmark", "x"]);
  assert.equal(resolved.isHeadlessMode, true);
  assert.equal(resolved.isHeadlessBenchmark, true);
  assert.equal(resolved.entry, join(repoRoot, "src", "cli.ts"));
  assert.deepEqual(resolved.entryArgs, ["--headless-benchmark", "x"]);
});

test("resolveNativeChatCommand targets the native SFT v2 checkpoint", () => {
  const modelRoot = join(tmpdir(), "Ubume model");
  const resolved = resolveNativeChatCommand({
    CODEXA_NATIVE_MODEL_ROOT: modelRoot,
    CODEXA_NATIVE_DEVICE: "cpu",
  });

  assert.equal(resolved.cwd, modelRoot);
  assert.equal(resolved.executable, join(modelRoot, ".venv", "bin", "python"));
  assert.deepEqual(resolved.args, [
    join(modelRoot, "scripts", "chat_native.py"),
    "--checkpoint", join(modelRoot, "checkpoints", "codexa-900m-sft-v2", "latest.pt"),
    "--tokenizer", join(modelRoot, "checkpoints", "tokenizer-base-v1", "tokenizer.json"),
    "--device", "cpu",
  ]);
});

test("resolveNativeChatCommand defaults to the canonical PyTorch checkout", () => {
  const resolved = resolveNativeChatCommand({});
  assert.equal(resolved.cwd, DEFAULT_NATIVE_MODEL_ROOT);
  assert.equal(resolved.executable, join(DEFAULT_NATIVE_MODEL_ROOT, ".venv", "bin", "python"));
  assert.deepEqual(resolved.requiredPaths, [
    join(DEFAULT_NATIVE_MODEL_ROOT, ".venv", "bin", "python"),
    join(DEFAULT_NATIVE_MODEL_ROOT, "scripts", "chat_native.py"),
    join(DEFAULT_NATIVE_MODEL_ROOT, "checkpoints", "codexa-900m-sft-v2", "latest.pt"),
    join(DEFAULT_NATIVE_MODEL_ROOT, "checkpoints", "tokenizer-base-v1", "tokenizer.json"),
  ]);
});

test("resolveNumpyChatCommand targets the trained NumPy follow-up checkpoint", () => {
  const modelRoot = join(tmpdir(), "NumPy model");
  const resolved = resolveNumpyChatCommand({
    CODEXA_NUMPY_MODEL_ROOT: modelRoot,
    CODEXA_NUMPY_DEVICE: "cpu",
  });

  assert.equal(resolved.cwd, modelRoot);
  assert.equal(resolved.executable, "python3");
  assert.deepEqual(resolved.args, [
    join(modelRoot, "scripts", "chat_codexa.py"),
    "--checkpoint", join(modelRoot, "runs", "pretraining", "pretrain_250m_fineweb_followup_10m", "target_final.npz"),
    "--tokenizer", join(modelRoot, "data", "tokenized", "general-fineweb-10m-v1", "tokenizer.json"),
    "--device", "cpu",
  ]);
});

test("createUbumeDevShim installs ubume-dev and ubd pointing at the local launcher", () => {
  const binDir = mkdtempSync(join(tmpdir(), "ubume-dev-shim-"));
  try {
    const result = createUbumeDevShim({ binDir });
    const launcherPath = join(repoRoot, "scripts", "development", "run-local-dev.mjs");

    assert.equal(result.launcherPath, launcherPath);
    assert.equal(result.shimPaths.length, SHIM_NAMES.length);
    assert.deepEqual([...SHIM_NAMES].sort(), ["ubd", "ubume-dev"]);

    for (const shimPath of result.shimPaths) {
      // Each shim exists and references the LOCAL run-local-dev.mjs launcher.
      assert.ok(statSync(shimPath).isFile(), `${shimPath} should be a file`);
      const contents = readFileSync(shimPath, "utf8");
      assert.ok(
        contents.includes(launcherPath),
        `${shimPath} should invoke the local launcher (${launcherPath})`,
      );
    }
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("resolveLocalDevEntry sends every headless terminal command to src/cli.ts, also after --json", () => {
  for (const command of HEADLESS_COMMANDS) {
    for (const args of [[command], ["--json", command]]) {
      const resolved = resolveLocalDevEntry(repoRoot, args);
      assert.equal(resolved.isHeadlessMode, true, args.join(" "));
      assert.equal(resolved.entry, join(repoRoot, "src", "cli.ts"));
      assert.deepEqual(resolved.entryArgs, args);
    }
  }
});

/**
 * Runs a launcher with a fake Bun that records its argv, and returns the Ubume entry file the
 * launcher chose. Nothing real starts: the fake exits immediately.
 */
function entryChosenBy(launcher: string, args: string[], workspace: string): string {
  const record = join(workspace, "bun-argv.json");
  const fakeBun = join(workspace, "fake-bun");
  writeFileSync(
    fakeBun,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  chmodSync(fakeBun, 0o755);
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, UBUME_BUN_EXECUTABLE: fakeBun, UBUME_STARTUP_TRACE: "" },
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `${launcher} ${args.join(" ")}: ${result.stderr}`);
  const argv = JSON.parse(readFileSync(record, "utf8")) as string[];
  rmSync(record);
  const entry = argv.find((arg) => /src[\\/](cli\.ts|index\.tsx)$/.test(arg));
  assert.ok(entry, `no Ubume entry in ${JSON.stringify(argv)}`);
  return entry.endsWith("cli.ts") ? "headless" : "interactive";
}

test("ubume-dev and the installed launcher route every command to the same entry", () => {
  const workspace = mkdtempSync(join(tmpdir(), "ubume launcher parity "));
  try {
    const cases = [
      ["hello there"],
      ["exec", "print the current directory"],
      ["--headless-benchmark", "x"],
      ...HEADLESS_COMMANDS.flatMap((command) => [[command], ["--json", command]]),
    ];
    for (const args of cases) {
      const installed = entryChosenBy(join(repoRoot, "bin", "ubume.js"), args, workspace);
      const local = entryChosenBy(
        join(repoRoot, "scripts", "development", "run-local-dev.mjs"),
        args,
        workspace,
      );
      assert.equal(local, installed, `ubume-dev ${args.join(" ")}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
