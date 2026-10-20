import assert from "node:assert/strict";
import test from "node:test";
import { getTextWidth } from "../shared/text.js";
import { releaseFrameLock, wrapStdoutWithFrameLock } from "./frameLock.js";
import {
  createStartupGraphicsChannel,
  effectiveLogoRenderer,
  graphicsPassthrough,
  KITTY_MAX_PLACEHOLDER_CELLS,
  KITTY_PLACEHOLDER,
  kittyImageCommands,
  kittyPlaceholderRow,
  logoRendererStatus,
  NO_GRAPHICS,
  registerStartupGraphicsChannel,
} from "./startupGraphics.js";

test("graphics require positive protocol and placeholder replies, even when explicitly selected", () => {
  let reply: (value: string) => void = () => {};
  let queries = 0;
  const channel = createStartupGraphicsChannel({
    query: (data, callback) => {
      queries++;
      assert.match(data, /a=q/);
      reply = callback;
    },
  });
  for (const choice of ["auto", "kitty", "iterm2", "sixel", "solid"] as const) {
    assert.equal(effectiveLogoRenderer(choice, channel.capabilities), "solid");
  }
  channel.probe();
  channel.probe();
  assert.equal(queries, 1);
  reply("\x1b_Gi=314159;OK\x1b\\");
  assert.equal(effectiveLogoRenderer("auto", channel.capabilities), "solid");
  reply("\x1bP>|kitty(0.47.1)\x1b\\");
  assert.equal(effectiveLogoRenderer("auto", channel.capabilities), "kitty");
  assert.equal(effectiveLogoRenderer("solid", channel.capabilities), "solid");
  for (const requested of ["iterm2", "sixel"] as const) {
    assert.equal(
      effectiveLogoRenderer(requested, channel.capabilities),
      "kitty",
      "an unavailable saved preference must retain supported graphical output",
    );
    assert.match(
      logoRendererStatus(requested, channel.capabilities, true),
      /Kitty Graphics.*Selected protocol unavailable/,
    );
  }
  assert.equal(effectiveLogoRenderer("iterm2", { ...NO_GRAPHICS, iterm2: true }), "solid");
  assert.equal(effectiveLogoRenderer("sixel", { ...NO_GRAPHICS, sixel: true }), "solid");
  channel.dispose();
  reply("\x1bP>|kitty(0.47.1)\x1b\\");
});

test("Kitty placeholders occupy exactly 12 cells in all three rows", () => {
  for (let row = 0; row < 3; row++) {
    const text = kittyPlaceholderRow(0x123456, row);
    assert.equal(getTextWidth(text), 12);
    assert.equal(text.split(KITTY_PLACEHOLDER).length - 1, 12);
    assert.doesNotMatch(text, /[\u2800-\u28ff\x1b]/);
  }
});

test("inline Kitty data is bounded, SSH-safe and has no filesystem transfer", () => {
  const commands = kittyImageCommands(321, new Uint8Array(10000));
  assert.match(commands, /a=t,t=d,f=100,i=321,q=2/);
  assert.match(commands, /a=p,U=1,i=321,p=1,c=12,r=3/);
  assert.doesNotMatch(commands, /t=f|t=s/);
  for (const match of commands.matchAll(/;([A-Za-z\d+/=]+)\x1b\\/g))
    assert.ok(match[1]!.length <= 4096);
  assert.equal(
    graphicsPassthrough("\x1b_Gtest\x1b\\", true),
    "\x1bPtmux;\x1b\x1b_Gtest\x1b\x1b\\\x1b\\",
  );
});

test("images transmit in the frame transaction and only owned images are cleaned up", () => {
  const writes: string[] = [];
  const stdout = {
    write: (chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    },
  };
  const channel = createStartupGraphicsChannel({ query: () => {} });
  const unregister = registerStartupGraphicsChannel(stdout, channel);
  wrapStdoutWithFrameLock({ stdout, env: {} });
  try {
    channel.stage(0x123456, new Uint8Array([1, 2, 3]));
    stdout.write("ordinary Ink output\n");
    assert.doesNotMatch(writes.join(""), /a=t/);
    stdout.write(`\x1b[38;2;18;52;86m${kittyPlaceholderRow(0x123456, 0)}\x1b[39m`);
    assert.match(writes.at(-1)!, /a=t/);
    assert.ok(writes.at(-1)!.indexOf("a=t") < writes.at(-1)!.indexOf(KITTY_PLACEHOLDER));
    assert.doesNotMatch(writes.at(-1)!, /a=t[^;]*\x1b\[K/);
    assert.equal(channel.prepareFrame(`\x1b[38;2;18;52;86m${KITTY_PLACEHOLDER}`), "");
    assert.equal(channel.dispose(), "\x1b_Ga=d,d=I,i=1193046,q=2\x1b\\");
    assert.equal(channel.dispose(), "");
  } finally {
    unregister();
    releaseFrameLock(stdout);
  }
});

test("native protocols require pixel geometry; Sixel also requires a measured background", () => {
  let reply: (data: string) => void = () => {};
  let queries = 0;
  const channel = createStartupGraphicsChannel({
    query: (_, cb) => {
      queries++;
      reply = cb;
    },
  });
  channel.probe(true);
  assert.equal(queries, 0, "Normal resizing must not start logo probes");
  channel.probe();
  reply("\x1b]1337;Capabilities=F\x07");
  reply("\x1b[?62;4c");
  assert.equal(effectiveLogoRenderer("iterm2", channel.capabilities), "solid");
  reply("\x1b[6;24;10t");
  assert.equal(
    effectiveLogoRenderer("iterm2", channel.capabilities),
    "solid",
    "unknown image erasure lifecycle must fall back",
  );
  reply("\x1bP>|WezTerm 20240203\x1b\\");
  assert.equal(effectiveLogoRenderer("iterm2", channel.capabilities), "iterm2");
  assert.equal(effectiveLogoRenderer("sixel", channel.capabilities), "iterm2");
  reply("\x1b]11;rgb:ffff/8080/0000\x07");
  assert.equal(channel.capabilities.background, "#ff8000");
  assert.equal(effectiveLogoRenderer("sixel", channel.capabilities), "sixel");
  assert.equal(
    effectiveLogoRenderer("sixel", { ...channel.capabilities, multiplexed: true }),
    "solid",
  );
  channel.dispose();
});

test("native image tiles replace only owned measured rows inside the Ink write", () => {
  const channel = createStartupGraphicsChannel({ query: () => {} });
  const tiles = ["\x1b]1337;File=inline=1:AA==\x07", "second", "third"];
  channel.stage(0x123456, new Uint8Array(), tiles);
  const row = `\x1b[38;2;18;52;86m${kittyPlaceholderRow(0x123456, 0)}\x1b[39m  Provider\x1b[K`;
  const result = channel.transformFrame(row);
  assert.ok(result.includes("\x1b7" + tiles[0] + "\x1b8\x1b[12C"));
  assert.ok(result.endsWith("\x1b[39m  Provider\x1b[K"));
  assert.ok(!result.includes(KITTY_PLACEHOLDER));
  assert.equal(channel.prepareFrame(row), "", "native tiles never transmit Kitty commands");
  channel.dispose();
  assert.equal(channel.transformFrame(row), row);
});

test("Kitty assets are uploaded again after alternate-screen and clear transitions", () => {
  const channel = createStartupGraphicsChannel({ query: () => {} });
  const frame = `\x1b[38;2;18;52;86m${kittyPlaceholderRow(0x123456, 0)}`;
  channel.stage(0x123456, new Uint8Array([1, 2, 3]));
  assert.match(channel.prepareFrame(frame), /a=t/);
  assert.equal(channel.prepareFrame(frame), "");
  for (const control of ["\x1b[?1049h", "\x1b[?1049l", "\x1b[2J"]) {
    assert.equal(channel.prepareFrame(control), "");
    assert.match(channel.prepareFrame(frame), /a=t/, "current buffer receives the cached image");
    assert.equal(channel.prepareFrame(frame), "");
  }
  channel.dispose();
});

test("placeholders address every responsive size through Kitty's diacritic table", () => {
  assert.ok(KITTY_MAX_PLACEHOLDER_CELLS >= 40);
  for (const [columns, rows] of [
    [12, 3],
    [24, 6],
    [40, 10],
  ] as const) {
    const lines = Array.from({ length: rows }, (_, row) => kittyPlaceholderRow(1, row, columns));
    for (const line of lines) {
      assert.equal(getTextWidth(line), columns, "diacritics are zero-width combining marks");
      assert.equal(line.split(KITTY_PLACEHOLDER).length - 1, columns);
    }
    assert.equal(new Set(lines).size, rows, "each row encodes a distinct row index");
    assert.match(
      kittyImageCommands(7, new Uint8Array(4), { columns, rows }),
      new RegExp(`p=1,c=${columns},r=${rows}`),
    );
  }
  // Each cell carries a distinct (row, column) pair of combining marks.
  const cells = kittyPlaceholderRow(1, 0, KITTY_MAX_PLACEHOLDER_CELLS).split(KITTY_PLACEHOLDER);
  assert.equal(new Set(cells.slice(1)).size, KITTY_MAX_PLACEHOLDER_CELLS);
  for (const mark of cells[1]!) assert.match(mark, /\p{Mn}/u);
  assert.throws(() => kittyPlaceholderRow(1, 0, KITTY_MAX_PLACEHOLDER_CELLS + 1), RangeError);
  assert.throws(() => kittyPlaceholderRow(1, KITTY_MAX_PLACEHOLDER_CELLS), RangeError);
});

test("staged images keep their own size for placement and inline tile replacement", () => {
  const channel = createStartupGraphicsChannel({ query: () => {} });
  const small = 0x000101;
  const large = 0x000202;
  const color = (id: number) => `\x1b[38;2;${id >> 16};${(id >> 8) & 255};${id & 255}m`;
  channel.stage(small, new Uint8Array([1]));
  channel.stage(large, new Uint8Array([2]), undefined, { columns: 32, rows: 8 });
  const frame =
    `${color(small)}${kittyPlaceholderRow(small, 0)}` +
    `${color(large)}${kittyPlaceholderRow(large, 0, 32)}`;
  const commands = channel.prepareFrame(frame);
  assert.match(commands, new RegExp(`i=${small},p=1,c=12,r=3`));
  assert.match(commands, new RegExp(`i=${large},p=1,c=32,r=8`));
  const tiles = Array.from({ length: 6 }, (_, row) => `<tile ${row}>`);
  const inlineId = 0x000303;
  channel.stage(inlineId, new Uint8Array(), tiles, { columns: 24, rows: 6 });
  const rows = Array.from(
    { length: 6 },
    (_, row) => `${color(inlineId)}${kittyPlaceholderRow(inlineId, row, 24)}\x1b[39m`,
  ).join("\n");
  const result = channel.transformFrame(rows);
  for (let row = 0; row < 6; row++) assert.ok(result.includes(`\x1b7<tile ${row}>\x1b8\x1b[24C`));
  assert.ok(!result.includes(KITTY_PLACEHOLDER), "every row of the larger region is replaced");
  channel.dispose();
});

test("a raster failure latches the solid fallback with an actionable status", () => {
  const channel = createStartupGraphicsChannel({
    query: (_, reply) => reply("\x1b_Gi=314159;OK\x1b\\\x1bP>|kitty(0.47.1)\x1b\\"),
  });
  let notified = 0;
  channel.subscribe(() => notified++);
  channel.probe();
  assert.equal(effectiveLogoRenderer("auto", channel.capabilities), "kitty");
  const before = notified;
  channel.reportRasterFailure();
  channel.reportRasterFailure();
  assert.equal(notified, before + 1, "listeners are told once");
  assert.equal(effectiveLogoRenderer("auto", channel.capabilities), "solid");
  assert.equal(effectiveLogoRenderer("kitty", channel.capabilities), "solid");
  assert.equal(
    logoRendererStatus("auto", channel.capabilities, true),
    "Solid Text — Image rendering failed",
  );
  assert.equal(logoRendererStatus("solid", channel.capabilities, true), "Solid Text");
  // A later capability refresh (e.g. after a resize) does not re-enable images.
  channel.probe(true);
  assert.equal(effectiveLogoRenderer("auto", channel.capabilities), "solid");
  channel.dispose();
  channel.reportRasterFailure();
});

test("placement refresh re-places only transmitted images in the latest logo frame", () => {
  const channel = createStartupGraphicsChannel({ query: () => {} });
  const color = (id: number) => `\x1b[38;2;${id >> 16};${(id >> 8) & 255};${id & 255}m`;
  assert.equal(channel.refreshPlacements(), "", "nothing placed yet");
  channel.stage(0x000101, new Uint8Array([1]), undefined, { columns: 24, rows: 6 });
  channel.stage(0x000202, new Uint8Array([2]));
  // Only the first image is drawn; the second was staged but never placed.
  channel.prepareFrame(`${color(0x000101)}${kittyPlaceholderRow(0x000101, 0, 24)}`);
  const refresh = channel.refreshPlacements();
  assert.equal(
    refresh,
    "\x1b_Ga=p,U=1,i=257,p=1,c=24,r=6,q=2\x1b\\",
    "data-free, same placement id",
  );
  // Partial Ink diffs without logo rows keep the current set; a cleared screen empties it.
  channel.prepareFrame("composer only\n");
  assert.equal(channel.refreshPlacements(), refresh);
  channel.prepareFrame("\x1b[2J\x1b[Hno logo\n");
  assert.equal(channel.refreshPlacements(), "");
  channel.prepareFrame(`${color(0x000101)}${kittyPlaceholderRow(0x000101, 0, 24)}`);
  assert.equal(channel.refreshPlacements(), refresh);
  assert.equal(
    createStartupGraphicsChannel({ query: () => {}, tmux: true }).refreshPlacements(),
    "",
  );
  channel.dispose();
  assert.equal(channel.refreshPlacements(), "");
});
