import assert from "node:assert/strict";
import test from "node:test";
import { getTextWidth } from "../../core/shared/text.js";
import {
  buildStartupLogoGrid,
  FINAL_STARTUP_LOGO_FRAME,
  NO_STARTUP_ANIMATION_ENV,
  STARTUP_LOGO_FRAMES,
  type StartupAnimationDecision,
  shouldPlayStartupAnimation,
  startupLogoGrid,
  startupLogoRowText,
} from "./startupAnimation.js";
import { BASE_STARTUP_LOGO_SIZE, MAX_LOGO_ROWS, MIN_LOGO_ROWS } from "./startupLogoLayout.js";

test("completed mark has three enlarged, balanced glyphs in a fixed cell region", () => {
  const grid = buildStartupLogoGrid();
  assert.equal(grid.height, 3);
  assert.equal(grid.width, 12);
  const lines = [0, 1, 2].map((row) => startupLogoRowText(grid, row));
  for (const line of lines) {
    assert.equal(getTextWidth(line), 12);
    assert.doesNotMatch(line, /[\u2800-\u28ff]/);
    assert.match(line, /[█▀▄]/);
  }
  // Left and right bracket tips meet at the middle row; slash travels upward right.
  assert.ok(grid.rows[1]!.slice(0, 2).some(Boolean));
  assert.ok(grid.rows[1]!.slice(10, 12).some(Boolean));
  assert.ok(grid.rows[0]!.slice(6, 8).some((cell) => cell?.tone === "text"));
  assert.ok(grid.rows[2]!.slice(4, 6).some((cell) => cell?.tone === "text"));
  assert.deepEqual(grid, startupLogoGrid(FINAL_STARTUP_LOGO_FRAME));
  for (const row of grid.rows) {
    const parts = row.filter(Boolean).map((cell) => cell!.tone);
    assert.ok(parts.includes("logoPrimary") && parts.includes("logoSecondary"));
  }
});

test("slash appears alone, followed by left and then overlapping right bracket arrival", () => {
  assert.deepEqual(STARTUP_LOGO_FRAMES[0]!.pose, { left: null, right: null });
  const left = STARTUP_LOGO_FRAMES.find((f) => f.atMs === 80)!;
  assert.equal(left.pose.left, 20);
  assert.equal(left.pose.right, null);
  const overlap = STARTUP_LOGO_FRAMES.find((f) => f.atMs === 160)!;
  assert.equal(overlap.pose.right, 20);
  assert.ok(overlap.pose.left! > 0 && overlap.pose.left! < 20);
  for (const side of ["left", "right"] as const) {
    const positions = STARTUP_LOGO_FRAMES.flatMap((frame) =>
      frame.pose[side] === null ? [] : [frame.pose[side]!],
    );
    for (let i = 1; i < positions.length; i++) assert.ok(positions[i]! <= positions[i - 1]!);
  }
  assert.equal(STARTUP_LOGO_FRAMES.find((f) => f.atMs === 400)!.impact, true);
  assert.equal(FINAL_STARTUP_LOGO_FRAME.impact, false);
  assert.equal(FINAL_STARTUP_LOGO_FRAME.atMs, 520);
});

test("all frames preserve slash cells, valid widths and escape-free geometry", () => {
  const slash = startupLogoGrid(STARTUP_LOGO_FRAMES[0]!);
  for (const frame of STARTUP_LOGO_FRAMES) {
    const grid = startupLogoGrid(frame);
    assert.equal(grid.rows.length, 3);
    for (let row = 0; row < 3; row += 1) {
      const text = startupLogoRowText(grid, row);
      assert.equal(getTextWidth(text), BASE_STARTUP_LOGO_SIZE.columns);
      assert.equal(text.includes("\x1b"), false);
      slash.rows[row]!.forEach((cell, col) => {
        if (cell) assert.deepEqual(grid.rows[row]![col], cell);
      });
    }
  }
});

test("animation gate respects style, layout, non-TTY and reduced motion", () => {
  const base: StartupAnimationDecision = {
    stdout: { isTTY: true },
    env: {},
    logoStyle: "minimal",
    animationEnabled: true,
    logoSize: BASE_STARTUP_LOGO_SIZE,
  };
  assert.equal(shouldPlayStartupAnimation(base), true);
  assert.equal(shouldPlayStartupAnimation({ ...base, logoStyle: "simple" }), true);
  for (const decision of [
    { ...base, logoStyle: "normal" as const },
    { ...base, animationEnabled: false },
    { ...base, env: { [NO_STARTUP_ANIMATION_ENV]: "1" } },
    { ...base, stdout: { isTTY: false } },
    { ...base, stdout: {} },
    // The responsive layout found no room for the mark (narrow or short terminal).
    { ...base, logoSize: null },
  ])
    assert.equal(shouldPlayStartupAnimation(decision), false);
});

test("golden: the base mark is unchanged and larger marks keep the same design", () => {
  const rows = (size: { columns: number; rows: number }) => {
    const grid = startupLogoGrid(FINAL_STARTUP_LOGO_FRAME, size);
    return grid.rows.map((_, row) => startupLogoRowText(grid, row));
  };
  assert.deepEqual(rows(BASE_STARTUP_LOGO_SIZE), [" ▄▀   ▄▀ ▀▄ ", "█    ▄▀    █", " ▀▄ ▄▀   ▄▀ "]);
  assert.deepEqual(rows({ columns: 24, rows: 6 }), [
    "    ▄▀       ▄█   ▀▄    ",
    "   █▀       ▄█     ▀█   ",
    " ▄█         █        █▄ ",
    " ▀█        █         █▀ ",
    "   █▄     █▀       ▄█   ",
    "    ▀▄   █▀       ▄▀    ",
  ]);
});

test("every responsive size draws a complete, mirrored, escape-free mark", () => {
  for (let logoRows = MIN_LOGO_ROWS; logoRows <= MAX_LOGO_ROWS; logoRows++) {
    const size = { columns: logoRows * 4, rows: logoRows };
    for (const frame of STARTUP_LOGO_FRAMES) {
      const grid = startupLogoGrid(frame, size);
      assert.equal(grid.width, size.columns);
      assert.equal(grid.height, size.rows);
      assert.equal(grid.rows.length, size.rows);
      for (let row = 0; row < size.rows; row++) {
        const text = startupLogoRowText(grid, row);
        assert.equal(getTextWidth(text), size.columns, `${logoRows}: row ${row} width`);
        assert.match(text, /^[ █▀▄]+$/, "only half-block glyphs, no Braille or escapes");
      }
    }
    const final = startupLogoGrid(FINAL_STARTUP_LOGO_FRAME, size);
    const tones = new Set(final.rows.flat().flatMap((cell) => (cell ? [cell.tone] : [])));
    assert.deepEqual([...tones].sort(), ["logoPrimary", "logoSecondary", "text"]);
    // The brackets are mirror images: left cell (r, c) ↔ right cell (r, width-1-c).
    for (let row = 0; row < size.rows; row++)
      for (let col = 0; col < size.columns; col++) {
        const left = final.rows[row]![col];
        if (left?.tone !== "logoPrimary") continue;
        const right = final.rows[row]![size.columns - 1 - col];
        assert.equal(right?.tone, "logoSecondary", `${logoRows}: mirror of ${row},${col}`);
        // Half blocks are horizontally symmetric, so the mirrored glyph is identical.
        assert.equal(right?.char, left.char);
      }
    // The slash rises to the right: its top row sits right of its bottom row.
    const slashCols = (row: number) =>
      final.rows[row]!.flatMap((cell, col) => (cell?.tone === "text" ? [col] : []));
    assert.ok(Math.min(...slashCols(0)) > Math.max(...slashCols(size.rows - 1)));
  }
});

test("grids are built once per size and frame", () => {
  const size = { columns: 32, rows: 8 };
  assert.equal(
    startupLogoGrid(FINAL_STARTUP_LOGO_FRAME, size),
    startupLogoGrid(FINAL_STARTUP_LOGO_FRAME, { ...size }),
  );
  assert.notEqual(
    startupLogoGrid(FINAL_STARTUP_LOGO_FRAME, size),
    startupLogoGrid(STARTUP_LOGO_FRAMES[0]!, size),
  );
});
