import { runCommand } from "../../../src/core/process/commandRunner.js";
import { runClaudeCodeWithRunner } from "../../../src/core/providerRuntime/anthropic.js";
import { runAntigravityWithRunner, parseAgyModelsOutput } from "../../../src/core/providerRuntime/antigravity.js";
import { runMistralVibe } from "../../../src/core/providerRuntime/mistralVibe.js";
import type { ProviderChatRequest } from "../../../src/core/providerRuntime/types.js";
import { saveProviderWorkspaceConfig } from "../../../src/core/providerLauncher/workspaceConfig.js";
/** Real startApp/Ink path driven by a sandboxed executable, including approval round trips. */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { BackendProvider } from "../../../src/core/providers/types.js";
import { flushResizeTrace, traceResize } from "../../../src/core/perf/resizeTrace.js";
import { startApp } from "../../../src/index.js";

const native = process.env.RESIZE_NATIVE_PROVIDER;
const route = native === "anthropic" ? {providerId:"anthropic", modelId:"haiku", backendKind:"claude-code-auth"} as const : native === "google" ? {providerId:"google",modelId:"fixture",backendKind:"antigravity-cli-auth"} as const : {providerId:"mistral",modelId:"Vibe default",backendKind:"mistral-vibe-cli-auth"} as const;
if (native) saveProviderWorkspaceConfig(process.cwd(), { activeRoute: route });
const provider: BackendProvider = {
  id: "codex-subprocess", label: "Resize fixture", description: "offline executable", authState: "delegated", authLabel: "offline", statusMessage: "offline", supportsModels: () => true,
  run(_prompt, options, handlers) {
    if (native) {
      const request: ProviderChatRequest = { prompt: _prompt, workspaceRoot: options.workspaceRoot, runtime: options.runtime, route };
      if (native === "anthropic") return runClaudeCodeWithRunner(request, handlers, runCommand, process.env.RESIZE_EXECUTABLE!);
      if (native === "google") return runAntigravityWithRunner(request, handlers, runCommand, process.env.RESIZE_EXECUTABLE!, process.platform, parseAgyModelsOutput("fixture  Fixture"));
      return runMistralVibe(request, handlers, {resolveExecutable: async () => process.env.RESIZE_EXECUTABLE!,findSessionImpl: async () => null});
    }
    const child = spawn(process.env.RESIZE_EXECUTABLE!, [], { cwd: options.workspaceRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let resolveStopped = () => {};
    const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
    handlers.onRunControl?.({ stopped });
    let canceled = false, final = "";
    const input = createInterface({ input: child.stdout });
    input.on("line", line => {
      const event = JSON.parse(line);
      traceResize("providerEvent", { seq: event.seq, kind: event.kind });
      if (event.kind === "text") { final += event.text; handlers.onAssistantDelta?.(event.text); }
      else if (event.kind === "tool") handlers.onToolActivity?.(event.tool);
      else if (event.kind === "approval") {
        void handlers.onToolApproval?.({ tool: "shell", signature: "resize-approval", command: "fixture safe operation", paths: [], description: "RESIZE_APPROVAL", workspace: options.workspaceRoot, kind: "command" }).then(decision => {
          child.stdin.write(`${decision}\n`);
          if (process.env.RESIZE_DECISIONS) appendFileSync(process.env.RESIZE_DECISIONS, `${decision}\n`);
        });
      }
    });
    child.stderr.on("data", () => {});
    child.once("error", error => handlers.onError(String(error)));
    child.once("close", code => {
      input.close(); resolveStopped();
      if (canceled) return;
      if (code) handlers.onError(`Fixture exited ${code}`);
      else { handlers.onResponse(final); traceResize("providerComplete"); flushResizeTrace(); }
    });
    return () => { canceled = true; child.kill("SIGTERM"); };
  },
};
startApp({ providerOverride: provider });
