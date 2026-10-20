import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "ink";
import { settle } from "../../test/async.js";
import { createFakeClock } from "../../test/fakeClock.js";
import { createTestTerminal } from "../../test/terminal.js";
import { ThemeProvider, useTheme } from "../theme.js";
import { FINAL_STARTUP_LOGO_FRAME, type StartupLogoAnimationFrame } from "./startupAnimation.js";
import { useStartupLogoAnimation } from "./useStartupLogoAnimation.js";

function harness(initialEnabled = true) {
  const clock = createFakeClock();
  let frame: StartupLogoAnimationFrame;
  let color = "";
  function Probe({ enabled }: { enabled: boolean }) {
    frame = useStartupLogoAnimation(enabled, clock);
    color = useTheme().logoPrimary;
    return <Text>{frame.atMs}</Text>;
  }
  const node = (enabled: boolean, theme = "dark") => (
    <ThemeProvider theme={theme}>
      <Probe enabled={enabled} />
    </ThemeProvider>
  );
  const terminal = createTestTerminal(node(initialEnabled));
  return {
    clock,
    terminal,
    frame: () => frame!,
    color: () => color,
    rerender: (enabled = true, theme = "dark") => terminal.instance.rerender(node(enabled, theme)),
  };
}

test("one-shot hook follows finite frames, recolors and never restarts on rerenders", async () => {
  const h = harness();
  try {
    await settle();
    assert.equal(h.frame().atMs, 0);
    assert.equal(h.clock.pending().length, 1);
    await h.clock.advance(240);
    assert.equal(h.frame().atMs, 240);
    const previousColor = h.color();
    h.rerender(true, "purple");
    await settle();
    assert.notEqual(h.color(), previousColor);
    assert.equal(h.frame().atMs, 240);
    assert.equal(h.clock.pending().length, 1);
    await h.clock.advance(160);
    assert.equal(h.frame().impact, true);
    await h.clock.advance(120);
    assert.equal(h.frame(), FINAL_STARTUP_LOGO_FRAME);
    assert.equal(h.clock.pending().length, 0);
    h.rerender(true, "mono");
    await settle();
    assert.equal(h.frame(), FINAL_STARTUP_LOGO_FRAME);
    await h.clock.advance(5000);
    assert.equal(h.clock.pending().length, 0);
  } finally {
    await h.terminal.dispose();
  }
});

test("unmount cancels pending work without updates after unmount", async () => {
  const h = harness();
  await settle();
  await h.clock.advance(80);
  const lastFrame = h.frame();
  await h.terminal.dispose();
  assert.equal(h.clock.pending().length, 0);
  await h.clock.advance(1000);
  assert.equal(h.frame(), lastFrame);
});

test("disabled animation starts complete and cannot begin later", async () => {
  const h = harness(false);
  try {
    await settle();
    assert.equal(h.frame(), FINAL_STARTUP_LOGO_FRAME);
    assert.equal(h.clock.pending().length, 0);
    h.rerender(true);
    await settle();
    assert.equal(h.frame(), FINAL_STARTUP_LOGO_FRAME);
    assert.equal(h.clock.pending().length, 0);
  } finally {
    await h.terminal.dispose();
  }
});

test("disabling motion or hiding a running presentation settles and cancels it", async () => {
  const h = harness();
  try {
    await settle();
    await h.clock.advance(140);
    h.rerender(false);
    await settle();
    assert.equal(h.frame(), FINAL_STARTUP_LOGO_FRAME);
    assert.equal(h.clock.pending().length, 0);
    h.rerender(true);
    await settle();
    assert.equal(h.frame(), FINAL_STARTUP_LOGO_FRAME);
    assert.equal(h.clock.pending().length, 0);
  } finally {
    await h.terminal.dispose();
  }
});

test("a late scheduler skips overdue frames instead of extending the entrance", async () => {
  const h = harness();
  try {
    await settle();
    h.clock.now = () => 1000;
    await h.clock.advance(40);
    assert.equal(h.frame(), FINAL_STARTUP_LOGO_FRAME);
    assert.equal(h.clock.pending().length, 0);
  } finally {
    await h.terminal.dispose();
  }
});
