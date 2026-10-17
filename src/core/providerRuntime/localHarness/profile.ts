/**
 * Writes the Ubume-owned Harness profile and resolves lazy session scratch hints. Profiles
 * disable unsupported hosted services and telemetry; scratch folders are created only when a
 * tool actually targets them.
 */

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { traceLocalStream } from "../../perf/debugLog.js";
import { errorMessage } from "../../shared/values.js";
import {
  resolveLegacyCodexaDataDir,
  resolveUbumeChatWorkspaceDir,
  resolveUbumeWorkspaceDataDir,
  workspaceStorageKey,
} from "../../workspace/appData.js";
import { describeSessionScratchDir, pruneStaleScratchDirs } from "../../workspace/scratchDir.js";
import type { ProviderChatRequest } from "../types.js";
import {
  HARNESS_VERSION,
  type HarnessConfig,
  INTERNAL_PROVIDER,
  LOCAL_STREAM_IDLE_TIMEOUT_MS,
  PROFILE_NAME,
  resolveHarnessSandboxMode,
} from "./config.js";

/** Quotes a string as a YAML single-quoted scalar, escaping embedded quotes. */
export function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Returns a lazy scratch hint for writable sessions and prunes old folders on fresh sessions;
 * failures are diagnostic-only.
 */
export function prepareSessionScratch(
  request: ProviderChatRequest,
  sessionId: string,
  resumed: boolean,
): string | null {
  if (resolveHarnessSandboxMode(request) === "read-only") return null;
  try {
    // Only name the folder here; the tool/policy bridge creates it once a tool targets it.
    const scratch = describeSessionScratchDir(request.workspaceRoot, sessionId);
    if (!resumed) pruneStaleScratchDirs(request.workspaceRoot, { keep: sessionId });
    return `Scratch directory for this session: ${scratch.relativePath}/ (put every temporary test, debug, or probe file there, not in the project).`;
  } catch (error) {
    traceLocalStream("harness.scratch.unavailable", {
      sessionId,
      error: errorMessage(error),
    });
    return null;
  }
}

/** Resolves the packaged tool-policy bridge relative to this module. */
export function bridgePath(): string {
  return fileURLToPath(new URL("../../../../bin/ubume-local-harness-bridge.js", import.meta.url));
}

/**
 * Builds the Harness profile patch for native tool/browser support and explicitly enabled
 * reasoning.
 */
export function profilePatch(supportsVision: boolean, reasoningEffortEnabled = false): string {
  const input = supportsVision ? "[text, image]" : "[text]";
  // pi-ai only accepts a reasoning effort for models that declare their
  // levels, so both the declaration and the provider default are emitted only
  // when the model opted in (supports_reasoning_effort in providers.json).
  const providerReasoning = reasoningEffortEnabled
    ? "\n        reasoning: !!js process.env.UBUME_DSH_REASONING_EFFORT"
    : "";
  const modelReasoning = reasoningEffortEnabled
    ? `
            reasoningEfforts:
              low: low
              medium: medium
              high: high
            compat:
              thinkingFormat: openai`
    : "";
  // Hosted DeepSeek search requires a hosted API key. The upstream base profile
  // enables HTTP fetch, which needs the disabled web service, so it is disabled
  // too. Interactive browser tools use a separate local adapter.
  return `- id: hmr
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: llm-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: web
  disabled: true
- id: web-search-deepseek
  disabled: true
- id: web-fetch-http
  disabled: true
- id: tool-web
  disabled: true
- id: agent-default-model
  config:
    provider: ${INTERNAL_PROVIDER}
    model: !!js process.env.UBUME_DSH_MODEL
- id: llm-pi-ai
  config:
    providers:
      ${INTERNAL_PROVIDER}:
        displayName: Ubume Local
        apiKeyEnv: UBUME_DSH_API_KEY
        api: openai-completions
        baseURL: !!js process.env.UBUME_DSH_BASE_URL
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        defaultContextWindow: !!js Number(process.env.UBUME_DSH_CONTEXT_WINDOW)
        defaultMaxTokens: !!js Number(process.env.UBUME_DSH_MAX_TOKENS)
        defaultInput: ${input}${providerReasoning}
        streamIdleTimeoutMs: ${LOCAL_STREAM_IDLE_TIMEOUT_MS}
        retryPolicy:
          mode: normal
          retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TRANSPORT]
        models:
          - id: !!js process.env.UBUME_DSH_MODEL
            name: !!js process.env.UBUME_DSH_MODEL
            contextWindow: !!js Number(process.env.UBUME_DSH_CONTEXT_WINDOW)
            maxTokens: !!js Number(process.env.UBUME_DSH_MAX_TOKENS)
            input: ${input}${modelReasoning}
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: !!js process.env.UBUME_DSH_APPROVAL_POLICY
- id: permission
  config:
    defaultPreset: !!js process.env.UBUME_DSH_PERMISSION_PRESET
    presets:
      read-only:
        sandbox: read-only
        approval: ask
        name: Read only
        description: Read-only access controlled by Ubume.
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: Workspace write
        description: Workspace writes controlled by Ubume.
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: Full access
        description: Full filesystem access controlled by Ubume.
- id: tools
  config:
    mode: native
- id: system-prompt
  config:
    persona: >-
      You are a coding agent running inside Ubume. Work only in the active workspace,
      use the provided Harness tools for shell and file operations, and respect every
      Ubume permission decision. Put throwaway files you create only to test, debug,
      or inspect your work (harness pages, probe scripts, logs, dumps, browser profiles)
      in the session scratch directory under .ubume/scratch/ that Ubume names, never
      in the project root or source tree. Only deliverables the user asked for belong
      in the project.
- insert:
    - id: ubume-local-harness-bridge
      name: ${yamlString(bridgePath())}
`;
}

/**
 * Creates or reuses the Ubume-owned profile home and writes its configuration; does not modify
 * the user's provider CLI settings.
 */
export function ensureProfile(workspaceRoot: string, config: HarnessConfig): string {
  const home = join(
    resolveUbumeChatWorkspaceDir(workspaceRoot),
    "local-harness",
    `v-${HARNESS_VERSION}`,
  );
  const legacy = [
    resolveUbumeWorkspaceDataDir(workspaceRoot, { readOnly: true }),
    join(resolveLegacyCodexaDataDir(), "workspaces", workspaceStorageKey(workspaceRoot)),
  ]
    .map((root) => join(root, "local-harness", `v-${HARNESS_VERSION}`))
    .find(existsSync);
  if (!existsSync(home) && legacy) {
    const temporary = `${home}.migration-${randomUUID()}`;
    mkdirSync(dirname(home), { recursive: true, mode: 0o700 });
    try {
      cpSync(legacy, temporary, { recursive: true, errorOnExist: true, force: false });
      renameSync(temporary, home);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const profileDir = join(home, "profiles", PROFILE_NAME);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(profileDir, "cordis.patch.yml"),
    profilePatch(config.supportsVision, config.reasoningEffort !== null),
    "utf8",
  );
  return home;
}
