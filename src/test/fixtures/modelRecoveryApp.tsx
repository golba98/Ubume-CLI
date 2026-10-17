/**
 * Child-process App recovery scenarios. The parent supplies isolated homes/data and fake CLI
 * paths; runtime registry replacements live only for this process. Network calls fail closed.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { App } from "../../app/App.js";
import { parseLaunchArgs } from "../../config/launchArgs.js";
import { loadSettings, saveSettings } from "../../config/persistence.js";
import {
  loadProviderWorkspaceConfig,
  saveProviderWorkspaceConfig,
} from "../../core/providerLauncher/workspaceConfig.js";
import { getProviderRuntime } from "../../core/providerRuntime/registry.js";
import type { ProviderModelDiscoveryResult } from "../../core/providerRuntime/types.js";
import { waitFor } from "../async.js";
import { createTestTerminal } from "../terminal.js";

// Exercise the real App and routing boundary. Every provider operation is local and mocked.
globalThis.fetch = () => {
  throw new Error("Network access is forbidden in model recovery tests");
};
const scenario = process.argv[2];
const scenarios = [
  "recover",
  "switch-provider",
  "fail-only",
  "restart-recover",
  "cli-override",
  "authentication",
  "rate",
  "retry-delay",
  "quota",
  "network",
  "temporary",
  "all-unavailable",
  "catalog-failure",
  "error-while-picker",
];
assert(scenario && scenarios.includes(scenario), `Unknown model recovery scenario: ${scenario}`);
const settings = loadSettings();
saveSettings({
  ...settings,
  updateCheck: { ...settings.updateCheck!, enabled: false },
});
const transientFailure: string | undefined = (
  {
    authentication: "Authentication expired; sign in",
    rate: "Rate limit exceeded (HTTP 429)",
    "retry-delay": "Rate limit exceeded (HTTP 429)",
    quota: "Quota exhausted",
    network: "Network error ECONNRESET",
    temporary: "Temporary service outage (HTTP 503)",
  } as Record<string, string>
)[scenario];
const emptyCatalog = scenario === "all-unavailable" || scenario === "catalog-failure";
const calls: string[] = [];
for (const providerId of ["google", "anthropic", "openai", "mistral", "local"] as const) {
  const native = getProviderRuntime(providerId);
  const ids =
    providerId === "google" ? ["gemini-withdrawn", "gemini-working"] : [`${providerId}-working`];
  const snapshot: ProviderModelDiscoveryResult = {
    providerId,
    backendKind: native.backendKind,
    status: "ready",
    freshness: "verified",
    complete: true,
    models: (providerId === "google" && scenario === "catalog-failure" ? [] : ids).map((id) => ({
      id,
      modelId: id,
      label: id,
      description: null,
      ...(providerId === "google" && scenario === "all-unavailable" ? { available: false } : {}),
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
      source: "discovered",
    })),
  };
  native.isRouteConfigured = () => true;
  native.discoverModels = () => snapshot;
  native.refreshModels = async () =>
    providerId === "google" && scenario === "catalog-failure"
      ? {
          ...snapshot,
          status: "not-configured",
          freshness: "unverified",
          refreshState: "failed",
          message: "Model catalog service failed. Change provider or refresh.",
        }
      : snapshot;
  native.validateRoute = async () => ({
    status: "ready",
    providerId,
    backendKind: native.backendKind,
  });
  native.run = (request, handlers) => {
    calls.push(`${providerId}:${request.route.modelId}`);
    handlers.onRunControl?.({ stopped: Promise.resolve() });
    const complete = () => {
      if (request.route.modelId === "gemini-withdrawn")
        handlers.onError(
          transientFailure ??
            "MODEL_NOT_FOUND: model gemini-withdrawn is unavailable for this account.",
          undefined,
          scenario === "retry-delay"
            ? {
                kind: "rate-limit",
                message: "Rate limit exceeded",
                retryable: true,
                retryAfterMs: 5000,
              }
            : undefined,
        );
      else handlers.onResponse(`MOCK_SUCCESS:${providerId}:${request.route.modelId}`);
    };
    if (scenario === "error-while-picker") setTimeout(complete, 300);
    else queueMicrotask(complete);
    return () => {};
  };
}

const configured = loadProviderWorkspaceConfig(process.cwd());
if (!configured.activeRoute)
  saveProviderWorkspaceConfig(process.cwd(), {
    activeRoute: {
      providerId: "google",
      modelId: "gemini-withdrawn",
      backendKind: "antigravity-cli-auth",
    },
    providers: {
      google: { backendKind: "antigravity-cli-auth", currentModel: "gemini-withdrawn" },
      anthropic: { currentModel: "anthropic-working" },
    },
  });
const parsed = parseLaunchArgs(scenario === "cli-override" ? ["--model", "gemini-withdrawn"] : []);
assert(parsed.ok);
const terminal = createTestTerminal(<App launchArgs={parsed.value} />, { columns: 120, rows: 35 });
const { stdin, stdout } = terminal;
const recording: string[] = [];
// Input pacing preserves Ink's key parsing; readiness is checked separately through frames.
const pause = (ms = 70) => new Promise((resolve) => setTimeout(resolve, ms));
function until(check: () => boolean, label: string) {
  return waitFor(check, {
    label,
    timeoutMs: 8000,
    diagnostics: () => `${terminal.lastFrame()}\nCalls: ${JSON.stringify(calls)}`,
  });
}
async function command(text: string) {
  stdin.write("\x15");
  await pause(20);
  stdin.write(text);
  await pause();
  stdin.write("\r");
  await pause();
}
async function chooseWorkingModel() {
  await until(
    () =>
      terminal.lastFrame().includes("Select model") &&
      terminal.lastFrame().includes("gemini-working"),
    "Google recovery picker",
  );
  recording.push(terminal.lastFrame());
  stdin.write("\x1b[F");
  await pause();
  stdin.write("\r");
  await pause();
  await until(
    () =>
      !(
        terminal.lastFrame().includes("Select model") &&
        terminal.lastFrame().includes("gemini-working")
      ) && terminal.lastFrame().includes("gemini-working"),
    "working model activated",
  );
  await command("say hello");
  await until(
    () => terminal.output().includes("MOCK_SUCCESS:google:gemini-working"),
    "working Google request",
  );
  recording.push(terminal.lastFrame());
}
async function runRecoveryScenario(): Promise<void> {
  await until(() => terminal.lastFrame().includes("gemini-withdrawn"), "initial App frame");
  if (emptyCatalog) {
    await command("/model");
    await until(
      () =>
        terminal.lastFrame().includes("Select model") &&
        /No models|No Google models|catalog service failed|Unavailable/.test(terminal.lastFrame()),
      "empty or failed catalog stays usable",
    );
    stdin.write("\x1b");
    await pause();
    await command("/providers");
    stdin.write("\x1b[H");
    await pause();
    stdin.write("\x1b[B");
    await pause();
    stdin.write("\r");
    await pause();
    await command("say hello");
    await until(
      () => terminal.output().includes("MOCK_SUCCESS:anthropic:anthropic-working"),
      "provider navigation after catalog failure",
    );
  } else {
    if (scenario !== "restart-recover") {
      await command("say hello");
      if (scenario === "error-while-picker") await command("/model");
      await until(
        () =>
          terminal
            .output()
            .includes(transientFailure ?? "unavailable or unsupported for this account"),
        "recoverable API error",
      );
      recording.push(terminal.lastFrame());
      assert.deepEqual(calls, ["google:gemini-withdrawn"]);
      assert.equal(
        loadProviderWorkspaceConfig(process.cwd()).providers?.google?.currentModel,
        "gemini-withdrawn",
      );
    }
    if (transientFailure) {
      await command("say hello again");
      if (scenario === "retry-delay") {
        await until(() => terminal.output().includes("Retry later"), "retry delay respected");
        assert.equal(calls.length, 1);
      } else await until(() => calls.length === 2, "transient failure permits manual retry");
      await pause();
    }
    if (scenario !== "fail-only") {
      if (scenario === "switch-provider") {
        await command("/providers");
        stdin.write("\x1b[H");
        await pause();
        stdin.write("\x1b[B");
        await pause();
        stdin.write("\r");
        await pause();
        await command("say hello");
        await until(
          () => terminal.output().includes("MOCK_SUCCESS:anthropic:anthropic-working"),
          "other provider works",
        );
        await command("/providers");
        stdin.write("\x1b[H");
        await pause();
        stdin.write("\x1b[B");
        await pause();
        stdin.write("\x1b[B");
        await pause();
        stdin.write("\r");
        await pause();
        // Returning to a rejected preference opens its catalog without retrying it.
        assert.equal(calls.filter((call) => call === "google:gemini-withdrawn").length, 1);
      } else if (scenario !== "error-while-picker") await command("/model");
      await chooseWorkingModel();
      assert.equal(
        loadProviderWorkspaceConfig(process.cwd()).activeRoute?.modelId,
        "gemini-working",
      );
      assert.equal(
        loadProviderWorkspaceConfig(process.cwd()).providers?.anthropic?.currentModel,
        "anthropic-working",
      );
    }
  }
}

function saveRecording(): void {
  if (process.env.UBUME_TEST_CAPTURE)
    writeFileSync(
      process.env.UBUME_TEST_CAPTURE,
      [
        JSON.stringify({
          version: 2,
          width: stdout.columns,
          height: stdout.rows,
          title: "Ubume model error recovery (mock providers)",
          env: { TERM: "xterm-256color" },
        }),
        ...recording.map((text, index) => JSON.stringify([index * 2, "o", `\x1b[2J\x1b[H${text}`])),
      ].join("\n") + "\n",
    );
}
try {
  await runRecoveryScenario();
  saveRecording();
} finally {
  await terminal.dispose();
}
console.log(JSON.stringify({ scenario, calls }));
process.exit(0);
