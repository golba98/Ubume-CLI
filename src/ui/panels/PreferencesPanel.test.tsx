/**
 * PreferencesPanel keyboard behavior: entry navigation, Enter opening the
 * target setting screen, Escape closing, and the visible current values that
 * keep `/theme` and `/preferences` in sync (both read the same committed theme).
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Box, render, Text } from "ink";
import React from "react";
import type { StartupLogoStyle } from "../../config/settings.js";
import { ThemeProvider } from "../theme.js";
import { type PreferencesEntry, PreferencesPanel } from "./PreferencesPanel.js";

class TestInput extends PassThrough {
  readonly isTTY = true;

  setRawMode(): this {
    return this;
  }

  override resume(): this {
    return this;
  }

  override pause(): this {
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
  columns = 120;
  rows = 40;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createInkHarness(node: React.ReactElement) {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    stdin,
    instance,
    getOutput(): string {
      return stripAnsi(output);
    },
    async cleanup() {
      instance.cleanup();
      await sleep(20);
    },
  };
}

function createEntries(): readonly PreferencesEntry[] {
  return [
    {
      id: "startup-logo",
      label: "Startup Logo",
      value: "Normal",
      target: "startup-logo-picker",
    },
    {
      id: "startup-animation",
      label: "Startup Animation",
      value: "On",
      target: "startup-animation-picker",
    },
    {
      id: "color-theme",
      label: "Color Theme",
      value: "Ubume Dark",
      target: "theme-picker",
    },
  ];
}

function PreferencesHarness() {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [cancelCount, setCancelCount] = React.useState(0);

  return (
    <ThemeProvider theme="purple">
      <Box flexDirection="column">
        <PreferencesPanel
          focusId="preferences-panel"
          entries={createEntries()}
          onSelect={(entry) => setSelected(`${entry.id}:${entry.target}`)}
          onCancel={() => setCancelCount((count) => count + 1)}
        />
        <Text>{`selected:${selected ?? "none"}`}</Text>
        <Text>{`cancel:${cancelCount}`}</Text>
      </Box>
    </ThemeProvider>
  );
}

test("renders the appearance entries with their current values", async () => {
  const harness = createInkHarness(<PreferencesHarness />);
  try {
    await sleep();
    const output = harness.getOutput();
    assert.match(output, /Ubume Preferences/);
    assert.match(output, /Appearance/);
    assert.match(output, /> Startup Logo\s+Normal/);
    assert.match(output, /Startup Animation\s+On/);
    assert.match(output, /Color Theme\s+Ubume Dark/);
    // Labels are padded to the maximum label width (Startup Animation = 17)
    assert.match(output, /> Startup Logo {5} {2}Normal/);
    assert.match(output, /Color Theme {6} {2}Ubume Dark/);
  } finally {
    await harness.cleanup();
  }
});

test("Enter opens the highlighted entry; arrow keys move the selection", async () => {
  const harness = createInkHarness(<PreferencesHarness />);
  try {
    await sleep();
    // First entry (Startup Logo) is initially highlighted.
    harness.stdin.write("\r");
    await sleep(60);
    assert.match(harness.getOutput(), /selected:startup-logo:startup-logo-picker/);

    // Down to Startup Animation, Enter opens its picker.
    harness.stdin.write("\u001b[B");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(60);
    assert.match(harness.getOutput(), /selected:startup-animation:startup-animation-picker/);

    // Down to Color Theme, then Enter opens the theme picker screen.
    harness.stdin.write("\u001b[B");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(60);
    assert.match(harness.getOutput(), /selected:color-theme:theme-picker/);
  } finally {
    await harness.cleanup();
  }
});

test("Escape cancels without opening a setting screen", async () => {
  const harness = createInkHarness(<PreferencesHarness />);
  try {
    await sleep();
    harness.stdin.write("\u001b");
    await sleep(60);
    const output = harness.getOutput();
    assert.match(output, /selected:none/);
    assert.match(output, /cancel:1/);
  } finally {
    await harness.cleanup();
  }
});

test("j/k move like arrow keys and the selection cannot leave the list", async () => {
  const harness = createInkHarness(<PreferencesHarness />);
  try {
    await sleep();
    harness.stdin.write("k");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(60);
    assert.match(harness.getOutput(), /selected:startup-logo:startup-logo-picker/);

    harness.stdin.write("j");
    await sleep(40);
    harness.stdin.write("j");
    await sleep(40);
    harness.stdin.write("j");
    await sleep(40);
    harness.stdin.write("\r");
    await sleep(60);
    assert.match(harness.getOutput(), /selected:color-theme:theme-picker/);
  } finally {
    await harness.cleanup();
  }
});

test("the logo entry value follows the persisted style (single source of truth)", async () => {
  function StyledHarness({ logoStyle }: { logoStyle: StartupLogoStyle }) {
    return (
      <ThemeProvider theme="purple">
        <PreferencesPanel
          focusId="preferences-panel"
          entries={[
            {
              id: "startup-logo",
              label: "Startup Logo",
              value: logoStyle,
              target: "startup-logo-picker",
            },
          ]}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </ThemeProvider>
    );
  }

  const harness = createInkHarness(<StyledHarness logoStyle="minimal" />);
  try {
    await sleep();
    assert.match(harness.getOutput(), /minimal/);
  } finally {
    await harness.cleanup();
  }
});

test("all header/rendering settings remain reachable in a short preferences viewport", async () => {
  const { PanelLayoutContext } = await import("../layout.js");
  const { createTestTerminal } = await import("../../test/terminal.js");
  const { settle } = await import("../../test/async.js");
  const entries: PreferencesEntry[] = [
    ...createEntries(),
    { id: "rendering", label: "Logo Rendering", value: "Auto", target: "startup-rendering-picker" },
    {
      id: "header",
      label: "Middle Line",
      value: "Provider",
      section: "Startup Header",
      target: "startup-header-picker",
    },
  ];
  let selected = "";
  const t = createTestTerminal(
    <PanelLayoutContext.Provider value={{ mode: "compact", availableRows: 5, availableCols: 55 }}>
      <PreferencesPanel
        focusId="preferences-short"
        entries={entries}
        onSelect={(entry) => {
          selected = entry.id;
        }}
        onCancel={() => {}}
      />
    </PanelLayoutContext.Provider>,
  );
  try {
    await settle();
    t.stdin.write("\x1b[F");
    await settle();
    const text = stripAnsi(t.lastFrame());
    assert.match(text, /Middle Line/);
    assert.ok(text.trimEnd().split("\n").length <= 5);
    t.stdin.write("\r");
    await settle();
    assert.equal(selected, "header");
  } finally {
    await t.dispose();
  }
});
