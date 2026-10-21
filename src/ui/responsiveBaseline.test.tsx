import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { captureReferenceScreen } from "../test/fixtures/responsiveLayout.js";
import { STARTUP_LOGO_FRAMES, startupLogoGrid } from "./render/startupAnimation.js";

const fixture = new URL("../test/fixtures/responsive-baseline.json", import.meta.url);

test("100x22 real shell and composer preserve the original styled output in every built-in theme", async () => {
  const captures: Record<string, string> = {};
  for (const style of ["normal", "minimal", "simple"] as const) {
    for (const theme of [
      "dark",
      "purple",
      "mono",
      "black",
      "nordic",
      "dracula",
      "gruvbox",
      "ocean",
    ]) {
      captures[`${style}/${theme}`] = await captureReferenceScreen(style, theme);
    }
  }
  assert.deepEqual(captures, JSON.parse(readFileSync(fixture, "utf8")));
});

test("every native startup animation frame preserves its original timing, glyphs and tones", () => {
  const original = JSON.parse(
    readFileSync(
      new URL("../test/fixtures/startup-animation-baseline.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    STARTUP_LOGO_FRAMES.map((frame) => ({
      atMs: frame.atMs,
      impact: frame.impact,
      grid: startupLogoGrid(frame),
    })),
    original,
  );
});

test("the legacy ASCII-banner override does not disable the selected developer mark", async () => {
  const previous = process.env.UBUME_NO_ASCII_LOGO;
  try {
    process.env.UBUME_NO_ASCII_LOGO = "1";
    const original = JSON.parse(readFileSync(fixture, "utf8"));
    for (const style of ["minimal", "simple"] as const)
      assert.equal(await captureReferenceScreen(style, "purple"), original[`${style}/purple`]);
  } finally {
    if (previous === undefined) delete process.env.UBUME_NO_ASCII_LOGO;
    else process.env.UBUME_NO_ASCII_LOGO = previous;
  }
});
