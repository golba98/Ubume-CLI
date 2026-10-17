import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { render, Text, useStdin } from "ink";
import {
  isMouseReportSequence,
  type RawStdinSignals,
  useRawStdinSignals,
} from "./rawStdinSignals.js";

class TestInput extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}
class TestOutput extends PassThrough {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SPECS = {
  mouse: { matches: isMouseReportSequence, holdMs: 40 },
  backtab: { matches: (raw: string) => raw === "\u001b[Z", holdMs: 40 },
} as const;

test("recognises SGR and X10 mouse reports only", () => {
  assert.equal(isMouseReportSequence("\u001b[<0;26;24M"), true);
  assert.equal(isMouseReportSequence("\u001b[<64;3;4m"), true);
  assert.equal(isMouseReportSequence("\u001b[M !!"), true);
  assert.equal(isMouseReportSequence("[<0;26;24M"), false, "fragment without ESC");
  assert.equal(isMouseReportSequence("\u001b[A"), false);
});

test("signals open on a matching chunk, expire, can be consumed, and are cleaned up", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let signals: RawStdinSignals<keyof typeof SPECS> | undefined;
  const chunks: string[] = [];
  function Probe() {
    const { stdin: inkStdin } = useStdin();
    signals = useRawStdinSignals(inkStdin, SPECS, (raw) => chunks.push(raw));
    return <Text>probe</Text>;
  }
  const baseline = stdin.listenerCount("data");
  const instance = render(<Probe />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await instance.waitUntilRenderFlush();
    assert.ok(signals);
    const firstSignals = signals;

    stdin.write("\u001b[<0;1;1M");
    await sleep(5);
    assert.equal(signals.isActive("mouse"), true);
    assert.equal(signals.isActive("backtab"), false);
    await sleep(60);
    assert.equal(signals.isActive("mouse"), false, "the hold window expires");

    stdin.write("\u001b[Z");
    await sleep(5);
    assert.equal(signals.isActive("backtab"), true);
    signals.consume("backtab");
    assert.equal(signals.isActive("backtab"), false, "consume closes the window at once");

    instance.rerender(<Probe />);
    await instance.waitUntilRenderFlush();
    assert.equal(signals, firstSignals, "the signals object is stable across renders");
    assert.deepEqual(
      chunks,
      ["\u001b[<0;1;1M", "\u001b[Z"],
      "every chunk reaches the extra handler",
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
  await sleep(5);
  assert.equal(stdin.listenerCount("data"), baseline, "the raw listener is removed on unmount");
});
