import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../test/environment.js";

function scenarios(steps: string[]) {
  const root = mkdtempSync(join(tmpdir(), "ubume-app-resume-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const script = fileURLToPath(new URL("../test/fixtures/workbenchApp.tsx", import.meta.url));
  try {
    for (const scenario of steps) {
      if (scenario === "headless") {
        const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
        const id = readdirSync(join(root, "data/chats", key, "conversations"))[0]!;
        const launcher = fileURLToPath(new URL("../../bin/ubume.js", import.meta.url));
        const provider = fileURLToPath(
          new URL("../test/fixtures/headlessProvider.mjs", import.meta.url),
        );
        const result = spawnSync(
          "node",
          [launcher, "exec", "--resume", id, "headless continuation", "--json"],
          {
            cwd: workspace,
            env: createTestEnvironment(root, {
              UBUME_DATA_DIR: join(root, "data"),
              CODEXA_DATA_DIR: join(root, "data"),
              CODEX_EXECUTABLE: provider,
            }),
            encoding: "utf8",
            timeout: 15000,
          },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).data.sessionId, id);
        continue;
      }
      const result = spawnSync(process.execPath, [script, scenario], {
        cwd: workspace,
        env: createTestEnvironment(root, {
          UBUME_DATA_DIR: join(root, "data"),
          CODEXA_DATA_DIR: join(root, "data"),
        }),
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(
        result.status,
        0,
        `${scenario}: ${result.stderr}\n${result.stdout}\n${result.error ?? ""}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  "actual App resumes after process restart with partial transcript, draft and paused queue",
  { timeout: 30000 },
  () => scenarios(["save", "resume"]),
);
test(
  "actual App does not persist a new conversation until the first prompt is sent",
  { timeout: 30000 },
  () => scenarios(["draft-only"]),
);
test(
  "actual App queues during runs and interrupts without overlapping cleanup or losing draft",
  { timeout: 30000 },
  () => scenarios(["flow"]),
);

test(
  "saved conversation continues from TUI to terminal commands and back",
  { timeout: 30000 },
  () => scenarios(["save", "headless", "resume"]),
);

test(
  "actual App quits on a second Ctrl+C only while the exit hint is visible",
  { timeout: 30000 },
  () => scenarios(["quit"]),
);

test(
  "interrupt during checkpoint preparation does not start provider or leak execution lease",
  { timeout: 30000 },
  () => scenarios(["cancel-start"]),
);

test(
  "actual App redraws plans immediately and implements directly in Auto",
  { timeout: 30000 },
  () => scenarios(["plan-actions"]),
);

test(
  "actual App opens /usage during a run without cancelling it or sending it to the provider",
  { timeout: 30000 },
  () => scenarios(["usage-during-run"]),
);
