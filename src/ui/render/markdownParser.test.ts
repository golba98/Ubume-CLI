import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkdownCache, resetMarkdownCaches } from "./markdownCache.js";
import {
  parseInline,
  parseMarkdown,
  type Segment,
  splitTableCells,
  type TableSegment,
} from "./markdownParser.js";

const text = (parts: ReturnType<typeof parseInline>) => parts.map((part) => part.text).join("");
const table = (source: string) => {
  const blocks = parseMarkdown(source);
  assert.equal(blocks[0]?.type, "table");
  return blocks[0] as TableSegment;
};
const withoutRanges = (segments: Segment[]) =>
  JSON.parse(JSON.stringify(segments, (key, value) => (key === "streaming" ? undefined : value)));

test("tables retain empty, surplus and missing cells with alignment directives", () => {
  const block = table(
    "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | | c |\n| extra | b | c | d |\n| short |\n",
  );
  assert.deepEqual(block.alignments, ["left", "center", "right", "left"]);
  assert.equal(text(block.headers[3]!), "Column 4");
  assert.deepEqual(
    block.rows.map((row) => row.map(text)),
    [
      ["a", "", "c", ""],
      ["extra", "b", "c", "d"],
      ["short", "", "", ""],
    ],
  );
});

test("table scanner honors escaped pipes, exact backtick runs and unmatched code", () => {
  assert.deepEqual(splitTableCells("| a\\|b | `c|d` | ``e`|f`` |"), ["a\\|b", "`c|d`", "``e`|f``"]);
  const block = table("A | B | C\n--- | --- | ---\na\\|b | `c|d` | ``e`|f``");
  assert.deepEqual(block.rows[0]!.map(text), ["a|b", "c|d", "e`|f"]);
  assert.deepEqual(splitTableCells("| `unclosed | value |"), ["`unclosed", "value"]);
  assert.deepEqual(splitTableCells("| a\\\\| b |"), ["a\\\\", "b"]);
});

test("invalid delimiter pairs are readable paragraphs, not consumed tables", () => {
  for (const source of [
    "A | B\n-- | ---\nx | y",
    "| A | B |\n| --- |\n| x | y |",
    "plain | pipe",
    "|---|---|",
  ]) {
    const blocks = parseMarkdown(source);
    assert.ok(blocks.every((block) => block.type !== "table"));
    assert.match(blocks.map((block) => block.raw).join(""), /\|/);
  }
});

test("all heading levels, closing hashes and setext titles are parsed", () => {
  for (let level = 1; level <= 6; level += 1) {
    const block = parseMarkdown(`${"#".repeat(level)} C# language ##`)[0];
    assert.equal(block?.type, "header");
    if (block?.type === "header") {
      assert.equal(block.level, level);
      assert.equal(text(block.parts), "C# language");
    }
  }
  assert.equal(parseMarkdown("Title\n===")[0]?.type, "header");
  assert.equal(parseMarkdown("####### literal")[0]?.type, "para");
});

test("nested mixed lists preserve numbering, tasks, continuation text and loose groups", () => {
  const block = parseMarkdown(
    "3. first\n  - nested\n    7) third\n       wrapped continuation\n  - [x] checked\n  - [ ] open\n\n4. last",
  )[0];
  assert.equal(block?.type, "list");
  if (block?.type !== "list") return;
  assert.deepEqual(
    block.items.map((item) => item.indent),
    [0, 2, 4, 2, 2, 0],
  );
  assert.equal(block.items[2]?.marker, "7)");
  assert.match(text(block.items[2]!.parts), /wrapped continuation/);
  assert.equal(block.items[3]?.checked, true);
  assert.equal(block.items[4]?.checked, false);
  assert.equal(block.items[5]?.blankBefore, true);
});

test("inline styling nests without rewriting code, escapes or literal paths", () => {
  const parts = parseInline(
    "**bold and *italic*** ~~gone~~ `C:/home/file.ts#L2` \\*literal\\* foo_bar",
  );
  assert.equal(text(parts), "bold and italic gone C:/home/file.ts#L2 *literal* foo_bar");
  assert.ok(parts.some((part) => part.bold && part.italic && part.text === "italic"));
  assert.ok(parts.some((part) => part.strikethrough && part.text === "gone"));
  assert.ok(parts.some((part) => part.kind === "code" && part.text === "C:/home/file.ts#L2"));
  assert.equal(
    text(parseInline("C:\\Users\\_test\\file.ts /home/me/__file__.ts")),
    "C:\\Users\\_test\\file.ts /home/me/__file__.ts",
  );
  const triple = parseInline("***both***");
  assert.ok(triple[0]?.italic && triple[0]?.bold);
  assert.equal(text(parseInline("*italic **bold***")), "italic bold");
});

test("links retain full targets and nested labels; partial links remain literal", () => {
  const parts = parseInline(
    "[**Docs**](https://example.org/a_(b)) [src/file.ts](/home/me/src/file.ts#L2)",
  );
  assert.equal(
    text(parts),
    "Docs (https://example.org/a_(b)) src/file.ts (/home/me/src/file.ts#L2)",
  );
  assert.ok(parts.some((part) => part.underline && part.bold));
  assert.equal(text(parseInline("[partial](https://")), "[partial](https://");
});

test("fences preserve filename-like lines, tabs, trailing spaces, empty lines and mismatched closers", () => {
  const source = "~~~~typescript\nfile.ts\n\t  exact  \n\n~~~\n~~~~";
  const block = parseMarkdown(source)[0];
  assert.equal(block?.type, "code");
  if (block?.type !== "code") return;
  assert.deepEqual(block.lines, ["file.ts", "\t  exact  ", "", "~~~"]);
  assert.equal(block.closed, true);
  const open = parseMarkdown("```ts\nline\n\n", { streaming: true })[0];
  assert.equal(open?.type, "code");
  if (open?.type === "code") {
    assert.deepEqual(open.lines, ["line", ""]);
    assert.equal(open.closed, false);
  }
});

test("quotes, rules, hard line breaks and four blank code lines retain structure", () => {
  const blocks = parseMarkdown(
    "> Quote **bold**\n>\n> > Nested\n\n---\n\nfirst  \nsecond\\\nthird\n\n```text\na\n\n\n\n\nb\n```",
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["quote", "rule", "para", "code"],
  );
  const code = blocks[3];
  if (code?.type === "code") assert.deepEqual(code.lines, ["a", "", "", "", "", "b"]);
  const para = blocks[2];
  if (para?.type === "para") assert.deepEqual(para.hardBreaks, [true, true, false]);
});

test("unsafe controls are stripped even inside code; meaningful noise-like lines survive", () => {
  const source =
    "# Title\n\u001b[2Jhello\u001b]52;c;attack\u0007\n```text\n\u001b[31mred\u001b[0m\n```";
  const blocks = parseMarkdown(source);
  assert.doesNotMatch(JSON.stringify(blocks), /\\u001b|attack|\\u0007/);
  const code = blocks.find((block) => block.type === "code");
  if (code?.type === "code") assert.deepEqual(code.lines, ["red"]);
  assert.equal(parseMarkdown("Assistant: meaningful text")[0]?.raw, "Assistant: meaningful text");
});

const STREAM_SAMPLE =
  "# Heading\n\nA **bold and *italic*** paragraph.\n\n| A | B |\n| --- | ---: |\n| `x|y` | 漢字 👩🏽‍💻 |\n| z | value |\n\n- [x] item\n  - nested\n\n```ts\n  const n = 1;\n\n```\n\n> quote\n";
test("character streaming and arbitrary chunks converge to exact stateless parsing", () => {
  for (const step of [1, 2, 5, 11, 29]) {
    resetMarkdownCaches();
    for (let end = step; end < STREAM_SAMPLE.length; end += step) {
      const source = STREAM_SAMPLE.slice(0, end);
      const incremental = parseMarkdown(source, { streaming: true, cacheKey: `step-${step}` });
      const stateless = parseMarkdown(source, { streaming: true });
      assert.deepEqual(
        withoutRanges(incremental),
        withoutRanges(stateless),
        `step ${step}, offset ${end}`,
      );
    }
    assert.deepEqual(
      parseMarkdown(STREAM_SAMPLE, { cacheKey: `step-${step}` }),
      parseMarkdown(STREAM_SAMPLE),
    );
  }
});

test("streaming reuses stable blocks and resets correctly after interruption or replacement", () => {
  resetMarkdownCaches();
  const first = parseMarkdown("# Stable\n\nParagraph", { cacheKey: "run", streaming: true });
  const second = parseMarkdown("# Stable\n\nParagraph grows", { cacheKey: "run", streaming: true });
  assert.strictEqual(first[0], second[0]);
  assert.deepEqual(
    parseMarkdown("Replacement\n\n```\nnew", { cacheKey: "run" }),
    parseMarkdown("Replacement\n\n```\nnew"),
  );
  resetMarkdownCaches();
  assert.deepEqual(
    parseMarkdown("Resumed **done**", { cacheKey: "run" }),
    parseMarkdown("Resumed **done**"),
  );
});

test("deep nesting and malformed/empty input remain bounded and readable", () => {
  assert.deepEqual(parseMarkdown(""), []);
  for (const source of [
    "> ".repeat(1000) + "keep",
    "*".repeat(2000),
    "[".repeat(2000),
    "  ".repeat(1000) + "- keep",
    "```",
    "| A | B |\n| --- | ---",
  ]) {
    assert.ok(parseMarkdown(source).length);
  }
});

test("presentation caches evict by count and characters and clear at lifecycle boundaries", () => {
  const cache = new MarkdownCache<number>(2, 10);
  cache.set("a", 1, 4);
  cache.set("b", 2, 4);
  cache.set("c", 3, 4);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
  cache.set("too big", 4, 11);
  assert.equal(cache.get("too big"), undefined);
  resetMarkdownCaches();
  assert.equal(cache.get("c"), undefined);
});

test("presentation caches keep recently hit entries and stay within both budgets", () => {
  const cache = new MarkdownCache<number>(3, 100);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), 1); // a hit earns a second chance
  cache.set("d", 4);
  assert.equal(cache.get("a"), 1, "the recently hit entry survives");
  assert.equal(cache.get("b"), undefined, "the oldest unreferenced entry is evicted");
  for (let i = 0; i < 50; i += 1) {
    cache.get("a");
    cache.set(`k${i}`, i, 30);
  }
  let retainedCost = 0;
  let retained = 0;
  for (const key of ["a", "c", "d", ...Array.from({ length: 50 }, (_, i) => `k${i}`)]) {
    if (cache.get(key) === undefined) continue;
    retained += 1;
    retainedCost += key === "a" || key === "c" || key === "d" ? 1 : 30;
  }
  assert.ok(retained <= 3);
  assert.ok(retainedCost <= 100);
});

test("prose preserves trailing Windows and UNC path separators", () => {
  for (const source of [
    ["C:", "Users", "_test", "folder", ""].join("\\"),
    ["", "", "server", "share", ""].join("\\"),
  ]) {
    const block = parseMarkdown(source)[0];
    assert.equal(block?.type, "para");
    if (block?.type === "para") assert.equal(text(block.lines[0]!), source);
  }
});
