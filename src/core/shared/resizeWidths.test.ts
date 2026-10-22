import { expect, test } from "bun:test";
import stringWidth from "string-width";
import { getTextWidth } from "./text.js";

test("cached and fast resize measurements match full Unicode width semantics", () => {
  const samples = [
    "",
    "ascii",
    "╭──╮",
    "⟦234⟧",
    "雪",
    "a\u0301",
    "👩🏽‍💻",
    "♥️",
    "─\ufe0f",
    "\x1b[31mcolored雪\x1b[0m",
    "\t\n",
    "🇿🇦",
    "█▀▄",
    "A\u200dB",
  ];
  for (let pass = 0; pass < 2; pass++)
    for (const value of samples) expect(getTextWidth(value)).toBe(stringWidth(value));
  for (let i = 0; i < 5000; i++) expect(getTextWidth(`雪${i}`)).toBe(stringWidth(`雪${i}`));
  for (const value of samples) expect(getTextWidth(value)).toBe(stringWidth(value));
});
