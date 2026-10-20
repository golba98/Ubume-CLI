import assert from "node:assert/strict";
import test from "node:test";
import { STARTUP_LOGO_COLUMNS_PER_ROW } from "../../core/shared/startupLogoDimensions.js";
import { KITTY_MAX_PLACEHOLDER_CELLS } from "../../core/terminal/startupGraphics.js";
import {
  BASE_STARTUP_LOGO_SIZE,
  COMPACT_STARTUP_MIN_WIDTH,
  MAX_LOGO_ROWS,
  MIN_LOGO_ROWS,
  MIN_METADATA_COLUMNS,
  type StartupLogoLayoutInput,
  type StartupLogoSize,
  selectStartupLogoSize,
  startupHeaderRows,
  startupLogoBudget,
  startupMetadataOffset,
  startupMetadataTop,
} from "./startupLogoLayout.js";

/** Mirrors TranscriptShell: 1-col gutter + 2 padding, 1-row gutter, 5-row composer, safety + reserve. */
function terminal(cols: number, rows: number, metadataRows = 3): StartupLogoLayoutInput {
  return {
    innerWidth: cols - 3,
    terminalRows: rows,
    availableRows: Math.max(10, rows - 1) - 5 - 2,
    metadataRows,
  };
}

function assertValid(size: StartupLogoSize | null, input: StartupLogoLayoutInput, label: string) {
  if (!size) return;
  assert.equal(size.columns, size.rows * STARTUP_LOGO_COLUMNS_PER_ROW, `${label}: aspect`);
  assert.ok(size.rows >= MIN_LOGO_ROWS && size.rows <= MAX_LOGO_ROWS, `${label}: row bounds`);
  assert.ok(size.columns <= KITTY_MAX_PLACEHOLDER_CELLS, `${label}: placeholder table`);
  assert.ok(
    startupMetadataOffset(size) + MIN_METADATA_COLUMNS <= input.innerWidth,
    `${label}: metadata keeps its minimum column`,
  );
  assert.ok(
    startupHeaderRows(size, input.metadataRows) <= input.availableRows,
    `${label}: header fits the live viewport`,
  );
}

const BRIEF_SIZES = [
  [20, 8, null],
  [40, 12, null],
  [60, 20, 3],
  [80, 24, 3],
  [100, 30, 4],
  [120, 40, 5],
  [160, 45, 6],
  [200, 60, 8],
  [240, 70, 10],
  [300, 90, 10],
] as const;

test("the mark grows from compact to fullscreen across representative terminals", () => {
  for (const [cols, rows, expected] of BRIEF_SIZES) {
    const input = terminal(cols, rows);
    const size = selectStartupLogoSize(input);
    assert.equal(size?.rows ?? null, expected, `${cols}x${rows}`);
    assertValid(size, input, `${cols}x${rows}`);
  }
  // Maximized is noticeably larger than a standard 80×24 window.
  const standard = selectStartupLogoSize(terminal(80, 24))!;
  const maximized = selectStartupLogoSize(terminal(200, 60))!;
  assert.ok(maximized.columns >= standard.columns * 2);
});

test("every size in a dense sweep is valid and monotonic in each dimension", () => {
  for (let cols = 1; cols <= 320; cols += 1) {
    let previousRows = 0;
    for (let rows = 1; rows <= 100; rows += 3) {
      const input = terminal(cols, rows);
      const size = selectStartupLogoSize(input);
      assertValid(size, input, `${cols}x${rows}`);
      assert.ok((size?.rows ?? 0) >= previousRows, `${cols}x${rows} never shrinks when taller`);
      previousRows = size?.rows ?? 0;
    }
  }
  for (let rows = 8; rows <= 100; rows += 7) {
    let previousRows = 0;
    for (let cols = 1; cols <= 320; cols += 1) {
      const size = selectStartupLogoSize(terminal(cols, rows));
      assert.ok((size?.rows ?? 0) >= previousRows, `${cols}x${rows} never shrinks when wider`);
      previousRows = size?.rows ?? 0;
    }
  }
});

test("breakpoints are exact on both sides and width-only or height-only changes are isolated", () => {
  // Inner width 40 is the smallest that shows the mark (unchanged from the fixed design).
  assert.equal(selectStartupLogoSize(terminal(COMPACT_STARTUP_MIN_WIDTH + 2, 30)), null);
  assert.deepEqual(
    selectStartupLogoSize(terminal(COMPACT_STARTUP_MIN_WIDTH + 3, 30)),
    BASE_STARTUP_LOGO_SIZE,
  );
  // Every whole-row boundary of the proportional budget, from either side.
  for (let target = MIN_LOGO_ROWS + 1; target <= MAX_LOGO_ROWS; target++) {
    const rows = Math.ceil(target * 7);
    const wide = 400;
    assert.equal(selectStartupLogoSize(terminal(wide, rows))!.rows, target, `${rows} rows`);
    assert.equal(selectStartupLogoSize(terminal(wide, rows - 1))!.rows, target - 1);
    const cols = Math.ceil((target * STARTUP_LOGO_COLUMNS_PER_ROW) / 0.18) + 3;
    assert.equal(selectStartupLogoSize(terminal(cols, 200))!.rows, target, `${cols} cols`);
    assert.equal(selectStartupLogoSize(terminal(cols - 1, 200))!.rows, target - 1);
  }
  // Extreme aspect ratios fall back to the limiting dimension, never overflow.
  assert.equal(selectStartupLogoSize(terminal(400, 12))!.rows, MIN_LOGO_ROWS);
  assert.equal(selectStartupLogoSize({ ...terminal(400, 12), availableRows: 2 }), null);
  assert.equal(selectStartupLogoSize(terminal(45, 200))!.rows, MIN_LOGO_ROWS);
});

test("hysteresis keeps the current size near a boundary but follows real changes", () => {
  const near = (cols: number, rows: number, previous: StartupLogoSize | null) =>
    selectStartupLogoSize({ ...terminal(cols, rows), previous });
  // 35 rows → budget 5.0 (5 rows); 34 rows → 4.86 (4 rows without hysteresis).
  const five = near(400, 35, null)!;
  assert.equal(five.rows, 5);
  assert.equal(near(400, 34, null)!.rows, 4);
  assert.equal(near(400, 34, five)!.rows, 5, "a one-row drag back does not flip the size");
  // Oscillating across the boundary stays stable in both directions.
  let size: StartupLogoSize | null = five;
  for (const rows of [34, 35, 34, 35, 34]) size = near(400, rows, size);
  assert.equal(size!.rows, 5);
  const four = near(400, 34, null)!;
  for (const rows of [35, 36, 35, 36]) size = near(400, rows, four);
  assert.equal(size!.rows, 4, "growth needs a clear margin before upgrading");
  // Large changes always apply, both ways.
  assert.equal(near(400, 70, four)!.rows, 10);
  assert.equal(near(400, 21, near(400, 70, null))!.rows, 3);
  // A kept size must still satisfy the hard constraints.
  const tight = { ...terminal(400, 35), availableRows: 4, previous: five };
  assert.equal(selectStartupLogoSize(tight)!.rows, 4);
});

test("hard constraints shrink the mark and invalid dimensions hide it safely", () => {
  // A tall multi-line draft shrinks the live region; the mark gives way.
  const roomy = terminal(200, 60);
  assert.equal(selectStartupLogoSize(roomy)!.rows, 8);
  assert.equal(selectStartupLogoSize({ ...roomy, availableRows: 6 })!.rows, 6);
  assert.equal(selectStartupLogoSize({ ...roomy, availableRows: 2 }), null);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    assert.equal(selectStartupLogoSize({ ...roomy, innerWidth: bad }), null);
    assert.equal(selectStartupLogoSize({ ...roomy, terminalRows: bad }), null);
    assert.equal(selectStartupLogoSize({ ...roomy, availableRows: bad }), null);
  }
  assert.equal(selectStartupLogoSize({ ...roomy, metadataRows: Number.NaN }), null);
  assert.ok(Number.isFinite(startupLogoBudget(0, 0)));
});

test("metadata is centered beside tall marks and top-aligned at the base size", () => {
  assert.equal(startupMetadataTop(BASE_STARTUP_LOGO_SIZE, 3), 0);
  assert.equal(startupMetadataTop(BASE_STARTUP_LOGO_SIZE, 2), 0, "Hidden keeps adjacent rows");
  for (let rows = MIN_LOGO_ROWS; rows <= MAX_LOGO_ROWS; rows++) {
    const size = { columns: rows * 4, rows, gap: 2 };
    for (const metadataRows of [2, 3]) {
      const top = startupMetadataTop(size, metadataRows);
      const bottom = rows - top - metadataRows;
      assert.ok(top >= 0 && bottom >= 0 && Math.abs(top - bottom) <= 1);
      assert.equal(startupHeaderRows(size, metadataRows), rows);
    }
  }
  assert.equal(startupMetadataTop(null, 3), 0);
  assert.equal(startupHeaderRows(null, 2), 2);
  assert.equal(startupMetadataOffset(null), 0);
  assert.equal(startupMetadataOffset(BASE_STARTUP_LOGO_SIZE), 14);
});
