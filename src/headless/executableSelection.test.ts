import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { clearCodexModelCapabilityCache } from "../core/models/codexModelCapabilities.js";
import { providerCatalog } from "../core/models/modelCatalog.js";
import { withEnvironment } from "../test/environment.js";
import { createOfflineSandbox } from "../test/offlineSandbox.js";
import { runTerminalCommand } from "./commands.js";

const modelServer = `
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const result = message.method === 'model/list'
    ? { data: [{ id: 'offline-model', model: 'offline-model', displayName: 'Offline', supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' }], nextCursor: null }
    : {};
  console.log(JSON.stringify({ id: message.id, result }));
});
`;

test("source headless refresh inherits the layered Codex path instead of the environment", async () => {
  const sandbox = createOfflineSandbox({ fakes: { codex: modelServer } });
  try {
    await withEnvironment(
      { ...sandbox.env, CODEX_EXECUTABLE: join(sandbox.root, "missing-env-codex") },
      async () => {
        mkdirSync(process.env.CODEX_HOME!, { recursive: true });
        writeFileSync(
          join(process.env.CODEX_HOME!, "config.toml"),
          `codex_command_path = ${JSON.stringify(sandbox.fakes.codex)}\n`,
        );
        let output = "";
        let errors = "";
        const code = await runTerminalCommand(
          ["models", "--provider", "openai", "--refresh", "--json", "--cwd", sandbox.root],
          {
            stdout: {
              write: (text) => {
                output += text;
                return true;
              },
            },
            stderr: {
              write: (text) => {
                errors += text;
                return true;
              },
            },
          },
        );
        assert.equal(code, 0, output + errors);
        assert.match(output, /offline-model/);
        sandbox.assertSpawnedOnly([sandbox.fakes.codex!]);
        assert.ok(sandbox.readSpawnLog().some((entry) => entry.argv[0] === "app-server"));
      },
    );
  } finally {
    providerCatalog.dispose();
    clearCodexModelCapabilityCache();
    sandbox.dispose();
  }
});
