/**
 * Discovers Claude Code models and reasoning metadata from native commands, installed package
 * metadata, settings and fallbacks.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildClaudeSpawnSpec,
  resolveClaudeExecutable,
} from "../executables/executableResolver.js";
import type { CommandResult } from "../process/commandRunner.js";
import { runCommand } from "../process/commandRunner.js";
import { isRecord } from "../shared/values.js";
import {
  ANTHROPIC_FALLBACK_MODELS,
  getClaudeCodeEffortLevels,
  getKnownClaudeCodeEffort,
} from "./models.js";
import type { ProviderModel, ReasoningControl } from "./types.js";

type CommandRunner = typeof runCommand;

const CLAUDE_MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
type ClaudeModelFamily = (typeof CLAUDE_MODEL_FAMILIES)[number];
const CLAUDE_FAMILIES_ALT = CLAUDE_MODEL_FAMILIES.join("|");
// Pre-compiled from CLAUDE_MODEL_FAMILIES — update that constant when new families are added.
const RE_VERSIONED_ID = new RegExp(`\\bclaude-(?:${CLAUDE_FAMILIES_ALT})-(\\d+)(?:-(\\d+))?\\b`);
const RE_VAGUE_LABEL = new RegExp(`^(?:claude\\s+)?(?:${CLAUDE_FAMILIES_ALT})$`, "i");

export type ClaudeCodeModelSource =
  | "claude-code"
  | "claude-code-command"
  | "claude-code-package"
  | "claude-code-cache"
  | "claude-code-config"
  | "config"
  | "settings"
  | "fallback";

export interface ClaudeCodeAuthInfo {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
}

export interface ClaudeCodeModel {
  label: string;
  family: string;
  value: string;
  canonicalId: string;
  source: ClaudeCodeModelSource;
  version?: string;
  isFallback: boolean;
  discoveryKind?: "models" | "aliases";
  effortLevels: readonly string[];
  defaultEffort: string;
  effortSource: ClaudeCodeModelSource;
  effortVerified: boolean;
  description?: string;
  reasoningControl?: ReasoningControl;
}

export interface ClaudeCodeCapabilityDiscovery {
  provider: "anthropic";
  backend: "claude-code-cli";
  resolvedCommand: string;
  auth: ClaudeCodeAuthInfo;
  models: ClaudeCodeModel[];
  modelSource: ClaudeCodeModelSource;
  discoveredAt: string;
  settings?: {
    path: string;
    model?: string;
    effortLevel?: string;
    availableModels?: readonly string[];
  };
  diagnostics?: Record<string, string | number | boolean | null>;
}

interface DiscoverClaudeCodeCapabilitiesOptions {
  cwd: string;
  runCommandImpl?: CommandRunner;
  configuredPath?: string | null;
  settingsPath?: string | null;
  now?: () => Date;
  timeoutMs?: number;
  metadataPaths?: readonly string[];
}

interface ClaudeSettingsInfo {
  path: string;
  model?: string;
  effortLevel?: string;
  availableModels?: readonly string[];
  models?: readonly ClaudeCodeModel[];
  env?: Record<string, unknown>;
  modelSettings?: Record<string, unknown>;
  maxEffortLevel?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map(readString).filter((item): item is string => Boolean(item));
  return result.length > 0 ? result : undefined;
}

/**
 * Parses structured Claude authentication output without treating malformed output as
 * authenticated.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeCodeAuthInfo | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (!isRecord(parsed)) return null;
    return {
      loggedIn: parsed["loggedIn"] === true,
      authMethod: readString(parsed["authMethod"]),
      apiProvider: readString(parsed["apiProvider"]),
      subscriptionType: readString(parsed["subscriptionType"]),
    };
  } catch {
    return null;
  }
}

/**
 * Extracts advertised effort choices; missing metadata returns null rather than inventing
 * levels.
 */
export function parseClaudeEffortLevelsFromHelp(helpText: string): string[] | null {
  // Commander wraps option descriptions. Stop at the next option so another
  // option's parenthesized choices cannot become effort capabilities.
  const section = helpText.match(
    /^[ \t]*--effort\b[^\r\n]*(?:\r?\n(?![ \t]*-|\S)[^\r\n]*)*/im,
  )?.[0];
  const match = section?.match(/\(([^)]+)\)/);
  if (!match?.[1]) return null;
  const levels = match[1]
    .split(",")
    .map((level) => level.trim())
    .filter((level) => /^[a-z][a-z0-9_-]*$/.test(level));
  return levels.length > 0 ? levels : null;
}

/** Extracts the advertised `--permission-mode` choices; null when the help omits them. */
export function parseClaudePermissionModesFromHelp(helpText: string): string[] | null {
  const section = helpText.match(
    /^[ \t]*--permission-mode\b[^\r\n]*(?:\r?\n(?![ \t]*-|\S)[^\r\n]*)*/im,
  )?.[0];
  const choices = section?.match(/choices:\s*([^)]*)\)/)?.[1];
  const modes = choices?.match(/"([A-Za-z]+)"/g)?.map((mode) => mode.slice(1, -1)) ?? [];
  return modes.length ? modes : null;
}

/**
 * True when the CLI can route permission prompts to a host over stream-json stdin
 * (`--input-format stream-json` plus `--permission-prompt-tool stdio`).
 */
export function claudeHelpSupportsHostApprovals(helpText: string): boolean {
  return /--input-format\b/.test(helpText) && /--permission-prompts?\b/.test(helpText);
}

function modelFamilyFromValue(value: string): ClaudeModelFamily {
  const normalized = value.toLowerCase();
  if (normalized.includes("fable")) return "fable";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  return "sonnet";
}

function fallbackModelByFamily(family: string): ProviderModel | undefined {
  return ANTHROPIC_FALLBACK_MODELS.find(
    (model) => model.family === family || model.modelId === family,
  );
}

function fallbackEffortIds(family: string): string[] {
  const fallback = fallbackModelByFamily(family);
  return fallback?.supportedReasoningLevels?.map((level) => level.id) ?? [];
}

function fallbackDefaultEffort(family: string): string {
  return fallbackModelByFamily(family)?.defaultReasoningLevel ?? "medium";
}

function titleCaseFamily(family: string): string {
  if (family === "fable") return "Fable";
  if (family === "opus") return "Opus";
  if (family === "haiku") return "Haiku";
  return "Sonnet";
}

function versionFromModelText(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const idMatch = normalized.match(RE_VERSIONED_ID);
  if (idMatch) return idMatch[2] ? `${idMatch[1]}.${idMatch[2]}` : (idMatch[1] ?? null);
  const labelMatch = normalized.match(
    new RegExp(`^(?:claude\\s+)?(?:${CLAUDE_FAMILIES_ALT})\\s+(\\d+(?:\\.\\d+)?)\\b`),
  );
  return labelMatch?.[1] ?? null;
}

function compareVersionStrings(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftParts = (left ?? "").split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = (right ?? "").split(".").map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const l = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const r = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (l !== r) return l - r;
  }
  return 0;
}

function isVagueClaudeFamilyLabel(value: string): boolean {
  return RE_VAGUE_LABEL.test(value.trim());
}

function normalizeClaudeDisplayLabel(value: string, rawLabel?: string): string {
  const family = modelFamilyFromValue(value);
  const familyLabel = titleCaseFamily(family);
  const raw = rawLabel?.trim();
  const valueVersion = versionFromModelText(value);

  if (raw) {
    const rawVersion = versionFromModelText(raw);
    if (rawVersion) {
      const prefixed = /^claude\b/i.test(raw) ? raw : `Claude ${raw}`;
      return prefixed.replace(/\b(opus|sonnet|haiku)\b/i, familyLabel);
    }
    if (!isVagueClaudeFamilyLabel(raw) && !valueVersion) {
      return raw;
    }
  }

  if (valueVersion) return `Claude ${familyLabel} ${valueVersion}`;
  return `Claude ${familyLabel} (version unknown)`;
}

function normalizeEffortIds(value: unknown, fallbackFamily: string): string[] {
  if (Array.isArray(value))
    return [...new Set(value.map(readString).filter((id): id is string => Boolean(id)))];
  const fromArray = readStringArray(value);
  return fromArray && fromArray.length > 0 ? fromArray : fallbackEffortIds(fallbackFamily);
}

function normalizeClaudeCodeModel(
  raw: unknown,
  source: ClaudeCodeModelSource,
): ClaudeCodeModel | null {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) return null;
    const family = modelFamilyFromValue(value);
    const version = versionFromModelText(value) ?? undefined;
    return {
      label: normalizeClaudeDisplayLabel(value),
      family,
      value,
      canonicalId: value,
      source,
      ...(version ? { version } : {}),
      isFallback: source === "fallback",
      effortLevels: fallbackEffortIds(family),
      defaultEffort: fallbackDefaultEffort(family),
      effortSource: "fallback",
      effortVerified: false,
      description: source === "settings" ? "Claude settings model" : undefined,
    };
  }

  if (!isRecord(raw)) return null;
  const value = readString(raw.value ?? raw.model ?? raw.modelId ?? raw.id ?? raw.name);
  if (!value) return null;
  const family = readString(raw.family) ?? modelFamilyFromValue(value);
  // Accept both camelCase and snake_case effort field names for compatibility.
  const rawEffortArray =
    raw.effortLevels ?? raw.effort_levels ?? raw.supportedEfforts ?? raw.supported_efforts;
  const effortLevels = normalizeEffortIds(rawEffortArray, family);
  const defaultEffort =
    readString(raw.defaultEffort ?? raw.default_effort ?? raw.effortLevel ?? raw.effort_level) ??
    fallbackDefaultEffort(family);
  const hasRawEffortArray = Array.isArray(rawEffortArray);
  const rawControl = isRecord(raw.reasoningControl) ? raw.reasoningControl : null;
  const reasoningControl: ReasoningControl | undefined =
    rawControl?.kind === "fixed" && typeof rawControl.label === "string"
      ? { kind: "fixed", label: rawControl.label }
      : rawControl?.kind === "unsupported" || rawControl?.kind === "unknown"
        ? { kind: rawControl.kind }
        : hasRawEffortArray && effortLevels.length === 0
          ? { kind: "unsupported" }
          : undefined;

  const canonicalId = readString(raw.canonicalId ?? raw.canonical_id) ?? value;
  const version =
    versionFromModelText(canonicalId) ??
    versionFromModelText(value) ??
    versionFromModelText(readString(raw.label ?? raw.displayName ?? raw.display_name) ?? "");

  return {
    label: normalizeClaudeDisplayLabel(
      value,
      readString(raw.label ?? raw.displayName ?? raw.display_name),
    ),
    family,
    value,
    canonicalId,
    source,
    ...(version ? { version } : {}),
    isFallback: source === "fallback",
    discoveryKind:
      readString(raw.discoveryKind ?? raw.discovery_kind) === "aliases" ? "aliases" : "models",
    effortLevels,
    defaultEffort: effortLevels.includes(defaultEffort)
      ? defaultEffort
      : (effortLevels[0] ?? "medium"),
    effortSource: hasRawEffortArray ? source : "fallback",
    effortVerified:
      (source === "claude-code" ||
        source === "claude-code-command" ||
        source === "claude-code-package") &&
      hasRawEffortArray,
    description: readString(raw.description),
    reasoningControl,
  };
}

function dedupeModels(models: ClaudeCodeModel[]): ClaudeCodeModel[] {
  const seen = new Set<string>();
  const result: ClaudeCodeModel[] = [];
  for (const model of models) {
    const key = model.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

function fallbackClaudeModels(): ClaudeCodeModel[] {
  return ANTHROPIC_FALLBACK_MODELS.map((model) => ({
    label: model.label,
    family: model.family ?? model.modelId,
    value: model.modelId,
    canonicalId: model.canonicalId ?? model.modelId,
    source: "fallback",
    isFallback: true,
    discoveryKind: "aliases",
    effortLevels: model.supportedReasoningLevels?.map((level) => level.id) ?? [],
    defaultEffort: model.defaultReasoningLevel ?? "medium",
    effortSource: "fallback",
    effortVerified: false,
    description: model.description ?? undefined,
  }));
}

function applyAvailableModelAllowlist(
  models: ClaudeCodeModel[],
  allowlist: readonly string[] | undefined,
): ClaudeCodeModel[] {
  if (!allowlist || allowlist.length === 0) return models;
  const allowed = new Set(allowlist.map((item) => item.toLowerCase()));
  const filtered = models.filter(
    (model) =>
      allowed.has(model.value.toLowerCase()) ||
      allowed.has(model.family.toLowerCase()) ||
      allowed.has(model.canonicalId.toLowerCase()) ||
      allowed.has(model.label.toLowerCase()),
  );
  return filtered.length > 0 ? filtered : models;
}

function defaultClaudeSettingsPath(): string | null {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  const configDir = process.env.CLAUDE_CONFIG_DIR || (home ? join(home, ".claude") : null);
  return configDir ? join(configDir, "settings.json") : null;
}

function readClaudeSettings(settingsPath: string | null | undefined): ClaudeSettingsInfo | null {
  const path = settingsPath === undefined ? defaultClaudeSettingsPath() : settingsPath;
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) return null;
    // Accept both camelCase and snake_case field names — Claude settings.json has used both across versions.
    const availableModels = readStringArray(parsed.availableModels ?? parsed.available_models);
    const modelOverrides = parsed.modelOverrides ?? parsed.model_overrides;
    const overrideModels = isRecord(modelOverrides)
      ? Object.entries(modelOverrides)
          .map(([key, value]) =>
            normalizeClaudeCodeModel(isRecord(value) ? { id: key, ...value } : key, "settings"),
          )
          .filter((model): model is ClaudeCodeModel => Boolean(model))
      : [];
    return {
      path,
      model: readString(parsed.model ?? parsed.defaultModel ?? parsed.default_model),
      effortLevel: readString(parsed.effortLevel ?? parsed.effort_level),
      availableModels,
      models: overrideModels,
      env: isRecord(parsed.env) ? parsed.env : undefined,
      modelSettings: isRecord(parsed.modelSettings) ? parsed.modelSettings : undefined,
      maxEffortLevel: readString(parsed.maxEffortLevel),
    };
  } catch {
    return null;
  }
}

function readEffectiveClaudeSettings(
  options: DiscoverClaudeCodeCapabilitiesOptions,
): ClaudeSettingsInfo | null {
  // An explicit path (including null) is also the isolation boundary for callers/tests.
  if (options.settingsPath !== undefined) return readClaudeSettings(options.settingsPath);
  const managedPath =
    process.platform === "win32"
      ? join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json")
      : process.platform === "darwin"
        ? "/Library/Application Support/ClaudeCode/managed-settings.json"
        : "/etc/claude-code/managed-settings.json";
  const sources = [
    readClaudeSettings(undefined),
    readClaudeSettings(join(options.cwd, ".claude", "settings.json")),
    readClaudeSettings(join(options.cwd, ".claude", "settings.local.json")),
    readClaudeSettings(managedPath),
  ].filter((source): source is ClaudeSettingsInfo => source !== null);
  return sources.reduce<ClaudeSettingsInfo | null>((previous, source) => {
    const caps = [previous?.maxEffortLevel, source.maxEffortLevel].filter((id): id is string =>
      Boolean(id),
    );
    const order = ["low", "medium", "high", "xhigh", "max"];
    return {
      ...previous,
      ...source,
      model: source.model ?? previous?.model,
      effortLevel: source.effortLevel ?? previous?.effortLevel,
      availableModels: source.availableModels ?? previous?.availableModels,
      models: source.models?.length ? source.models : previous?.models,
      env: { ...previous?.env, ...source.env },
      modelSettings: { ...previous?.modelSettings, ...source.modelSettings },
      maxEffortLevel: caps
        .filter((id) => order.includes(id))
        .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0],
    };
  }, null);
}

function applyClaudeEffortCapabilities(
  model: ClaudeCodeModel,
  cliLevels: readonly string[] | null,
  settings: ClaudeSettingsInfo | null,
): ClaudeCodeModel {
  const known = getKnownClaudeCodeEffort(model.canonicalId);
  const explicit = model.effortSource !== "fallback";
  // CLI-wide choices only establish transport support. Never use them alone
  // as model capabilities, including for unversioned fallback aliases.
  let levels = explicit
    ? [...model.effortLevels]
    : known && cliLevels
      ? known.levels.filter((id) => cliLevels.includes(id))
      : [];
  const cap = settings?.maxEffortLevel;
  const order = ["low", "medium", "high", "xhigh", "max"];
  if (cap && order.includes(cap))
    levels = levels.filter((id) => order.includes(id) && order.indexOf(id) <= order.indexOf(cap));
  if (model.reasoningControl && model.reasoningControl.kind !== "levels") levels = [];
  const perModel = settings?.modelSettings?.[model.canonicalId];
  const preferred =
    (isRecord(perModel) ? readString(perModel.effortLevel) : undefined) ??
    settings?.effortLevel ??
    (explicit ? model.defaultEffort : known?.default) ??
    "";
  const defaultEffort = levels.includes(preferred)
    ? preferred
    : explicit && levels.includes(model.defaultEffort)
      ? model.defaultEffort
      : levels.includes(known?.default ?? "")
        ? known!.default
        : (levels[0] ?? "");
  return {
    ...model,
    effortLevels: levels,
    defaultEffort,
    effortSource: explicit
      ? model.effortSource
      : levels.length
        ? "claude-code-command"
        : "fallback",
    effortVerified: explicit ? model.effortVerified : Boolean(known && cliLevels),
    reasoningControl:
      model.reasoningControl ??
      (levels.length
        ? {
            kind: "levels",
            levels: getClaudeCodeEffortLevels(levels),
            default: defaultEffort,
            transport: "parameter",
          }
        : {
            kind:
              known?.levels.length === 0 || (explicit && !levels.length)
                ? "unsupported"
                : "unknown",
          }),
  };
}

async function runClaudeCommand(
  executable: string,
  args: string[],
  cwd: string,
  runCommandImpl: CommandRunner,
  timeoutMs: number,
): Promise<CommandResult> {
  const spawnSpec = buildClaudeSpawnSpec(executable, args);
  return await runCommandImpl({
    executable: spawnSpec.executable,
    args: spawnSpec.args,
    cwd,
    timeoutMs,
  }).result;
}

function parseModelsFromJsonOutput(stdout: string): ClaudeCodeModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  const rawModels = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.models)
      ? parsed.models
      : isRecord(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : [];
  return dedupeModels(
    rawModels
      .map((raw) => normalizeClaudeCodeModel(raw, "claude-code-command"))
      .filter((model): model is ClaudeCodeModel => Boolean(model)),
  );
}

interface ClaudeCodePackageMetadataDiscovery {
  sourcePath: string;
  rawModelIds: string[];
  models: ClaudeCodeModel[];
}

function uniqueStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean)));
}

function executablePathCandidates(command: string): string[] {
  if (command.includes("/") || command.includes("\\")) return [command];
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  const candidates: string[] = [];
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      candidates.push(join(directory, `${command}${extension}`));
    }
  }
  return candidates;
}

function defaultClaudeMetadataPaths(resolvedCommand: string): string[] {
  const candidates: string[] = [];
  for (const executablePath of executablePathCandidates(resolvedCommand)) {
    candidates.push(executablePath);
    try {
      const realPath = realpathSync.native(executablePath);
      candidates.push(realPath);
      candidates.push(join(dirname(dirname(realPath)), "package.json"));
    } catch {
      // Best effort only: package metadata discovery must never block CLI probing.
    }
  }
  return uniqueStrings(candidates);
}

function extractClaudeModelIdsFromMetadata(raw: Buffer): string[] {
  const text = raw.toString("latin1");
  const ids = new Set<string>();
  // Fresh regex per call — /g flag requires a clean lastIndex on each invocation.
  // The minor version is optional (mirrors RE_VERSIONED_ID): major-only ids like
  // claude-sonnet-5 must be discovered too. \d{1,2} keeps date suffixes
  // (claude-haiku-4-5-20251001) from being absorbed into the version.
  const pattern = new RegExp(`\\bclaude-(${CLAUDE_FAMILIES_ALT})-(\\d+)(?:-(\\d{1,2}))?\\b`, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    ids.add(match[0]);
  }
  return Array.from(ids);
}

function latestModelIdByFamily(
  modelIds: readonly string[],
): Map<string, { id: string; version: string }> {
  const result = new Map<string, { id: string; version: string }>();
  for (const id of modelIds) {
    const family = modelFamilyFromValue(id);
    const version = versionFromModelText(id);
    if (!version) continue;
    const existing = result.get(family);
    if (!existing || compareVersionStrings(version, existing.version) > 0) {
      result.set(family, { id, version });
    }
  }
  return result;
}

function aliasResolvedModel(family: string, canonicalId: string, version: string): ClaudeCodeModel {
  const alias = family;
  return {
    label: normalizeClaudeDisplayLabel(canonicalId),
    family,
    value: alias,
    canonicalId,
    source: "claude-code-package",
    version,
    isFallback: false,
    discoveryKind: "aliases",
    effortLevels: fallbackEffortIds(family),
    defaultEffort: fallbackDefaultEffort(family),
    effortSource: "fallback",
    effortVerified: false,
    description: `Claude Code alias resolved to ${canonicalId} from installed package metadata`,
  };
}

function resolveAliasModelsWithPackageMetadata(
  models: readonly ClaudeCodeModel[],
  packageMetadata: ClaudeCodePackageMetadataDiscovery | null,
): ClaudeCodeModel[] {
  if (!packageMetadata) return [...models];
  const byFamily = new Map(packageMetadata.models.map((model) => [model.family, model]));
  return models.map((model) => {
    if (!isVagueClaudeFamilyLabel(model.value) || model.version) return model;
    const resolved = byFamily.get(model.family);
    if (!resolved) return model;
    return model.effortSource === "fallback" && !model.reasoningControl
      ? resolved
      : {
          ...model,
          canonicalId: resolved.canonicalId,
          version: resolved.version,
          label: resolved.label,
        };
  });
}

function allModelsHaveKnownVersions(models: readonly ClaudeCodeModel[]): boolean {
  return models.length > 0 && models.every((model) => Boolean(model.version));
}

/**
 * Reads native Claude package metadata as a discovery source without submitting a model prompt.
 */
export function discoverModelsFromClaudePackageMetadata(
  resolvedCommand: string,
  metadataPaths?: readonly string[],
): ClaudeCodePackageMetadataDiscovery | null {
  const paths = metadataPaths
    ? uniqueStrings(metadataPaths)
    : defaultClaudeMetadataPaths(resolvedCommand);

  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const rawModelIds = extractClaudeModelIdsFromMetadata(readFileSync(path));
      const latestByFamily = latestModelIdByFamily(rawModelIds);
      const models = CLAUDE_MODEL_FAMILIES.map((family) => {
        const latest = latestByFamily.get(family);
        return latest ? aliasResolvedModel(family, latest.id, latest.version) : null;
      }).filter((model): model is ClaudeCodeModel => Boolean(model));
      if (models.length > 0) {
        return {
          sourcePath: path,
          rawModelIds,
          models,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Claude Code CLI does not consistently advertise JSON model listing in its help text,
// so we probe these well-known command shapes directly first, before falling back to
// help-text analysis. Each probe fails fast (non-zero exit) if unsupported.
const PROBE_MODEL_LIST_ARGS: string[][] = [
  ["model", "list", "--json"],
  ["models", "--json"],
  ["models", "list", "--json"],
];

function candidateModelListArgs(helpOutput: string): string[][] {
  const text = helpOutput.toLowerCase();
  const candidates: string[][] = [];
  if (/model\s+list/.test(text) && /--json/.test(text)) {
    candidates.push(["model", "list", "--json"]);
  }
  if (/models\s+list/.test(text) && /--json/.test(text)) {
    candidates.push(["models", "list", "--json"]);
  }
  if (/\bmodels\b/.test(text) && /--json/.test(text)) {
    candidates.push(["models", "--json"]);
  }
  return candidates;
}

async function discoverModelsFromClaudeHelp(
  executable: string,
  cwd: string,
  runCommandImpl: CommandRunner,
  timeoutMs: number,
  rootHelpText: string,
): Promise<ClaudeCodeModel[]> {
  // Step 1: try well-known command shapes directly, without requiring the help text
  // to advertise them. Claude Code CLI versions vary in whether (and how) they expose
  // a model list command — probing directly is more reliable than help-text detection.
  const triedArgKeys = new Set<string>();
  for (const args of PROBE_MODEL_LIST_ARGS) {
    triedArgKeys.add(args.join("\0"));
    const result = await runClaudeCommand(executable, args, cwd, runCommandImpl, timeoutMs);
    if (result.status === "completed" && result.exitCode === 0) {
      const models = parseModelsFromJsonOutput(result.stdout);
      if (models.length > 0) return models;
    }
  }

  // Step 2: fall through to help-text-based detection as a supplementary strategy
  // for future Claude Code versions that advertise additional model-list commands.
  const modelHelpResult = await runClaudeCommand(
    executable,
    ["model", "--help"],
    cwd,
    runCommandImpl,
    timeoutMs,
  );
  const candidates = [
    ...candidateModelListArgs(rootHelpText),
    ...[modelHelpResult].flatMap((result) =>
      result.status === "completed" && result.exitCode === 0
        ? candidateModelListArgs(`${result.stdout}\n${result.stderr}`)
        : [],
    ),
  ];

  for (const args of candidates) {
    if (triedArgKeys.has(args.join("\0"))) continue; // skip already-probed commands
    const result = await runClaudeCommand(executable, args, cwd, runCommandImpl, timeoutMs);
    if (result.status !== "completed" || result.exitCode !== 0) continue;
    const models = parseModelsFromJsonOutput(result.stdout);
    if (models.length > 0) return models;
  }
  return [];
}

/**
 * Adapts native Claude discovery records into shared models while retaining reasoning
 * provenance.
 */
export function claudeCodeModelsToProviderModels(
  models: readonly ClaudeCodeModel[],
): readonly ProviderModel[] {
  return models.map((model) => ({
    id: model.value,
    modelId: model.value,
    label: model.label,
    description:
      model.description ??
      (model.source === "fallback"
        ? `${model.label} - Fallback defaults${model.effortVerified ? "" : "; effort metadata unverified"}`
        : model.source === "settings" ||
            model.source === "config" ||
            model.source === "claude-code-config"
          ? `${model.label} - From Claude settings`
          : `${model.label} - ${model.discoveryKind === "aliases" ? "Claude Code alias resolved" : "Discovered from Claude Code"} (${model.source})`),
    defaultReasoningLevel: model.effortLevels.length ? model.defaultEffort : null,
    supportedReasoningLevels: getClaudeCodeEffortLevels(model.effortLevels),
    reasoningControl:
      model.reasoningControl ??
      (model.effortLevels.length
        ? {
            kind: "levels",
            levels: getClaudeCodeEffortLevels(model.effortLevels),
            default: model.defaultEffort,
            transport: "parameter",
          }
        : { kind: "unknown" }),
    source: model.source,
    canonicalId: model.canonicalId,
    family: model.family,
    version: model.version,
    isFallback: model.isFallback,
    discoveryKind: model.discoveryKind,
    effortSource: model.effortSource,
    effortVerified: model.effortVerified,
  }));
}

/**
 * Combines bounded native probes, settings and installed package metadata, degrading to explicit
 * fallback records when discovery is unavailable.
 */
export async function discoverClaudeCodeCapabilities(
  options: DiscoverClaudeCodeCapabilitiesOptions,
): Promise<ClaudeCodeCapabilityDiscovery> {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const resolvedCommand = await resolveClaudeExecutable({
    runCommandImpl: options.runCommandImpl,
    cwd: options.cwd,
    configuredPath: options.configuredPath,
  });

  const authResult = await runClaudeCommand(
    resolvedCommand,
    ["auth", "status"],
    options.cwd,
    runCommandImpl,
    timeoutMs,
  );
  const authJson =
    authResult.status === "completed" && authResult.exitCode === 0
      ? parseClaudeAuthStatus(authResult.stdout)
      : null;
  const auth: ClaudeCodeAuthInfo = authJson?.loggedIn === true ? authJson : { loggedIn: false };

  const settings = readEffectiveClaudeSettings(options);
  const helpResult = await runClaudeCommand(
    resolvedCommand,
    ["--help"],
    options.cwd,
    runCommandImpl,
    timeoutMs,
  );
  const helpText =
    helpResult.status === "completed" && helpResult.exitCode === 0
      ? `${helpResult.stdout}\n${helpResult.stderr}`
      : "";
  const cliEffortLevels = parseClaudeEffortLevelsFromHelp(helpText);
  const discoveredModels = await discoverModelsFromClaudeHelp(
    resolvedCommand,
    options.cwd,
    runCommandImpl,
    timeoutMs,
    helpText,
  );
  const packageMetadata = discoverModelsFromClaudePackageMetadata(
    resolvedCommand,
    options.metadataPaths,
  );

  let modelSource: ClaudeCodeModelSource = "fallback";
  let models: ClaudeCodeModel[] = fallbackClaudeModels();

  if (discoveredModels.length > 0) {
    const resolvedModels = resolveAliasModelsWithPackageMetadata(discoveredModels, packageMetadata);
    modelSource =
      allModelsHaveKnownVersions(resolvedModels) &&
      resolvedModels.some((model) => model.source === "claude-code-package")
        ? "claude-code-package"
        : "claude-code-command";
    models = resolvedModels;
  } else if (packageMetadata?.models && packageMetadata.models.length > 0) {
    modelSource = "claude-code-package";
    models = packageMetadata.models;
  } else if (settings?.models && settings.models.length > 0) {
    modelSource = "settings";
    models = [...settings.models];
  } else if (settings?.availableModels && settings.availableModels.length > 0) {
    modelSource = "settings";
    models = settings.availableModels
      .map((model) => normalizeClaudeCodeModel(model, "settings"))
      .filter((model): model is ClaudeCodeModel => Boolean(model));
  }

  if (
    settings?.model &&
    !models.some(
      (model) =>
        model.value === settings.model ||
        model.canonicalId === settings.model ||
        model.family === settings.model,
    )
  ) {
    const settingsModel = normalizeClaudeCodeModel(settings.model, "settings");
    if (settingsModel) {
      models = [settingsModel, ...models];
      if (modelSource === "fallback") modelSource = "settings";
    }
  }

  models = applyAvailableModelAllowlist(dedupeModels(models), settings?.availableModels);
  models = models.map((model) => {
    const pinKey = `ANTHROPIC_DEFAULT_${model.family.toUpperCase()}_MODEL`;
    const pinned = readString(settings?.env?.[pinKey]) ?? readString(process.env[pinKey]);
    const thirdParty =
      /bedrock|vertex|foundry/i.test(auth.apiProvider ?? "") ||
      ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
        (key) => process.env[key] === "1" || settings?.env?.[key] === "1",
      );
    if (isVagueClaudeFamilyLabel(model.value) && (pinned || thirdParty)) {
      const canonicalId = pinned ?? model.value;
      model = {
        ...model,
        canonicalId,
        version: versionFromModelText(canonicalId) ?? undefined,
        label: normalizeClaudeDisplayLabel(canonicalId),
      };
    }
    return applyClaudeEffortCapabilities(model, cliEffortLevels, settings);
  });

  return {
    provider: "anthropic",
    backend: "claude-code-cli",
    resolvedCommand,
    auth,
    models,
    modelSource,
    discoveredAt: (options.now?.() ?? new Date()).toISOString(),
    ...(settings
      ? {
          settings: {
            path: settings.path,
            ...(settings.model ? { model: settings.model } : {}),
            ...(settings.effortLevel ? { effortLevel: settings.effortLevel } : {}),
            ...(settings.availableModels ? { availableModels: settings.availableModels } : {}),
          },
        }
      : {}),
    diagnostics: {
      authExitCode: authResult.exitCode,
      authStatus: authResult.status,
      authJsonParsed: authJson !== null,
      loggedIn: auth.loggedIn,
      permissionPromptsSupported: /--permission-prompts\b/.test(helpText),
      // Unknown help (empty) leaves both unset so callers keep their defaults.
      ...(helpText
        ? {
            hostApprovalsSupported: claudeHelpSupportsHostApprovals(helpText),
            permissionModes: parseClaudePermissionModesFromHelp(helpText)?.join(",") ?? null,
          }
        : {}),
      modelSource,
      settingsPath: settings?.path ?? null,
      packageMetadataPath: packageMetadata?.sourcePath ?? null,
      packageMetadataModelCount: packageMetadata?.rawModelIds.length ?? 0,
      rawPackageModelIds: packageMetadata?.rawModelIds.slice(0, 12).join(",") ?? null,
    },
  };
}

/** Resolves a supported default effort for a discovered Claude model or its native alias. */
export function getClaudeModelDefaultEffort(
  modelId: string,
  models: readonly ProviderModel[],
): string {
  const model = findClaudeModel(modelId, models);
  return model?.defaultReasoningLevel ?? "medium";
}

/**
 * Checks effort support against native discovery metadata rather than assuming all models share
 * controls.
 */
export function modelSupportsClaudeEffort(
  modelId: string,
  effort: string | null | undefined,
  models: readonly ProviderModel[],
): boolean {
  if (!effort) return false;
  const model = findClaudeModel(modelId, models);
  if (model?.reasoningControl)
    return (
      model.reasoningControl.kind === "levels" &&
      model.reasoningControl.levels.some((level) => level.id === effort)
    );
  return Boolean(model?.supportedReasoningLevels?.some((level) => level.id === effort));
}

/** Exact native identities win; a versioned model never borrows a family's levels. */
export function findClaudeModel(
  modelId: string,
  models: readonly ProviderModel[],
): ProviderModel | undefined {
  const normalized = modelId.toLowerCase();
  return (
    models.find(
      (item) => item.modelId.toLowerCase() === normalized || item.id.toLowerCase() === normalized,
    ) ??
    models.find((item) => item.canonicalId?.toLowerCase() === normalized) ??
    (isVagueClaudeFamilyLabel(normalized)
      ? models.find((item) => item.family?.toLowerCase() === normalized)
      : undefined)
  );
}
