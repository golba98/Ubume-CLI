import assert from "node:assert/strict";
import test from "node:test";
import { getTextWidth } from "../../../core/shared/text.js";
import {
  STARTUP_LOGO_FRAMES,
  startupLogoGrid,
  startupLogoRowText,
} from "../../render/startupAnimation.js";
import { THEMES } from "../../theme.js";
import { getToneColor } from "../TimelineRows.js";
import { buildIntroRenderItem } from "../timelineItems.js";
import { buildIntroRows } from "./eventRows.js";
import {
  buildCompactStartupRows,
  buildMinimalStartupRows,
  buildSimpleStartupRows,
  STARTUP_METADATA_OFFSET,
} from "./startupBrandingRows.js";
import type { IntroRenderTimelineItem, TimelineRow } from "./types.js";

function intro(overrides: Partial<IntroRenderTimelineItem["intro"]> = {}): IntroRenderTimelineItem {
  const item = buildIntroRenderItem({
    authState: "authenticated",
    workspaceLabel: "project",
    layout: { mode: "expanded", cols: 120, rows: 30 },
    providerLabel: "Example Provider",
    modelLabel: "Example Model (Low)",
    workspacePath: "~/project",
    logoStyle: "minimal",
  });
  return { ...item, intro: { ...item.intro, ...overrides } };
}
const text = (row: TimelineRow) => row.spans.map((span) => span.text).join("");

test("Minimal and Simple share a three-row logo and identically aligned runtime metadata", () => {
  for (const build of [buildMinimalStartupRows, buildSimpleStartupRows]) {
    const rows = build(intro({ version: "9.8.7-dev local" }), 100);
    assert.equal(rows.length, 3);
    assert.equal(
      text(rows[0]!).slice(STARTUP_METADATA_OFFSET).trimEnd(),
      "Ubume CLI v9.8.7-dev local",
    );
    assert.equal(text(rows[1]!).slice(STARTUP_METADATA_OFFSET).trimEnd(), "Example Provider");
    assert.equal(text(rows[2]!).slice(STARTUP_METADATA_OFFSET).trimEnd(), "~/project");
    rows.forEach((row, i) =>
      assert.equal(
        text(row).slice(0, 12),
        startupLogoRowText(startupLogoGrid(STARTUP_LOGO_FRAMES.at(-1)!), i),
      ),
    );
  }
  assert.deepEqual(buildMinimalStartupRows(intro(), 100), buildSimpleStartupRows(intro(), 100));
});

test("metadata never moves between frames and logo never enters its column", () => {
  const item = intro();
  const final = buildCompactStartupRows(item, 100)!;
  for (const frame of STARTUP_LOGO_FRAMES) {
    buildCompactStartupRows(item, 100, frame)!.forEach((row, i) => {
      assert.equal(text(row).slice(12, 14), "  ");
      assert.equal(
        text(row).slice(STARTUP_METADATA_OFFSET),
        text(final[i]!).slice(STARTUP_METADATA_OFFSET),
      );
      assert.equal(getTextWidth(text(row)), 100);
    });
  }
});

test("narrow layouts hide the logo and keep three bounded text rows including Unicode", () => {
  for (const width of [1, 8, 12, 20, 39, 40, 60, 120]) {
    const rows = buildCompactStartupRows(
      intro({ workspacePath: "~/漢字/👩🏽‍💻/project", modelLabel: "模型 ".repeat(30) }),
      width,
    )!;
    assert.equal(rows.length, 3);
    rows.forEach((row) => assert.equal(getTextWidth(text(row)), width));
    if (width < 40) {
      assert.equal(/[\u2801-\u28ff]/.test(text(rows[0]!)), false);
      assert.ok(text(rows[0]!).startsWith("U"));
    }
  }
});

test("missing metadata stays truthful while preserving all three rows", () => {
  const missing = buildCompactStartupRows(
    intro({ providerLabel: null, modelLabel: null, workspacePath: null }),
    100,
  )!;
  assert.equal(text(missing[1]!).slice(STARTUP_METADATA_OFFSET).trim(), "Provider unavailable");
  assert.equal(text(missing[2]!).slice(STARTUP_METADATA_OFFSET).trim(), "");
  const providerOnly = buildCompactStartupRows(intro({ modelLabel: null }), 100)!;
  assert.equal(text(providerOnly[1]!).slice(STARTUP_METADATA_OFFSET).trim(), "Example Provider");
});

test("branding uses semantic theme roles, including provider and model, without embedded ANSI", () => {
  const item = intro({
    middleLine: "provider-model",
    providerLabel: "bad\x07provider\x1b[31m\nnext",
    workspacePath: "~/multi\nline/\u2028path",
  });
  const rows = buildCompactStartupRows(item, 100)!;
  for (const row of rows) assert.doesNotMatch(text(row), /[\x00-\x1f\x7f]/);
  const roles = new Set(rows.flatMap((row) => row.spans.map((span) => span.tone)));
  for (const role of ["logoPrimary", "logoSecondary", "provider", "model"] as const)
    assert.ok(roles.has(role));
  for (const theme of Object.values(THEMES)) {
    assert.equal(getToneColor(theme, "logoPrimary"), theme.logoPrimary);
    assert.equal(getToneColor(theme, "logoSecondary"), theme.logoSecondary);
    assert.equal(getToneColor(theme, "provider"), theme.provider);
    assert.equal(getToneColor(theme, "model"), theme.model);
    assert.ok(theme.logoPrimary && theme.logoSecondary);
  }
});

test("impact changes theme roles without changing geometry or metadata", () => {
  const assembled = STARTUP_LOGO_FRAMES.at(-2)!;
  const impact = buildCompactStartupRows(intro(), 100, assembled)!;
  const settled = buildCompactStartupRows(intro(), 100)!;
  assert.deepEqual(impact.map(text), settled.map(text));
  assert.ok(impact[1]!.spans.some((span) => span.tone === "text" && /[█▀▄]/.test(span.text)));
  assert.ok(settled[1]!.spans.some((span) => span.tone === "logoPrimary"));
});

test("Normal bypasses compact branding including tiny viewport behavior", () => {
  assert.equal(buildCompactStartupRows(intro({ logoStyle: "normal" }), 100), null);
  assert.equal(buildCompactStartupRows(intro({ logoStyle: undefined }), 100), null);
  for (const style of ["minimal", "simple"] as const) {
    const rows = buildIntroRows(intro({ logoStyle: style, startupHeaderMode: "tiny" }), 35);
    assert.equal(rows.length, 3);
    assert.ok(text(rows[0]!).startsWith("Ubume CLI v"));
  }
  const normal = buildIntroRows(intro({ logoStyle: "normal", startupHeaderMode: "tiny" }), 35);
  assert.ok(text(normal[0]!).startsWith("Ubume v"));
});

test("all middle-line modes preserve the title/path and use current structured metadata", () => {
  for (const [mode, expected] of [
    ["provider", "Example Provider"],
    ["model", "Current Model"],
    ["provider-model", "Example Provider · Current Model"],
    ["usage", "Context: ~24% used (estimate)"],
  ] as const) {
    const rows = buildCompactStartupRows(
      intro({
        middleLine: mode,
        startupModelLabel: "Current Model",
        usageLabel: "Context: ~24% used (estimate)",
      }),
      100,
    )!;
    assert.equal(text(rows[1]!).slice(STARTUP_METADATA_OFFSET).trim(), expected);
    assert.match(text(rows[0]!), /Ubume CLI v/);
    assert.equal(text(rows[2]!).slice(STARTUP_METADATA_OFFSET).trim(), "~/project");
    assert.ok(
      rows[2]!.spans.some(
        (span) => span.text.includes("~/project") && span.tone === "text" && !span.bold,
      ),
    );
  }
  const hidden = buildCompactStartupRows(intro({ middleLine: "hidden" }), 100)!;
  assert.equal(hidden.length, 3);
  assert.equal(text(hidden[1]!).slice(STARTUP_METADATA_OFFSET).trim(), "~/project");
  assert.equal(text(hidden[2]!).slice(STARTUP_METADATA_OFFSET).trim(), "");
  assert.equal(buildCompactStartupRows(intro({ middleLine: "hidden" }), 20)!.length, 2);
  const changed = buildCompactStartupRows(
    intro({
      middleLine: "provider-model",
      providerLabel: "Other Provider",
      startupModelLabel: "Other Model",
    }),
    100,
  )!;
  assert.equal(
    text(changed[1]!).slice(STARTUP_METADATA_OFFSET).trim(),
    "Other Provider · Other Model",
  );
});

test("larger marks center their metadata beside the logo at a proportional gap", () => {
  for (const rows of [4, 5, 6, 8, 10]) {
    const size = { columns: rows * 4, rows, gap: Math.max(2, Math.round(rows / 2)) };
    const offset = size.columns + size.gap;
    for (const middleLine of ["provider", "hidden"] as const) {
      const built = buildCompactStartupRows(intro({ logoSize: size, middleLine }), 160)!;
      assert.equal(built.length, rows, `${rows}: header height follows the mark`);
      const metadata = built.map((row) => text(row).slice(offset).trimEnd());
      const filled = metadata.flatMap((line, i) => (line ? [i] : []));
      const expectedRows = middleLine === "hidden" ? 2 : 3;
      assert.equal(filled.length, expectedRows);
      assert.equal(filled.at(-1)! - filled[0]!, expectedRows - 1, "metadata rows stay adjacent");
      const top = filled[0]!;
      const bottom = rows - 1 - filled.at(-1)!;
      assert.ok(Math.abs(top - bottom) <= 1, `${rows}/${middleLine}: centered`);
      assert.match(metadata[top]!, /^Ubume CLI v/);
      assert.equal(metadata.at(filled.at(-1)!), "~/project");
      for (const row of built) {
        assert.equal(getTextWidth(text(row)), 160);
        assert.equal(text(row).slice(size.columns, offset), " ".repeat(size.gap));
        assert.match(text(row).slice(0, size.columns), /[█▀▄]/, "every header row carries logo");
      }
    }
  }
});

test("large headers stay inside their width with long Unicode and control-character labels", () => {
  const size = { columns: 40, rows: 10, gap: 5 };
  const item = intro({
    logoSize: size,
    workspacePath: "~/漢字/👩🏽‍💻/é́/" + "very-long-directory-name/".repeat(12),
    providerLabel: "Prov\x1b[31mider\nwith newline",
    modelLabel: "模型 ".repeat(40),
    middleLine: "provider-model",
  });
  for (const width of [69, 70, 100, 237, 297]) {
    const rows = buildCompactStartupRows(item, width)!;
    for (const row of rows) {
      assert.equal(getTextWidth(text(row)), width, `width ${width}`);
      assert.doesNotMatch(text(row), /[\x1b\n\r]/);
    }
  }
});

test("a size that no longer fits the width falls back to the base mark; null hides it", () => {
  const large = { columns: 40, rows: 10, gap: 5 };
  // 40 + 5 + 24 metadata columns = 69: one column short falls back to 12×3.
  assert.equal(buildCompactStartupRows(intro({ logoSize: large }), 69)!.length, 10);
  const narrower = buildCompactStartupRows(intro({ logoSize: large }), 68)!;
  assert.equal(narrower.length, 3);
  assert.deepEqual(narrower, buildCompactStartupRows(intro(), 68));
  const hidden = buildCompactStartupRows(intro({ logoSize: null }), 120)!;
  assert.equal(hidden.length, 3);
  assert.ok(text(hidden[0]!).startsWith("Ubume CLI v"), "metadata only, no logo column");
  assert.doesNotMatch(hidden.map(text).join(""), /[█▀▄]/);
});
