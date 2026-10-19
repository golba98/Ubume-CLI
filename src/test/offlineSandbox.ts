/**
 * Offline execution sandbox shared by tests and benchmarks.
 *
 * A sandbox guarantees that no real provider CLI or credential can be reached:
 * - PATH holds only symlinks to trusted runtime tools (node, bun, git, python3, sh)
 *   plus the system directories, and construction fails if a provider CLI resolves;
 * - HOME, XDG, provider homes and Ubume data live under a temporary root;
 * - provider secrets/endpoints are stripped and HTTP(S) proxies point at a port that
 *   refuses connections, so a child that ignores PATH still cannot reach the network
 *   through a proxy-aware client;
 * - fake provider executables log every invocation (absolute path + argv) to one
 *   spawn log, so tests can assert exactly which binaries ran.
 *
 * Limitations: a child that opens raw sockets without honoring proxy variables is not
 * blocked at the syscall level; in-process code is covered by the fetch guard in
 * `offlinePreload.ts`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createTestEnvironment } from "./environment.js";

/** Provider CLIs that must never resolve from a sandbox PATH. */
export const PROVIDER_COMMANDS = ["codex", "claude", "gemini", "agy", "antigravity", "vibe"];
/** Trusted runtime tools linked into the sandbox `bin/` when present on the host. */
const TRUSTED_TOOLS = ["node", "bun", "git", "python3", "sh"];
const SYSTEM_DIRECTORIES = ["/usr/bin", "/bin"];
/** A loopback port that is reserved and never listened on by the sandbox. */
export const REFUSING_PROXY = "http://127.0.0.1:9";

export type FakeProvider = "codex" | "claude" | "agy" | "vibe";

export interface SpawnRecord {
  provider: string;
  executable: string;
  argv: string[];
  pid: number;
}

export interface OfflineSandbox {
  root: string;
  binDir: string;
  /** Provider-free PATH value. */
  path: string;
  /** Child-process environment (temp homes, provider-free PATH, no secrets, refusing proxy). */
  env: NodeJS.ProcessEnv;
  /** Absolute paths of fake provider executables that were requested. */
  fakes: Partial<Record<FakeProvider, string>>;
  spawnLogPath: string;
  readSpawnLog(): SpawnRecord[];
  /** Throws unless every logged spawn used one of `executables`. */
  assertSpawnedOnly(executables: readonly string[]): void;
  dispose(): void;
}

function resolveOnPath(command: string, path: string): string | null {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Throws when any provider CLI resolves from `path`. */
export function assertProviderFreePath(path: string): void {
  for (const command of PROVIDER_COMMANDS) {
    const found = resolveOnPath(command, path);
    if (found) throw new Error(`Unsafe offline PATH: ${command} resolves to ${found}`);
  }
  // `command -v` agrees with the direct lookup for shell-resolved names.
  for (const command of PROVIDER_COMMANDS) {
    const shell = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
      env: { PATH: path },
      encoding: "utf8",
    });
    if (shell.status === 0) {
      throw new Error(`Unsafe offline PATH: ${command} resolves to ${shell.stdout.trim()}`);
    }
  }
}

/**
 * Builds `binDir` with symlinks to trusted tools found on `hostPath` and returns a PATH of
 * `binDir` plus the system directories. System directories must not contain provider CLIs.
 */
export function createProviderFreePath(binDir: string, hostPath = process.env.PATH ?? ""): string {
  mkdirSync(binDir, { recursive: true });
  for (const tool of TRUSTED_TOOLS) {
    const target = tool === "bun" ? process.execPath : resolveOnPath(tool, hostPath);
    const link = join(binDir, tool);
    if (!target || existsSync(link)) continue;
    symlinkSync(realpathSync(target), link);
  }
  const path = [binDir, ...SYSTEM_DIRECTORIES].join(delimiter);
  assertProviderFreePath(path);
  return path;
}

const SPAWN_LOG_HEADER = (provider: string, logPath: string) => `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  provider: ${JSON.stringify(provider)},
  executable: require("node:fs").realpathSync(process.argv[1]),
  argv: process.argv.slice(2),
  pid: process.pid,
}) + "\\n");
`;

/** Default fake behavior: answer version probes, otherwise exit with a recognizable error. */
const DEFAULT_FAKE_BODY = `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("offline-fake 0.0.0"); process.exit(0); }
console.error("offline sandbox fake provider: no scenario for " + JSON.stringify(args));
process.exit(97);
`;

export interface OfflineSandboxOptions {
  /** Fake provider executables to create, with optional script bodies (Node, CommonJS). */
  fakes?: Partial<Record<FakeProvider, string | true>>;
  /** Extra environment applied last (synthetic values only). */
  env?: NodeJS.ProcessEnv;
  /** Parent directory for the sandbox root (defaults to the OS temp dir). */
  base?: string;
}

export function createOfflineSandbox(options: OfflineSandboxOptions = {}): OfflineSandbox {
  const base = options.base ?? tmpdir();
  mkdirSync(base, { recursive: true });
  // Real path, so spawn-log identities (realpath of argv[1]) compare directly.
  const root = realpathSync(mkdtempSync(join(base, "ubume-offline-")));
  try {
    const binDir = join(root, "bin");
    const path = createProviderFreePath(binDir);
    const spawnLogPath = join(root, "spawns.jsonl");
    writeFileSync(spawnLogPath, "");
    const fakesDir = join(root, "fake-providers");
    mkdirSync(fakesDir);
    const fakes: Partial<Record<FakeProvider, string>> = {};
    for (const [provider, body] of Object.entries(options.fakes ?? {}) as [
      FakeProvider,
      string | true,
    ][]) {
      const executable = join(fakesDir, provider);
      writeFileSync(
        executable,
        SPAWN_LOG_HEADER(provider, spawnLogPath) + (body === true ? DEFAULT_FAKE_BODY : body),
        { mode: 0o700 },
      );
      fakes[provider] = realpathSync(executable);
    }
    mkdirSync(join(root, "data"));
    const env = createTestEnvironment(root, {
      PATH: path,
      HTTP_PROXY: REFUSING_PROXY,
      HTTPS_PROXY: REFUSING_PROXY,
      http_proxy: REFUSING_PROXY,
      https_proxy: REFUSING_PROXY,
      ALL_PROXY: REFUSING_PROXY,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      ...(fakes.codex ? { CODEX_EXECUTABLE: fakes.codex } : {}),
      ...(fakes.claude ? { CLAUDE_EXECUTABLE: fakes.claude } : {}),
      ...(fakes.agy ? { AGY_EXECUTABLE: fakes.agy } : {}),
      ...(fakes.vibe ? { VIBE_EXECUTABLE: fakes.vibe } : {}),
      ...options.env,
    });
    assertProviderFreePath(env.PATH ?? "");
    const readSpawnLog = (): SpawnRecord[] =>
      readFileSync(spawnLogPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SpawnRecord);
    return {
      root,
      binDir,
      path,
      env,
      fakes,
      spawnLogPath,
      readSpawnLog,
      assertSpawnedOnly(executables) {
        const allowed = new Set(executables.map((executable) => realpathSync(executable)));
        for (const record of readSpawnLog()) {
          if (!allowed.has(record.executable)) {
            throw new Error(`Unexpected provider executable spawned: ${record.executable}`);
          }
        }
      },
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Whether `path` (resolved through symlinks when it exists) lies inside the sandbox root. */
export function isInsideSandbox(sandbox: Pick<OfflineSandbox, "root">, path: string): boolean {
  const real = existsSync(path) ? realpathSync(path) : path;
  return real.startsWith(`${sandbox.root}/`);
}
