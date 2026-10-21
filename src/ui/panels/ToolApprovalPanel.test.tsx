import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { render } from "ink";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../core/providers/types.js";
import { ThemeProvider } from "../theme.js";
import { ToolApprovalPanel } from "./ToolApprovalPanel.js";

class Input extends PassThrough {
  readonly isTTY = true;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
class Output extends PassThrough {
  readonly isTTY = true;
  columns = 110;
  rows = 24;
}

test("browser approval renders a concise target and offers only individual approval or denial", async () => {
  const stdin = new Input();
  const stdout = new Output();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const decisions: string[] = [];
  const instance = render(
    <ThemeProvider>
      <ToolApprovalPanel
        focusId="browser-permission"
        request={{
          tool: "browser_type",
          signature: "browser:1",
          paths: [],
          description: "Browser  Type e7 — Email field",
          allowForRun: false,
        }}
        onSelect={(decision) => decisions.push(decision)}
      />
    </ThemeProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(output, /Browser  Type e7/);
    assert.match(output, /Allow once/);
    assert.match(output, /Deny/);
    assert.doesNotMatch(output, /for this run/);
    stdin.write("j");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(decisions, ["deny"]);
  } finally {
    instance.cleanup();
  }
});

async function renderApproval(request: ToolApprovalRequest, columns = 110) {
  const stdin = new Input();
  const stdout = new Output();
  stdout.columns = columns;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const decisions: ToolApprovalDecision[] = [];
  const instance = render(
    <ThemeProvider>
      <ToolApprovalPanel
        focusId="claude-permission"
        request={request}
        onSelect={(decision) => decisions.push(decision)}
      />
    </ThemeProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    output: () => output,
    decisions,
    press: async (key: string) => {
      stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    cleanup: () => instance.cleanup(),
  };
}

const claudeCommand: ToolApprovalRequest = {
  tool: "Bash",
  signature: "Bash:x",
  command: 'npm install && npm run build | tee "build log.txt"',
  paths: [],
  description: "Install and build",
  provider: "Claude Code",
  workspace: "/home/me/23-Ubume Minecraft tester/2-Claude",
  kind: "command",
  reason: "Command is not read-only",
};

test("Claude command approval names the provider, full command, workspace and reason", async () => {
  const view = await renderApproval(claudeCommand);
  try {
    const output = view.output();
    assert.match(output, /CLAUDE CODE PERMISSION/);
    assert.match(output, /wants to run a shell command/);
    assert.match(output, /npm install && npm run build \| tee "build log.txt"/);
    assert.match(output, /Workspace: 2-Claude/);
    assert.match(output, /Reason: Command is not read-only/);
    assert.match(output, /Shell commands can affect files/);
    assert.match(output, /1\. Allow once/);
    assert.match(output, /2\. Allow this exact action for this run/);
    assert.match(output, /3\. Deny/);
    await view.press("2");
    assert.deepEqual(view.decisions, ["allow-for-run"]);
  } finally {
    view.cleanup();
  }
});

test("Claude file approval shows the file, warns outside the workspace, and Esc denies", async () => {
  const view = await renderApproval({
    tool: "Write",
    signature: "Write:x",
    paths: ["/etc/hosts"],
    provider: "Claude Code",
    workspace: "/home/me/project",
    kind: "file",
    outsideWorkspace: true,
    allowForRun: false,
  });
  try {
    const output = view.output();
    assert.match(output, /wants to use Write on a file/);
    assert.match(output, /File: \/etc\/hosts/);
    assert.match(output, /outside the workspace/);
    assert.doesNotMatch(output, /Shell commands/);
    assert.doesNotMatch(output, /for this run/);
    await view.press("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(view.decisions, ["deny"]);
  } finally {
    view.cleanup();
  }
});

test("approval prompt stays usable at a narrow terminal width", async () => {
  const view = await renderApproval(claudeCommand, 40);
  try {
    assert.match(view.output(), /PERMISSION/);
    await view.press("1");
    assert.deepEqual(view.decisions, ["allow-once"]);
  } finally {
    view.cleanup();
  }
});
