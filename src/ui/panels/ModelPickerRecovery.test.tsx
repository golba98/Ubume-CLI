import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { render } from "ink";
import type { CodexModelCapability } from "../../core/models/codexModelCapabilities.js";
import { createLayoutSnapshot } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import { ModelPickerScreen } from "./ModelPickerScreen.js";

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
  columns = 100;
  rows = 30;
}

const sleep = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const model = (id: string): CodexModelCapability => ({
  id,
  model: id,
  label: id.toUpperCase(),
  description: null,
  available: true,
  hidden: false,
  isDefault: false,
  defaultReasoningLevel: null,
  supportedReasoningLevels: null,
  reasoningLevelCount: null,
  source: "fallback",
  raw: null,
});

test("an open picker recovers when the highlighted model disappears or the list empties", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  const selected: string[] = [];
  const cancelled: (string | undefined)[] = [];
  const picker = (models: CodexModelCapability[]) => (
    <ThemeProvider theme="purple">
      <ModelPickerScreen
        layout={createLayoutSnapshot(100, 30)}
        models={models}
        currentModel="alpha"
        currentReasoning="medium"
        onSelect={(id) => selected.push(id)}
        onCancel={(reason) => cancelled.push(reason)}
      />
    </ThemeProvider>
  );
  const instance = render(picker([model("alpha"), model("beta"), model("gamma")]), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await sleep();
    stdin.write("\u001b[B");
    stdin.write("\u001b[B");
    await sleep();
    // gamma is highlighted; a refresh drops it, so the highlight must land on a real row.
    instance.rerender(picker([model("alpha"), model("beta")]));
    await sleep();
    stdin.write("\r");
    await sleep();
    assert.deepEqual(selected, ["beta"]);

    instance.rerender(picker([]));
    await sleep();
    stdin.write("\r");
    await sleep();
    assert.deepEqual(cancelled, ["empty-selection"], "Enter on an empty list closes the picker");
    assert.deepEqual(selected, ["beta"], "nothing stale is selected");
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
