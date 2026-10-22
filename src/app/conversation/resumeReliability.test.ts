import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../../test/environment.js";

for (const scenario of ["picker", "cancel", "recovery-failure", "save-failure"]) {
  test(`actual App resume: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "ubume-resume-app-"));
    const workspace = join(root, "workspace with spaces");
    mkdirSync(workspace);
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../../test/fixtures/resumeReliabilityApp.tsx", import.meta.url)),
          scenario,
        ],
        {
          cwd: workspace,
          env: createTestEnvironment(root, { CODEX_WORKSPACE_ROOT: workspace }),
          encoding: "utf8",
          timeout: 20000,
        },
      );
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${result.error ?? ""}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
