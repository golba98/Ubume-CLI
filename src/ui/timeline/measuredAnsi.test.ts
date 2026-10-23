import { expect, test } from "bun:test";
import { DARK_THEME } from "../theme.js";
import { measuredColorDepth, measuredRowsToAnsi } from "./measuredAnsi.js";
import type { TimelineRow } from "./timelineMeasure.js";

test("prepared history preserves text, line boundaries and every supported span style", () => {
  const rows: TimelineRow[] = [
    {
      key: "a",
      spans: [
        {
          text: "雪 👩🏽‍💻",
          tone: "error",
          backgroundTone: "panel",
          bold: true,
          italic: true,
          underline: true,
          strikethrough: true,
        },
      ],
    },
    { key: "b", spans: [{ text: "```ts" }] },
  ];
  const ansi = measuredRowsToAnsi(rows, DARK_THEME, true);
  expect(ansi).toContain("38;2;239;68;68;48;2;24;24;27;1;3;4;9m");
  expect(ansi.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).toBe("雪 👩🏽‍💻\n```ts");
  expect(measuredRowsToAnsi(rows, DARK_THEME, false)).toBe("雪 👩🏽‍💻\n```ts");
  expect(measuredRowsToAnsi(rows, DARK_THEME, true)).toBe(ansi);
});

test("prepared history honors plain, ANSI 16, ANSI 256 and truecolor capabilities", () => {
  const rows: TimelineRow[] = [{ key: "palette", spans: [{ text: "error", tone: "error" }] }];
  expect(measuredRowsToAnsi(rows, DARK_THEME, 4)).toContain("[91m");
  expect(measuredRowsToAnsi(rows, DARK_THEME, 8)).toContain("[38;5;203m");
  expect(measuredRowsToAnsi(rows, DARK_THEME, 24)).toContain("[38;2;239;68;68m");
  expect(measuredRowsToAnsi(rows, DARK_THEME, 0)).toBe("error");
  expect(measuredColorDepth({ isTTY: true }, { NO_COLOR: "" })).toBe(0);
  expect(measuredColorDepth({ isTTY: false }, { FORCE_COLOR: "3" })).toBe(24);
  expect(measuredColorDepth({ isTTY: true }, { TERM: "xterm-256color" })).toBe(8);
  expect(measuredColorDepth({ isTTY: true }, { TERM: "linux" })).toBe(4);
  expect(measuredColorDepth({ isTTY: true }, { TERM: "dumb" })).toBe(0);
  // Like Ink/Chalk, an enabled FORCE_COLOR is a floor, preserving richer terminals.
  expect(measuredColorDepth({ isTTY: true }, { FORCE_COLOR: "1", TERM: "xterm-256color" })).toBe(8);
  expect(measuredColorDepth({ isTTY: true }, { FORCE_COLOR: "1", COLORTERM: "truecolor" })).toBe(
    24,
  );
  expect(measuredColorDepth({ isTTY: true }, { FORCE_COLOR: "0", COLORTERM: "truecolor" })).toBe(0);
});
