import assert from "node:assert/strict";
import test from "node:test";
import { settle } from "../../test/async.js";
import { createTestTerminal } from "../../test/terminal.js";
import { PanelLayoutContext } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import type { IntroRenderTimelineItem } from "../timeline/measure/types.js";
import { LogoRenderingPanel } from "./LogoRenderingPanel.js";

const item: IntroRenderTimelineItem = {
  key: "preview",
  type: "intro",
  padded: false,
  intro: {
    version: "runtime",
    layoutMode: "regular",
    authLabel: "",
    workspaceLabel: "",
    providerLabel: "Current Provider",
    workspacePath: "~/actual-workspace",
    logoStyle: "minimal",
  },
};
for (const rows of [3, 4, 5, 6, 16])
  test(`renderer preview at ${rows} rows stays bounded and never commits on highlight/replay`, async () => {
    const chosen: string[] = [];
    let closed = false;
    const terminal = createTestTerminal(
      <ThemeProvider theme="dark">
        <PanelLayoutContext.Provider
          value={{ availableRows: rows, availableCols: 80, mode: "regular" }}
        >
          <LogoRenderingPanel
            focusId="renderer-test"
            value="auto"
            item={item}
            animation={false}
            onSelect={(value) => chosen.push(value)}
            onCancel={() => {
              closed = true;
            }}
          />
        </PanelLayoutContext.Provider>
      </ThemeProvider>,
    );
    try {
      await settle();
      terminal.stdin.write("\x1b[B");
      await settle();
      assert.deepEqual(chosen, []);
      terminal.stdin.write("r");
      await settle();
      assert.match(terminal.lastFrame(), /Current Provider/);
      assert.match(terminal.lastFrame(), /actual-workspace/);
      assert.ok(terminal.lastFrame().trimEnd().split("\n").length <= rows);
      assert.deepEqual(chosen, []);
      terminal.stdin.write("\x1b[27u");
      await settle();
      if (rows < 13) {
        assert.equal(closed, false, "Escape returns from compact preview to list");
        terminal.stdin.write("\r");
        await settle();
        assert.deepEqual(chosen, ["kitty"]);
      } else assert.equal(closed, true);
    } finally {
      await terminal.dispose();
    }
  });
