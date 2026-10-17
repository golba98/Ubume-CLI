import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { App } from "../../app/App.js";
import { parseLaunchArgs } from "../../config/launchArgs.js";
import { loadSettings, saveSettings } from "../../config/persistence.js";
import {
  loadProviderWorkspaceConfig,
  saveProviderWorkspaceConfig,
} from "../../core/providerLauncher/workspaceConfig.js";
import { getProviderRuntime } from "../../core/providerRuntime/registry.js";
import type { ProviderModelDiscoveryResult } from "../../core/providerRuntime/types.js";

// Exercise the real App and routing boundary. Every provider operation is local and mocked.
globalThis.fetch = () => {
  throw new Error("Network access is forbidden in model recovery tests");
};
saveSettings({
  ...loadSettings(),
  updateCheck: { ...loadSettings().updateCheck!, enabled: false },
});
const scenario = process.argv[2];
const transientFailure: string | undefined = (
  {
    authentication: "Authentication expired; sign in",
    rate: "Rate limit exceeded (HTTP 429)",
    "retry-delay": "Rate limit exceeded (HTTP 429)",
    quota: "Quota exhausted",
    network: "Network error ECONNRESET",
    temporary: "Temporary service outage (HTTP 503)",
  } as Record<string, string>
)[scenario!];
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
class Input extends PassThrough {
  isTTY = true;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
class Output extends PassThrough {
  isTTY = true;
  columns = 120;
  rows = 35;
}
const stdin = new Input();
const stdout = new Output();
let frame = "";
let output = "";
const recording: string[] = [];
stdout.on("data", (chunk) => {
  frame = chunk.toString();
  output += frame;
});
const terminal = render(<App launchArgs={parsed.value} />, {
  stdin: stdin as never,
  stdout: stdout as never,
  stderr: stdout as never,
  debug: true,
  patchConsole: false,
  exitOnCtrlC: false,
});
const pause = (ms = 70) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${label}\n${frame}\nCalls: ${JSON.stringify(calls)}`);
    await pause(25);
  }
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
    () => frame.includes("Select model") && frame.includes("gemini-working"),
    "Google recovery picker",
  );
  recording.push(frame);
  stdin.write("\x1b[F");
  await pause();
  stdin.write("\r");
  await pause();
  await until(
    () =>
      !(frame.includes("Select model") && frame.includes("gemini-working")) &&
      frame.includes("gemini-working"),
    "working model activated",
  );
  await command("say hello");
  await until(
    () => output.includes("MOCK_SUCCESS:google:gemini-working"),
    "working Google request",
  );
  recording.push(frame);
}
try {
  await pause(350);
  if (emptyCatalog) {
    await command("/model");
    await until(
      () =>
        frame.includes("Select model") &&
        /No models|No Google models|catalog service failed|Unavailable/.test(frame),
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
      () => output.includes("MOCK_SUCCESS:anthropic:anthropic-working"),
      "provider navigation after catalog failure",
    );
  } else {
    if (scenario !== "restart-recover") {
      await command("say hello");
      if (scenario === "error-while-picker") await command("/model");
      await until(
        () => output.includes(transientFailure ?? "unavailable or unsupported for this account"),
        "recoverable API error",
      );
      recording.push(frame);
      assert.deepEqual(calls, ["google:gemini-withdrawn"]);
      assert.equal(
        loadProviderWorkspaceConfig(process.cwd()).providers?.google?.currentModel,
        "gemini-withdrawn",
      );
    }
    if (transientFailure) {
      await command("say hello again");
      if (scenario === "retry-delay") {
        await until(() => output.includes("Retry later"), "retry delay respected");
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
          () => output.includes("MOCK_SUCCESS:anthropic:anthropic-working"),
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
  terminal.cleanup();
} catch (error) {
  terminal.cleanup();
  throw error;
}
console.log(JSON.stringify({ scenario, calls }));
process.exit(0);
