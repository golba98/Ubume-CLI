import { expect, test } from "bun:test";
import { withEnvironment } from "../../test/environment.js";
import type {
  ProviderModel,
  ProviderModelDiscoveryResult,
  ProviderRuntime,
} from "../providerRuntime/types.js";
import { catalogContextKey, ModelCatalog, providerConnectionKey } from "./modelCatalog.js";

const model = (id: string): ProviderModel => ({
  id,
  modelId: id,
  label: id,
  description: null,
  defaultReasoningLevel: null,
  supportedReasoningLevels: null,
  source: "discovered",
});
const ready = (ids: string[] = ["one"]): ProviderModelDiscoveryResult => ({
  status: "ready",
  providerId: "mistral",
  backendKind: "mistral-vibe-cli-auth",
  models: ids.map(model),
});
const runtime = (
  refresh: NonNullable<ProviderRuntime["refreshModels"]>,
  providerId: ProviderRuntime["providerId"] = "mistral",
): ProviderRuntime => ({
  providerId,
  label: providerId,
  backendKind: "mistral-vibe-cli-auth",
  routeAvailable: true,
  routeStatus: "test",
  launchAvailable: true,
  discoverModels: () => ready(),
  refreshModels: refresh,
});
const context = { cwd: "/tmp/ubume-catalog-fixture" };

test("initial discovery, valid TTL reuse, expiry and forced revalidation", async () => {
  let time = 10;
  let calls = 0;
  const catalog = new ModelCatalog(() => time);
  const provider = runtime(async () => {
    calls++;
    return ready([`model-${calls}`]);
  });
  expect((await catalog.refresh(provider, context)).freshness).toBe("verified");
  await catalog.refresh(provider, context);
  expect(calls).toBe(1);
  time += 300001;
  await catalog.refresh(provider, context);
  expect(calls).toBe(2);
  await catalog.refresh(provider, { ...context, forceRefresh: true });
  expect(calls).toBe(3);
});

test("simultaneous forced requests share one pending discovery", async () => {
  let resolve!: (result: ProviderModelDiscoveryResult) => void;
  let calls = 0;
  const provider = runtime(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const catalog = new ModelCatalog();
  const first = catalog.refresh(provider, context);
  const second = catalog.refresh(provider, { ...context, forceRefresh: true });
  expect(first).toBe(second);
  expect(catalog.get("mistral")?.refreshState).toBe("loading");
  resolve(ready());
  await first;
  expect(calls).toBe(1);
});

for (const state of ["auth-required", "unavailable", "failed"] as const)
  test(`failed ${state} refresh preserves last-good inventory visibly unverified`, async () => {
    let fail = false;
    const catalog = new ModelCatalog();
    const provider = runtime(async () =>
      fail
        ? { ...ready([]), status: "not-configured", refreshState: state, message: "failure" }
        : ready(),
    );
    await catalog.refresh(provider, context);
    fail = true;
    const result = await catalog.refresh(provider, { ...context, forceRefresh: true });
    expect(result.models[0]?.modelId).toBe("one");
    expect(result.freshness).toBe("unverified");
    expect(result.refreshState).toBe(state);
  });

test("successful empty discovery replaces previous inventory and validates removal", async () => {
  let empty = false;
  const catalog = new ModelCatalog();
  const provider = runtime(async () => ready(empty ? [] : ["one", "one", "two"]));
  expect((await catalog.refresh(provider, context)).models.length).toBe(2);
  empty = true;
  expect((await catalog.refresh(provider, { ...context, forceRefresh: true })).refreshState).toBe(
    "empty",
  );
  expect(catalog.get("mistral")?.models).toEqual([]);
});

test("connection changes abort old generation; late responses cannot overwrite new catalog", async () => {
  const resolvers: ((result: ProviderModelDiscoveryResult) => void)[] = [];
  const signals: AbortSignal[] = [];
  const provider = runtime((options) => {
    signals.push(options.signal!);
    return new Promise((done) => resolvers.push(done));
  });
  const catalog = new ModelCatalog();
  const first = catalog.refresh(provider, {
    ...context,
    providerConfig: { baseUrl: "https://old.test/v1" },
  });
  const second = catalog.refresh(provider, {
    ...context,
    providerConfig: { baseUrl: "https://new.test/v1" },
  });
  expect(signals[0]?.aborted).toBe(true);
  resolvers[1]!(ready(["new"]));
  await second;
  resolvers[0]!(ready(["old"]));
  await first;
  expect(catalog.get("mistral")?.models[0]?.modelId).toBe("new");
});

test("provider identities isolate out-of-order inventories", async () => {
  let finish!: (result: ProviderModelDiscoveryResult) => void;
  const catalog = new ModelCatalog();
  const first = catalog.refresh(
    runtime(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    ),
    context,
  );
  await catalog.refresh(
    runtime(async () => ({ ...ready(["claude"]), providerId: "anthropic" }), "anthropic"),
    context,
  );
  finish(ready(["mistral"]));
  await first;
  expect(catalog.get("anthropic")?.models[0]?.modelId).toBe("claude");
  expect(catalog.get("mistral")?.models[0]?.modelId).toBe("mistral");
});

test("bounded timeout keeps cached models and cancels provider", async () => {
  let signal!: AbortSignal;
  const catalog = new ModelCatalog(Date.now, 5);
  const result = await catalog.refresh(
    runtime((options) => {
      signal = options.signal!;
      return new Promise(() => {});
    }),
    context,
  );
  expect(signal.aborted).toBe(true);
  expect(result.freshness).toBe("unverified");
  expect(result.models[0]?.modelId).toBe("one");
});

test("shutdown cancels pending requests without reviving catalog", async () => {
  const catalog = new ModelCatalog();
  const pending = catalog.refresh(
    runtime(() => new Promise(() => {})),
    context,
  );
  catalog.dispose();
  await pending;
  expect(catalog.get("mistral")).toBeUndefined();
});

test("already canceled caller does not hang", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await new ModelCatalog().refresh(
        runtime(() => new Promise(() => {})),
        { ...context, signal: controller.signal },
      )
    ).freshness,
  ).toBe("unverified");
});

test("authentication and endpoint identities change without leaking credentials or tracking selection", () => {
  const base = {
    ...context,
    providerConfig: {
      apiKey: "fixture-secret",
      baseUrl: "https://fixture.test/v1",
      currentModel: "old",
    },
  };
  const key = catalogContextKey("mistral", base);
  expect(key).not.toContain("fixture-secret");
  expect(
    catalogContextKey("mistral", {
      ...base,
      providerConfig: { ...base.providerConfig, currentModel: "new", currentReasoning: "high" },
    }),
  ).toBe(key);
  expect(
    catalogContextKey("mistral", {
      ...base,
      providerConfig: { ...base.providerConfig, apiKey: "rotated" },
    }),
  ).not.toBe(key);
});

test("rate-limit retry window prevents automatic storms, manual refresh still revalidates", async () => {
  let calls = 0;
  const catalog = new ModelCatalog(() => 10);
  const provider = runtime(async () => {
    calls++;
    return { ...ready([]), status: "not-configured", diagnostics: { retryAfterMs: 10000 } };
  });
  await catalog.refresh(provider, context);
  await catalog.refresh(provider, context);
  expect(calls).toBe(1);
  await catalog.refresh(provider, { ...context, forceRefresh: true });
  expect(calls).toBe(2);
});

test("runtime capability rejection updates subscribers without allowing stale request metadata to overwrite refresh", async () => {
  const catalog = new ModelCatalog();
  const provider = runtime(async () => ready(["one"]));
  await catalog.refresh(provider, context);
  const old = catalog.get("mistral")!.models[0]!;
  let notifications = 0;
  const unsubscribe = catalog.subscribe(() => notifications++);
  expect(
    catalog.amendModel(
      "mistral",
      "one",
      (m) => ({ ...m, reasoningControl: { kind: "unsupported" } }),
      old,
    ),
  ).toBe(true);
  expect(catalog.get("mistral")!.models[0]!.reasoningControl).toEqual({ kind: "unsupported" });
  expect(notifications).toBe(1);
  await catalog.refresh(provider, { ...context, forceRefresh: true });
  expect(catalog.amendModel("mistral", "one", (m) => ({ ...m, label: "stale" }), old)).toBe(false);
  expect(catalog.get("mistral")!.models[0]!.label).toBe("one");
  unsubscribe();
});

test("Local connection keys agree whether or not the route names its backend", () => {
  const cwd = "/tmp/ubume-connection-key";
  const savedUnsloth = { providers: { local: { localBackend: "unsloth" as const } } };
  // Evidence recorded for a route that names its backend must be found by a
  // consumer that only knows the saved preference, and vice versa.
  expect(providerConnectionKey("local", { cwd, config: savedUnsloth })).toBe(
    providerConnectionKey("local", { cwd, config: savedUnsloth, routeLocalBackend: "unsloth" }),
  );
  expect(providerConnectionKey("local", { cwd, config: {} })).toBe(
    providerConnectionKey("local", { cwd, config: {}, routeLocalBackend: "lm-studio" }),
  );
  expect(providerConnectionKey("local", { cwd, config: savedUnsloth })).not.toBe(
    providerConnectionKey("local", { cwd, config: savedUnsloth, routeLocalBackend: "lm-studio" }),
  );
});

test("non-Local connection keys ignore Local backend selection", () => {
  const cwd = "/tmp/ubume-connection-key";
  expect(providerConnectionKey("google", { cwd, config: {} })).toBe(
    providerConnectionKey("google", { cwd, config: {}, routeLocalBackend: "unsloth" }),
  );
});

test("forced Claude refresh replaces cached effort restrictions with current model metadata", async () => {
  let ids = ["low", "medium", "high"];
  const snapshot = (): ProviderModelDiscoveryResult => ({
    ...ready([]),
    providerId: "anthropic",
    backendKind: "claude-code-auth",
    models: [
      {
        ...model("claude-opus-5-5"),
        supportedReasoningLevels: ids.map((id) => ({ id, label: id, description: null })),
      },
    ],
  });
  const provider: ProviderRuntime = {
    ...runtime(async () => snapshot(), "anthropic"),
    backendKind: "claude-code-auth",
    discoverModels: snapshot,
  };
  const catalog = new ModelCatalog();
  try {
    await catalog.refresh(provider, context);
    ids = ["low", "medium", "high", "xhigh", "max"];
    await catalog.refresh(provider, { ...context, forceRefresh: true });
    expect(
      catalog.get("anthropic")?.models[0]?.supportedReasoningLevels?.map((level) => level.id),
    ).toEqual(ids);
  } finally {
    catalog.dispose();
  }
});

test("Claude alias pin changes invalidate only Claude capability identity", async () => {
  await withEnvironment({ ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5" }, async () => {
    const first = catalogContextKey("anthropic", context);
    const google = catalogContextKey("google", context);
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-6";
    expect(catalogContextKey("anthropic", context)).not.toBe(first);
    expect(catalogContextKey("google", context)).toBe(google);
  });
});

test("completed discoveries detach their abort listener even when an adapter retains the signal", async () => {
  const { getEventListeners } = await import("node:events");
  const signals: AbortSignal[] = [];
  const catalog = new ModelCatalog();
  const provider = runtime(async ({ signal }) => {
    signals.push(signal!);
    return ready();
  });
  for (let i = 0; i < 100; i++) {
    await catalog.refresh(provider, { ...context, forceRefresh: true });
  }
  for (const signal of signals) expect(getEventListeners(signal, "abort").length).toBe(0);
  catalog.dispose();
});
