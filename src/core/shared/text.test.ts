import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  getTextUnits,
  getTextWidth,
  splitTextAtColumn,
  wrapCommandText,
  wrapPlainText,
  wrapTextRows,
} from "./text.js";

test("wrapCommandText breaks on spaces and indents continuation lines", () => {
  const result = wrapCommandText(
    "if (Get-Command rg) { rg --files } else { Get-ChildItem -Recurse -File }",
    40,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].trimEnd(), "if (Get-Command rg) { rg --files } else");
  assert.equal(result[1].trimEnd(), "  { Get-ChildItem -Recurse -File }");
});

test("wrapCommandText handles extremely long unbroken tokens by breaking them", () => {
  const result = wrapCommandText("A_Very_Long_Token_Without_Spaces_That_Exceeds_Max_Width", 20);
  assert.equal(result.length, 3);
  assert.equal(result[0], "A_Very_Long_Token_Wi");
  assert.equal(result[1], "  thout_Spaces_That_");
  assert.equal(result[2], "  Exceeds_Max_Width");
});

test("narrow command wrapping terminates without splitting or losing wide graphemes", () => {
  // Isolate this regression: a synchronous wrapping loop cannot be interrupted
  // by the test runner's own timeout when it stops making progress.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `import { wrapCommandText } from ${JSON.stringify(new URL("./text.ts", import.meta.url).href)};
       console.log(JSON.stringify(["界界", "👩‍💻👩‍💻", "a 界"].map(text => wrapCommandText(text, 3))));`,
    ],
    { encoding: "utf8", timeout: 2_000 },
  );
  assert.equal(probe.error, undefined, "wrapping must finish within the subprocess timeout");
  assert.equal(probe.status, 0, probe.stderr);
  const rows: string[][] = JSON.parse(probe.stdout);
  assert.deepEqual(rows, [
    ["界", "界"],
    ["👩‍💻", "👩‍💻"],
    ["a", "界"],
  ]);
  for (const row of rows.flat()) assert.ok(getTextWidth(row) <= 3, row);
});

test("wrapPlainText default firstLineWidth equals maxWidth (existing callers unchanged)", () => {
  const text = "alpha beta gamma delta epsilon zeta";
  assert.deepEqual(wrapPlainText(text, 16), wrapPlainText(text, 16, 16));
  for (const row of wrapPlainText(text, 16)) {
    assert.ok(getTextWidth(row) <= 16, `row "${row}" should fit maxWidth`);
  }
});

test("wrapPlainText honors a narrower firstLineWidth on the first row only", () => {
  const text = "alpha beta gamma delta epsilon zeta eta";
  const rows = wrapPlainText(text, 20, 10);
  assert.ok(rows.length >= 2, "should wrap onto multiple rows");
  assert.ok(getTextWidth(rows[0]) <= 10, `first row "${rows[0]}" must fit firstLineWidth (10)`);
  for (const row of rows.slice(1)) {
    assert.ok(getTextWidth(row) <= 20, `continuation row "${row}" must fit maxWidth (20)`);
  }
  assert.deepEqual(rows, ["alpha", "beta gamma delta", "epsilon zeta eta"]);
});

test("wrapPlainText moves a whole word to the continuation row", () => {
  assert.deepEqual(wrapPlainText("say was", 6), ["say", "was"]);
});

test("wrapTextRows preserves source offsets when a soft-wrap separator is hidden", () => {
  assert.deepEqual(wrapTextRows("say was", 6), [
    { text: "say", start: 0, end: 3, breakType: "soft" },
    { text: "was", start: 4, end: 7, breakType: "end" },
  ]);
});

test("wrapPlainText only character-splits an individually overlong word", () => {
  assert.deepEqual(wrapPlainText("supercalifragilistic", 5), ["super", "calif", "ragil", "istic"]);
});

test("atomic token ID markers measure zero columns, matching getTextWidth", () => {
  const token = "[Image: a.png]\u2063\uFE01\u2063";
  const units = getTextUnits(token);
  assert.deepEqual(
    units.slice(-3).map((unit) => unit.width),
    [0, 0, 0],
  );
  assert.equal(
    units.reduce((total, unit) => total + unit.width, 0),
    getTextWidth(token),
  );
});

test("splitTextAtColumn highlights the visible character after an atomic token", () => {
  assert.equal(splitTextAtColumn("[Image: a.png]\u2063\uFE01\u2063 x", 14).current, " ");
});

test("text units match terminal cell width for combining marks and emoji clusters", () => {
  for (const text of [
    "e\u0301",
    "👩‍💻",
    "🇿🇦",
    "字",
    "[Pasted Content 22,703 chars]\u2063\uFE01\u2063",
  ]) {
    const units = getTextUnits(text);
    assert.equal(
      units.reduce((sum, unit) => sum + unit.width, 0),
      getTextWidth(text),
    );
    assert.equal(units.map((unit) => unit.text).join(""), text);
    for (const unit of units) assert.equal(text.slice(unit.start, unit.end), unit.text);
  }
  assert.equal(getTextUnits("e\u0301").length, 1);
  assert.equal(getTextUnits("👩‍💻").length, 1);
  assert.deepEqual(
    wrapTextRows("e\u0301👩‍💻字", 2).map((row) => row.text),
    ["e\u0301", "👩‍💻", "字"],
  );
});
