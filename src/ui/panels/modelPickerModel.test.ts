import assert from "node:assert/strict";
import test from "node:test";
import type { CodexModelCapability } from "../../core/models/codexModelCapabilities.js";
import {
  calculateModelPickerWindow,
  collapseGeminiEffortVariants,
  getCompactModelName,
  getInitialCursor,
  getModelName,
  getVariantReasoning,
  initModelPickerSelection,
  isModelIdentifiedBy,
  type ModelPickerSelection,
  modelPickerSelectionReducer,
  resolveVariantModelId,
} from "./modelPickerModel.js";

const levels = (ids: string[]) => ids.map((id) => ({ id, label: id, description: null }));
function model(overrides: Partial<CodexModelCapability> & { model: string }): CodexModelCapability {
  return {
    id: overrides.model,
    label: overrides.model,
    description: null,
    available: true,
    hidden: false,
    isDefault: false,
    defaultReasoningLevel: null,
    supportedReasoningLevels: null,
    reasoningLevelCount: null,
    source: "fallback",
    raw: null,
    ...overrides,
  };
}
const withLevels = (id: string, ids: string[], preference?: string) =>
  model({
    model: id,
    supportedReasoningLevels: levels(ids),
    reasoningControl: {
      kind: "levels",
      levels: levels(ids),
      default: ids[0]!,
      transport: "parameter",
    },
    ...(preference ? { reasoningPreference: preference } : {}),
  });
const budget = model({
  model: "budget",
  reasoningControl: {
    kind: "budget",
    min: 1024,
    max: 4096,
    default: 2048,
    auto: true,
    canDisable: true,
  },
});
const variant = (level: string) =>
  model({
    model: `gemini-3-pro-${level}`,
    label: `Gemini 3 Pro (${level})`,
    supportedReasoningLevels: levels([level]),
    reasoningControl: {
      kind: "levels",
      levels: levels([level]),
      default: level,
      transport: "variant",
    },
  });

const A = withLevels("a", ["low", "medium", "high"]);
const B = withLevels("b", ["low", "high"], "high");
const C = withLevels("c", ["medium"]);

test("the initial draft highlights the active model with a supported reasoning level", () => {
  assert.deepEqual(
    initModelPickerSelection({ models: [A, B, C], currentModel: "b", currentReasoning: "medium" }),
    { cursor: 1, identity: "b", reasoning: "low" },
    "unsupported 'medium' falls back to the control's default",
  );
  assert.equal(getInitialCursor([A, B], "missing"), 0);
});

test("moving clamps at the ends and adopts a model's preferred reasoning", () => {
  let state: ModelPickerSelection = { cursor: 0, identity: "a", reasoning: "medium" };
  state = modelPickerSelectionReducer(state, { type: "move", models: [A, B, C], direction: -1 });
  assert.equal(state.cursor, 0);
  state = modelPickerSelectionReducer(state, { type: "move", models: [A, B, C], direction: 1 });
  assert.deepEqual(state, { cursor: 1, identity: "b", reasoning: "high" });
  state = modelPickerSelectionReducer(state, { type: "select", models: [A, B, C], index: 99 });
  assert.equal(state.cursor, 2);
});

test("reasoning steps through discrete levels and token budgets", () => {
  let state: ModelPickerSelection = { cursor: 0, identity: "a", reasoning: "low" };
  state = modelPickerSelectionReducer(state, { type: "stepReasoning", models: [A], direction: 1 });
  state = modelPickerSelectionReducer(state, { type: "stepReasoning", models: [A], direction: 1 });
  state = modelPickerSelectionReducer(state, { type: "stepReasoning", models: [A], direction: 1 });
  assert.equal(state.reasoning, "high", "clamped at the last level");

  const single = { cursor: 0, identity: "c", reasoning: "medium" };
  assert.equal(
    modelPickerSelectionReducer(single, { type: "stepReasoning", models: [C], direction: 1 }),
    single,
    "a single level cannot change",
  );

  const budgeted = { cursor: 0, identity: "budget", reasoning: "budget:4096" };
  assert.equal(
    modelPickerSelectionReducer(budgeted, { type: "stepReasoning", models: [budget], direction: 1 })
      .reasoning,
    "budget:4096",
  );
  assert.equal(
    modelPickerSelectionReducer(budgeted, {
      type: "stepReasoning",
      models: [budget],
      direction: -1,
    }).reasoning,
    "budget:3072",
  );
});

test("sync follows the highlighted model when the list is reordered", () => {
  const state = { cursor: 1, identity: "b", reasoning: "high" };
  assert.deepEqual(
    modelPickerSelectionReducer(state, {
      type: "sync",
      models: [C, A, B],
      currentModel: "a",
      currentReasoning: "low",
      activeChanged: false,
    }),
    { cursor: 2, identity: "b", reasoning: "high" },
  );
});

test("sync recovers when the highlighted model disappears", () => {
  const state = { cursor: 2, identity: "c", reasoning: "medium" };
  const next = modelPickerSelectionReducer(state, {
    type: "sync",
    models: [A, B],
    currentModel: "a",
    currentReasoning: "low",
    activeChanged: false,
  });
  assert.deepEqual(next, { cursor: 1, identity: "b", reasoning: "low" });
});

test("sync with an empty list parks the cursor and resets the draft reasoning", () => {
  const state = { cursor: 2, identity: "c", reasoning: "medium" };
  assert.deepEqual(
    modelPickerSelectionReducer(state, {
      type: "sync",
      models: [],
      currentModel: "a",
      currentReasoning: "xhigh",
      activeChanged: false,
    }),
    { cursor: 0, identity: "c", reasoning: "xhigh" },
  );
});

test("sync re-seeds reasoning only when the active route changed", () => {
  const state = { cursor: 0, identity: "a", reasoning: "low" };
  const sync = (activeChanged: boolean) =>
    modelPickerSelectionReducer(state, {
      type: "sync",
      models: [A],
      currentModel: "a",
      currentReasoning: "high",
      activeChanged,
    }).reasoning;
  assert.equal(sync(false), "low");
  assert.equal(sync(true), "high");
});

test("Gemini effort variants collapse into one row that resolves back to a variant id", () => {
  const plain = model({ model: "gemini-flash" });
  const collapsed = collapseGeminiEffortVariants([variant("high"), plain, variant("low")]);
  assert.deepEqual(
    collapsed.map((row) => row.model),
    ["gemini-3-pro", "gemini-flash"],
  );
  const family = collapsed[0]!;
  assert.equal(family.label, "Gemini 3 Pro");
  assert.deepEqual(
    family.supportedReasoningLevels?.map((level) => level.id),
    ["low", "high"],
    "levels are in canonical order",
  );
  assert.equal(isModelIdentifiedBy(family, "gemini-3-pro-low"), true);
  assert.equal(getVariantReasoning(family, "gemini-3-pro-high"), "high");
  assert.equal(resolveVariantModelId(family, "low", "gemini-3-pro-high"), "gemini-3-pro-low");
  assert.equal(resolveVariantModelId(plain, "high", "gemini-flash"), "gemini-flash");
});

test("Mistral execution classes add full and compact suffixes", () => {
  const vibe = model({
    model: "devstral",
    label: "Devstral",
    raw: { mistralExecutionClass: "native-vibe" },
  });
  assert.equal(getModelName(vibe), "Devstral · Native Vibe");
  assert.equal(getCompactModelName(vibe), "Devstral · Vibe");
  assert.equal(getCompactModelName(model({ model: "id-only", label: "" })), "id-only");
});

test("the window drops chrome before scrolling and shows the active model when it scrolls away", () => {
  const base = {
    selectedIndex: 0,
    scrollOffset: 0,
    hasSourceMarker: true,
    allowFull: true,
    activeModelIndex: 0,
  };
  const full = calculateModelPickerWindow({ ...base, itemCount: 4, availableRows: 10 });
  assert.equal(full.mode, "full");
  assert.equal(full.showSourceMarker, true);

  const noMarker = calculateModelPickerWindow({ ...base, itemCount: 4, availableRows: 9 });
  assert.equal(noMarker.mode, "full");
  assert.equal(noMarker.showSourceMarker, false);

  const compact = calculateModelPickerWindow({ ...base, itemCount: 4, availableRows: 8 });
  assert.deepEqual(
    [compact.mode, compact.showRouteText, compact.showReasoningText],
    ["compact", false, true],
  );

  const windowed = calculateModelPickerWindow({
    ...base,
    itemCount: 20,
    availableRows: 6,
    selectedIndex: 15,
    activeModelIndex: 0,
  });
  assert.equal(windowed.mode, "windowed");
  assert.equal(windowed.showCurrentLine, true);
  assert.equal(windowed.end - windowed.start, 4, "one row is given up for the Current: line");
});
