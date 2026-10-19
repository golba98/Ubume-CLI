import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeTerminalInput,
  sanitizeTerminalLines,
  sanitizeTerminalOutput,
  sanitizeTerminalStreamChunk,
} from "./terminalSanitize.js";

test("sanitizeTerminalOutput strips ANSI/OSC/control bytes and normalizes line breaks", () => {
  const raw = "A\u001B[31mred\u001B[0m\u001B]0;title\u0007\r\nB\rC\u0007";
  assert.equal(sanitizeTerminalOutput(raw), "Ared\nB\nC");
});

test("sanitizeTerminalInput removes layout-breaking escapes", () => {
  const raw = "hello\u001B[2J\u001B[H\tworld";
  assert.equal(sanitizeTerminalInput(raw), "hello  world");
});

test("sanitizeTerminalLines sanitizes and drops empty lines", () => {
  const lines = ["\u001B[32mok\u001B[0m", " \u0007", "next\rline"];
  assert.deepEqual(sanitizeTerminalLines(lines), ["ok", "next\nline"]);
});

test("plain Unicode and LF fast path agrees with control-heavy normalization", () => {
  const text = "你好🌸\nplain text\n";
  assert.equal(sanitizeTerminalOutput(text), text);
  assert.equal(sanitizeTerminalStreamChunk(text), text);
  assert.equal(sanitizeTerminalOutput(`\x1b[0m${text}`), text);
  assert.equal(sanitizeTerminalOutput("a\tb", { preserveTabs: true }), "a\tb");
  assert.equal(sanitizeTerminalOutput("a\tb", { tabSize: 4 }), "a    b");
  for (let code = 0; code < 32; code++) {
    const char = String.fromCharCode(code);
    const expected = code === 9 ? "  " : code === 10 || code === 13 ? "\n" : "";
    assert.equal(sanitizeTerminalOutput(`a${char}b`), `a${expected}b`);
    assert.equal(sanitizeTerminalStreamChunk(`a${char}b`), `a${expected}b`);
  }
});
