/** Separate Ubume adapter process used by the credential-free concurrency regression. */

import { runCommand } from "../../core/process/commandRunner.js";
import { runClaudeCodeWithRunner } from "../../core/providerRuntime/anthropic.js";
import {
  parseAgyModelsOutput,
  runAntigravityWithRunner,
} from "../../core/providerRuntime/antigravity.js";
import { runMistralVibe } from "../../core/providerRuntime/mistralVibe.js";
import type { ProviderChatRequest } from "../../core/providerRuntime/types.js";
import { codexSubprocessProvider } from "../../core/providers/codexSubprocess.js";
import type { BackendRunHandlers } from "../../core/providers/types.js";
import { acquireOwnership } from "../../core/workspace/ownership.js";
import { createTestRuntime } from "../runtimeTestUtils.js";

const [provider, executable, workspace, mode = "stress"] = process.argv.slice(2);
if (!provider || !executable || !workspace) throw new Error("Missing fixture arguments");
const runtime = createTestRuntime({ codexCommandPath: executable });
const request: ProviderChatRequest = {
  prompt: `${mode}:${provider}`,
  workspaceRoot: workspace,
  runtime,
  route: {
    providerId:
      provider === "codex" || provider === "openai"
        ? "openai"
        : provider === "google"
          ? "google"
          : provider === "mistral"
            ? "mistral"
            : "anthropic",
    modelId:
      provider === "anthropic" ? "haiku" : provider === "mistral" ? "Vibe default" : "fixture",
    backendKind: provider === "google" ? "antigravity-cli-auth" : "claude-code-auth",
  },
  ...(mode === "timeout" ? { providerConfig: { executionTimeoutMs: 200 } } : {}),
};
const lease = acquireOwnership(workspace, "execution");
let stopped = Promise.resolve();
let cancel: (() => void) | undefined;
const deltas: string[] = [];
const tools: { id: string; status: string }[] = [];
let settle: (value: { response?: string; error?: string; canceled?: boolean }) => void = () => {};
const done = new Promise<{ response?: string; error?: string; canceled?: boolean }>((resolve) => {
  settle = resolve;
});
const handlers: BackendRunHandlers = {
  onRunControl: (control) => {
    stopped = control.stopped;
  },
  onResponse: (response) => settle({ response }),
  onError: (error, detail) => settle({ error: detail ? `${error}\n${detail}` : error }),
  onAssistantDelta: (text) => deltas.push(text),
  onToolActivity: (tool) => {
    tools.push({ id: tool.id, status: tool.status });
    if (mode === "cancel" && tool.status === "completed") {
      cancel?.();
      settle({ canceled: true });
    }
  },
};
try {
  if (provider === "openai" || provider === "codex")
    cancel = codexSubprocessProvider.run!(
      request.prompt,
      { runtime, workspaceRoot: workspace, promptPolicy: "raw" },
      handlers,
    );
  else if (provider === "google")
    cancel = runAntigravityWithRunner(
      request,
      handlers,
      runCommand,
      executable,
      process.platform,
      parseAgyModelsOutput("fixture  Fixture"),
    );
  else if (provider === "mistral")
    cancel = runMistralVibe(request, handlers, {
      resolveExecutable: async () => executable,
      findSessionImpl: async () => null,
    });
  else cancel = runClaudeCodeWithRunner(request, handlers, runCommand, executable);
  const outcome = await done;
  await stopped;
  console.log(JSON.stringify({ provider, workspace, ...outcome, deltas: deltas.join(""), tools }));
} finally {
  cancel?.();
  await stopped;
  lease.release();
}
