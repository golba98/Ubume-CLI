/** Invalid fixture invocations must fail before reaching a provider or real user data. */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../environment.js";

for (const scenario of [
  {
    name: "rejects an unsupported resume backend",
    fixture: "localResume.ts",
    args: ["unknown", "1"],
    diagnostic: "localResume requires backend lm-studio or unsloth",
  },
  {
    name: "rejects a fractional resume turn",
    fixture: "localResume.ts",
    args: ["lm-studio", "1.5"],
    diagnostic: "localResume requires a positive integer turn number",
  },
  {
    name: "explains a missing saved conversation",
    fixture: "localResume.ts",
    args: ["lm-studio", "2"],
    diagnostic: "Cannot resume turn 2: no saved conversation",
  },
  {
    name: "rejects an AGY prompt flag without a value",
    fixture: "antigravityProvider.mjs",
    args: ["-p"],
    diagnostic: "AGY fixture requires a value for -p",
  },
  {
    name: "rejects a headless prompt flag without a value",
    fixture: "headlessProvider.mjs",
    args: ["-p"],
    diagnostic: "Headless provider fixture requires a prompt after -p",
  },
]) {
  test(scenario.name, () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-fixture-invalid-"));
    try {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL(scenario.fixture, import.meta.url)), ...scenario.args],
        {
          cwd: root,
          env: createTestEnvironment(root),
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain(scenario.diagnostic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
