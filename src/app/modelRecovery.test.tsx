import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import { normalizeRuntimeConfig } from "../config/runtimeConfig.js";
import { providerCatalog } from "../core/models/modelCatalog.js";
import { SelectionCoordinator } from "../core/models/selectionCoordinator.js";
import type { ProviderWorkspaceConfig } from "../core/providerLauncher/types.js";
import { getProviderRuntime } from "../core/providerRuntime/registry.js";
import type { ProviderRouteValidationResult } from "../core/providerRuntime/types.js";
import { useModelSelection } from "./useModelSelection.js";
import { useOverlayRouting } from "./useOverlayRouting.js";
import { useProviderRoute } from "./useProviderRoute.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const noop = () => {};
const ref = <T,>(current: T) => ({ current });
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  providerCatalog.dispose();
});

async function harness() {
  const google = getProviderRuntime("google");
  const openai = getProviderRuntime("openai");
  const originalGoogle = google.validateRoute;
  const originalOpenai = openai.validateRoute;
  cleanups.push(() => {
    google.validateRoute = originalGoogle;
    openai.validateRoute = originalOpenai;
  });
  const validations: string[] = [];
  google.validateRoute = async ({ route }) => {
    validations.push(route.modelId);
    return {
      status: route.modelId === "working" ? "ready" : "not-configured",
      providerId: "google",
      backendKind: google.backendKind,
      ...(route.modelId === "working"
        ? {}
        : { message: `Google model ${route.modelId} is unavailable.` }),
    };
  };
  openai.validateRoute = async () => ({
    status: "ready",
    providerId: "openai",
    backendKind: openai.backendKind,
  });
  const snapshot = {
    status: "ready" as const,
    providerId: "google" as const,
    backendKind: google.backendKind,
    freshness: "verified" as const,
    complete: true,
    models: [
      {
        id: "working",
        modelId: "working",
        label: "Working",
        description: null,
        defaultReasoningLevel: null,
        supportedReasoningLevels: null,
        source: "discovered" as const,
      },
    ],
  };
  await providerCatalog.refresh(
    { ...google, discoverModels: () => snapshot, refreshModels: async () => snapshot },
    { cwd: "/tmp/ubume-model-recovery-test", forceRefresh: true },
  );
  const input = new PassThrough() as PassThrough & Record<string, unknown>;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = noop;
  input.unref = noop;
  const output = new PassThrough() as PassThrough & Record<string, unknown>;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  output.on("data", noop);
  const refs = {
    modelSelectionInFlightRef: ref(false),
    modelPickerOpenRef: ref(false),
    intendedInputModeRef: ref("chat/input"),
    intendedFocusTargetRef: ref("composer"),
    providerDiagnosticsRef: ref({}),
    providerRouteErrorsRef: ref({}),
    routeChoiceRequiredRef: ref(null),
    isMountedRef: ref(true),
    localBackendCheckInFlightRef: ref(new Map()),
    providerActionRef: ref(null),
    providerLaunchBypassRef: ref(false),
    busyRef: ref(false),
  };
  const selectionCoordinator = new SelectionCoordinator();
  const events: string[] = [];
  const commits: string[] = [];
  let failSave = false;
  let api: any;
  function Harness() {
    const [config, setConfig] = React.useState<ProviderWorkspaceConfig>({
      activeRoute: {
        providerId: "openai",
        modelId: "gpt-fixture",
        backendKind: openai.backendKind,
      },
      providers: { google: { currentModel: "withdrawn" }, openai: { currentModel: "gpt-fixture" } },
    });
    const [screen, setScreen] = React.useState("main");
    const [pending, setPending] = React.useState(null);
    const [switchBusy, setBusy] = React.useState(false);
    const [runtime, setRuntime] = React.useState(normalizeRuntimeConfig({ model: "gpt-fixture" }));
    const providers = (["openai", "google"] as const).map((id) => ({
      id,
      displayName: id,
      currentModel: config.providers?.[id]?.currentModel,
      routeMode: "in-ubume",
      enabled: true,
    }));
    const ctx: any = {
      selectionCoordinator,
      dispatchSession: noop,
      ...refs,
      providerWorkspaceConfig: config,
      activeProviderRoute: config.activeRoute,
      activeRouteProvider: providers.find((p) => p.id === config.activeRoute?.providerId),
      providerRegistry: providers,
      workspaceRoot: "/tmp/ubume-model-recovery-test",
      runtimeConfig: runtime,
      model: runtime.model,
      reasoningLevel: "",
      screen,
      pendingRouteProviderId: pending,
      setScreen,
      setPendingRouteProviderId: setPending,
      setRouteSwitchBusy: setBusy,
      setProviderWorkspaceConfig: setConfig,
      updateRuntimeConfig: setRuntime,
      setRegistryNonce: noop,
      appendEvent: (_: string, title: string, message: string) =>
        events.push(`${title}: ${message}`),
      getInputDebugSnapshot: () => ({}),
      persistActiveRoute: (
        providerId: "openai" | "google",
        modelId: string,
        reasoning: string,
        backendKind: "codex-cli-auth",
      ) => {
        if (failSave) return false;
        commits.push(`${providerId}:${modelId}`);
        setConfig((c) => ({
          ...c,
          activeRoute: { providerId, modelId, reasoning, backendKind },
          providers: {
            ...c.providers,
            [providerId]: { ...c.providers?.[providerId], currentModel: modelId },
          },
        }));
      },
      persistProviderDefaultModelAndReasoning: noop,
      returnToChatMode: () => {
        if (!refs.modelPickerOpenRef.current) setScreen("main");
      },
      focusManager: { focus: noop },
      busy: false,
      launchArgs: {},
      setPlanFlow: noop,
      mode: "suggest",
      planMode: false,
      modelCapabilities: null,
      activeRouteModelCapabilities: null,
      markProviderAvailability: noop,
      ensureProviderModels: async () => {},
      refreshModelCapabilities: async () => {},
      setLocalBackendStatuses: noop,
      setProviderSetup: noop,
      externalCliLaunchHooks: { stdin: input, beforeLaunch: noop, afterLaunch: noop },
    };
    const selection = useModelSelection(ctx);
    const provider = useProviderRoute({ ...ctx, ...selection });
    const overlay = useOverlayRouting(ctx);
    api = {
      ...selection,
      ...provider,
      ...overlay,
      changeConnection: () =>
        setConfig((c) => ({
          ...c,
          providers: {
            ...c.providers,
            google: { ...c.providers?.google, antigravityCommandPath: "changed-fixture-command" },
          },
        })),
      read: () => ({ screen, pending, switchBusy, route: config.activeRoute, config, runtime }),
    };
    return null;
  }
  const instance = render(<Harness />, {
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => instance.cleanup());
  await tick();
  return {
    api: () => api,
    google,
    validations,
    events,
    commits,
    refs,
    selectionCoordinator,
    failSave: () => {
      failSave = true;
    },
  };
}

test("returning to a provider with an unavailable saved model opens its recovery picker", async () => {
  const h = await harness();
  h.api().handleProviderAction("google", "use-in-ubume");
  await tick();
  expect(h.api().read().screen).toBe("model-picker");
  expect(h.api().read().pending).toBe("google");
  expect(h.api().read().config.providers.google.currentModel).toBe("withdrawn");
});

test("an older model activation cannot overwrite a newer provider selection", async () => {
  const h = await harness();
  let resolve!: (result: ProviderRouteValidationResult) => void;
  h.google.validateRoute = () =>
    new Promise((done) => {
      resolve = done;
    });
  const slow = h.api().setModelAndReasoningWithNotice("working", "", "google");
  await tick();
  await h.api().setModelAndReasoningWithNotice("gpt-fixture", "", "openai");
  await tick();
  resolve({ status: "ready", providerId: "google", backendKind: h.google.backendKind });
  await slow;
  await tick();
  expect(h.api().read().route.providerId).toBe("openai");
  expect(h.commits).toEqual(["openai:gpt-fixture"]);
});

test("failed candidates preserve the active route and provider preferences across repeated selections", async () => {
  const h = await harness();
  for (let i = 0; i < 3; i++) {
    await h.api().setModelAndReasoningWithNotice(`nonexistent-${i}`, "", "google");
    await tick();
    expect(h.api().read().route.modelId).toBe("gpt-fixture");
    expect(h.api().read().config.providers.google.currentModel).toBe("withdrawn");
    expect(h.api().read().screen).toBe("model-picker");
  }
  h.refs.modelPickerOpenRef.current = false;
  await h.api().setModelAndReasoningWithNotice("working", "", "google");
  await tick();
  expect(h.api().read().route.modelId).toBe("working");
  expect(h.api().read().switchBusy).toBe(false);
  expect(h.commits).toEqual(["google:working"]);
});

test("persistence failure cannot partially commit the runtime model", async () => {
  const h = await harness();
  h.failSave();
  await h.api().setModelAndReasoningWithNotice("working", "", "google");
  await tick();
  expect(h.api().read().runtime.model).toBe("gpt-fixture");
  expect(h.api().read().route.modelId).toBe("gpt-fixture");
  expect(h.api().read().config.providers.google.currentModel).toBe("withdrawn");
  expect(h.commits).toEqual([]);
  expect(h.api().read().screen).toBe("model-picker");
});

test("late activation failure cannot close a provider picker opened during validation", async () => {
  const h = await harness();
  let resolve!: (result: ProviderRouteValidationResult) => void;
  h.google.validateRoute = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = h.api().setModelAndReasoningWithNotice("working", "", "google");
  await tick();
  h.api().openProviderPicker();
  await tick();
  resolve({
    status: "not-configured",
    providerId: "google",
    backendKind: h.google.backendKind,
    message: "Model working is unavailable",
  });
  await pending;
  await tick();
  expect(h.api().read().screen).toBe("provider-picker");
  expect(h.api().read().switchBusy).toBe(false);
  expect(h.commits).toEqual([]);
});

test("late failed selection cannot attach an error to a newer successful route", async () => {
  const h = await harness();
  let resolve!: (result: ProviderRouteValidationResult) => void;
  h.google.validateRoute = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = h.api().setModelAndReasoningWithNotice("working", "", "google");
  await tick();
  await h.api().setModelAndReasoningWithNotice("gpt-fixture", "", "openai");
  const count = h.events.length;
  resolve({
    status: "not-configured",
    providerId: "google",
    backendKind: h.google.backendKind,
    message: "Model working is unavailable",
  });
  await pending;
  await tick();
  expect(h.events.length).toBe(count);
  expect(h.api().read().route.providerId).toBe("openai");
});

test("a validation for an old connection cannot activate a model after credentials or command changes", async () => {
  const h = await harness();
  let resolve!: (result: ProviderRouteValidationResult) => void;
  h.google.validateRoute = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = h.api().setModelAndReasoningWithNotice("working", "", "google");
  await tick();
  h.api().changeConnection();
  await tick();
  resolve({ status: "ready", providerId: "google", backendKind: h.google.backendKind });
  await pending;
  await tick();
  expect(h.api().read().route.providerId).toBe("openai");
  expect(h.commits).toEqual([]);
  expect(h.api().read().screen).toBe("model-picker");
  expect(h.api().read().pending).toBe("google");
});
