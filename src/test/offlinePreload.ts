/**
 * Global test preload (bunfig.toml `[test] preload`): runs before any test module.
 *
 * In-process code under test reads `process.env` directly, so the runner's own
 * environment is made offline-safe here instead of relying on each suite:
 * - PATH is replaced by a provider-free PATH (trusted tools + system dirs), so a bare
 *   `codex`/`claude`/`agy`/`vibe` lookup can never reach an installed CLI;
 * - HOME and provider/config homes point at a temporary root, so no real user
 *   configuration, credential or session store is read or written;
 * - provider secrets, endpoints and executable overrides from the developer shell are
 *   removed (suites that need one set a fixture value explicitly);
 * - `fetch` to anything but loopback fails immediately.
 *
 * Child processes inherit these values unless a test builds its own environment, which
 * `createTestEnvironment`/`createOfflineSandbox` already isolate further.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderFreePath, REFUSING_PROXY } from "./offlineSandbox.js";

const providerPrefixes =
  /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GOOGLE|GEMINI|AGY|ANTIGRAVITY|MISTRAL|VIBE|UNSLOTH|LM_STUDIO|LMSTUDIO|AZURE_OPENAI|AWS|BEDROCK)_/i;
const sensitiveSetting =
  /(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIALS?|BASE_URL|ENDPOINT|EXECUTABLE)$/i;

const root = mkdtempSync(join(tmpdir(), "ubume-test-preload-"));
for (const name of Object.keys(process.env)) {
  // Preserve the existing CI quality gate; isolation must not turn required browser tests into skips.
  if (name === "UBUME_REQUIRE_BROWSER_TESTS") continue;
  if (
    // App settings (UBUME_*) and Codexa model-family settings (CODEXA_NATIVE_*, …).
    /^(?:UBUME|CODEXA)_/i.test(name) ||
    providerPrefixes.test(name) ||
    sensitiveSetting.test(name) ||
    /^(?:NODE_OPTIONS|BUN_OPTIONS|(?:HTTP|HTTPS|ALL)_PROXY)$/i.test(name)
  ) {
    delete process.env[name];
  }
}
Object.assign(process.env, {
  PATH: createProviderFreePath(join(root, "bin")),
  HOME: join(root, "home"),
  USERPROFILE: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "home", ".config"),
  XDG_DATA_HOME: join(root, "home", ".local", "share"),
  XDG_CACHE_HOME: join(root, "home", ".cache"),
  XDG_STATE_HOME: join(root, "home", ".local", "state"),
  APPDATA: join(root, "appdata"),
  LOCALAPPDATA: join(root, "localappdata"),
  CODEX_HOME: join(root, "codex"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  GEMINI_CLI_HOME: join(root, "gemini"),
  VIBE_HOME: join(root, "vibe"),
  HTTP_PROXY: REFUSING_PROXY,
  HTTPS_PROXY: REFUSING_PROXY,
  NO_PROXY: "127.0.0.1,localhost,::1",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True for URLs the offline sandbox lets `fetch` reach. */
export function isOfflineAllowedUrl(input: string | URL | Request): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "file:") return true;
  return LOOPBACK_HOSTS.has(url.hostname);
}

const realFetch = globalThis.fetch;
const guardedFetch = ((input: string | URL | Request, init?: RequestInit) => {
  if (!isOfflineAllowedUrl(input)) {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    return Promise.reject(new TypeError(`offline test sandbox blocked network access to ${host}`));
  }
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = Object.assign(guardedFetch, realFetch);

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
