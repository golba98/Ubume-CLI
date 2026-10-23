import { expect, test } from "bun:test";
import { Text } from "ink";
import type { Screen, TimelineEvent } from "../../session/types.js";
import { createTestTerminal } from "../../test/terminal.js";
import { createTerminalViewport } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import { AppShell } from "./AppShell.js";

test("overlay-only shells never measure hidden history, and legacy timelines freeze until visible", async () => {
  let reads = 0;
  const events: TimelineEvent[] = [
    {
      id: 1,
      type: "user",
      turnId: 1,
      createdAt: 0,
      get prompt() {
        reads++;
        return "HISTORY_PROMPT";
      },
    },
    {
      id: 2,
      type: "assistant",
      contentChunks: [],
      turnId: 1,
      createdAt: 1,
      get content() {
        reads++;
        return "HISTORY_ANSWER";
      },
    },
  ];
  const node = (screen: Screen, cols = 100, rows = 22) => (
    <ThemeProvider theme="purple">
      <AppShell
        layout={createTerminalViewport(cols, rows)}
        screen={screen}
        authState="authenticated"
        workspaceLabel="fixture"
        staticEvents={events}
        activeEvents={[]}
        uiState={{ kind: "IDLE" }}
        panel={<Text>Resume fixture</Text>}
        composer={<Text>Prompt fixture</Text>}
        composerRows={1}
      />
    </ThemeProvider>
  );
  const terminal = createTestTerminal(node("resume-picker"));
  try {
    await terminal.instance.waitUntilRenderFlush();
    for (const [cols, rows] of [
      [160, 40],
      [60, 20],
      [100, 22],
    ]) {
      terminal.stdout.columns = cols!;
      terminal.stdout.rows = rows!;
      terminal.instance.rerender(node("resume-picker", cols, rows));
      await terminal.instance.waitUntilRenderFlush();
    }
    expect(reads).toBe(0);
    terminal.instance.rerender(node("main"));
    await terminal.instance.waitUntilRenderFlush();
    expect(reads).toBeGreaterThan(0);
    terminal.instance.rerender(node("resume-picker"));
    await terminal.instance.waitUntilRenderFlush();
    reads = 0;
    terminal.stdout.columns = 60;
    terminal.stdout.rows = 20;
    terminal.instance.rerender(node("resume-picker", 60, 20));
    await terminal.instance.waitUntilRenderFlush();
    expect(reads).toBe(0);
    terminal.instance.rerender(node("main", 60, 20));
    await terminal.instance.waitUntilRenderFlush();
    expect(reads).toBeGreaterThan(0);
  } finally {
    await terminal.dispose();
  }
});
