import assert from "node:assert/strict";
import test from "node:test";
import { useState } from "react";
import { getTextWidth } from "../core/shared/text.js";
import { isTerminalResizing } from "../core/terminal/terminalControl.js";
import { captureReferenceScreen, ReferenceScreen } from "../test/fixtures/responsiveLayout.js";
import { createTestTerminal } from "../test/terminal.js";
import { useTerminalViewport } from "./layout.js";

const MATRIX = [
  [100, 22],
  [100, 30],
  [140, 22],
  [80, 22],
  [100, 15],
  [60, 15],
  [40, 10],
  [160, 40],
  [200, 22],
  [80, 60],
  [240, 60],
  [300, 80],
  [120, 30],
  [140, 35],
  [200, 50],
  [90, 20],
  [80, 24],
  [80, 18],
  [70, 16],
  [50, 12],
  [30, 8],
] as const;
const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

for (const style of ["normal", "minimal", "simple"] as const)
  test(`${style}: real Ink header, editor and footer fit the complete requested matrix`, async () => {
    for (const [columns, rows] of MATRIX) {
      for (const value of ["", "A multiline draft\n開発👩🏽‍💻\nthird\nfourth\nfifth\nsixth"]) {
        const output = plain(
          await captureReferenceScreen(style, "purple", columns, rows, value, true),
        );
        const lines = output.replace(/\n$/, " ").split("\n");
        assert.ok(
          lines.every((line) => getTextWidth(line) <= columns),
          `${style} ${columns}x${rows}: horizontal bounds\n${output}`,
        );
        assert.ok(
          lines.length <= rows,
          `${style} ${columns}x${rows}: ${lines.length} rows exceed viewport\n${output}`,
        );
        assert.match(output, /❯/);
        assert.match(output, /fixture-model/);
      }
    }
  });

test("live resize bursts preserve editable draft, use final dimensions and release subscriptions", async () => {
  let draft = "draft kept";
  let renders = 0;
  function Harness() {
    const layout = useTerminalViewport();
    const [value, setValue] = useState(draft);
    draft = value;
    renders++;
    return (
      <ReferenceScreen
        style="simple"
        theme="purple"
        layout={layout}
        value={value}
        onChangeInput={setValue}
      />
    );
  }
  const terminal = createTestTerminal(<Harness />, { columns: 100, rows: 22 });
  const initialListeners = terminal.stdout.listenerCount("resize");
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const [columns, rows] of [...MATRIX, [0, 0], [100, 22]] as const) {
      terminal.stdout.columns = columns;
      terminal.stdout.rows = rows;
      terminal.stdout.emit("resize");
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(draft, "draft kept");
    assert.ok(renders < 15, `${renders} renders for a synchronous burst`);
    assert.equal(terminal.stdout.listenerCount("resize"), initialListeners);
    assert.match(plain(terminal.lastFrame()), /draft kept/);
    terminal.stdout.emit("resize");
  } finally {
    await terminal.dispose();
  }
  assert.equal(terminal.stdout.listenerCount("resize"), 0);
  assert.equal(isTerminalResizing(), false);
});
