/// <reference path="../../node_modules/bun-types/test.d.ts" />
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setProjectTrust } from "../config/trustStore.js";
import { withEnvironment } from "../test/environment.js";
import {
  createOfflineSandbox,
  type OfflineSandbox,
  PROVIDER_COMMANDS,
} from "../test/offlineSandbox.js";

// End-to-end companion of executableSelection.test.ts: every case runs through the installed
// Node launcher (bin/ubume.js → Bun → src/cli.ts), so the launcher's environment and argument
// forwarding are part of what is verified. Each case has a decoy `codex` first on PATH and
// CODEX_EXECUTABLE pointing at a different valid fake, so a silent fallback is observable.

const launcher = fileURLToPath(new URL("../../bin/ubume.js", import.meta.url));

/** Fake Codex: `app-server` answers model/list; `exec --json` answers one turn. */
const FAKE_CODEX = `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.0.0-offline"); process.exit(0); }
if (args.includes("--help")) { console.log("Usage: codex exec\\n  -c, --config <key=value>"); process.exit(0); }
if (args[0] === "login") { console.log(JSON.stringify({ loggedIn: true, authMode: "chatgpt" })); process.exit(0); }
if (args[0] === "app-server") {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id == null) return;
    const result = message.method === "model/list"
      ? { data: [{ id: "offline-model", model: "offline-model", displayName: "Offline", supportedReasoningEfforts: [], defaultReasoningEffort: "medium" }], nextCursor: null }
      : {};
    console.log(JSON.stringify({ id: message.id, result }));
  });
  return;
}
(async () => {
  for await (const _ of process.stdin);
  console.log(JSON.stringify({ type: "item.completed", item: { id: "a", type: "agent_message", text: "answer from " + require("node:path").basename(process.argv[1]) } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
})();
`;

interface Fixture {
  sandbox: OfflineSandbox;
  workspace: string;
  decoyMarker: string;
  /** Valid fakes; all log to the sandbox spawn log under their own path. */
  fakes: { user: string; project: string; profile: string; override: string; env: string };
  env: NodeJS.ProcessEnv;
}

function createFixture(): Fixture {
  const sandbox = createOfflineSandbox({ fakes: { codex: FAKE_CODEX } });
  const source = sandbox.fakes.codex!;
  const fakes = {
    user: source,
    project: join(sandbox.root, "fake-providers", "codex-project"),
    profile: join(sandbox.root, "fake-providers", "codex-profile"),
    override: join(sandbox.root, "fake-providers", "codex-override"),
    env: join(sandbox.root, "fake-providers", "codex-env"),
  };
  for (const copy of [fakes.project, fakes.profile, fakes.override, fakes.env])
    copyFileSync(source, copy);

  const decoyDir = join(sandbox.root, "decoy-bin");
  const decoyMarker = join(decoyDir, "REAL-INVOKED");
  mkdirSync(decoyDir);
  for (const command of PROVIDER_COMMANDS) {
    writeFileSync(
      join(decoyDir, command),
      `#!/bin/sh\necho "${command} $*" >> "${decoyMarker}"\nexit 1\n`,
      { mode: 0o700 },
    );
  }

  const workspace = join(sandbox.root, "workspace");
  mkdirSync(workspace);
  // Pins the project root: layered config walks up to the nearest `.git`.
  expect(spawnSync("git", ["init", "-q"], { cwd: workspace, env: sandbox.env }).status).toBe(0);
  mkdirSync(sandbox.env.CODEX_HOME!, { recursive: true });

  const env = {
    ...sandbox.env,
    PATH: `${decoyDir}${delimiter}${sandbox.path}`,
    CODEX_EXECUTABLE: fakes.env,
    UBUME_DATA_DIR: join(sandbox.root, "data"),
  };
  return { sandbox, workspace, decoyMarker, fakes, env };
}

function writeUserConfig(fixture: Fixture, toml: string) {
  writeFileSync(join(fixture.sandbox.env.CODEX_HOME!, "config.toml"), toml);
}

async function writeProjectConfig(fixture: Fixture, toml: string, trusted: boolean) {
  mkdirSync(join(fixture.workspace, ".codex"), { recursive: true });
  writeFileSync(join(fixture.workspace, ".codex", "config.toml"), toml);
  await withEnvironment(fixture.env, () => setProjectTrust(fixture.workspace, trusted));
}

const pathSetting = (path: string) => `codex_command_path = ${JSON.stringify(path)}\n`;

async function runLauncher(fixture: Fixture, args: string[]) {
  const child = spawn("node", [launcher, ...args], {
    cwd: fixture.workspace,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

const exec = (fixture: Fixture, ...extra: string[]) =>
  runLauncher(fixture, [
    "exec",
    "--provider",
    "openai",
    "--no-save",
    "--json",
    ...extra,
    "--",
    "hi",
  ]);
const refresh = (fixture: Fixture) =>
  runLauncher(fixture, ["models", "--provider", "openai", "--refresh", "--json"]);

/** Asserts the run succeeded and every provider spawn used exactly `expected`. */
function expectOnly(
  fixture: Fixture,
  expected: string,
  run: { code: number | null; stderr: string; stdout: string },
) {
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const spawned = fixture.sandbox.readSpawnLog().map((record) => record.executable);
  expect(spawned.length).toBeGreaterThan(0);
  expect(new Set(spawned)).toEqual(new Set([expected]));
  expect(existsSync(fixture.decoyMarker) ? readFileSync(fixture.decoyMarker, "utf8") : "").toBe("");
}

async function withFixture(body: (fixture: Fixture) => Promise<void>) {
  const fixture = createFixture();
  try {
    await body(fixture);
  } finally {
    fixture.sandbox.dispose();
  }
}

const TIMEOUT = 60_000;

test(
  "user config.toml codex_command_path wins over CODEX_EXECUTABLE for exec and refresh",
  () =>
    withFixture(async (fixture) => {
      writeUserConfig(fixture, pathSetting(fixture.fakes.user));
      const run = await exec(fixture);
      expectOnly(fixture, fixture.fakes.user, run);
      expect(JSON.parse(run.stdout).data.text).toBe("answer from codex");
      writeFileSync(fixture.sandbox.spawnLogPath, "");
      const listed = await refresh(fixture);
      expectOnly(fixture, fixture.fakes.user, listed);
      expect(listed.stdout).toContain("offline-model");
    }),
  TIMEOUT,
);

test(
  "trusted project config overrides user config; untrusted project config is ignored",
  () =>
    withFixture(async (fixture) => {
      writeUserConfig(fixture, pathSetting(fixture.fakes.user));
      await writeProjectConfig(fixture, pathSetting(fixture.fakes.project), false);
      expectOnly(fixture, fixture.fakes.user, await exec(fixture));

      writeFileSync(fixture.sandbox.spawnLogPath, "");
      await writeProjectConfig(fixture, pathSetting(fixture.fakes.project), true);
      expectOnly(fixture, fixture.fakes.project, await exec(fixture));
      writeFileSync(fixture.sandbox.spawnLogPath, "");
      expectOnly(fixture, fixture.fakes.project, await refresh(fixture));
    }),
  TIMEOUT,
);

test(
  "--profile and -c overrides select their executable through the launcher",
  () =>
    withFixture(async (fixture) => {
      writeUserConfig(
        fixture,
        `${pathSetting(fixture.fakes.user)}\n[profiles.offline]\n${pathSetting(fixture.fakes.profile)}`,
      );
      expectOnly(fixture, fixture.fakes.profile, await exec(fixture, "--profile", "offline"));
      writeFileSync(fixture.sandbox.spawnLogPath, "");
      expectOnly(
        fixture,
        fixture.fakes.override,
        await exec(fixture, "-c", `codex_command_path=${JSON.stringify(fixture.fakes.override)}`),
      );
    }),
  TIMEOUT,
);

test(
  "CODEX_EXECUTABLE is used when no layer configures a path",
  () =>
    withFixture(async (fixture) => {
      expectOnly(fixture, fixture.fakes.env, await exec(fixture));
    }),
  TIMEOUT,
);

test(
  "a configured but missing executable fails instead of falling back to env or PATH",
  () =>
    withFixture(async (fixture) => {
      const missing = join(fixture.sandbox.root, "missing", "codex");
      writeUserConfig(fixture, pathSetting(missing));
      const executed = await exec(fixture);
      for (const run of [executed, await refresh(fixture)]) {
        expect(run.code, run.stdout + run.stderr).not.toBe(0);
        expect(JSON.parse(run.stdout).ok).toBe(false);
      }
      expect(JSON.parse(executed.stdout).error.message).toContain(missing);
      expect(fixture.sandbox.readSpawnLog()).toEqual([]);
      expect(existsSync(fixture.decoyMarker) ? readFileSync(fixture.decoyMarker, "utf8") : "").toBe(
        "",
      );
    }),
  TIMEOUT,
);
