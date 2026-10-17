/**
 * Validation and resolution of development-only Codexa Native model paths and generation
 * settings. This module describes configuration; the runtime owns loaded worker state.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getHomeDir } from "../../config/settings.js";

export const CODEXA_TOKENIZER_SHA256 =
  "a710b68c646d4b375331f65ee164aed4456813cc1c1b7dcc7fa2bafc9450854e";
export const DEFAULT_CODEXA_NATIVE_MODEL_ROOT = join(
  getHomeDir(),
  "Development",
  "3-Python",
  "37-LLM From Scratch (PyTorch Codexa v1)",
  "LLM-From-Scratch",
);
export const CODEXA_MODELS = [
  {
    id: "codexa-934m-base",
    label: "Codexa 934M — Base",
    sha256: "808afec9923e3f00d91bcbef47643265ae5dbe6c5aeb4bd112c4e97be3d0a3a7",
  },
  {
    id: "codexa-934m-repair",
    label: "Codexa 934M — Repair",
    sha256: "c55f4edd1477a8ffefd03ce63d033a291eb261f6047b129baa47e10756899a4f",
  },
  {
    id: "codexa-934m-balanced",
    label: "Codexa 934M — Balanced",
    sha256: "a4c8c172152dd8e3ef23a7dde05bc4a4355ff548f84fc904d8d5534dd2183892",
  },
  {
    id: "codexa-934m-original-2h",
    label: "Codexa 934M — Original 2H",
    sha256: "374f3f1746b0ff0b24febc5176f3d20f5bb4ccadc3fb6aa24a120d1f31481918",
  },
  {
    id: "codexa-934m-end3",
    label: "Codexa 934M — END3",
    sha256: "4f4e5d1540eb6813ad6d6f91f1a1a503bf8952632d51f9dc6410343a8e0c456b",
  },
  {
    id: "codexa-934m-foundation-5h",
    label: "Codexa 934M — Foundation (step 1792)",
    sha256: "ca779a1640fa8f664356faf6db0897c9e9669b90a2e3ed35a7a23fc13144236e",
  },
] as const;

export interface CodexaGeneration {
  preset: "evaluation" | "conversation" | "custom";
  max_new_tokens: number;
  do_sample: boolean;
  temperature: number;
  top_p: number;
  top_k: number | null;
  repetition_penalty: number;
  seed: number;
}
export interface CodexaNativeOptions {
  modelRoot?: string;
  python?: string;
  registry?: string;
  device?: "cuda" | "cpu";
  systemPrompt?: string;
  startupTimeoutMs?: number;
  generationTimeoutMs?: number;
  generation?: Partial<CodexaGeneration>;
}
export interface CodexaNativeConfig {
  modelRoot: string;
  python: string;
  bridgeScript: string;
  registry: string;
  tokenizer: string;
  device: "cuda" | "cpu";
  checkpoints: Record<string, string>;
  configurationError?: string;
}
/** Returns the established evaluation or conversation decoding defaults. */
export function codexaPreset(
  preset: "evaluation" | "conversation" = "evaluation",
): CodexaGeneration {
  return {
    preset,
    max_new_tokens: 128,
    do_sample: preset === "conversation",
    temperature: 0.7,
    top_p: 0.9,
    top_k: null,
    repetition_penalty: 1,
    seed: 42,
  };
}
/** Resolves generation defaults and throws on unsupported or out-of-range settings. */
export function validateCodexaGeneration(value: Partial<CodexaGeneration> = {}): CodexaGeneration {
  const config = {
    ...codexaPreset(value.preset === "conversation" ? "conversation" : "evaluation"),
    ...value,
  };
  if (
    !["evaluation", "conversation", "custom"].includes(config.preset) ||
    typeof config.do_sample !== "boolean" ||
    !Number.isInteger(config.max_new_tokens) ||
    config.max_new_tokens < 1 ||
    config.max_new_tokens >= 2048 ||
    !Number.isInteger(config.seed) ||
    config.seed < 0 ||
    config.seed > 0x7fffffff ||
    !Number.isFinite(config.temperature) ||
    config.temperature <= 0 ||
    !Number.isFinite(config.top_p) ||
    config.top_p <= 0 ||
    config.top_p > 1 ||
    !Number.isFinite(config.repetition_penalty) ||
    config.repetition_penalty <= 0 ||
    (config.top_k !== null &&
      (!Number.isInteger(config.top_k) || config.top_k < 1 || config.top_k > 16384))
  ) {
    throw new Error("Invalid Codexa generation settings.");
  }
  return config;
}
/**
 * Checks native model/path options before resolving or loading a worker; invalid options throw.
 */
export function validateCodexaOptions(options: CodexaNativeOptions): void {
  for (const field of ["modelRoot", "python", "registry", "systemPrompt"] as const) {
    const value = options[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.includes("\0")))
      throw new Error(`Invalid Codexa ${field}.`);
  }
  if (options.device !== undefined && options.device !== "cuda" && options.device !== "cpu")
    throw new Error("Codexa device must be cuda or explicit cpu.");
  for (const value of [options.startupTimeoutMs, options.generationTimeoutMs]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1000 || value > 180000))
      throw new Error("Codexa timeout must be 1000–180000 ms.");
  }
  if (options.generation !== undefined) validateCodexaGeneration(options.generation);
}
/**
 * Resolves native paths from overrides/environment; invalid options or registry data populate
 * configurationError instead of throwing.
 */
export function resolveCodexaNativeConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: CodexaNativeOptions = {},
): CodexaNativeConfig {
  let optionError: string | undefined;
  try {
    validateCodexaOptions(options);
  } catch (error) {
    optionError = error instanceof Error ? error.message : String(error);
    options = {};
  }
  const modelRoot =
    options.modelRoot?.trim() ||
    env.CODEXA_NATIVE_MODEL_ROOT?.trim() ||
    DEFAULT_CODEXA_NATIVE_MODEL_ROOT;
  const registry =
    options.registry?.trim() ||
    env.CODEXA_NATIVE_REGISTRY?.trim() ||
    join(modelRoot, "artifacts.codexa-native.local.json");
  const config: CodexaNativeConfig = {
    modelRoot,
    registry,
    python:
      options.python?.trim() ||
      env.CODEXA_NATIVE_PYTHON?.trim() ||
      join(modelRoot, ".venv", "bin", "python"),
    bridgeScript: join(modelRoot, "scripts", "native_chat_bridge.py"),
    tokenizer: "",
    checkpoints: {},
    device: options.device ?? (env.CODEXA_NATIVE_DEVICE === "cpu" ? "cpu" : "cuda"),
  };
  try {
    if (optionError) throw new Error(optionError);
    if (env.CODEXA_NATIVE_DEVICE && !["cuda", "cpu"].includes(env.CODEXA_NATIVE_DEVICE))
      throw new Error("Set CODEXA_NATIVE_DEVICE to cuda or explicit cpu.");
    if (!existsSync(registry))
      throw new Error("Codexa model registry is missing. Run the documented local setup.");
    const data = JSON.parse(readFileSync(registry, "utf8"));
    if (
      data.format !== "codexa-native-registry-v1" ||
      data.tokenizer_sha256 !== CODEXA_TOKENIZER_SHA256 ||
      typeof data.tokenizer !== "string"
    )
      throw new Error("Invalid Codexa model registry or tokenizer identity.");
    config.tokenizer = resolve(modelRoot, data.tokenizer);
    for (const model of CODEXA_MODELS) {
      const item = data.models?.[model.id];
      if (item && (typeof item.path !== "string" || item.sha256 !== model.sha256))
        throw new Error(`Registry identity mismatch for ${model.id}.`);
      if (item) config.checkpoints[model.id] = resolve(modelRoot, item.path);
    }
  } catch (error) {
    config.configurationError = error instanceof Error ? error.message : String(error);
  }
  return config;
}
/** Formats the configured native model identity for display. */
export function codexaModelLabel(id: string): string {
  return CODEXA_MODELS.find((model) => model.id === id)?.label ?? id;
}
