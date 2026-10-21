import assert from "node:assert/strict";
import test from "node:test";
import { getTextWidth } from "../../core/shared/text.js";
import { measureBottomComposerRows } from "../chrome/composer/composerModel.js";
import { createLayoutSnapshot, getShellHeight, getShellWidth } from "../layout.js";
import { buildIntroRows } from "../timeline/measure/eventRows.js";
import { buildIntroRenderItem } from "../timeline/timelineItems.js";
import { buildNativeTranscriptParts } from "../timeline/timelineMeasure.js";
import { LOGO_LARGE } from "./logoVariants.js";
import { computeResponsiveHeader, HEADER_CONSTRAINTS } from "./responsiveHeader.js";
import { MAX_WORDMARK_ROWS, WORDMARK_ROWS, wordmarkArt } from "./wordmarkArt.js";

export const RESPONSIVE_MATRIX = [
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
function allocation(cols: number, rows: number, style: "normal" | "minimal" | "simple") {
  const layout = createLayoutSnapshot(cols, rows);
  const composer = measureBottomComposerRows({
    layout,
    uiState: { kind: "IDLE" },
    value: "",
    cursor: 0,
  });
  const input = {
    innerWidth: Math.max(0, getShellWidth(cols) - 2),
    terminalRows: rows,
    availableRows: Math.max(
      0,
      getShellHeight(rows) - composer - 1 - HEADER_CONSTRAINTS.contentReserveRows,
    ),
    metadataRows: 3,
    style,
  };
  return { input, plan: computeResponsiveHeader(input) };
}

test("dense viewport sweep bounds every logo, metadata column and header independently", () => {
  for (const style of ["normal", "minimal", "simple"] as const)
    for (let cols = 1; cols <= 320; cols++)
      for (let rows = 3; rows <= 100; rows += 3) {
        const { input, plan } = allocation(cols, rows, style);
        const label = `${style} ${cols}x${rows}`;
        assert.ok(plan.totalRows >= 0 && plan.totalRows <= input.availableRows, label);
        assert.ok(plan.metadataWidth >= 0 && plan.metadataWidth <= input.innerWidth, label);
        if (plan.size) {
          assert.ok(plan.size.columns > 0 && plan.size.columns <= input.innerWidth, label);
          assert.ok(plan.size.rows > 0 && plan.size.rows <= input.availableRows, label);
          if (plan.arrangement === "beside")
            assert.ok(
              plan.size.columns + plan.size.gap + plan.metadataWidth <= input.innerWidth,
              label,
            );
          else assert.ok(plan.size.rows + plan.metadataRows <= input.availableRows, label);
        }
        assert.deepEqual(computeResponsiveHeader(input), computeResponsiveHeader(input), label);
      }
});

test("reference geometry, independent axes and fixed native maximums", () => {
  assert.deepEqual(allocation(100, 22, "normal").plan.size, { columns: 45, rows: 6, gap: 2 });
  assert.deepEqual(allocation(100, 22, "minimal").plan.size, { columns: 12, rows: 3, gap: 2 });
  for (const style of ["normal", "minimal", "simple"] as const) {
    const reference = allocation(100, 22, style).plan.size!;
    assert.equal(allocation(200, 22, style).plan.size!.rows, reference.rows);
    assert.ok(allocation(80, 60, style).plan.size!.columns <= reference.columns);
    const sizes = [
      [100, 22],
      [120, 30],
      [140, 35],
      [160, 40],
      [200, 50],
      [240, 60],
      [300, 80],
    ];
    for (const [cols, rows] of sizes)
      assert.deepEqual(allocation(cols!, rows!, style).plan.size, reference, `${cols}x${rows}`);
  }
  assert.equal(wordmarkArt(6), LOGO_LARGE);
  for (let rows = WORDMARK_ROWS; rows <= MAX_WORDMARK_ROWS; rows++) {
    const art = wordmarkArt(rows);
    assert.equal(art.length, rows);
    assert.ok(
      art.every((line) => /^[ █╗║╔═╝╚]+$/u.test(line)),
      "enlargement uses native connected glyphs",
    );
    assert.ok(art.every((line) => getTextWidth(line) <= Math.round((45 * rows) / 6)));
    assert.ok(Math.abs(Math.round((45 * rows) / 6) / rows - 45 / 6) <= 0.5 / rows + 1e-12);
  }
});

test("all requested dimensions build bounded real header rows with long Unicode labels", () => {
  for (const [cols, rows] of RESPONSIVE_MATRIX)
    for (const style of ["normal", "minimal", "simple"] as const) {
      const { input, plan } = allocation(cols, rows, style);
      const item = buildIntroRenderItem({
        layout: createLayoutSnapshot(cols, rows),
        authState: "authenticated",
        workspaceLabel: "/開発/👩🏽‍💻/".repeat(30),
        workspacePath: "/開発/👩🏽‍💻/".repeat(30),
        providerLabel: "Long provider ".repeat(30),
        logoStyle: style,
        logoSize: plan.size,
        headerLayout: plan,
      });
      const result = buildIntroRows(item, input.innerWidth);
      assert.ok(
        result.every(
          (row) => getTextWidth(row.spans.map((span) => span.text).join("")) <= input.innerWidth,
        ),
        `${style} ${cols}x${rows}`,
      );
      assert.equal(result.length, plan.totalRows);
    }
});

test("invalid geometry and hidden decorations produce bounded metadata-only plans", () => {
  for (const value of [NaN, Infinity, -1, 0]) {
    const plan = computeResponsiveHeader({
      innerWidth: value,
      terminalRows: value,
      availableRows: value,
      metadataRows: 3,
      style: "normal",
    });
    assert.equal(plan.size, null);
    assert.equal(plan.totalRows, 0);
  }
  const plan = computeResponsiveHeader({
    innerWidth: 97,
    terminalRows: 22,
    availableRows: 3,
    metadataRows: 3,
    style: "normal",
    hideLogo: true,
  });
  assert.equal(plan.size, null);
  assert.equal(plan.totalRows, 3);
  assert.throws(() => wordmarkArt(0), RangeError);
  assert.throws(() => wordmarkArt(Infinity), RangeError);
});

test("wordmark stays native across resizes and still falls back to the compact identity", () => {
  let previous = computeResponsiveHeader({
    innerWidth: 108,
    terminalRows: 40,
    availableRows: 25,
    metadataRows: 3,
    style: "normal",
  }).size;
  assert.equal(previous!.rows, WORDMARK_ROWS);
  for (const [innerWidth, terminalRows] of [
    [104, 40],
    [200, 60],
    [300, 80],
    [105, 40],
  ] as const) {
    const next = computeResponsiveHeader({
      innerWidth,
      terminalRows,
      availableRows: 25,
      metadataRows: 3,
      style: "normal",
      previous,
    });
    assert.deepEqual(next.size, { columns: 45, rows: WORDMARK_ROWS, gap: 2 });
    previous = next.size;
  }
  assert.equal(
    computeResponsiveHeader({
      innerWidth: 97,
      terminalRows: 22,
      availableRows: 15,
      metadataRows: 3,
      style: "normal",
      previous,
    }).size!.rows,
    6,
  );
  assert.equal(
    computeResponsiveHeader({
      innerWidth: 97,
      terminalRows: 22,
      availableRows: 4,
      metadataRows: 3,
      style: "normal",
      previous,
    }).size!.rows,
    1,
  );
});

test("height-only geometry changes invalidate cached intro rows at the same width and layout mode", () => {
  const counts: number[] = [];
  for (const rows of [22, 15, 22]) {
    const { plan } = allocation(100, rows, "normal");
    const item = buildIntroRenderItem({
      layout: createLayoutSnapshot(100, rows),
      startupHeaderMode: "large",
      authState: "authenticated",
      workspaceLabel: "fixture",
      providerLabel: "Local",
      headerLayout: plan,
    });
    const result = buildNativeTranscriptParts([item], { totalWidth: 99, verboseMode: false });
    const count =
      result.staticItems.reduce((sum, item) => sum + item.rows.length, 0) + result.liveRows.length;
    counts.push(count);
    // The native transcript adds its existing item-separation row outside the header.
    assert.equal(count, plan.totalRows + 1);
  }
  assert.equal(counts[0], counts[2]);
  assert.ok(counts[1]! < counts[0]!);
});
