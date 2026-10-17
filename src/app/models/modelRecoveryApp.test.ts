import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function scenarios(steps: string[]) {
  const root = mkdtempSync(join(tmpdir(), "ubume-model-recovery-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  try {
    for (const scenario of steps) {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../../test/fixtures/modelRecoveryApp.tsx", import.meta.url)),
          scenario,
        ],
        {
          cwd,
          encoding: "utf8",
          timeout: 20000,
          env: {
            ...process.env,
            HOME: root,
            UBUME_DATA_DIR: join(root, "data"),
            CODEXA_DATA_DIR: join(root, "data"),
            CODEX_HOME: join(root, "codex"),
            UBUME_DEV_MODE: "0",
            CODEX_EXECUTABLE: join(root, "missing-codex"),
            CLAUDE_EXECUTABLE: join(root, "missing-claude"),
            AGY_EXECUTABLE: join(root, "missing-agy"),
            VIBE_EXECUTABLE: join(root, "missing-vibe"),
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            MISTRAL_API_KEY: "",
          },
        },
      );
      expect(`${result.stderr}\n${result.stdout}\n${result.error ?? ""}`).not.toContain(
        "Timed out",
      );
      expect(result.status, `${result.stderr}\n${result.stdout}\n${result.error ?? ""}`).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  "actual App: unavailable Google request → picker → working model → successful request",
  () => scenarios(["recover"]),
  25000,
);
test(
  "actual App: unavailable Google → other provider → Google → picker → successful request",
  () => scenarios(["switch-provider"]),
  25000,
);
test(
  "actual App: restart after a failed model selection preserves recovery controls",
  () => scenarios(["fail-only", "restart-recover"]),
  45000,
);
test(
  "actual App: interactive recovery supersedes the initial CLI model override",
  () => scenarios(["cli-override"]),
  25000,
);

for (const scenario of [
  "authentication",
  "rate",
  "retry-delay",
  "quota",
  "network",
  "temporary",
  "all-unavailable",
  "catalog-failure",
])
  test(
    `actual App: ${scenario} never locks provider or model navigation`,
    () => scenarios([scenario]),
    25000,
  );

test(
  "actual App: a request error cannot steal focus from an already open model picker",
  () => scenarios(["error-while-picker"]),
  25000,
);
