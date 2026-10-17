import assert from "node:assert/strict";
import test from "node:test";
import {
  formatToolActivity,
  isProcessTerminationNoise,
  shouldSuppressAssistantChunk,
  writeDiagnostic,
} from "./execOutput.js";

function capture() {
  let text = "";
  return {
    stream: {
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

test("diagnostics are prefixed, sanitised, indented and skipped when blank", () => {
  const stderr = capture();
  writeDiagnostic(stderr.stream, "tool", "\x1b[32mline one\r\nline two\x1b[0m");
  writeDiagnostic(stderr.stream, "tool", "  \n ");
  assert.equal(stderr.text(), "[ubume exec] tool: line one\n  line two\n");
});

test("only chunks made entirely of protocol or teardown noise are suppressed", () => {
  const event = '{"type":"item.completed","item":{}}';
  const kill = "SUCCESS: The process with PID 42 (child process of PID 7) has been terminated.";
  assert.equal(shouldSuppressAssistantChunk(`${event}\n${kill}\n`), true);
  assert.equal(shouldSuppressAssistantChunk(`${event}\nreal answer`), false);
  assert.equal(shouldSuppressAssistantChunk('{"type":"message"}'), false);
  assert.equal(shouldSuppressAssistantChunk("{not json}"), false);
  assert.equal(shouldSuppressAssistantChunk("\n  \n"), false);
  assert.equal(isProcessTerminationNoise(`  ${kill}  `), true);
});

test("tool activity shows its summary unless the summary is teardown noise", () => {
  const base = { id: "1", command: "ls", status: "completed" } as const;
  assert.equal(
    formatToolActivity({ ...base, summary: " 3 files " } as never),
    "completed: ls\n3 files",
  );
  assert.equal(formatToolActivity({ ...base } as never), "completed: ls");
  assert.equal(
    formatToolActivity({
      ...base,
      summary: "SUCCESS: The process with PID 1 (x) has been terminated.",
    } as never),
    "completed: ls",
  );
});
