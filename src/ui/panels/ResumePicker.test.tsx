import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { render, renderToString } from "ink";
import type React from "react";
import { getTextWidth } from "../../core/shared/text.js";
import { conversationSummary, mergeSessionSummaries } from "../../session/sessionCatalog.js";
import { createAtomicContentToken } from "../input/pastedContent.js";
import { PanelLayoutContext } from "../layout.js";
import { ThemeProvider } from "../theme.js";
import { ResumePicker, visibleResumeTabs } from "./ResumePicker.js";

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
  columns = 100;
  rows = 22;
}

function sleep(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ResumePicker keeps its side borders aligned for pasted titles at different widths", () => {
  const conversations = [
    {
      version: 1 as const,
      id: "chat_paste",
      title: createAtomicContentToken("[Pasted Content 22,703 chars]"),
      createdAt: "",
      updatedAt: "not a date",
      providerId: "local",
      modelId: "Ornith-1.5-35B-A3B-Q4_K_M",
      backendKind: null,
      messageCount: 9,
    },
  ];
  for (const columns of [60, 80, 100, 120]) {
    // Ink colors the border when the test runner's stdout is a TTY (e.g. `npm publish`).
    const frame = stripVTControlCharacters(
      renderToString(
        <ThemeProvider theme="purple">
          <PanelLayoutContext.Provider
            value={{ mode: "compact", availableRows: 12, availableCols: columns - 4 }}
          >
            <ResumePicker
              conversations={conversations}
              onSelect={() => {}}
              onCancel={() => {}}
              loadSessions={async () => ({ sessions: [], errors: [] })}
            />
          </PanelLayoutContext.Provider>
        </ThemeProvider>,
        { columns },
      ),
    );
    // Ink emits ANSI styles in color-enabled terminals; compare visible borders.
    const lines = stripVTControlCharacters(frame).split("\n");
    assert.equal(lines.length, 6);
    assert.match(frame, /\[Pasted Content 22,703 chars\]/);
    assert.doesNotMatch(frame, /\u2063[\uFE00-\uFE09]+\u2063/);
    for (const line of lines)
      assert.equal(getTextWidth(line), columns, `misaligned border at ${columns} columns: ${line}`);
    for (const line of lines.slice(1, -1)) {
      assert.ok(line.startsWith("│ "));
      assert.ok(line.endsWith(" │"));
    }
  }
});

test("ResumePicker lists metadata and resumes the selected conversation", async () => {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  let selected: string | null = null;
  const instance = render(
    <ThemeProvider theme="purple">
      <PanelLayoutContext.Provider
        value={{ mode: "compact", availableRows: 12, availableCols: 96 }}
      >
        <ResumePicker
          conversations={[
            {
              version: 1,
              id: "chat_one",
              title: "Fix provider picker",
              createdAt: "2026-08-16T10:00:00.000Z",
              updatedAt: "2026-08-16T10:00:00.000Z",
              providerId: "local",
              modelId: "qwen",
              backendKind: "local-openai-compatible",
              messageCount: 4,
            },
          ]}
          onSelect={(id) => {
            selected = id;
          }}
          onCancel={() => {}}
        />
      </PanelLayoutContext.Provider>
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
    await sleep();
    const text = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
    assert.match(text, /Fix provider picker/);
    assert.match(text, /qwen/);
    stdin.write("\r");
    await sleep();
    assert.equal(selected, "chat_one");
  } finally {
    instance.cleanup();
    await sleep(20);
  }
});

type PickerProps = React.ComponentProps<typeof ResumePicker>;

function mountPicker(props: Partial<PickerProps>) {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(
    <ThemeProvider theme="purple">
      <PanelLayoutContext.Provider
        value={{ mode: "compact", availableRows: 12, availableCols: 96 }}
      >
        <ResumePicker conversations={[]} onSelect={() => {}} onCancel={() => {}} {...props} />
      </PanelLayoutContext.Provider>
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
  return {
    stdin,
    // Debug mode appends every frame; the last frame is what is on screen.
    lastFrame: () => {
      const text = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
      return text.slice(text.lastIndexOf("Resume"));
    },
    cleanup: async () => {
      instance.cleanup();
      await sleep(20);
    },
  };
}

const here = {
  source: "claude" as const,
  id: "here-1",
  title: "Fix flaky test",
  cwd: "/work/app",
  updatedAt: "2026-09-30T10:00:00.000Z",
  model: "claude-opus-5-5",
};
const elsewhere = {
  source: "claude" as const,
  id: "far-2",
  title: "Movie app subtitles",
  cwd: "/work/movies",
  updatedAt: "2026-09-30T11:00:00.000Z",
};

test("ResumePicker merges native histories under providers and changes workspace scope", async () => {
  const calls: string[] = [];
  const opened: string[] = [];
  const picker = mountPicker({
    loadSessions: async (scope) => {
      calls.push(scope);
      return {
        sessions: mergeSessionSummaries([], scope === "all" ? [elsewhere, here] : [here]),
        errors: [],
      };
    },
    onOpenExternal: (summary) => opened.push(`view:${summary.id}`),
    onResumeExternalNative: (summary) => opened.push(`native:${summary.id}`),
    onContinueExternal: (summary) => opened.push(`continue:${summary.id}`),
  });
  try {
    await sleep();
    assert.match(picker.lastFrame(), /All.*OpenAI.*Anthropic.*Mistral.*Local/);
    assert.doesNotMatch(picker.lastFrame(), /Antigravity/);
    picker.stdin.write("3");
    await sleep();
    assert.deepEqual(calls, ["workspace"]);
    assert.match(picker.lastFrame(), /Fix flaky test/);
    assert.doesNotMatch(picker.lastFrame(), /Movie app subtitles/);
    picker.stdin.write("a");
    await sleep();
    assert.deepEqual(calls, ["workspace", "all"]);
    assert.match(picker.lastFrame(), /All projects/);
    assert.match(picker.lastFrame(), /Movie app subtitles/);
    picker.stdin.write("\r");
    await sleep();
    picker.stdin.write("o");
    await sleep();
    picker.stdin.write("j");
    await sleep();
    picker.stdin.write("c");
    await sleep();
    assert.deepEqual(opened, ["view:far-2", "native:far-2", "continue:here-1"]);
  } finally {
    await picker.cleanup();
  }
});

test("ResumePicker shows loading and isolated discovery errors", async () => {
  let finish!: (value: { sessions: never[]; errors: string[] }) => void;
  const picker = mountPicker({
    loadSessions: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    await sleep();
    assert.match(picker.lastFrame(), /Loading saved sessions/);
    finish({ sessions: [], errors: ["vibe: store locked"] });
    await sleep();
    assert.match(picker.lastFrame(), /store locked/);
  } finally {
    await picker.cleanup();
  }
});

test("ResumePicker restores section, scope, query and namespaced selection", async () => {
  const positions: string[] = [];
  let opened: string | null = null;
  const sessions = mergeSessionSummaries([], [elsewhere, here]);
  const picker = mountPicker({
    position: {
      tab: "anthropic",
      scope: "all",
      selectedId: sessions.find((entry) => entry.native?.id === "here-1")!.key,
    },
    loadSessions: async () => ({ sessions, errors: [] }),
    onOpenExternal: (summary) => {
      opened = summary.id;
    },
    onPositionChange: (position) =>
      positions.push(`${position.tab}:${position.scope}:${position.selectedId}`),
  });
  try {
    await sleep();
    picker.stdin.write("\r");
    await sleep();
    assert.equal(opened, "here-1");
    assert.equal(positions.at(-1), "anthropic:all:native:claude:here-1:/work/app");
  } finally {
    await picker.cleanup();
  }
});

test("Local filters separate backends with identical model names and cycle saved models", async () => {
  const base = {
    version: 1 as const,
    createdAt: "",
    updatedAt: "",
    providerId: "local",
    modelId: "shared-model",
    backendKind: "local-openai-compatible",
    messageCount: 2,
  };
  const conversations = [
    { ...base, id: "chat_lm", title: "LM chat", localBackend: "lm-studio" as const },
    { ...base, id: "chat_unsloth", title: "Unsloth chat", localBackend: "unsloth" as const },
    {
      ...base,
      id: "chat_other",
      title: "Other model",
      modelId: "other",
      localBackend: "unsloth" as const,
    },
  ];
  const sessions = conversations.map((entry) => conversationSummary(entry, "/work/app", "key"));
  const picker = mountPicker({
    loadSessions: async () => ({ sessions, errors: [] }),
    position: { tab: "local", scope: "workspace", selectedId: null },
  });
  try {
    await sleep();
    assert.match(picker.lastFrame(), /LM chat/);
    assert.match(picker.lastFrame(), /Unsloth chat/);
    picker.stdin.write("b");
    await sleep();
    assert.match(picker.lastFrame(), /LM Studio/);
    assert.doesNotMatch(picker.lastFrame(), /Unsloth chat/);
    picker.stdin.write("b");
    await sleep();
    assert.match(picker.lastFrame(), /Unsloth chat/);
    assert.doesNotMatch(picker.lastFrame(), /LM chat/);
    picker.stdin.write("m");
    await sleep();
    assert.match(picker.lastFrame(), /Other model/);
    assert.doesNotMatch(picker.lastFrame(), /Unsloth chat/);
  } finally {
    await picker.cleanup();
  }
});

test("narrow provider bars always contain the active section", () => {
  const tabs = ["all", "openai", "anthropic", "mistral", "local"] as const;
  for (const tab of tabs)
    for (const width of [14, 25, 45, 80])
      assert.ok(visibleResumeTabs(tabs, tab, width).includes(tab));
});

test("large resume lists never exceed their panel budget, including tiny heights", () => {
  const conversations = Array.from({ length: 1000 }, (_, index) => ({
    version: 1 as const,
    id: `chat_${index}`,
    title: `Long title ${index} ${"界".repeat(60)}`,
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    providerId: "openai",
    modelId: "fixture",
    backendKind: null,
    messageCount: 2,
  }));
  for (const columns of [60, 80, 100, 120, 160, 200])
    for (const rows of [1, 2, 3, 4, 5, 8, 12, 20]) {
      const frame = stripVTControlCharacters(
        renderToString(
          <ThemeProvider theme="purple">
            <PanelLayoutContext.Provider
              value={{ mode: "compact", availableRows: rows, availableCols: columns }}
            >
              <ResumePicker conversations={conversations} onSelect={() => {}} onCancel={() => {}} />
            </PanelLayoutContext.Provider>
          </ThemeProvider>,
          { columns },
        ),
      );
      const lines = frame.split("\n");
      assert(lines.length <= rows, `${columns}x${rows} rendered ${lines.length} rows`);
      assert(lines.every((line) => getTextWidth(line) <= columns));
    }
});

test("batched search input filters before Enter and never reaches the global composer", async () => {
  const selected: string[] = [];
  const picker = mountPicker({
    loadSessions: async () => ({
      sessions: mergeSessionSummaries([], [here, elsewhere]),
      errors: [],
    }),
    onOpenExternal: (entry) => selected.push(entry.id),
  });
  try {
    await sleep();
    picker.stdin.write("a");
    await sleep();
    picker.stdin.write("/Movie");
    await sleep();
    assert.match(picker.lastFrame(), /Movie app/);
    assert.doesNotMatch(picker.lastFrame(), /Fix flaky/);
    picker.stdin.write("\r");
    await sleep();
    picker.stdin.write("\r");
    await sleep();
    assert.deepEqual(selected, ["far-2"]);
  } finally {
    await picker.cleanup();
  }
});

test("asynchronous catalog reordering preserves the highlighted session identity", async () => {
  const records = ["one", "two"].map((id) => ({
    version: 1 as const,
    id: `chat_${id}`,
    title: id,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    providerId: "openai",
    modelId: "fixture",
    backendKind: null,
    workspaceRoot: "/work/app",
    storageWorkspaceKey: "fixture",
    messageCount: 2,
  }));
  let finish!: (value: {
    sessions: ReturnType<typeof conversationSummary>[];
    errors: string[];
  }) => void;
  const chosen: string[] = [];
  const picker = mountPicker({
    conversations: records,
    loadSessions: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    onSelectSession: (entry) => {
      chosen.push(entry.title);
    },
  });
  try {
    await sleep();
    picker.stdin.write("j");
    await sleep();
    finish({
      sessions: records
        .toReversed()
        .map((entry) => conversationSummary(entry, "/work/app", "fixture")),
      errors: [],
    });
    await sleep();
    picker.stdin.write("\r");
    await sleep();
    assert.deepEqual(chosen, ["two"]);
  } finally {
    await picker.cleanup();
  }
});
