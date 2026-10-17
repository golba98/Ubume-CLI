/**
 * Credential-free environments for process-backed fixtures. The caller owns the
 * temporary root and its cleanup; constructing an environment does not create files.
 */
import { join } from "node:path";

const providerPrefixes =
  /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GOOGLE|GEMINI|AGY|ANTIGRAVITY|MISTRAL|VIBE|UNSLOTH|LM_STUDIO|LMSTUDIO|AZURE_OPENAI|AWS|BEDROCK)_/i;
const sensitiveSetting =
  /(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIALS?|BASE_URL|ENDPOINT|EXECUTABLE)$/i;

/**
 * Copies execution settings while isolating homes, configuration, and application data.
 * Provider discovery defaults to missing executables so a fixture cannot fall back to
 * an installed CLI. Explicit overrides are applied last, including fixture credentials.
 */
export function createTestEnvironment(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (
      /^(?:UBUME|CODEXA)_/i.test(name) ||
      providerPrefixes.test(name) ||
      sensitiveSetting.test(name) ||
      /^(?:NODE_OPTIONS|NODE_COMPILE_CACHE|BUN_OPTIONS|(?:HTTP|HTTPS|ALL)_PROXY)$/i.test(name)
    )
      continue;
    env[name] = value;
  }
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "share"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    GEMINI_CLI_HOME: join(root, "gemini"),
    VIBE_HOME: join(root, "vibe"),
    UBUME_DATA_DIR: join(root, "data"),
    CODEXA_DATA_DIR: join(root, "legacy"),
    UBUME_DEV_MODE: "0",
    UBUME_EXEC_TIMING: "0",
    // Read-only command assertions include the fixture root; compiler caches are
    // runner artifacts rather than application writes and must stay in memory.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  });
  for (const provider of ["CODEX", "CLAUDE", "AGY", "GEMINI", "VIBE"]) {
    env[`${provider}_EXECUTABLE`] = join(root, `missing-${provider.toLowerCase()}`);
  }
  return Object.assign(env, overrides);
}

/**
 * Temporarily patches process.env, restoring missing and empty values exactly even
 * when the callback rejects. Calls that touch overlapping keys must run serially.
 */
export async function withEnvironment<T>(
  patch: NodeJS.ProcessEnv,
  run: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(patch)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
