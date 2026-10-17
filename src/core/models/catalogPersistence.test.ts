import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnvironment } from "../../test/environment.js";
import { persistProviderDiscovery } from "../providerRuntime/registry.js";
import type { ProviderModelDiscoveryResult } from "../providerRuntime/types.js";
import { getCodexModelCapabilities } from "./codexModelCapabilities.js";

test("cached inventory reuse does not rewrite last verification time or disk", async () => {
  const home = mkdtempSync(join(tmpdir(), "ubume-verification-time-"));
  try {
    await withEnvironment({ HOME: home, USERPROFILE: home }, () => {
      const discovery: ProviderModelDiscoveryResult = {
        providerId: "mistral",
        backendKind: "mistral-vibe-cli-auth",
        status: "ready",
        freshness: "verified",
        verifiedAt: 1234,
        models: [],
      };
      persistProviderDiscovery(discovery);
      const file = join(home, ".ubume-model-cache.json");
      expect(JSON.parse(readFileSync(file, "utf8")).providers.mistral.discoveredAt).toBe(1234);
      writeFileSync(file, "external-marker");
      persistProviderDiscovery(discovery);
      expect(readFileSync(file, "utf8")).toBe("external-marker");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("canceling Codex discovery terminates a stalled native app-server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubume-codex-cancel-"));
  const executable = join(directory, "codex-fixture");
  writeFileSync(executable, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n", { mode: 0o700 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  try {
    const result = await getCodexModelCapabilities({
      executable,
      signal: controller.signal,
      timeoutMs: 5000,
      forceRefresh: true,
      seed: () => null,
    });
    expect(result.status).toBe("fallback");
    expect(result.error).toContain("canceled");
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    clearTimeout(timer);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a ready Codex disk seed is not classified as verified live discovery", async () => {
  const { isVerifiedCodexModelCapabilities, createFallbackModelCapabilities } = await import(
    "./codexModelCapabilities.js"
  );
  const seed = {
    ...createFallbackModelCapabilities(null),
    status: "ready" as const,
    source: "runtime" as const,
  };
  const result = await getCodexModelCapabilities({
    executable: "/fixture/cached-codex",
    forceRefresh: true,
    discover: async () => {
      throw new Error("temporary unavailable");
    },
    seed: () => seed,
  });
  expect(result).toBe(seed);
  expect(isVerifiedCodexModelCapabilities(result)).toBe(false);
  const live = await getCodexModelCapabilities({
    executable: "/fixture/live-codex",
    forceRefresh: true,
    discover: async () => ({ ...seed }),
    persist: () => {},
  });
  expect(isVerifiedCodexModelCapabilities(live)).toBe(true);
});
