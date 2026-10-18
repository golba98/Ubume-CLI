import assert from "node:assert/strict";
import test from "node:test";
import { useState } from "react";
import { parseLaunchArgs } from "../../config/launchArgs.js";
import { normalizeRuntimeConfig } from "../../config/runtimeConfig.js";
import { findModelCapability } from "../../core/models/codexModelCapabilities.js";
import { providerCatalog } from "../../core/models/modelCatalog.js";
import { SelectionCoordinator } from "../../core/models/selectionCoordinator.js";
import type { ProviderWorkspaceConfig } from "../../core/providerLauncher/types.js";
import {
  parseProviderWorkspaceConfig,
  serializeProviderWorkspaceConfig,
  setProviderActiveRoute,
  setProviderDefaultModel,
  setProviderDefaultReasoning,
} from "../../core/providerLauncher/workspaceConfig.js";
import { claudeCodeModelsToProviderModels } from "../../core/providerRuntime/claudeCodeDiscovery.js";
import { providerModelsToCodexCapabilities } from "../../core/providerRuntime/models.js";
import { getProviderRuntime } from "../../core/providerRuntime/registry.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import { settle } from "../../test/async.js";
import { createTestTerminal } from "../../test/terminal.js";
import {
  initModelPickerSelection,
  modelPickerSelectionReducer,
} from "../../ui/panels/modelPickerModel.js";
import { useModelSelection } from "./useModelSelection.js";

const noop = () => {};
const ref = <T,>(current: T) => ({ current });
const ids = ["low", "medium", "high", "xhigh", "max"];
const models = claudeCodeModelsToProviderModels(
  ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-4-6"].map((id) => ({
    value: id,
    canonicalId: id,
    family: id.includes("opus") ? "opus" : "sonnet",
    label: id,
    source: "claude-code-command" as const,
    isFallback: false,
    effortLevels: id.endsWith("4-6") ? ids.filter((level) => level !== "xhigh") : ids,
    defaultEffort: "high",
    effortSource: "claude-code-command" as const,
    effortVerified: true,
  })),
);

test("Claude picker keeps max through model switches, refresh and reopening", () => {
  const capabilities = providerModelsToCodexCapabilities(models, models[0]!.modelId);
  let draft = initModelPickerSelection({
    models: capabilities.models,
    currentModel: models[0]!.modelId,
    currentReasoning: "max",
  });
  for (const index of [1, 2, 0]) {
    draft = modelPickerSelectionReducer(draft, {
      type: "select",
      models: capabilities.models,
      index,
    });
    assert.equal(draft.reasoning, "max");
  }
  draft = modelPickerSelectionReducer(draft, {
    type: "sync",
    models: capabilities.models.map((model) => ({ ...model })),
    currentModel: models[0]!.modelId,
    currentReasoning: "max",
    activeChanged: false,
  });
  assert.equal(draft.reasoning, "max");
  assert.equal(
    initModelPickerSelection({
      models: capabilities.models,
      currentModel: draft.identity!,
      currentReasoning: draft.reasoning,
    }).reasoning,
    "max",
  );
});

test("Claude activation preserves supported high efforts and rejects an unsupported switch before persistence", async () => {
  const runtime = getProviderRuntime("anthropic");
  const originalValidate = runtime.validateRoute;
  const originalDiscover = runtime.discoverModels;
  const validations: ProviderRoute[] = [];
  const notices: string[] = [];
  runtime.validateRoute = async ({ route }) => {
    validations.push(route);
    return { status: "ready", providerId: "anthropic", backendKind: "claude-code-auth" };
  };
  runtime.discoverModels = () => ({
    status: "ready",
    providerId: "anthropic",
    backendKind: "claude-code-auth",
    models,
  });
  providerCatalog.invalidate("anthropic");
  const parsed = parseLaunchArgs([]);
  assert(parsed.ok);
  const launchArgs = parsed.value;
  const coordinator = new SelectionCoordinator();
  const initialRoute: ProviderRoute = {
    providerId: "anthropic",
    modelId: models[0]!.modelId,
    reasoning: "max",
    backendKind: "claude-code-auth",
  };
  let selection!: ReturnType<typeof useModelSelection>;
  let snapshot!: { config: ProviderWorkspaceConfig; reasoning: string };
  const stableRefs = {
    modelSelectionInFlightRef: ref(false),
    routeChoiceRequiredRef: ref<string | null>(null),
    modelPickerOpenRef: ref(false),
    providerRouteErrorsRef: ref<Record<string, string>>({}),
    providerDiagnosticsRef: ref<Record<string, Record<string, string | number | boolean | null>>>(
      {},
    ),
  };
  function Harness() {
    const [config, setConfig] = useState<ProviderWorkspaceConfig>({ activeRoute: initialRoute });
    const [runtimeConfig, setRuntime] = useState(
      normalizeRuntimeConfig({ model: initialRoute.modelId, reasoningLevel: "max" }),
    );
    const capabilities = providerModelsToCodexCapabilities(models, config.activeRoute!.modelId);
    snapshot = { config, reasoning: runtimeConfig.reasoningLevel };
    selection = useModelSelection({
      ...stableRefs,
      selectionCoordinator: coordinator,
      pendingRouteProviderId: null,
      setPendingRouteProviderId: noop,
      setRegistryNonce: noop,
      markProviderAvailability: noop,
      ensureProviderModels: async () => {},
      modelCapabilities: null,
      currentModelCapability: findModelCapability(capabilities, config.activeRoute!.modelId),
      activeProviderRoute: { ...config.activeRoute!, backendKind: "claude-code-auth" },
      providerWorkspaceConfig: config,
      updateRuntimeConfig: setRuntime,
      model: runtimeConfig.model,
      reasoningLevel: runtimeConfig.reasoningLevel,
      mode: "suggest",
      planMode: false,
      launchArgs,
      workspaceRoot: "/tmp/claude-selection-test",
      persistActiveRoute: (providerId, modelId, reasoning, backendKind) => {
        setConfig((current) =>
          setProviderActiveRoute(
            setProviderDefaultReasoning(
              setProviderDefaultModel(current, providerId, modelId),
              providerId,
              reasoning,
            ),
            { providerId, modelId, reasoning, backendKind: backendKind! },
          ),
        );
        return true;
      },
      persistProviderDefaultModelAndReasoning: noop,
      appendEvent: (_type, _title, message) => notices.push(message),
      setScreen: noop,
      returnToChatMode: noop,
      setRouteSwitchBusy: noop,
      setPlanFlow: noop,
      dispatchSession: noop,
      getInputDebugSnapshot: () => ({}),
    });
    return null;
  }
  const terminal = createTestTerminal(<Harness />);
  try {
    await settle();
    for (const effort of ["xhigh", "max"]) {
      await selection.setModelAndReasoningWithNotice(models[1]!.modelId, effort, "anthropic");
      await settle();
      assert.equal(snapshot.reasoning, effort);
      const roundTrip = parseProviderWorkspaceConfig(
        serializeProviderWorkspaceConfig(snapshot.config),
      );
      assert.equal(roundTrip.activeRoute?.reasoning, effort);
      assert.equal(
        roundTrip.providers?.anthropic?.models?.[models[1]!.modelId]?.reasoningPreference,
        effort,
      );
    }
    await selection.setModelAndReasoningWithNotice(models[2]!.modelId, "xhigh", "anthropic");
    await settle();
    assert.equal(validations.length, 2, "unsupported effort is rejected before validation");
    assert.equal(snapshot.config.activeRoute?.modelId, models[1]!.modelId);
    assert.equal(snapshot.reasoning, "max");
    assert.match(notices.at(-1)!, /does not support/);
  } finally {
    await terminal.dispose();
    runtime.validateRoute = originalValidate;
    runtime.discoverModels = originalDiscover;
    providerCatalog.invalidate("anthropic");
  }
});

test("Claude picker restores intended max when stale High-only metadata refreshes", () => {
  const current = providerModelsToCodexCapabilities(models, models[0]!.modelId).models;
  const stale = current.map((model) => ({
    ...model,
    supportedReasoningLevels: model.supportedReasoningLevels!.filter((level) =>
      ["low", "medium", "high"].includes(level.id),
    ),
    reasoningControl: undefined,
  }));
  let draft = initModelPickerSelection({
    models: stale,
    currentModel: current[0]!.model,
    currentReasoning: "max",
  });
  assert.equal(draft.reasoning, "high");
  draft = modelPickerSelectionReducer(draft, {
    type: "sync",
    models: current,
    currentModel: current[0]!.model,
    currentReasoning: "max",
    activeChanged: false,
  });
  assert.equal(draft.reasoning, "max");
  draft = modelPickerSelectionReducer(draft, {
    type: "stepReasoning",
    models: current,
    direction: -1,
  });
  assert.equal(draft.reasoning, "xhigh");
  draft = modelPickerSelectionReducer(draft, {
    type: "sync",
    models: current,
    currentModel: current[0]!.model,
    currentReasoning: "max",
    activeChanged: false,
  });
  assert.equal(draft.reasoning, "xhigh", "refresh preserves the user's newer explicit choice");
});
