import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import { normalizeRuntimeConfig } from "../../config/runtimeConfig.js";
import { loadProviderWorkspaceConfig } from "../../core/providerLauncher/workspaceConfig.js";
import { useRuntimeSettings } from "./useRuntimeSettings.js";

test("route persistence merges against the latest provider preferences, even before a re-render", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-route-persistence-"));
  const previous = process.env.UBUME_DATA_DIR;
  process.env.UBUME_DATA_DIR = join(root, "data");
  const noop = () => {};
  const output = new PassThrough();
  output.on("data", noop);
  let api: ReturnType<typeof useRuntimeSettings> | undefined;
  let config: any;
  function Harness() {
    const [current, setConfig] = React.useState({
      providers: { google: { currentModel: "saved" }, anthropic: { currentModel: "claude" } },
    });
    const ctx: any = {
      workspaceRoot: root,
      launchArgs: {},
      providerWorkspaceConfig: current,
      setProviderWorkspaceConfig: setConfig,
      baseRuntimeConfigRef: { current: normalizeRuntimeConfig({}) },
      setBaseLayeredConfig: noop,
      setSessionRuntimeOverride: noop,
      setConversationRouteOverride: noop,
      routeChoiceRequiredRef: { current: null },
      activeConversationRef: { current: null },
      appendEvent: noop,
    };
    api = useRuntimeSettings(ctx);
    config = current;
    return null;
  }
  const terminal = render(<Harness />, {
    stdout: output as never,
    stderr: output as never,
    stdin: new PassThrough() as never,
    debug: true,
    patchConsole: false,
  });
  try {
    // Hold the callback from the original render and make two same-tick writes.
    const original = api!;
    original.persistProviderDefaultModelAndReasoning("google", "working", "");
    expect(original.persistActiveRoute("anthropic", "claude-new", "", "claude-code-auth")).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(config.providers.google.currentModel).toBe("working");
    expect(loadProviderWorkspaceConfig(root).providers?.google?.currentModel).toBe("working");
    expect(config.activeRoute.modelId).toBe("claude-new");
    // A failed save returns a failure without publishing a new route or preference.
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "file");
    process.env.UBUME_DATA_DIR = blocked;
    expect(api!.persistActiveRoute("google", "do-not-commit", "", "antigravity-cli-auth")).toBe(
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(config.activeRoute.modelId).toBe("claude-new");
    expect(config.providers.google.currentModel).toBe("working");
  } finally {
    terminal.cleanup();
    if (previous == null) delete process.env.UBUME_DATA_DIR;
    else process.env.UBUME_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("config updates from a stale callback merge into the newest provider config", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-config-update-"));
  const previous = process.env.UBUME_DATA_DIR;
  process.env.UBUME_DATA_DIR = join(root, "data");
  const noop = () => {};
  const output = new PassThrough();
  output.on("data", noop);
  let api: ReturnType<typeof useRuntimeSettings> | undefined;
  let config: any;
  function Harness() {
    const [current, setConfig] = React.useState<any>({ providers: {} });
    const ctx: any = {
      workspaceRoot: root,
      launchArgs: {},
      providerWorkspaceConfig: current,
      setProviderWorkspaceConfig: setConfig,
      baseRuntimeConfigRef: { current: normalizeRuntimeConfig({}) },
      setBaseLayeredConfig: noop,
      setSessionRuntimeOverride: noop,
      setConversationRouteOverride: noop,
      routeChoiceRequiredRef: { current: null },
      activeConversationRef: { current: null },
      appendEvent: noop,
    };
    api = useRuntimeSettings(ctx);
    config = current;
    return null;
  }
  const terminal = render(<Harness />, {
    stdout: output as never,
    stderr: output as never,
    stdin: new PassThrough() as never,
    debug: true,
    patchConsole: false,
  });
  try {
    const original = api!;
    original.persistProviderDefaultModelAndReasoning("google", "gemini-new", "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The callback captured before the first write must not drop it.
    original.updateProviderWorkspaceConfig((latest) => ({
      ...latest,
      providers: { ...latest.providers, local: { localBackend: "unsloth" } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(config.providers.google.currentModel).toBe("gemini-new");
    expect(config.providers.local.localBackend).toBe("unsloth");
    const saved = loadProviderWorkspaceConfig(root);
    expect(saved.providers?.google?.currentModel).toBe("gemini-new");
    expect(saved.providers?.local?.localBackend).toBe("unsloth");
  } finally {
    terminal.cleanup();
    if (previous == null) delete process.env.UBUME_DATA_DIR;
    else process.env.UBUME_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
