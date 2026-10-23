/** Real App and native adapters, driven only by explicitly configured test executables. */
import { saveProviderWorkspaceConfig } from "../../../src/core/providerLauncher/workspaceConfig.js";
import { runClaudeCodeWithRunner } from "../../../src/core/providerRuntime/anthropic.js";
import { runMistralVibe } from "../../../src/core/providerRuntime/mistralVibe.js";
import type { ProviderChatRequest } from "../../../src/core/providerRuntime/types.js";
import type { BackendProvider } from "../../../src/core/providers/types.js";
import { startApp } from "../../../src/index.js";

const executable = process.env.PERMISSION_EXECUTABLE;
if (!executable) throw new Error("PERMISSION_EXECUTABLE is required");
const vibe = process.env.PERMISSION_PROVIDER === "vibe";
const route = vibe ? { providerId: "mistral", modelId: "Vibe default", backendKind: "mistral-vibe-cli-auth" } as const
  : { providerId: "anthropic", modelId: "haiku", backendKind: "claude-code-auth" } as const;
saveProviderWorkspaceConfig(process.cwd(), { activeRoute: route });
const provider: BackendProvider = {
  id: "codex-subprocess", label: "Permission test", description: "Native protocol fixture", authState: "delegated",
  authLabel: "offline", statusMessage: "offline", supportsModels: () => true,
  run(prompt, options, handlers) {
    const request: ProviderChatRequest = { prompt, workspaceRoot: options.workspaceRoot, runtime: options.runtime, route, approvalSurface: "interactive" };
    return vibe ? runMistralVibe(request, handlers, { resolveExecutable: async () => executable, findSessionImpl: async () => null })
      : runClaudeCodeWithRunner(request, handlers, undefined, executable);
  },
};
startApp({ providerOverride: provider });
