import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink";
import { ResumePicker } from "../../src/ui/panels/ResumePicker.js";
import { ThemeProvider } from "../../src/ui/theme.js";
import { PanelLayoutContext } from "../../src/ui/layout.js";
import { conversationSummary, mergeSessionSummaries } from "../../src/session/sessionCatalog.js";

// A deterministic UI recording using fictional chats; no provider calls or user data.
class Input extends PassThrough { isTTY = true; setRawMode() { return this; } ref() { return this; } unref() { return this; } }
class Output extends PassThrough { isTTY = true; columns = 100; rows = 22; }
const input = new Input(); const output = new Output();
let time = 0;
const frames: unknown[] = [{ version: 2, width: 100, height: 22, timestamp: 1790812800, title: "Ubume: provider resume and Local filters (fixture chats)", env: { TERM: "xterm-256color" } }];
output.on("data", (chunk) => { frames.push([time, "o", chunk.toString()]); time += 0.05; });
const owned = [
  ["openai", "gpt-fixture", undefined, "Fix the parser"],
  ["anthropic", "claude-fixture", undefined, "Review the changes"],
  ["local", "Ornith-1.5-35B", "lm-studio", "Build a voxel world"],
  ["local", "Qwen-fixture", "unsloth", "Continue the agent session"],
].map(([providerId, modelId, localBackend, title], index) => ({ version: 1 as const, id: `chat_fixture-${index}`, providerId: providerId!, modelId: modelId!, localBackend: localBackend as "lm-studio" | "unsloth" | undefined, title: title!, backendKind: null, workspaceRoot: "/projects/demo", createdAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-01T09:00:00Z", messageCount: 8 }));
const sessions = mergeSessionSummaries(owned.map((entry) => conversationSummary(entry, entry.workspaceRoot, "fixture")), [
  { source: "vibe", id: "native-vibe", title: "Refactor the renderer", model: "mistral-fixture", cwd: "/projects/demo", updatedAt: "2026-10-01T09:00:00Z" },
]);
const app = render(<ThemeProvider theme="purple"><PanelLayoutContext.Provider value={{ mode: "compact", availableRows: 16, availableCols: 96 }}><ResumePicker conversations={owned} loadSessions={async () => ({ sessions, errors: [] })} onSelect={() => undefined} onCancel={() => undefined} /></PanelLayoutContext.Provider></ThemeProvider>, { stdin: input as never, stdout: output as never, stderr: output as never, patchConsole: false });
const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
await pause();
for (const key of ["\x1b[C", "\x1b[C", "\x1b[C", "\x1b[C", "b", "b", "m", "\x1b[C", "a"]) { time += 1.5; input.write(key); await pause(); }
time += 2; app.unmount();
const directory = join(import.meta.dir, "..", "..", "docs", "terminal", "recordings"); mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, "provider-resume.cast"), frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
