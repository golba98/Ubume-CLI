import { expect, test } from "bun:test";
import { DARK_THEME } from "../theme.js";
import { measuredRowsToAnsi } from "./measuredAnsi.js";
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
