import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Text } from "ink";
import { selectedToolApprovalAction } from "../../core/providers/toolApproval.js";
import type { ToolApprovalRequest, ToolApprovalSelection } from "../../core/providers/types.js";
import { getTextWidth } from "../../core/shared/text.js";
import { createTestTerminal } from "../../test/terminal.js";
import { AppShell } from "../chrome/AppShell.js";
import { createTerminalViewport } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import { ToolApprovalPanel } from "./ToolApprovalPanel.js";
import { visibleApprovalText, wrapApprovalText } from "./toolApprovalLayout.js";

const command: ToolApprovalRequest = {
  requestId: "request-a",
  tool: "Bash",
  signature: "Bash:x",
  paths: [],
  provider: "Claude Code",
  kind: "command",
  description: "Recheck biome distribution after threshold change",
  command:
    "cp \"/home/k9-vortex/Development/1-JavaScript/23-Ubume Minecraft tester/2-Claude/src/worldgen.js\" /tmp/vox-test/src/ && cd /tmp/vox-test && node dist.mjs 2>&1 | sed -n '5,14p'",
  workspace: "/home/me/project",
  reason: "Command is not read-only",
};

async function harness(request = command, columns = 100, rows = 22) {
  const selections: ToolApprovalSelection[] = [];
  let current = request;
  const node = () => (
    <ThemeProvider theme="mono">
      <AppShell
        layout={createTerminalViewport(columns, rows)}
        screen="tool-approval"
        authState="authenticated"
        workspaceLabel="fixture"
        staticEvents={[]}
        activeEvents={[]}
        uiState={{ kind: "THINKING", turnId: 1 }}
        panel={
          <ToolApprovalPanel
            focusId="permission"
            request={current}
            onSelect={(result) => selections.push(result)}
          />
        }
        composer={<Text>Awaiting permission</Text>}
        composerRows={2}
      />
    </ThemeProvider>
  );
  const terminal = createTestTerminal(node(), { columns, rows });
  await sleep(30);
  await terminal.instance.waitUntilRenderFlush();
  return {
    terminal,
    selections,
    frame: terminal.lastFrame,
    async press(key: string) {
      terminal.stdin.write(key);
      await sleep(25);
      await terminal.instance.waitUntilRenderFlush();
    },
    async update(next = current, cols = columns, height = rows) {
      current = next;
      columns = cols;
      rows = height;
      terminal.stdout.columns = cols;
      terminal.stdout.rows = height;
      terminal.instance.rerender(node());
      await sleep(25);
      await terminal.instance.waitUntilRenderFlush();
    },
    decision: () => selectedToolApprovalAction(current, selections.at(-1))?.decision ?? "deny",
  };
}

for (const [columns, rows] of [
  [60, 16],
  [80, 24],
  [100, 22],
  [120, 30],
  [160, 40],
]) {
  test(`all Claude decisions, title, selection and help survive ${columns}x${rows}`, async () => {
    const h = await harness(command, columns, rows);
    try {
      expect(h.frame()).toContain("CLAUDE CODE PERMISSION");
      expect(h.frame()).toContain("> 1. Allow once");
      expect(h.frame()).toContain("2. Allow this exact action for this run");
      expect(h.frame()).toContain("3. Deny");
      expect(h.frame()).toContain("Esc deny");
      expect(h.frame().split("\n").length).toBeLessThanOrEqual(rows);
      for (const line of h.frame().split("\n"))
        expect(getTextWidth(line)).toBeLessThanOrEqual(columns);
      await h.press("1");
      expect(h.decision()).toBe("allow-once");
    } finally {
      await h.terminal.dispose();
    }
  });
}

for (const count of [1, 2, 3, 6, 12]) {
  test(`${count} native actions use sequential rows and exact IDs`, async () => {
    const actions = Array.from({ length: count }, (_, i) => ({
      id: `native-${100 + i}`,
      label: `Native choice ${i + 1}`,
      decision: "allow-once" as const,
    }));
    const request = { ...command, actions };
    const h = await harness(request, 60, 16);
    try {
      expect(h.frame()).toContain("> 1. Native choice 1");
      expect(h.frame()).toContain(
        count === 1 ? "Enter or 1 select" : `Enter or 1–${Math.min(9, count)} select`,
      );
      for (let i = 1; i < count; i++) await h.press("j");
      expect(h.frame()).toContain(`> ${count}. Native choice ${count}`);
      await h.press("\r");
      expect(h.selections).toEqual([
        { requestId: request.requestId!, actionId: actions.at(-1)!.id },
      ]);
    } finally {
      await h.terminal.dispose();
    }
  });
}

test("filtered run scope becomes 1 Allow once / 2 Deny, including numeric dispatch", async () => {
  const h = await harness({ ...command, allowForRun: false });
  try {
    expect(h.frame()).toContain("1. Allow once");
    expect(h.frame()).toContain("2. Deny");
    expect(h.frame()).not.toContain("3.");
    expect(h.frame()).toContain("Enter or 1–2");
    await h.press("3");
    expect(h.selections).toEqual([]);
    await h.press("2");
    expect(h.decision()).toBe("deny");
  } finally {
    await h.terminal.dispose();
  }
});

for (const [keys, expected] of [
  ["\x1b[B", 2],
  ["j", 2],
  ["k", 1],
  ["\x1b[A", 1],
] as const) {
  test(`navigation ${JSON.stringify(keys)} clamps and Enter confirms visible choice`, async () => {
    const h = await harness();
    try {
      await h.press(keys);
      expect(h.frame()).toContain(`> ${expected}.`);
      await h.press("\r");
      expect(h.selections[0]?.actionId).toBe(expected === 1 ? "allow-once" : "allow-for-run");
      await h.press("\r");
      expect(h.selections.length).toBe(1);
    } finally {
      await h.terminal.dispose();
    }
  });
}

test("resize preserves selection, reflows evidence, and never responds; a new request resets", async () => {
  const h = await harness();
  try {
    await h.press("j");
    for (const [cols, rows] of [
      [60, 16],
      [160, 40],
      [80, 24],
      [100, 22],
    ]) {
      await h.update(command, cols, rows);
      expect(h.frame()).toContain("> 2. Allow this exact action");
      expect(h.selections).toEqual([]);
    }
    await h.update({ ...command, requestId: "request-b" });
    expect(h.frame()).toContain("> 1. Allow once");
    await h.press("\x1b");
    expect(h.selections).toEqual([{ requestId: "request-b", actionId: null }]);
  } finally {
    await h.terminal.dispose();
  }
});

test("long evidence has accessible final arguments and scroll instructions", async () => {
  const h = await harness(
    {
      ...command,
      command: "雪👩🏽‍💻é".repeat(200) + " FINAL_ARGUMENT",
      description: "description\nsecond line",
      workspace: undefined,
      reason: undefined,
    },
    60,
    16,
  );
  try {
    expect(h.frame()).toContain("PgUp/PgDn");
    await h.press("\x1b[F");
    expect(h.frame()).toContain("FINAL_ARGUMENT");
    expect(h.frame()).toContain("1. Allow once");
    await h.press("\x1b[H");
    expect(h.frame()).toContain("Claude Code wants to");
    expect(h.selections).toEqual([]);
  } finally {
    await h.terminal.dispose();
  }
});

test("empty or malformed options render safe unavailable state", async () => {
  for (const actions of [
    [],
    [
      { id: "duplicate", label: "One", decision: "allow-once" as const },
      { id: "duplicate", label: "Two", decision: "deny" as const },
    ],
  ]) {
    const h = await harness({ ...command, actions });
    try {
      expect(h.frame()).toContain("No supported actions");
      await h.press("1");
      expect(h.selections).toEqual([]);
      await h.press("\r");
      expect(h.selections[0]?.actionId).toBeNull();
    } finally {
      await h.terminal.dispose();
    }
  }
});

test("approval wrapping preserves every printable source character and inertly exposes controls", () => {
  const source = 'cp "雪👩🏽‍💻é long  quoted path" && ' + "x".repeat(200) + " | sed -n '5,14p'";
  for (const width of [2, 10, 54, 76, 96]) {
    const lines = wrapApprovalText(source, width);
    expect(lines.join("")).toBe(source);
    if (width > 2) for (const line of lines) expect(getTextWidth(line)).toBeLessThanOrEqual(width);
  }
  expect(wrapApprovalText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  expect(visibleApprovalText("\x1b[31mCOMMAND\t\r\x1b[0m")).toBe("\\x1b[31mCOMMAND\\t\\r\\x1b[0m");
});

test("a batched Return burst confirms exactly once", async () => {
  const h = await harness();
  try {
    await h.press("\r\r");
    expect(h.selections).toEqual([{ requestId: "request-a", actionId: "allow-once" }]);
  } finally {
    await h.terminal.dispose();
  }
});

test("an exceptionally long native label stays fully accessible in details", async () => {
  const h = await harness(
    {
      ...command,
      actions: [
        {
          id: "long",
          decision: "allow-once",
          label: "Detailed native scope ".repeat(50) + "EXACT_SCOPE_END",
        },
      ],
    },
    60,
    16,
  );
  try {
    await h.press("\x1b[F");
    expect(h.frame()).toContain("EXACT_SCOPE_END");
    expect(h.selections).toEqual([]);
  } finally {
    await h.terminal.dispose();
  }
});
