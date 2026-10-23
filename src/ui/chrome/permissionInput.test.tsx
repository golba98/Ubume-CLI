import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createTestTerminal } from "../../test/terminal.js";
import { createTerminalViewport } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import { BottomComposer } from "./BottomComposer.js";
import { measureBottomComposerRows } from "./composer/composerModel.js";

test("permission lock blocks composer synchronously, before React focus and screen effects", async () => {
  const blocked: { current: unknown } = { current: null };
  let submissions = 0;
  let changes = 0;
  let pickers = 0;
  const props = {
    layout: createTerminalViewport(100, 22),
    uiState: { kind: "THINKING" as const, turnId: 1 },
    value: "retained draft",
    cursor: 14,
    inputBlocked: blocked,
    onChangeInput: () => changes++,
    onSubmit: () => submissions++,
    onCancel: () => {},
    onHistoryUp: () => {},
    onHistoryDown: () => {},
    onOpenModelPicker: () => pickers++,
    onCycleMode: () => {},
    onQuit: () => {},
    activeProviderId: "anthropic",
  };
  const node = (pending = false) => (
    <ThemeProvider>
      <BottomComposer {...props} permissionPending={pending} inputEnabled={!pending} />
    </ThemeProvider>
  );
  const t = createTestTerminal(node());
  try {
    await sleep(30);
    blocked.current = { pending: true };
    for (const key of ["j", "1", "\r", "\x1b[B", "\x0f"]) {
      t.stdin.write(key);
      await sleep(15);
    }
    expect(submissions).toBe(0);
    expect(changes).toBe(0);
    expect(pickers).toBe(0);
    t.instance.rerender(node(true));
    await sleep(25);
    expect(t.lastFrame()).toContain("Awaiting permission");
    expect(t.lastFrame()).toContain("retained draft");
    expect(t.lastFrame()).not.toContain("Enter queue");
    expect(t.lastFrame()).not.toContain("is working");
    expect(measureBottomComposerRows({ ...props, permissionPending: true })).toBe(2);
  } finally {
    await t.dispose();
  }
});
