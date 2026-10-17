/**
 * Plain-text formatters for the app's diagnostic outputs.
 *
 * Each function turns raw diagnostics (provider validation results, GitHub
 * connectivity probes, route metadata) into the multi-line strings shown in
 * the transcript and status views. They are pure: no I/O, no state, so they
 * can be unit tested and reused by both the TUI and headless surfaces.
 */

import { formatContextLength } from "../core/providerRuntime/contextMetadata.js";
import type { DiagnosticResult, parseRepoIdentity } from "../core/shared/githubDiagnostics.js";

/** A provider's diagnostic field, as exposed by validation, and its label. */
type DiagnosticField = readonly [key: string, label: string];

/** Providers reported by `/diagnose providers`, in display order. */
const DIAGNOSED_PROVIDERS = [
  { id: "openai", label: "OpenAI/Codex" },
  { id: "anthropic", label: "Anthropic/Claude" },
  { id: "google", label: "Google" },
  { id: "codexa-native", label: "Codexa Native" },
  { id: "local", label: "Local OpenAI-compatible" },
] as const;

/** Fields printed for every provider that has diagnostic data. */
const PROVIDER_DIAGNOSTIC_FIELDS: readonly DiagnosticField[] = [
  ["resolvedCommand", "Resolved command"],
  ["executablePath", "Executable path"],
  ["loggedIn", "Logged in"],
  ["authMethod", "Auth method"],
  ["subscriptionType", "Subscription"],
  ["apiProvider", "API provider"],
  ["modelSource", "Model source"],
];

/**
 * Formats per-provider validation diagnostics for `/diagnose providers`.
 *
 * Every known provider gets a section, in `DIAGNOSED_PROVIDERS` order, so the
 * output shows which providers have not been validated yet.
 */
export function formatProviderDiagnostics(
  diags: Record<string, Record<string, string | number | boolean | null>>,
): string {
  const lines: string[] = ["Provider CLI diagnostics:"];

  for (const { id, label } of DIAGNOSED_PROVIDERS) {
    const diag = diags[id];

    lines.push(`\n  ${label ?? id}:`);

    if (!diag) {
      lines.push("    No diagnostic data (provider not yet validated).");
      continue;
    }

    for (const [key, fieldLabel] of PROVIDER_DIAGNOSTIC_FIELDS) {
      if (diag[key] != null) {
        lines.push(`    ${fieldLabel}: ${diag[key]}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Formats one row of the GitHub diagnostics table. Evidence is truncated to
 * keep the table aligned.
 */
function githubDiagnosticRow(result: DiagnosticResult): string {
  return `${result.path.padEnd(20)}| ${result.status.padEnd(8)}| ${(result.evidence || "")
    .substring(0, 30)
    .padEnd(30)}| ${result.blocker || ""}`;
}

/**
 * Formats the `/diagnose github` report: a table of the four connectivity
 * probes (gh CLI, local git, git write, connector), the resolved repository,
 * and the recommended PR flow.
 */
export function formatGithubDiagnostics(
  repo: ReturnType<typeof parseRepoIdentity>,
  ghCli: DiagnosticResult,
  localGit: DiagnosticResult,
  localGitWrite: DiagnosticResult,
  connector: DiagnosticResult,
  recommendedFlow: string,
): string {
  const tableLines = [
    "Path                | Status  | Evidence                      | Blocker",
    "--------------------|---------|-------------------------------|---------------------------",
    githubDiagnosticRow(ghCli),
    githubDiagnosticRow(localGit),
    githubDiagnosticRow(localGitWrite),
    githubDiagnosticRow(connector),
  ];

  return [
    ...tableLines,
    "",
    `Resolved repo: ${repo ? `${repo.owner}/${repo.repo}` : "Unknown"}`,
    `Recommended PR flow: ${recommendedFlow}`,
  ].join("\n");
}

/** Diagnostics values as recorded by provider validation. */
type RouteDiagnostics = Record<string, string | number | boolean | null>;

/** Appends Google route diagnostics: the resolved command and model source. */
function appendGoogleRouteDiagnostics(line: string, diagnostics: RouteDiagnostics): string {
  const lines = [line];

  if (diagnostics.resolvedCommand ?? diagnostics.executablePath) {
    lines.push(
      `    Resolved command: ${diagnostics.resolvedCommand ?? diagnostics.executablePath}`,
    );
  }

  if (diagnostics.modelSource) {
    lines.push(`    Model source: ${diagnostics.modelSource}`);
  }

  if (diagnostics.discoveredModelCount !== undefined) {
    lines.push(`    Discovered models: ${diagnostics.discoveredModelCount}`);
  }

  return lines.join("\n");
}

/** Appends Local-backend route diagnostics: endpoint and loaded model. */
function appendLocalRouteDiagnostics(line: string, diagnostics: RouteDiagnostics): string {
  const lines = [
    line,
    `    Base URL: ${diagnostics.baseUrl ?? "unknown"}`,
    `    Selected model: ${diagnostics.selectedModel ?? "none"}`,
    `    Models: ${diagnostics.discoveredModels || "none"}`,
    `    Endpoint check: ${diagnostics.endpointCheckResult ?? "unknown"}`,
  ];

  if (diagnostics.errorMessage) {
    lines.push(`    Error: ${diagnostics.errorMessage}`);
  }

  return lines.join("\n");
}

/** Appends resolved context-window metadata, when the provider reports any. */
function appendContextMetadataDiagnostics(line: string, diagnostics: RouteDiagnostics): string {
  const contextLength =
    typeof diagnostics.contextLength === "number" ? diagnostics.contextLength : null;

  const lines = [
    ...line.split("\n"),
    `    Context: ${formatContextLength(contextLength)}`,
    `    Context source: ${diagnostics.contextSource ?? "unknown"}`,
    `    Context confidence: ${diagnostics.contextConfidence ?? "unknown"}`,
  ];

  if (diagnostics.contextRawField) {
    lines.push(`    Context field: ${diagnostics.contextRawField}`);
  }

  if (diagnostics.contextError) {
    lines.push(`    Context reason: ${diagnostics.contextError}`);
  }

  return lines.join("\n");
}

/**
 * Extends a route status line with provider-specific diagnostics.
 *
 * Google routes report their resolved command and model source, Local routes
 * report their endpoint and loaded model, and any route with resolved
 * context-window metadata appends that as well. `line` is returned unchanged
 * when there are no diagnostics.
 */
export function formatProviderRouteDiagnostics(
  line: string,
  providerId: string,
  diagnostics: RouteDiagnostics | undefined,
): string {
  if (!diagnostics) {
    return line;
  }

  if (providerId === "google") {
    line = appendGoogleRouteDiagnostics(line, diagnostics);
  }

  if (providerId === "local") {
    line = appendLocalRouteDiagnostics(line, diagnostics);
  }

  if (diagnostics.contextSource || diagnostics.contextError) {
    line = appendContextMetadataDiagnostics(line, diagnostics);
  }

  return line;
}
