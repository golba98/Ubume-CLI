#!/usr/bin/env node
/**
 * Creates the local Codexa native-model registry
 * (`artifacts.codexa-native.local.json`) from a verified inventory.
 *
 * Safety contract:
 *   - Reads only the inventory JSON and checkpoint sidecar files; verifies each
 *     inventory hash against its `.sha256` sidecar. The native loader verifies full
 *     checkpoint hashes before loading.
 *   - Never copies, moves or rewrites checkpoints or tokenizers.
 *   - Refuses to overwrite an existing registry that differs (inspect it manually
 *     instead of silently replacing it); writes with `wx` (no clobber) and mode
 *     0600.
 *
 * Usage: node scripts/configure-codexa-native.mjs [--model-root PATH] [--inventory PATH]
 */

import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("node scripts/configure-codexa-native.mjs [--model-root PATH] [--inventory PATH]\nReads the verified existing Codexa inventory and creates only artifacts.codexa-native.local.json; never copies checkpoints.");
  process.exit(0);
}

const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const root = realpathSync(
  option("--model-root")
    || process.env.CODEXA_NATIVE_MODEL_ROOT
    || join(homedir(), "Development", "3-Python", "37-LLM From Scratch (PyTorch Codexa v1)", "LLM-From-Scratch"),
);
const inventoryPath = option("--inventory")
  || join(root, "outputs", "diagnosis", "codexa-934m-foundation-20261011-v1", "job-v2", "plan.json");

const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const models = {};

// Inventory key -> registry suffix for the five verified checkpoints.
const names = { base: "base", repair: "repair", balanced: "balanced", original_2h: "original-2h", END3: "end3" };

for (const [key, suffix] of Object.entries(names)) {
  const item = inventory.candidates?.[key];
  if (!item || typeof item.path !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)) {
    throw new Error(`Missing verified inventory identity for ${key}`);
  }
  if (!existsSync(item.path)) throw new Error(`Checkpoint is unavailable: ${key}`);
  const fields = readFileSync(`${item.path}.sha256`, "utf8").trim().split(/\s+/);
  if (fields[0] !== item.sha256) throw new Error(`Checkpoint sidecar differs from inventory: ${key}`);
  models[`codexa-934m-${suffix}`] = { path: realpathSync(item.path), sha256: item.sha256 };
}

if (!existsSync(inventory.tokenizer_path) || !/^[0-9a-f]{64}$/.test(inventory.tokenizer_sha256)) {
  throw new Error("Tokenizer inventory is unavailable.");
}

const destination = join(root, "artifacts.codexa-native.local.json");
const data = {
  format: "codexa-native-registry-v1",
  tokenizer: realpathSync(inventory.tokenizer_path),
  tokenizer_sha256: inventory.tokenizer_sha256,
  models,
  provenance: {
    inventory: inventoryPath,
    verification: "inventory and sidecars; full hashes are verified before native model loading",
  },
};

if (existsSync(destination)) {
  if (JSON.stringify(JSON.parse(readFileSync(destination, "utf8"))) !== JSON.stringify(data)) {
    throw new Error("Existing local registry differs; inspect it instead of silently replacing it.");
  }
} else {
  writeFileSync(destination, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

console.log(`Configured five local checkpoints: ${destination}\nLaunch with bun run dev:run; choose Codexa Native, then Select model.`);
