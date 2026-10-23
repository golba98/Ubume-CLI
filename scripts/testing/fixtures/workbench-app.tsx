// Deterministic UI fixture for smoke-workbench.py; never calls a real provider.
import { render } from "ink";
import { writeFileSync } from "node:fs";
import { App } from "../../../src/app/App.js";
import { parseLaunchArgs } from "../../../src/config/launchArgs.js";
import type { BackendProvider } from "../../../src/core/providers/types.js";
if (process.env.UBUME_SMOKE_WORKSPACE !== process.cwd()) throw new Error("Run through smoke-workbench.py in its temporary workspace.");
let turn = 0;
const provider: BackendProvider = {
  id: "codex-subprocess", label: "Smoke fixture", description: "Deterministic fixture", authState: "delegated", authLabel: "fixture", statusMessage: "fixture", supportsModels: () => true,
  run(_prompt, _options, handlers) {
    const current = ++turn;
    let stopped!: () => void; let ended = false;
    handlers.onRunControl?.({ stopped: new Promise<void>((resolve) => { stopped = resolve; }) });
    const activity = { id: `tool-${current}`, command: "cat demo.ts", startedAt: Date.now() };
    handlers.onToolActivity?.({ ...activity, status: "running" });
    const timer = setTimeout(() => {
      writeFileSync("demo.ts", `export const result = ${current};\n`);
      handlers.onToolActivity?.({ ...activity, status: "completed", completedAt: Date.now(), output: "export const result = 1;\n", summary: "Read demo.ts" });
      handlers.onAssistantDelta?.("Updated demo.ts. You can review the change with /diff.");
      ended = true; stopped(); handlers.onResponse("Updated demo.ts. You can review the change with /diff.");
    }, 1800);
    return () => { if (ended) return; clearTimeout(timer); ended = true; stopped(); };
  },
};
const args = parseLaunchArgs(["--model", "gpt-5.4", "--no-clear"]);
if (!args.ok) throw new Error(args.error);
render(<App launchArgs={args.value} providerOverride={provider} />, { exitOnCtrlC: false, patchConsole: false });
