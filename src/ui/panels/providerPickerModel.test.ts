import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import {
  buildLocalBackendRows,
  calculateProviderPickerWindow,
  getInitialProviderIndex,
  type ProviderPickerKeyContext,
  resolveProviderPickerKey,
} from "./providerPickerModel.js";

const provider = (id: string, extra: Partial<ProviderConfig> = {}) =>
  ({ id, displayName: id, currentModel: `${id}-model`, ...extra }) as ProviderConfig;
const grouped = [provider("openai"), provider("codexa-native"), provider("local")];
const nativeModels = [provider("codexa-native"), provider("codexa-cupy", { isDefault: true })];
const noKey = {
  ctrl: false,
  escape: false,
  home: false,
  end: false,
  pageUp: false,
  pageDown: false,
  upArrow: false,
  downArrow: false,
  return: false,
};
function context(overrides: Partial<ProviderPickerKeyContext> = {}): ProviderPickerKeyContext {
  return {
    mode: "providers",
    rowCount: grouped.length,
    pageSize: 5,
    selectedProvider: grouped[0],
    selectedIndex: 0,
    groupedProviders: grouped,
    codexaNativeModels: nativeModels,
    localBackendRowCount: 2,
    activeLocalBackend: "unsloth",
    ...overrides,
  };
}

test("navigation keys move relative to the latest index or jump", () => {
  assert.deepEqual(resolveProviderPickerKey("j", noKey, context()), { kind: "move", delta: 1 });
  assert.deepEqual(resolveProviderPickerKey("", { ...noKey, upArrow: true }, context()), {
    kind: "move",
    delta: -1,
  });
  assert.deepEqual(resolveProviderPickerKey("", { ...noKey, pageDown: true }, context()), {
    kind: "move",
    delta: 5,
  });
  assert.deepEqual(resolveProviderPickerKey("", { ...noKey, end: true }, context()), {
    kind: "jump",
    index: 2,
  });
});

test("Esc backs out of a drill-in to its parent row, and cancels at the top level", () => {
  assert.deepEqual(resolveProviderPickerKey("", { ...noKey, escape: true }, context()), {
    kind: "cancel",
  });
  assert.deepEqual(
    resolveProviderPickerKey("", { ...noKey, escape: true }, context({ mode: "local-backends" })),
    { kind: "open", mode: "providers", index: 2 },
  );
  assert.deepEqual(
    resolveProviderPickerKey("q", { ...noKey, ctrl: true }, context({ mode: "local-backends" })),
    { kind: "cancel" },
  );
});

test("grouped rows drill in instead of acting", () => {
  const onNative = context({ selectedProvider: grouped[1], selectedIndex: 1 });
  for (const input of ["m", "u", "s"]) {
    assert.deepEqual(resolveProviderPickerKey(input, noKey, onNative), {
      kind: "open",
      mode: "codexa-native-models",
      index: 1,
    });
  }
  const onLocal = context({ selectedProvider: grouped[2], selectedIndex: 2 });
  assert.deepEqual(resolveProviderPickerKey("\r", { ...noKey, return: true }, onLocal), {
    kind: "open",
    mode: "local-backends",
    index: 1,
  });
  assert.deepEqual(resolveProviderPickerKey("m", noKey, onLocal), {
    kind: "action",
    providerId: "local",
    action: "select-model",
    localBackend: undefined,
    withLocalBackend: true,
  });
});

test("actions from the Local drill-in carry the highlighted backend; set-default never does", () => {
  const inBackends = context({
    mode: "local-backends",
    selectedProvider: provider("local"),
    selectedIndex: 1,
  });
  assert.deepEqual(resolveProviderPickerKey("u", noKey, inBackends), {
    kind: "action",
    providerId: "local",
    action: "use-in-ubume",
    localBackend: "unsloth",
    withLocalBackend: true,
  });
  assert.deepEqual(resolveProviderPickerKey("s", noKey, inBackends), {
    kind: "action",
    providerId: "local",
    action: "set-default",
    withLocalBackend: false,
  });
  assert.deepEqual(resolveProviderPickerKey("x", noKey, inBackends), { kind: "none" });
  assert.deepEqual(resolveProviderPickerKey("m", noKey, context({ selectedProvider: undefined })), {
    kind: "none",
  });
});

test("Local backend rows show the model only on the active backend", () => {
  const rows = buildLocalBackendRows([provider("local")], "unsloth");
  assert.deepEqual(
    rows.map((row) => [row.displayName, row.currentModel]),
    [
      ["LM Studio", "Local server"],
      ["Unsloth", "local-model"],
    ],
  );
  assert.deepEqual(buildLocalBackendRows([provider("openai")], "unsloth"), []);
  assert.equal(getInitialProviderIndex(grouped, "codexa-cupy"), 1);
  assert.equal(getInitialProviderIndex(grouped, undefined), 0);
});

test("the window reserves a row while the active route is scrolled out of view", () => {
  const base = { itemCount: 10, selectedIndex: 0, availableRows: 6, scrollOffset: 0 };
  const visible = calculateProviderPickerWindow({ ...base, activeRouteIndex: 1 });
  const hidden = calculateProviderPickerWindow({ ...base, activeRouteIndex: 9 });
  assert.equal(visible.end - visible.start, 5);
  assert.equal(hidden.end - hidden.start, 4);
  assert.deepEqual([visible.showBorder, visible.showTitle, visible.showRange], [true, true, true]);
  const tiny = calculateProviderPickerWindow({ ...base, availableRows: 1, activeRouteIndex: -1 });
  assert.deepEqual([tiny.showBorder, tiny.showTitle], [false, false]);
});
