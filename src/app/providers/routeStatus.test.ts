import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../../core/providerLauncher/types.js";
import type { ModelContextMetadata } from "../../core/providerRuntime/contextMetadata.js";
import type { ProviderRoute } from "../../core/providerRuntime/types.js";
import { formatRouteStatus } from "./routeStatus.js";

const route = {
  providerId: "openai",
  modelId: "gpt-x",
  backendKind: "codex-cli-auth",
} as ProviderRoute;
const openai = { id: "openai", displayName: "OpenAI Codex CLI" } as ProviderConfig;

function report(metadata: ModelContextMetadata | null, routeAvailable = true) {
  return formatRouteStatus({
    providerRegistry: [],
    diagnostics: {},
    activeProviderRoute: route,
    activeContextMetadata: metadata,
    workspaceDefaultProvider: openai,
    activeRouteProvider: openai,
    activeRouteAvailable: routeAvailable,
  });
}

test("the route report names the default, active route and backend", () => {
  const lines = report(null).split("\n");
  assert.equal(lines[0], "Route status:");
  assert.equal(lines[1], "  Workspace default provider: OpenAI Codex CLI");
  assert.equal(lines[2], "  Active chat route: OpenAI Codex CLI / gpt-x");
  assert.equal(lines[3], "  Context: Unknown");
  assert.equal(lines[4], "  Backend kind: codex-cli-auth");
  assert.equal(lines[6], "  External launch: Unavailable");
  assert.match(report(null, false), /In-Ubume routing: unavailable/);
});

test("the context line shows estimates and the metadata source", () => {
  const estimated = {
    contextLength: 128000,
    confidence: "estimated",
    source: "known-registry",
  } as ModelContextMetadata;
  assert.match(report(estimated), /Context: ~.+ \(known-registry\)/);
  const sourceOnly = { contextLength: null, source: "provider" } as unknown as ModelContextMetadata;
  assert.match(report(sourceOnly), /Context: Unknown \(provider\)/);
});
