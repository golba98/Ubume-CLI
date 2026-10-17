import { expect, test } from "bun:test";
import { Text, useInput } from "ink";
import { useState } from "react";
import { waitFor } from "./async.js";
import { createTestTerminal } from "./terminal.js";

function InputProbe() {
  const [value, setValue] = useState("waiting");
  useInput((input) => setValue(input));
  return <Text>{`value:${value}`}</Text>;
}

test("terminal captures whole frames and history while preserving real stream input", async () => {
  const terminal = createTestTerminal(<InputProbe />, { columns: 80, rows: 20 });
  try {
    await waitFor(() => terminal.lastFrame().includes("value:waiting"), { label: "initial frame" });
    terminal.stdin.write("x");
    await waitFor(() => terminal.lastFrame().includes("value:x"), { label: "input frame" });
    expect(terminal.output()).toContain("value:waiting");
    expect(terminal.output()).toContain("value:x");
    expect(terminal.stdout.columns).toBe(80);
    expect(terminal.stdout.rows).toBe(20);
  } finally {
    await terminal.dispose();
  }
  expect(terminal.stdin.destroyed).toBe(true);
  expect(terminal.stdout.destroyed).toBe(true);
  expect(terminal.stdout.listenerCount("data")).toBe(0);
  expect(terminal.stdin.listenerCount("readable")).toBe(0);
  await terminal.dispose();
});

test("separate terminal instances do not share output", async () => {
  const first = createTestTerminal(<Text>first fixture</Text>);
  const second = createTestTerminal(<Text>second fixture</Text>);
  try {
    await Promise.all([
      waitFor(() => first.output().includes("first fixture"), { label: "first" }),
      waitFor(() => second.output().includes("second fixture"), { label: "second" }),
    ]);
    expect(first.output()).not.toContain("second fixture");
    expect(second.output()).not.toContain("first fixture");
  } finally {
    await first.dispose();
    await second.dispose();
  }
});
