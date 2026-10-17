import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { render, Text } from "ink";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import type { UsageTarget } from "../../core/usage/registry.js";
import type { ProviderUsageSnapshot, UsageAdapter } from "../../core/usage/types.js";
import { createUsageService } from "../../core/usage/usageService.js";
import type { Screen } from "../../session/types.js";
import { useProviderUsage } from "./useProviderUsage.js";

class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 100;
  rows = 20;
}

const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function heldAdapter(id: string) {
  const pending: Array<() => void> = [];
  const adapter: UsageAdapter = {
    id,
    fetch: (context) =>
      new Promise<ProviderUsageSnapshot>((resolve) => {
        pending.push(() =>
          resolve({
            providerId: context.route.providerId,
            providerLabel: id,
            scopeKey: context.scopeKey,
            billingMode: "subscription",
            status: "available",
            retrievedAt: 1,
            freshness: "live",
            source: id,
            limits: [],
            facts: [],
          }),
        );
      }),
  };
  return {
    adapter,
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

const ROUTES: Record<string, ProviderRoute> = {
  codex: { providerId: "openai", modelId: "m", backendKind: "codex-cli-auth" },
  claude: { providerId: "anthropic", modelId: "m", backendKind: "claude-code-auth" },
};

function setup() {
  const adapters = { codex: heldAdapter("codex"), claude: heldAdapter("claude") };
  const resolveTarget = (route: ProviderRoute): UsageTarget => {
    const key = route.providerId === "openai" ? "codex" : "claude";
    return { adapter: adapters[key].adapter, route, scopeKey: key };
  };
  const service = createUsageService({ now: () => 0, cooldownMs: 0 });
  const screens: Screen[] = [];
  let api: ReturnType<typeof useProviderUsage> | null = null;
  function Probe({ route }: { route: ProviderRoute }) {
    api = useProviderUsage({
      activeProviderRoute: route,
      providerWorkspaceConfig: {},
      workspaceRoot: "/tmp",
      activeContextMetadata: null,
      setScreen: (value) => {
        screens.push(typeof value === "function" ? value("main") : value);
      },
      service,
      resolveTarget,
    });
    return <Text>{api.usageView.snapshot?.providerLabel ?? "none"}</Text>;
  }
  const stdout = new TestOutput();
  const instance = render(<Probe route={ROUTES.codex!} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    adapters,
    service,
    screens,
    instance,
    rerender: (route: ProviderRoute) => instance.rerender(<Probe route={route} />),
    api: () => api!,
  };
}

test("opening /usage switches to the panel and starts one retrieval", async () => {
  const t = setup();
  try {
    t.api().openUsagePanel();
    await sleep();
    assert.deepEqual(t.screens, ["usage-panel"]);
    assert.equal(t.api().usageView.inFlight, true);
    t.adapters.codex.release();
    await sleep();
    assert.equal(t.api().usageView.snapshot?.providerLabel, "codex");
    assert.equal(t.api().usageView.origin, "live");
  } finally {
    t.instance.unmount();
  }
});

test("a result for the previous provider never replaces the new provider's view", async () => {
  const t = setup();
  try {
    t.api().openUsagePanel();
    await sleep();
    t.rerender(ROUTES.claude!);
    await sleep();
    t.adapters.codex.release();
    await sleep();
    assert.equal(t.api().usageView.scopeKey, "claude");
    assert.equal(t.api().usageView.snapshot, null);
    // The finished Codex result is still cached for when Codex is selected again.
    assert.equal(t.service.peek("codex").snapshot?.providerLabel, "codex");
    t.rerender(ROUTES.codex!);
    await sleep();
    assert.equal(t.api().usageView.snapshot?.providerLabel, "codex");
    assert.equal(t.api().usageView.origin, "cached");
  } finally {
    t.instance.unmount();
  }
});

test("unmounting during a retrieval is safe and the result is still cached", async () => {
  const t = setup();
  t.api().openUsagePanel();
  await sleep();
  t.instance.unmount();
  t.adapters.codex.release();
  await sleep();
  assert.equal(t.service.peek("codex").snapshot?.providerLabel, "codex");
});
