import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "ink";
import {
  createStartupGraphicsChannel,
  registerStartupGraphicsChannel,
} from "../../core/terminal/startupGraphics.js";
import { settle } from "../../test/async.js";
import { createTestTerminal } from "../../test/terminal.js";
import { ThemeProvider } from "../theme.js";
import { useStartupLogoAnimation } from "./useStartupLogoAnimation.js";
import { useStartupLogoGraphic } from "./useStartupLogoGraphic.js";

test("graphical asset recolors without replay and ignores asynchronous work after unmount", async () => {
  const requests: { svg: string; resolve: (r: { id: number; png: Uint8Array }) => void }[] = [];
  const rasterize = (svg: string) =>
    new Promise<{ id: number; png: Uint8Array }>((resolve) => requests.push({ svg, resolve }));
  let id: number | null = null;
  let atMs = 0;
  let reply: (value: string) => void = () => {};
  const channel = createStartupGraphicsChannel({
    query: (_, callback) => {
      reply = callback;
    },
  });
  function Probe() {
    const frame = useStartupLogoAnimation(false);
    atMs = frame.atMs;
    id = useStartupLogoGraphic(frame, "iterm2", true, rasterize);
    return <Text>{id ?? "solid"}</Text>;
  }
  const node = (theme: string) => (
    <ThemeProvider theme={theme}>
      <Probe />
    </ThemeProvider>
  );
  const terminal = createTestTerminal(node("dark"));
  Object.assign(terminal.stdout, { getColorDepth: () => 24 });
  const unregister = registerStartupGraphicsChannel(terminal.stdout, channel);
  try {
    terminal.instance.rerender(node("dark"));
    await settle();
    reply("\x1b_Gi=314159;OK\x1b\\");
    reply("\x1bP>|kitty(0.47.1)\x1b\\");
    await settle();
    assert.equal(requests.length, 1);
    requests[0]!.resolve({ id: 123, png: new Uint8Array([1]) });
    await settle();
    assert.equal(id, 123);
    assert.equal(atMs, 520);
    terminal.instance.rerender(node("purple"));
    await settle();
    assert.equal(id, 123, "retain the graphical frame while recoloring, never flash blocks");
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0]!.svg, requests[1]!.svg);
    assert.equal(atMs, 520);
    requests[1]!.resolve({ id: 124, png: new Uint8Array([2]) });
    await settle();
    assert.equal(id, 124);
    terminal.instance.rerender(node("mono"));
    await settle();
    await terminal.dispose();
    requests[2]!.resolve({ id: 125, png: new Uint8Array([3]) });
    await settle();
    assert.doesNotMatch(channel.prepareFrame("\x1b[38;2;0;0;125m\u{10eeee}"), /a=t/);
  } finally {
    unregister();
    channel.dispose();
    await terminal.dispose();
  }
});

function kittyChannel() {
  return createStartupGraphicsChannel({
    query: (_, reply) => reply("\x1b_Gi=314159;OK\x1b\\\x1bP>|kitty(0.47.1)\x1b\\"),
  });
}

test("a failing rasterizer degrades to solid once and is not retried on every resize", async () => {
  let calls = 0;
  const rasterize = async () => {
    calls++;
    throw new Error("sharp unavailable");
  };
  const channel = kittyChannel();
  let id: number | null = -1;
  function Probe({ rows }: { rows: number }) {
    const frame = useStartupLogoAnimation(false);
    id = useStartupLogoGraphic(frame, "auto", true, rasterize, { columns: rows * 4, rows });
    return <Text>{id ?? "solid"}</Text>;
  }
  const node = (rows: number) => (
    <ThemeProvider theme="dark">
      <Probe rows={rows} />
    </ThemeProvider>
  );
  const terminal = createTestTerminal(node(3));
  Object.assign(terminal.stdout, { getColorDepth: () => 24 });
  const unregister = registerStartupGraphicsChannel(terminal.stdout, channel);
  try {
    terminal.instance.rerender(node(3));
    await settle();
    assert.equal(calls, 1);
    assert.equal(id, null);
    assert.equal(channel.capabilities.rasterFailed, true);
    for (const rows of [4, 5, 6, 8, 3]) {
      terminal.instance.rerender(node(rows));
      await settle();
    }
    assert.equal(calls, 1, "resizes after a deterministic failure do not re-attempt");
    assert.equal(id, null);
  } finally {
    unregister();
    channel.dispose();
    await terminal.dispose();
  }
});

test("a resize never places an image prepared for a different cell region", async () => {
  const requests: {
    size: { columns: number; rows: number } | undefined;
    resolve: (r: { id: number; png: Uint8Array }) => void;
  }[] = [];
  const rasterize = (_svg: string, options: { size?: { columns: number; rows: number } }) =>
    new Promise<{ id: number; png: Uint8Array }>((resolve) =>
      requests.push({ size: options.size, resolve }),
    );
  const channel = kittyChannel();
  let id: number | null = null;
  function Probe({ rows }: { rows: number }) {
    const frame = useStartupLogoAnimation(false);
    id = useStartupLogoGraphic(frame, "auto", true, rasterize, { columns: rows * 4, rows });
    return <Text>{id ?? "solid"}</Text>;
  }
  const node = (rows: number) => (
    <ThemeProvider theme="dark">
      <Probe rows={rows} />
    </ThemeProvider>
  );
  const terminal = createTestTerminal(node(3));
  Object.assign(terminal.stdout, { getColorDepth: () => 24 });
  const unregister = registerStartupGraphicsChannel(terminal.stdout, channel);
  try {
    terminal.instance.rerender(node(3));
    await settle();
    requests.at(-1)!.resolve({ id: 11, png: new Uint8Array([1]) });
    await settle();
    assert.equal(id, 11);
    terminal.instance.rerender(node(5));
    await settle();
    const superseded = requests.at(-1)!;
    assert.deepEqual(superseded.size, { columns: 20, rows: 5 });
    assert.equal(id, null, "solid at the new size until its own image is ready");
    terminal.instance.rerender(node(8));
    await settle();
    assert.deepEqual(requests.at(-1)!.size, { columns: 32, rows: 8 });
    // A late result for an intermediate size must not be adopted for the new region.
    superseded.resolve({ id: 12, png: new Uint8Array([2]) });
    await settle();
    assert.equal(id, null);
    requests.at(-1)!.resolve({ id: 13, png: new Uint8Array([3]) });
    await settle();
    assert.equal(id, 13);
    assert.match(
      channel.prepareFrame(`\x1b[38;2;0;0;13m\u{10eeee}`),
      /i=13,p=1,c=32,r=8/,
      "the staged image is placed at its own size",
    );
  } finally {
    unregister();
    channel.dispose();
    await terminal.dispose();
  }
});
