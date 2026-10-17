import assert from "node:assert/strict";
import test from "node:test";
import type { DiagnosticResult } from "../core/shared/githubDiagnostics.js";
import {
  formatGithubDiagnostics,
  formatProviderDiagnostics,
  formatProviderRouteDiagnostics,
} from "./diagnosticsFormat.js";

function diagnosticResult(overrides: Partial<DiagnosticResult> = {}): DiagnosticResult {
  return {
    path: "gh --version",
    status: "PASS",
    evidence: "gh 2.40.0",
    blocker: null,
    recommendedUse: true,
    ...overrides,
  };
}

test("formatProviderDiagnostics lists every known provider in order", () => {
  const output = formatProviderDiagnostics({
    openai: { resolvedCommand: "codex", loggedIn: true },
  });

  const sections = output.match(/^  (.*):$/gm) ?? [];
  assert.deepEqual(sections, [
    "  OpenAI/Codex:",
    "  Anthropic/Claude:",
    "  Google:",
    "  Codexa Native:",
    "  Local OpenAI-compatible:",
  ]);
});

test("formatProviderDiagnostics shows fields that have data and skips nulls", () => {
  const output = formatProviderDiagnostics({
    openai: {
      resolvedCommand: "codex",
      executablePath: null,
      loggedIn: true,
      authMethod: "chatgpt",
    },
  });

  assert.match(output, /Resolved command: codex/);
  assert.match(output, /Logged in: true/);
  assert.match(output, /Auth method: chatgpt/);
  assert.doesNotMatch(output, /Executable path/);
});

test("formatProviderDiagnostics reports providers without diagnostic data", () => {
  const output = formatProviderDiagnostics({});

  assert.match(output, /No diagnostic data \(provider not yet validated\)\./);
});

test("formatGithubDiagnostics renders the probe table and summary", () => {
  const output = formatGithubDiagnostics(
    {
      owner: "example",
      repo: "ubume",
      provider: "github",
      remoteUrl: "https://github.com/example/ubume",
    },
    diagnosticResult(),
    diagnosticResult({ path: "git", status: "PASS", evidence: "git 2.43" }),
    diagnosticResult({
      path: "git commit",
      status: "FAIL",
      evidence: "no user.name",
      blocker: "Configure git identity",
    }),
    diagnosticResult({
      path: "mcp connector",
      status: "PARTIAL",
      evidence: "not installed",
      blocker: null,
    }),
    "gh pr create",
  );

  assert.match(output, /^Path\s+\| Status\s+\| Evidence\s+\| Blocker/);
  assert.match(output, /gh --version\s+\| PASS/);
  assert.match(output, /Resolved repo: example\/ubume/);
  assert.match(output, /Recommended PR flow: gh pr create/);
  assert.match(output, /git commit\s+\| FAIL\s+\| no user\.name\s+\| Configure git identity/);
});

test("formatGithubDiagnostics truncates long evidence to keep the table aligned", () => {
  const longEvidence = "a".repeat(50);
  const output = formatGithubDiagnostics(
    null,
    diagnosticResult({ evidence: longEvidence }),
    diagnosticResult(),
    diagnosticResult(),
    diagnosticResult(),
    "flow",
  );

  assert.match(output, new RegExp(`${"a".repeat(30)}\\s*\\|`));
  assert.doesNotMatch(output, new RegExp(`${"a".repeat(31)}`));
});

test("formatGithubDiagnostics reports an unknown repo when none resolved", () => {
  const output = formatGithubDiagnostics(
    null,
    diagnosticResult(),
    diagnosticResult(),
    diagnosticResult(),
    diagnosticResult(),
    "flow",
  );

  assert.match(output, /Resolved repo: Unknown/);
});

test("formatProviderRouteDiagnostics leaves the line unchanged without diagnostics", () => {
  assert.equal(
    formatProviderRouteDiagnostics("Route status.", "google", undefined),
    "Route status.",
  );
});

test("formatProviderRouteDiagnostics appends Google route details", () => {
  const output = formatProviderRouteDiagnostics("Route status.", "google", {
    executablePath: "/usr/local/bin/gemini",
    modelSource: "registry",
    discoveredModelCount: 12,
  });

  assert.equal(
    output,
    [
      "Route status.",
      "    Resolved command: /usr/local/bin/gemini",
      "    Model source: registry",
      "    Discovered models: 12",
    ].join("\n"),
  );
});

test("formatProviderRouteDiagnostics appends Local backend details with fallbacks", () => {
  const output = formatProviderRouteDiagnostics("Route status.", "local", {
    endpointCheckResult: "ok",
  });

  assert.equal(
    output,
    [
      "Route status.",
      "    Base URL: unknown",
      "    Selected model: none",
      "    Models: none",
      "    Endpoint check: ok",
    ].join("\n"),
  );
});

test("formatProviderRouteDiagnostics includes the Local error when present", () => {
  const output = formatProviderRouteDiagnostics("Route status.", "local", {
    endpointCheckResult: "no-model",
    errorMessage: "No model is loaded",
  });

  assert.match(output, /Error: No model is loaded/);
});

test("formatProviderRouteDiagnostics appends context metadata below earlier sections", () => {
  const output = formatProviderRouteDiagnostics("Route status.", "local", {
    endpointCheckResult: "ok",
    contextLength: 128000,
    contextSource: "known-registry",
    contextConfidence: "verified",
    contextRawField: "context_window",
    contextError: null,
  });

  const lines = output.split("\n");
  assert.equal(lines[0], "Route status.");
  assert.ok(
    lines.findIndex((line) => line.includes("Endpoint check")) <
      lines.findIndex((line) => line.includes("Context:")),
  );
  assert.match(output, /Context: 128,000/);
  assert.match(output, /Context source: known-registry/);
  assert.match(output, /Context confidence: verified/);
  assert.match(output, /Context field: context_window/);
  assert.doesNotMatch(output, /Context reason/);
});

test("formatProviderRouteDiagnostics reports context errors and unknown lengths", () => {
  const output = formatProviderRouteDiagnostics("Route status.", "openai", {
    contextSource: null,
    contextError: "lookup failed",
  });

  assert.match(output, /Context: Unknown/);
  assert.match(output, /Context source: unknown/);
  assert.match(output, /Context confidence: unknown/);
  assert.match(output, /Context reason: lookup failed/);
});
