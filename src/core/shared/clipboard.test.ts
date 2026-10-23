import assert from "node:assert/strict";
import test from "node:test";
import { buildOsc52Sequence, copyToClipboard, MAX_OSC52_TEXT_BYTES } from "./clipboard.js";

const KITTY_LOGO_CELLS = "\u{10eeee}\u0305\u0305\u{10eeee}\u0305\u030d";

/** Decodes an OSC 52 sequence back to the bytes the terminal would place on the clipboard. */
function osc52Bytes(sequence: string): Buffer {
  const match = /^\x1b\]52;c;([A-Za-z0-9+/=]*)\x07$/.exec(sequence);
  assert.ok(match, `not an OSC 52 sequence: ${JSON.stringify(sequence.slice(0, 40))}`);
  return Buffer.from(match[1]!, "base64");
}

function recorder(succeeds: (cmd: string) => boolean) {
  const calls: string[] = [];
  const writes: string[] = [];
  return {
    calls,
    writes,
    options: {
      platform: "linux" as const,
      spawnText: async (cmd: string) => {
        calls.push(cmd);
        return succeeds(cmd);
      },
      writeTerminal: (sequence: string) => writes.push(sequence),
    },
  };
}

test("Wayland copies through wl-copy first and never reaches X11 tools or OSC 52", async () => {
  const run = recorder((cmd) => cmd === "wl-copy");
  const result = await copyToClipboard("hello", {
    ...run.options,
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
  });
  assert.deepEqual(result, { ok: true, method: "wl-copy" });
  assert.deepEqual(run.calls, ["wl-copy"]);
  assert.deepEqual(run.writes, []);
});

test("Wayland without wl-clipboard (the Fedora/Kitty case) falls through X11 tools to OSC 52", async () => {
  const run = recorder(() => false);
  const result = await copyToClipboard("hello", {
    ...run.options,
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
  });
  assert.deepEqual(result, { ok: true, method: "osc52" });
  assert.deepEqual(run.calls, ["wl-copy", "xclip", "xsel"]);
  assert.equal(osc52Bytes(run.writes[0]!).toString("utf8"), "hello");
});

test("X11 sessions use xclip then xsel; Wayland tools are not tried without WAYLAND_DISPLAY", async () => {
  const run = recorder((cmd) => cmd === "xsel");
  const result = await copyToClipboard("x", { ...run.options, env: { DISPLAY: ":0" } });
  assert.deepEqual(result, { ok: true, method: "xsel" });
  assert.deepEqual(run.calls, ["xclip", "xsel"]);
});

test("OSC 52 carries exact UTF-8 bytes for every kind of text", () => {
  const samples = [
    "plain ASCII 123",
    "Ünïcödé — ελληνικά — 日本語",
    "e\u0301 combining + a\u0308\u0323 stacked marks",
    KITTY_LOGO_CELLS,
    "👩🏽‍💻 ZWJ + 🇿🇦 flag + 1\ufe0f⃣ keycap",
    "\x1b[31mANSI stays literal\x1b[0m",
    "line one\r\n  indented\n\ttabbed\n\n",
  ];
  for (const text of samples) {
    const bytes = osc52Bytes(buildOsc52Sequence(text));
    assert.ok(bytes.equals(Buffer.from(text, "utf8")), `byte mismatch for ${JSON.stringify(text)}`);
    assert.equal(bytes.toString("utf8"), text);
  }
});

test("inside tmux the OSC 52 request is wrapped in a passthrough", () => {
  assert.equal(buildOsc52Sequence("hi", true), "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
});

test("no display tools and no terminal reports an accurate reason instead of claiming success", async () => {
  const run = recorder(() => false);
  const result = await copyToClipboard("x", { ...run.options, env: {}, writeTerminal: null });
  assert.deepEqual(result, {
    ok: false,
    reason: "no Wayland or X11 display; no terminal attached for OSC 52",
  });
  assert.deepEqual(run.calls, []);

  const oversized = await copyToClipboard("a".repeat(MAX_OSC52_TEXT_BYTES + 1), {
    ...run.options,
    env: { WAYLAND_DISPLAY: "wayland-0" },
  });
  assert.deepEqual(oversized, {
    ok: false,
    reason: "wl-copy unavailable or failed; text too large for OSC 52",
  });
  assert.deepEqual(run.writes, []);
});

test("macOS and Windows keep their native clipboard commands", async () => {
  const run = recorder(() => true);
  assert.deepEqual(await copyToClipboard("x", { ...run.options, platform: "darwin", env: {} }), {
    ok: true,
    method: "pbcopy",
  });
  assert.deepEqual(await copyToClipboard("x", { ...run.options, platform: "win32", env: {} }), {
    ok: true,
    method: "clip",
  });
  assert.deepEqual(run.calls, ["pbcopy", "clip"]);
});
