/// <reference path="../../node_modules/bun-types/test.d.ts" />
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHomeDir, getSettingsFile } from "../config/settings.js";
import { probeCodexAuthStatus } from "../core/codex/codexAuth.js";
import { buildExternalResumeLaunch } from "../core/externalSessions/index.js";
import { codexSubprocessProvider } from "../core/providers/codexSubprocess.js";
import { withEnvironment } from "./environment.js";
import { sendJson, startLoopbackServer } from "./loopbackServer.js";
import {
  assertProviderFreePath,
  createOfflineSandbox,
  createProviderFreePath,
  isInsideSandbox,
  PROVIDER_COMMANDS,
} from "./offlineSandbox.js";
import { createTestRuntime } from "./runtimeTestUtils.js";

const launcher = fileURLToPath(new URL("../../bin/ubume.js", import.meta.url));

/** JSON-mode Codex double: answers one structured turn. */
const FAKE_CODEX_TURN = `
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("Usage: codex exec\\n  -c, --config <key=value>"); process.exit(0); }
if (args[0] === "login") { console.log(JSON.stringify({ loggedIn: true, authMode: "chatgpt" })); process.exit(0); }
(async () => {
  for await (const _ of process.stdin);
  console.log(JSON.stringify({ type: "item.completed", item: { id: "a", type: "agent_message", text: "fake codex answer" } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
})();
`;

/**
 * A stand-in for an installed provider CLI that sits first on a developer-like PATH. It
 * only records that it ran; any record is a test failure.
 */
function createDecoyProviderDir(): { dir: string; marker: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "ubume-decoy-real-cli-"));
  const marker = join(dir, "REAL-INVOKED");
  for (const command of PROVIDER_COMMANDS) {
    writeFileSync(join(dir, command), `#!/bin/sh\necho "${command} $*" >> "${marker}"\nexit 1\n`, {
      mode: 0o700,
    });
  }
  return { dir, marker, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the test preload removes provider CLIs, real homes and secrets from the runner", () => {
  assertProviderFreePath(process.env.PATH ?? "");
  const realHome = userInfo().homedir;
  // Bun's os.homedir() keeps the launch-time home, so app code must use getHomeDir().
  expect(getHomeDir()).not.toBe(realHome);
  expect(getSettingsFile().startsWith(realHome)).toBe(false);
  expect(process.env.CODEX_HOME?.startsWith(realHome)).toBe(false);
  expect(process.env.CLAUDE_CONFIG_DIR?.startsWith(realHome)).toBe(false);
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_EXECUTABLE",
    "CLAUDE_EXECUTABLE",
  ])
    expect(process.env[name]).toBeUndefined();
});

test("fetch to a non-loopback host is rejected before any connection", async () => {
  await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
    /offline test sandbox blocked network access to api\.anthropic\.com/,
  );
  await expect(fetch("https://registry.npmjs.org/-/package/ubume/dist-tags")).rejects.toThrow(
    /offline test sandbox/,
  );
  const server = await startLoopbackServer((_request, response) =>
    sendJson(response, 200, { ok: 1 }),
  );
  try {
    expect(await (await fetch(`${server.url}/x`)).json()).toEqual({ ok: 1 });
  } finally {
    await server.close();
  }
});

test("a provider-free PATH never inherits provider CLIs from the host PATH", () => {
  const decoy = createDecoyProviderDir();
  const root = mkdtempSync(join(tmpdir(), "ubume-safe-path-"));
  try {
    expect(() => assertProviderFreePath(`${decoy.dir}${delimiter}/usr/bin`)).toThrow(
      /Unsafe offline PATH/,
    );
    const path = createProviderFreePath(
      join(root, "bin"),
      `${decoy.dir}${delimiter}${process.env.PATH}`,
    );
    expect(path.split(delimiter)).not.toContain(decoy.dir);
    assertProviderFreePath(path);
  } finally {
    decoy.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configured Codex path is the binary that runs, even with an installed codex first on PATH", async () => {
  // Reproduces the Phase 1 incident: the runtime used to drop codexCommandPath, so the
  // adapter resolved `codex` from PATH and launched the installed CLI.
  const sandbox = createOfflineSandbox({ fakes: { codex: FAKE_CODEX_TURN } });
  const decoy = createDecoyProviderDir();
  try {
    const runtime = createTestRuntime({ codexCommandPath: sandbox.fakes.codex });
    expect(runtime.codexCommandPath).toBe(sandbox.fakes.codex);
    const response = await withEnvironment(
      { PATH: `${decoy.dir}${delimiter}${sandbox.path}`, CODEX_EXECUTABLE: undefined },
      () =>
        new Promise<string>((resolve, reject) => {
          codexSubprocessProvider.run!(
            "offline proof",
            { runtime, workspaceRoot: sandbox.root, promptPolicy: "raw" },
            { onResponse: resolve, onError: (message) => reject(new Error(message)) },
          );
        }),
    );
    expect(response).toBe("fake codex answer");
    expect(existsSync(decoy.marker)).toBe(false);
    sandbox.assertSpawnedOnly([sandbox.fakes.codex!]);
    expect(sandbox.readSpawnLog().length).toBeGreaterThan(0);
  } finally {
    decoy.cleanup();
    sandbox.dispose();
  }
});

test("the Codex auth probe and native resume honor the configured executable", async () => {
  const sandbox = createOfflineSandbox({ fakes: { codex: FAKE_CODEX_TURN } });
  const decoy = createDecoyProviderDir();
  try {
    await withEnvironment(
      { PATH: `${decoy.dir}${delimiter}${sandbox.path}`, CODEX_EXECUTABLE: undefined },
      async () => {
        const status = await probeCodexAuthStatus({ codexCommandPath: sandbox.fakes.codex });
        expect(status.state).not.toBe("unknown");
        const project = join(sandbox.root, "project");
        mkdirSync(project);
        const prepared = await buildExternalResumeLaunch(
          { source: "codex", id: "session-1", title: "t", cwd: project } as Parameters<
            typeof buildExternalResumeLaunch
          >[0],
          { fallbackCwd: project, configuredPaths: { codex: sandbox.fakes.codex } },
        );
        expect(prepared.ok && prepared.launch.executable).toBe(sandbox.fakes.codex!);
      },
    );
    expect(existsSync(decoy.marker)).toBe(false);
    sandbox.assertSpawnedOnly([sandbox.fakes.codex!]);
  } finally {
    decoy.cleanup();
    sandbox.dispose();
  }
});

test("a missing configured Codex path fails clearly instead of falling back to PATH", async () => {
  const sandbox = createOfflineSandbox();
  const decoy = createDecoyProviderDir();
  try {
    const missing = join(sandbox.root, "not-installed", "codex");
    const error = await withEnvironment(
      { PATH: `${decoy.dir}${delimiter}${sandbox.path}`, CODEX_EXECUTABLE: undefined },
      () =>
        new Promise<string>((resolve) => {
          codexSubprocessProvider.run!(
            "offline proof",
            {
              runtime: createTestRuntime({ codexCommandPath: missing }),
              workspaceRoot: sandbox.root,
              promptPolicy: "raw",
            },
            { onResponse: () => resolve("unexpected response"), onError: resolve },
          );
        }),
    );
    expect(error).toMatch(/codexCommandPath|does not exist|not found/i);
    expect(existsSync(decoy.marker)).toBe(false);
  } finally {
    decoy.cleanup();
    sandbox.dispose();
  }
});

test("headless exec through the real launcher runs only the configured fake Codex", async () => {
  const sandbox = createOfflineSandbox({ fakes: { codex: FAKE_CODEX_TURN } });
  const decoy = createDecoyProviderDir();
  try {
    const workspace = join(sandbox.root, "workspace");
    mkdirSync(workspace);
    const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
    const dataRoot = join(sandbox.root, "data", "workspaces", key);
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(
      join(dataRoot, "providers.json"),
      JSON.stringify({ providers: { openai: { codexCommandPath: sandbox.fakes.codex } } }),
    );
    const env = {
      ...sandbox.env,
      // A developer-like PATH with an installed CLI first, and no CODEX_EXECUTABLE.
      PATH: `${decoy.dir}${delimiter}${sandbox.path}`,
      CODEX_EXECUTABLE: undefined,
      UBUME_DATA_DIR: join(sandbox.root, "data"),
    };
    const child = spawn(
      "node",
      [launcher, "exec", "--provider", "openai", "--no-save", "--json", "--", "hi"],
      {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout).data.text).toBe("fake codex answer");
    expect(existsSync(decoy.marker) ? readFileSync(decoy.marker, "utf8") : "").toBe("");
    sandbox.assertSpawnedOnly([sandbox.fakes.codex!]);
    expect(
      sandbox.readSpawnLog().every((record) => isInsideSandbox(sandbox, record.executable)),
    ).toBe(true);
  } finally {
    decoy.cleanup();
    sandbox.dispose();
  }
});

test("Codex resolution precedence: configured path, then CODEX_EXECUTABLE, then PATH", async () => {
  const { resolveCodexExecutable, resetCodexExecutableCacheForTests } = await import(
    "../core/executables/codexExecutable.js"
  );
  const sandbox = createOfflineSandbox({ fakes: { codex: true, claude: true } });
  const onPath = join(sandbox.root, "path-bin");
  mkdirSync(onPath);
  writeFileSync(join(onPath, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  try {
    resetCodexExecutableCacheForTests();
    await withEnvironment(
      { CODEX_EXECUTABLE: sandbox.fakes.claude, PATH: `${onPath}${delimiter}${sandbox.path}` },
      async () => {
        expect(await resolveCodexExecutable({ configuredPath: sandbox.fakes.codex })).toBe(
          sandbox.fakes.codex!,
        );
        expect(await resolveCodexExecutable({ configuredPath: undefined })).toBe(
          sandbox.fakes.claude!,
        );
      },
    );
    resetCodexExecutableCacheForTests();
    await withEnvironment(
      { CODEX_EXECUTABLE: undefined, PATH: `${onPath}${delimiter}${sandbox.path}` },
      async () => {
        // Bare-name fallback is resolved by the OS at spawn time from this PATH.
        expect(await resolveCodexExecutable()).toBe("codex");
      },
    );
    resetCodexExecutableCacheForTests();
    await expect(
      resolveCodexExecutable({ configuredPath: "/opt/codex; rm -rf /" }),
    ).rejects.toThrow();
    // A cached unconfigured result never overrides a later configured path.
    await withEnvironment({ CODEX_EXECUTABLE: sandbox.fakes.claude }, async () => {
      await resolveCodexExecutable();
      const configured = await Promise.all(
        Array.from({ length: 8 }, () =>
          resolveCodexExecutable({ configuredPath: sandbox.fakes.codex }),
        ),
      );
      expect(new Set(configured)).toEqual(new Set([sandbox.fakes.codex!]));
    });
  } finally {
    resetCodexExecutableCacheForTests();
    sandbox.dispose();
  }
});

test("a Codex run cancelled before launch never spawns a process", async () => {
  const sandbox = createOfflineSandbox({ fakes: { codex: FAKE_CODEX_TURN } });
  try {
    const outcomes: string[] = [];
    const cancel = codexSubprocessProvider.run!(
      "never sent",
      {
        runtime: createTestRuntime({ codexCommandPath: sandbox.fakes.codex }),
        workspaceRoot: sandbox.root,
        promptPolicy: "raw",
      },
      { onResponse: () => outcomes.push("response"), onError: () => outcomes.push("error") },
    );
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sandbox.readSpawnLog()).toEqual([]);
    expect(outcomes).toEqual([]);
  } finally {
    sandbox.dispose();
  }
});

test("switching the headless route to Claude runs only the configured fake Claude", async () => {
  const fakeClaude = `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.0.0 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" || args[0] === "login") { console.log('{"loggedIn":true}'); process.exit(0); }
if (args[0] === "model") { console.log(JSON.stringify({ models: [{ value: "sonnet", canonicalId: "claude-sonnet-5-5" }] })); process.exit(0); }
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fake claude answer" }] } }));
`;
  const sandbox = createOfflineSandbox({ fakes: { claude: fakeClaude } });
  const decoy = createDecoyProviderDir();
  try {
    const workspace = join(sandbox.root, "workspace");
    mkdirSync(workspace);
    const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
    const dataRoot = join(sandbox.root, "data", "workspaces", key);
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(
      join(dataRoot, "providers.json"),
      JSON.stringify({
        activeRoute: {
          providerId: "anthropic",
          modelId: "sonnet",
          backendKind: "claude-code-auth",
        },
        providers: { anthropic: { claudeCommandPath: sandbox.fakes.claude } },
      }),
    );
    const child = spawn("node", [launcher, "exec", "--no-save", "--json", "--", "hi"], {
      cwd: workspace,
      env: {
        ...sandbox.env,
        PATH: `${decoy.dir}${delimiter}${sandbox.path}`,
        CLAUDE_EXECUTABLE: undefined,
        ANTHROPIC_API_KEY: "",
        UBUME_DATA_DIR: join(sandbox.root, "data"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout).data.text).toBe("fake claude answer");
    expect(existsSync(decoy.marker) ? readFileSync(decoy.marker, "utf8") : "").toBe("");
    sandbox.assertSpawnedOnly([sandbox.fakes.claude!]);
  } finally {
    decoy.cleanup();
    sandbox.dispose();
  }
});
