import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { render, Text } from "ink";
import type { RuntimeSummary } from "../../config/runtimeConfig.js";
import type { StartupLogoStyle } from "../../config/settings.js";
import { getTextWidth } from "../../core/shared/text.js";
import {
  resetInkOutputForFreshFrame,
  resolveInkRenderInstance,
} from "../../core/terminal/inkRenderReset.js";
import type { RunEvent, TimelineEvent, UIState, UserPromptEvent } from "../../session/types.js";
import { waitFor } from "../../test/async.js";
import { TEST_RUNTIME } from "../../test/runtimeTestUtils.js";
import { createLayoutSnapshot } from "../layout.js";
import { LOGO_COMPACT, LOGO_LARGE } from "../render/logoVariants.js";
import { MAX_WORDMARK_ROWS, WORDMARK_ROWS, wordmarkArt } from "../render/wordmarkArt.js";
import { ThemeProvider } from "../theme.js";
import { TranscriptShell } from "./TranscriptShell.js";
import {
  __getNativeTurnBuildCountForTests,
  __resetNativeTurnBuildCountForTests,
} from "./timelineMeasure.js";

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
  rows = 30;
}

const IDLE: UIState = { kind: "IDLE" };
const TEST_RUNTIME_SUMMARY: RuntimeSummary = {
  providerLabel: "Local",
  model: "gpt-5.4",
  modelLabel: "qwen/qwen3.6-35b-a3b",
  reasoningLabel: "High",
  contextLabel: "115 / 262K",
  modeLabel: "Full Auto",
  sandboxLabel: "Workspace Write",
  approvalLabel: "Never",
  networkLabel: "Enabled",
  writableRootsLabel: "none",
};

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function countOccurrences(value: string, needle: string): number {
  return stripAnsi(value).split(needle).length - 1;
}

function assertFullLargeLogoVisible(value: string): void {
  const text = stripAnsi(value);
  LOGO_LARGE.forEach((line) => {
    assert.ok(text.includes(line.trim()), `expected full large logo row to be visible: ${line}`);
  });
}

function firstLineIndex(value: string, needle: string): number {
  return stripAnsi(value)
    .split(/\r?\n/)
    .findIndex((line) => line.includes(needle));
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function systemEvent(id: number, content: string): TimelineEvent {
  return {
    id,
    type: "system",
    createdAt: id,
    title: `System ${id}`,
    content,
  };
}

function launchEvent(id = 1): TimelineEvent {
  return {
    id,
    type: "system",
    createdAt: id,
    title: "Launch mode",
    content: "Ready. Type a prompt, run !shell, or use /command.\nTip: /workspace relaunch <path>",
  };
}

function providerMigrationEvent(id = 2): TimelineEvent {
  return {
    id,
    type: "system",
    createdAt: id,
    title: "Provider migrated",
    content: "Antigravity provider is no longer supported. Reverted to Local.",
  };
}

function userPromptEvent(turnId = 10, prompt = "hi"): UserPromptEvent {
  return {
    id: turnId * 10,
    type: "user",
    createdAt: turnId,
    prompt,
    turnId,
  };
}

function runningRunEvent(turnId = 10, prompt = "hi"): RunEvent {
  return {
    id: turnId * 10 + 1,
    type: "run",
    createdAt: turnId,
    startedAt: turnId,
    durationMs: null,
    backendId: "codex-subprocess",
    backendLabel: "Ubume",
    runtime: TEST_RUNTIME,
    prompt,
    progressEntries: [],
    status: "running",
    summary: "thinking...",
    truncatedOutput: false,
    toolActivities: [],
    activity: [],
    touchedFileCount: 0,
    errorMessage: null,
    turnId,
    streamItems: [],
    responseSegments: [],
    lastStreamSeq: 0,
    activeResponseSegmentId: null,
  };
}

function transcriptNode({
  staticEvents,
  activeEvents = [],
  uiState = IDLE,
  visible = true,
  prompt = "LIVE PROMPT",
  clearCount = 0,
  repaintGeneration = 0,
  cols = 120,
  rows = 30,
  notice = null,
  logoStyle = "normal",
  theme = "purple",
  runtimeSummary = TEST_RUNTIME_SUMMARY,
  startupAnimation = false,
}: {
  staticEvents: TimelineEvent[];
  activeEvents?: TimelineEvent[];
  uiState?: UIState;
  visible?: boolean;
  prompt?: string;
  clearCount?: number;
  repaintGeneration?: number;
  cols?: number;
  rows?: number;
  notice?: string | null;
  logoStyle?: StartupLogoStyle;
  theme?: string;
  runtimeSummary?: RuntimeSummary | null;
  startupAnimation?: boolean;
}) {
  const layout = createLayoutSnapshot(cols, rows);
  return (
    <ThemeProvider theme={theme}>
      <TranscriptShell
        layout={layout}
        authState="authenticated"
        workspaceLabel="/workspace/ubume"
        workspaceRoot="/workspace/ubume"
        runtimeSummary={runtimeSummary}
        logoStyle={logoStyle}
        startupAnimation={startupAnimation}
        staticEvents={staticEvents}
        activeEvents={activeEvents}
        uiState={uiState}
        composer={<Text>{prompt}</Text>}
        composerRows={5}
        clearCount={clearCount}
        repaintGeneration={repaintGeneration}
        notice={notice}
        visible={visible}
      />
    </ThemeProvider>
  );
}

test("renders theme feedback in a replaceable row without adding transcript events", async () => {
  const staticEvents: TimelineEvent[] = [];
  const { instance, getOutput } = renderTranscript(staticEvents, { cols: 100, rows: 22 });

  instance.rerender(
    transcriptNode({
      staticEvents,
      cols: 100,
      rows: 22,
      notice: "Theme switched to Monochrome.",
    }),
  );
  await sleep();

  const output = stripAnsi(getOutput());
  assert.match(output, /Theme switched to Monochrome\./);
  assert.equal(staticEvents.length, 0);
  instance.unmount();
});

function renderTranscript(
  staticEvents: TimelineEvent[] = [],
  options: {
    prompt?: string;
    activeEvents?: TimelineEvent[];
    uiState?: UIState;
    cols?: number;
    rows?: number;
    logoStyle?: StartupLogoStyle;
    startupAnimation?: boolean;
  } = {},
) {
  const stdin = new TestInput();
  const stdout = new TestOutput();
  stdout.columns = options.cols ?? stdout.columns;
  stdout.rows = options.rows ?? stdout.rows;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const instance = render(transcriptNode({ staticEvents, ...options }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const getFrame = () => resolveInkRenderInstance(stdout)?.lastOutput ?? "";
  return { instance, stdout, getOutput: () => output, getFrame };
}

function detectBrandTier(value: string): "large" | "compact" | "wordmark" | "none" {
  const text = stripAnsi(value);
  for (let rows = WORDMARK_ROWS; rows <= MAX_WORDMARK_ROWS; rows++) {
    if (wordmarkArt(rows).every((line) => text.includes(line.trim())))
      return rows >= 6 ? "large" : "compact";
  }
  if (text.includes(LOGO_LARGE[0]!.trim())) return "large";
  if (text.includes(LOGO_COMPACT[0]!)) return "compact";
  if (text.includes("UBUME") || text.includes("Ubume v")) return "wordmark";
  return "none";
}

function assertHomeScreenFrame(
  value: string,
  size: { cols: number; rows: number },
  expectedTier: "large" | "compact" | "wordmark",
) {
  const text = stripAnsi(value);
  assert.equal(
    detectBrandTier(text),
    expectedTier,
    `${size.cols}x${size.rows} should use the same responsive brand tier`,
  );
  if (size.rows > 18 || size.cols < 60) {
    assert.match(text, /Ubume v/);
  }
  assert.match(text, /Workspace: ubume/);
  assert.match(text, /Provider: Local/);
  assert.equal(
    countOccurrences(text, "│ ❯"),
    1,
    `${size.cols}x${size.rows} should render one composer`,
  );
  assert.equal(
    countOccurrences(text, "Context:"),
    1,
    `${size.cols}x${size.rows} should render one footer/status area`,
  );

  const lines = text.split(/\r?\n/);
  const brandIndex = lines.findIndex(
    (line) =>
      line.includes("██████") ||
      line.includes("✦ UBUME") ||
      line.includes("UBUME") ||
      line.includes("Ubume v") ||
      line.includes("Workspace: ubume"),
  );
  const composerIndex = lines.findIndex((line) => line.includes("│ ❯"));
  assert.ok(brandIndex >= 0, `${size.cols}x${size.rows} should render branding`);
  assert.ok(
    composerIndex > brandIndex,
    `${size.cols}x${size.rows} should render branding before composer`,
  );
}

test("keeps the Ubume intro present across prompt rerenders", async () => {
  const { instance, getOutput } = renderTranscript([
    launchEvent(),
    systemEvent(2, "initial history line"),
  ]);
  await sleep();

  instance.rerender(
    transcriptNode({
      staticEvents: [launchEvent(), systemEvent(2, "initial history line")],
      prompt: "UPDATED LIVE PROMPT",
    }),
  );
  await sleep();
  instance.cleanup();

  const output = getOutput();
  assert.ok(countOccurrences(output, "Ubume v") >= 1);
  assert.ok(countOccurrences(output, "Provider: Local") >= 1);
  assert.match(stripAnsi(output), /UPDATED LIVE PROMPT/);
});

test("preserves a single intro after an explicit frame-cache reset", async () => {
  const { instance, stdout, getOutput } = renderTranscript([
    launchEvent(),
    systemEvent(2, "initial history line"),
  ]);
  await sleep();

  const beforeOutput = getOutput();
  assert.equal(countOccurrences(beforeOutput, "Ubume v"), 1);
  assert.equal(countOccurrences(beforeOutput, "Launch mode"), 1);

  resetInkOutputForFreshFrame({
    instance: resolveInkRenderInstance(stdout),
    columns: stdout.columns,
  });
  instance.rerender(
    transcriptNode({
      staticEvents: [launchEvent(), systemEvent(2, "initial history line")],
    }),
  );
  await sleep();
  instance.cleanup();

  const output = getOutput();
  assert.equal(
    countOccurrences(output, "Ubume v"),
    1,
    "cache resets must not duplicate committed history",
  );
  assert.equal(countOccurrences(output, "Launch mode"), 1, "committed events remain single-copy");
  assert.match(stripAnsi(output), /LIVE PROMPT/, "the composer should still be present");
});

test("clearCount change remounts TranscriptShell and repaints fresh static content", async () => {
  const { instance, stdout, getOutput } = renderTranscript([launchEvent()]);
  await sleep();
  assert.equal(countOccurrences(getOutput(), "Ubume v"), 1);

  resetInkOutputForFreshFrame({
    instance: resolveInkRenderInstance(stdout),
    columns: stdout.columns,
  });
  instance.rerender(transcriptNode({ staticEvents: [launchEvent()], clearCount: 1 }));
  await sleep();
  instance.cleanup();

  assert.equal(
    countOccurrences(getOutput(), "Ubume v"),
    2,
    "clearCount forces fresh static mount for clean post-clear frame",
  );
});

test("fresh launch renders the banner before Launch mode as transcript content", async () => {
  const { instance, getOutput } = renderTranscript([launchEvent()]);
  await sleep();
  instance.cleanup();

  const text = stripAnsi(getOutput());
  assertFullLargeLogoVisible(text);
  assert.match(text, /██████/);
  assert.match(text, /Ubume v/);
  assert.match(text, /Workspace: ubume/);
  assert.match(text, /Provider: Local/);
  assert.ok(text.indexOf("██████") < text.indexOf("Launch mode"));
  assert.equal(countOccurrences(text, "Ubume v"), 1);
  assert.equal(countOccurrences(text, "Launch mode"), 1);
});

test("fresh launch with provider migration keeps one logo, one composer, and one footer", async () => {
  const { instance, getOutput } = renderTranscript([launchEvent(), providerMigrationEvent()], {
    prompt: ["│ ❯", "Local / qwen/qwen3.6-35b-a3b (High)", "Context: 115 / 262K"].join("\n"),
  });
  await sleep();
  instance.cleanup();

  const text = stripAnsi(getOutput());
  assertFullLargeLogoVisible(text);
  assert.equal(countOccurrences(text, "Provider migrated"), 1);
  assert.equal(countOccurrences(text, "Launch mode"), 1);
  assert.equal(
    countOccurrences(text, "│ ❯"),
    1,
    "migration startup must not create a second composer prompt",
  );
  assert.equal(
    countOccurrences(text, "Context:"),
    1,
    "migration startup must not create a second runtime footer",
  );
  assert.ok(text.indexOf("██████") < text.indexOf("Launch mode"));
  assert.ok(text.indexOf("Launch mode") < text.indexOf("Provider migrated"));
  assert.ok(text.indexOf("Provider migrated") < text.indexOf("│ ❯"));
});

test("fresh launch reserves top space so the large logo is not clipped", async () => {
  const { instance, getOutput } = renderTranscript([launchEvent()]);
  await sleep();
  instance.cleanup();

  const output = getOutput();
  assertFullLargeLogoVisible(output);
  const firstLogoIndex = firstLineIndex(output, LOGO_LARGE[0]!.trim());
  assert.ok(firstLogoIndex > 0, "large logo should not start on the first terminal row");
});

test("first submitted prompt remains visible in the owned conversation viewport", async () => {
  const { instance, getOutput } = renderTranscript([launchEvent()]);
  await sleep();

  instance.rerender(
    transcriptNode({
      staticEvents: [launchEvent()],
      activeEvents: [userPromptEvent(10, "hi"), runningRunEvent(10, "hi")],
      uiState: { kind: "THINKING", turnId: 10 },
      prompt: "BOTTOM COMPOSER AFTER SUBMIT",
    }),
  );
  await sleep();
  instance.cleanup();

  const text = stripAnsi(getOutput());
  assertFullLargeLogoVisible(text);
  assert.ok(countOccurrences(text, "Ubume v") >= 1);
  assert.equal(countOccurrences(text, "Launch mode"), 1);
  assert.ok(text.indexOf("Launch mode") < text.lastIndexOf("PROMPT"));
  assert.ok(text.lastIndexOf("PROMPT") < text.lastIndexOf("hi"));
  assert.ok(text.lastIndexOf("hi") < text.lastIndexOf("BOTTOM COMPOSER AFTER SUBMIT"));
});

test("reflows the current running turn when the terminal becomes wider", async () => {
  const prompt =
    "Update the README structure so every section is easier to read and then update the existing pull request";
  const activeEvents = [userPromptEvent(10, prompt), runningRunEvent(10, prompt)];
  const { instance, stdout, getOutput } = renderTranscript([launchEvent()], {
    activeEvents,
    uiState: { kind: "THINKING", turnId: 10 },
    cols: 60,
    rows: 30,
  });
  await sleep();

  const narrowFrame = stripAnsi(getOutput());
  assert.doesNotMatch(narrowFrame, new RegExp(prompt));

  const beforeResizeLength = getOutput().length;
  stdout.columns = 140;
  instance.rerender(
    transcriptNode({
      staticEvents: [launchEvent()],
      activeEvents,
      uiState: { kind: "THINKING", turnId: 10 },
      cols: 140,
      rows: 30,
    }),
  );
  await sleep();

  const wideFrame = stripAnsi(getOutput().slice(beforeResizeLength));
  assert.match(wideFrame, new RegExp(prompt));
  assert.equal(countOccurrences(wideFrame, prompt), 1);
  instance.cleanup();
});

test("commits complete history to native scrollback without clearing the terminal", async () => {
  const manyEvents = [
    launchEvent(90),
    ...Array.from({ length: 30 }, (_, index) => systemEvent(index + 100, `history line ${index}`)),
  ];
  const { instance, getOutput } = renderTranscript(manyEvents);
  await sleep();
  instance.cleanup();

  const output = getOutput();
  const text = stripAnsi(output);
  assert.doesNotMatch(output, /\u001b\[2J|\u001b\[3J|\u001bc/);
  assert.match(text, /history line 0/);
  assert.match(text, /history line 29/);
  assert.ok(
    text.lastIndexOf("LIVE PROMPT") > text.lastIndexOf("history line 29"),
    "composer prompt should render after transcript history at the live bottom",
  );
});

function streamingRunEvent(
  turnId: number,
  prompt: string,
  toolCount: number,
  tail: string,
): RunEvent {
  const toolActivities = Array.from({ length: toolCount }, (_, index) => ({
    id: `tool-${index}`,
    command: `cat file-${String(index).padStart(3, "0")}.txt`,
    status: "completed" as const,
    startedAt: turnId + index,
    completedAt: turnId + index + 1,
    streamSeq: index + 1,
  }));
  const responseSeq = toolCount + 1;
  return {
    ...runningRunEvent(turnId, prompt),
    toolActivities,
    responseSegments: [
      {
        id: "response-101-tail",
        streamSeq: responseSeq,
        chunks: [tail],
        status: "active",
        startedAt: turnId,
      },
    ],
    streamItems: [
      ...toolActivities.map((tool) => ({
        streamSeq: tool.streamSeq,
        kind: "action" as const,
        refId: tool.id,
      })),
      { streamSeq: responseSeq, kind: "response" as const, refId: "response-101-tail" },
    ],
    lastStreamSeq: responseSeq,
    activeResponseSegmentId: "response-101-tail",
  };
}

test("tail-windows a long streaming turn so it never overflows the terminal or clears scrollback", async () => {
  const prompt = "read every file and summarize";
  const rows = 14;
  const uiState: UIState = { kind: "RESPONDING", turnId: 10 };
  const { instance, getOutput } = renderTranscript([launchEvent()], {
    activeEvents: [
      userPromptEvent(10, prompt),
      streamingRunEvent(10, prompt, 30, "Summary so far"),
    ],
    uiState,
    cols: 100,
    rows,
  });
  await sleep();

  const streamingStart = getOutput().length;
  for (const [toolCount, tail] of [
    [40, "Summary so far, more"],
    [50, "Summary complete"],
  ] as const) {
    instance.rerender(
      transcriptNode({
        staticEvents: [launchEvent()],
        activeEvents: [userPromptEvent(10, prompt), streamingRunEvent(10, prompt, toolCount, tail)],
        uiState,
        cols: 100,
        rows,
      }),
    );
    await sleep();
  }

  const streamingOutput = getOutput().slice(streamingStart);
  assert.doesNotMatch(
    streamingOutput,
    /\u001b\[2J|\u001b\[3J/,
    "streaming frames must never clear the terminal",
  );
  const lastFrame = stripAnsi(streamingOutput.slice(streamingOutput.lastIndexOf("\u001b[?2026h")));
  assert.match(lastFrame, /Summary complete/);
  assert.match(lastFrame, /file-049\.txt/);
  assert.doesNotMatch(
    lastFrame,
    /file-000\.txt/,
    "the head of the live turn is windowed away while streaming",
  );
  const liveLineCount = lastFrame.split(/\r?\n/).length;
  assert.ok(liveLineCount < rows, `live frame has ${liveLineCount} lines; must stay below ${rows}`);

  const beforeFinalize = getOutput().length;
  const completed: RunEvent = {
    ...streamingRunEvent(10, prompt, 50, "Summary complete"),
    status: "completed",
    durationMs: 10,
    activeResponseSegmentId: null,
  };
  completed.responseSegments = completed.responseSegments!.map((segment) => ({
    ...segment,
    status: "completed" as const,
  }));
  instance.rerender(
    transcriptNode({
      staticEvents: [launchEvent(), userPromptEvent(10, prompt), completed],
      activeEvents: [],
      uiState: IDLE,
      cols: 100,
      rows,
    }),
  );
  await sleep();
  instance.cleanup();

  const finalizeOutput = getOutput().slice(beforeFinalize);
  assert.doesNotMatch(
    finalizeOutput,
    /\u001b\[2J|\u001b\[3J/,
    "finalize must append to scrollback without clearing",
  );
  assert.match(
    stripAnsi(finalizeOutput),
    /file-000\.txt/,
    "finalize commits the whole turn to scrollback",
  );
  assert.match(stripAnsi(finalizeOutput), /Summary complete/);
});

function finalizedTurnEvents(turnId: number): TimelineEvent[] {
  const run: RunEvent = {
    ...runningRunEvent(turnId, `task ${turnId}`),
    status: "completed",
    durationMs: 5,
    summary: "completed",
    responseSegments: [
      {
        id: `response-${turnId}`,
        streamSeq: 1,
        chunks: [`answer ${turnId}`],
        status: "completed",
        startedAt: turnId,
      },
    ],
    streamItems: [{ streamSeq: 1, kind: "response", refId: `response-${turnId}` }],
    lastStreamSeq: 1,
  };
  return [userPromptEvent(turnId, `task ${turnId}`), run];
}

test("re-rendering with a new composer element does not rebuild finalized turns", async () => {
  const staticEvents = [
    launchEvent(),
    ...Array.from({ length: 20 }, (_, index) => finalizedTurnEvents(index + 1)).flat(),
  ];
  const { instance, getOutput } = renderTranscript(staticEvents, { rows: 40 });
  await sleep();

  __resetNativeTurnBuildCountForTests();
  instance.rerender(transcriptNode({ staticEvents, prompt: "UPDATED PROMPT" }));
  await sleep();
  assert.equal(
    __getNativeTurnBuildCountForTests(),
    0,
    "a keystroke-equivalent rerender must not rebuild static turns",
  );
  assert.match(stripAnsi(getOutput()), /UPDATED PROMPT/);

  // A streaming turn rebuilds only the live turn, never the finalized ones.
  __resetNativeTurnBuildCountForTests();
  instance.rerender(
    transcriptNode({
      staticEvents,
      activeEvents: [userPromptEvent(99, "live task"), runningRunEvent(99, "live task")],
      uiState: { kind: "THINKING", turnId: 99 },
      prompt: "UPDATED PROMPT",
    }),
  );
  await sleep();
  assert.equal(__getNativeTurnBuildCountForTests(), 1, "only the running turn is built");
  instance.cleanup();
});

test("hides transcript input during overlay mode and restores the owned viewport", async () => {
  const initialEvents = [launchEvent(199), systemEvent(200, "visible history")];
  const hiddenEvents = [...initialEvents, systemEvent(201, "queued while overlay is visible")];
  const { instance, getOutput } = renderTranscript(initialEvents);
  await sleep();

  instance.rerender(
    transcriptNode({
      staticEvents: initialEvents,
      visible: false,
      prompt: "HIDDEN PROMPT",
    }),
  );
  await sleep();
  const hiddenOutput = getOutput();
  assert.doesNotMatch(stripAnsi(hiddenOutput), /HIDDEN PROMPT/);

  instance.rerender(
    transcriptNode({
      staticEvents: hiddenEvents,
      visible: false,
      prompt: "STILL HIDDEN",
    }),
  );
  await sleep();
  assert.doesNotMatch(stripAnsi(getOutput()), /queued while overlay is visible/);

  instance.rerender(
    transcriptNode({
      staticEvents: hiddenEvents,
      visible: true,
      prompt: "RESTORED PROMPT",
    }),
  );
  await sleep();
  instance.cleanup();

  const output = getOutput();
  assert.equal(countOccurrences(output, "Ubume v"), 1);
  assert.match(stripAnsi(output), /queued while overlay is visible/);
  assert.match(stripAnsi(output), /RESTORED PROMPT/);
});

test("clear rerender shows fresh banner and launch text once without stale messages", async () => {
  const beforeClearEvents = [launchEvent(300), systemEvent(301, "old message before clear")];
  const afterClearEvents = [launchEvent(400)];
  const { instance, getOutput } = renderTranscript(beforeClearEvents);
  await sleep();
  const beforeClearLength = getOutput().length;

  instance.rerender(
    transcriptNode({
      staticEvents: afterClearEvents,
      clearCount: 1,
      prompt: "PROMPT AFTER CLEAR\nLocal / qwen/qwen3.6-35b-a3b (High)\nContext: 115 / 262K",
    }),
  );
  await sleep();
  instance.cleanup();

  const postClearOutput = stripAnsi(getOutput().slice(beforeClearLength));
  assertFullLargeLogoVisible(postClearOutput);
  assert.match(postClearOutput, /██████/);
  assert.match(postClearOutput, /Launch mode/);
  assert.match(postClearOutput, /PROMPT AFTER CLEAR/);
  assert.match(postClearOutput, /Local \/ qwen\/qwen3\.6-35b-a3b \(High\)/);
  assert.match(postClearOutput, /Context: 115 \/ 262K/);
  assert.equal(countOccurrences(postClearOutput, "Ubume v"), 1);
  assert.equal(countOccurrences(postClearOutput, "Launch mode"), 1);
  assert.doesNotMatch(postClearOutput, /old message before clear/);
});

const CLEAR_HOME_SCREEN_CASES: Array<{
  cols: number;
  rows: number;
  expectedTier: "large" | "compact" | "wordmark";
}> = [
  { cols: 140, rows: 40, expectedTier: "large" },
  { cols: 120, rows: 32, expectedTier: "large" },
  { cols: 100, rows: 28, expectedTier: "large" },
  { cols: 80, rows: 24, expectedTier: "large" },
  { cols: 70, rows: 20, expectedTier: "compact" },
  { cols: 60, rows: 18, expectedTier: "compact" },
  { cols: 39, rows: 24, expectedTier: "compact" },
];

for (const testCase of CLEAR_HOME_SCREEN_CASES) {
  test(`fresh startup and /clear render the same branded home screen at ${testCase.cols}x${testCase.rows}`, async () => {
    const prompt = [
      "│ ❯ Ask Ubume, run !shell, or use /command",
      "OpenAI Codex CLI / gpt-5.4-mini (Low)",
      "Context: 0 / 1M",
    ].join("\n");
    const startupEvents = [launchEvent(500), providerMigrationEvent(501)];
    const { instance, getOutput } = renderTranscript(startupEvents, {
      cols: testCase.cols,
      rows: testCase.rows,
      prompt,
    });
    await sleep();

    const freshOutput = stripAnsi(getOutput());
    assertHomeScreenFrame(freshOutput, testCase, testCase.expectedTier);
    assert.equal(countOccurrences(freshOutput, "Provider migrated"), 1);
    assert.equal(countOccurrences(freshOutput, "Launch mode"), 1);

    instance.rerender(
      transcriptNode({
        staticEvents: [launchEvent(600), providerMigrationEvent(601)],
        clearCount: 1,
        prompt,
        cols: testCase.cols,
        rows: testCase.rows,
      }),
    );
    await sleep();
    instance.cleanup();

    const postClearOutput = stripAnsi(getOutput());
    assert.ok(countOccurrences(postClearOutput, "Provider migrated") >= 1);
    assert.ok(countOccurrences(postClearOutput, "Launch mode") >= 1);
    assert.equal(
      detectBrandTier(postClearOutput),
      detectBrandTier(freshOutput),
      `${testCase.cols}x${testCase.rows} clear should use startup's responsive home layout rules`,
    );
  });
}

test("Markdown streaming and width changes preserve the live composer/footer and screen bounds", async () => {
  const prompt = "markdown preview";
  const source =
    "# Summary\n\n```ts\n  const n = 1;\n```\n\n|First|Second|Third|Fourth|Fifth|\n|---|---|---|---|---|\n" +
    Array.from(
      { length: 12 },
      (_, index) => `|alpha ${index}|beta ${index}|gamma ${index}|fourth ${index}|fifth ${index}|`,
    ).join("\n");
  const uiState: UIState = { kind: "RESPONDING", turnId: 150 };
  const user = userPromptEvent(150, prompt);
  const composer = "COMPOSER_SENTINEL\nSTATUS_SENTINEL";
  const { instance, stdout, getOutput, getFrame } = renderTranscript([], {
    activeEvents: [user, streamingRunEvent(150, prompt, 0, source)],
    uiState,
    cols: 80,
    rows: 32,
    prompt: composer,
  });
  await sleep();
  const afterInitial = getOutput().length;
  for (const width of [40, 60, 80, 100, 120, 160, 40]) {
    stdout.columns = width;
    instance.rerender(
      transcriptNode({
        staticEvents: [],
        activeEvents: [user, streamingRunEvent(150, prompt, 0, source + "\n")],
        uiState,
        cols: width,
        rows: 32,
        prompt: composer,
      }),
    );
    await sleep();
    const frame = stripAnsi(getFrame());
    assert.equal(countOccurrences(frame, "COMPOSER_SENTINEL"), 1);
    assert.equal(countOccurrences(frame, "STATUS_SENTINEL"), 1);
    assert.ok(frame.indexOf("COMPOSER_SENTINEL") < frame.indexOf("STATUS_SENTINEL"));
    assert.ok(frame.trimEnd().split("\n").length <= 32, `height at ${width}`);
    assert.doesNotMatch(frame, /\|---|\|First\|/);
    assert.ok(
      frame.split("\n").every((line) => getTextWidth(line) <= width),
      `row overflow at ${width}`,
    );
  }
  assert.doesNotMatch(
    getOutput().slice(afterInitial),
    /\u001b\[3J|\u001bc/,
    "routine resize/streaming must not clear native scrollback",
  );
  const completed = streamingRunEvent(150, prompt, 0, source);
  completed.status = "completed";
  completed.responseSegments = completed.responseSegments?.map((segment) => ({
    ...segment,
    status: "completed",
  }));
  instance.rerender(
    transcriptNode({
      staticEvents: [user, completed],
      activeEvents: [],
      uiState: IDLE,
      cols: 40,
      rows: 32,
      prompt: composer,
    }),
  );
  await sleep();
  const committed = stripAnsi(getOutput());
  for (let index = 0; index < 12; index += 1) assert.match(committed, new RegExp(`alpha ${index}`));
  instance.unmount();
});

test("startup logo styles render the selected branding at the shell level", async () => {
  const events: TimelineEvent[] = [launchEvent(900)];

  // Compact styles use one live, three-row header before conversation begins.
  const minimal = renderTranscript(events, { cols: 120, rows: 30, logoStyle: "minimal" });
  try {
    await sleep();
    const output = stripAnsi(minimal.getOutput());
    assert.match(output, /Ubume CLI v/);
    assert.match(output, /Local/);
    assert.equal(countOccurrences(output, "██████"), 0, "minimal must not draw the banner");
  } finally {
    minimal.instance.cleanup();
    await sleep(20);
  }

  const simple = renderTranscript(events, { cols: 120, rows: 30, logoStyle: "simple" });
  try {
    await sleep();
    const output = stripAnsi(simple.getOutput());
    assert.match(output, /Ubume CLI v/);
    assert.match(output, /Local/);
    assert.equal(countOccurrences(output, "██████"), 0, "simple must not draw the banner");
  } finally {
    simple.instance.cleanup();
    await sleep(20);
  }
});

test("normal startup logo keeps the classic large banner", async () => {
  const events: TimelineEvent[] = [launchEvent(910)];
  const harness = renderTranscript(events, { cols: 120, rows: 40, logoStyle: "normal" });
  try {
    await sleep();
    const output = stripAnsi(harness.getOutput());
    assert.ok(countOccurrences(output, "██████") > 0, "normal must keep the ASCII banner");
  } finally {
    harness.instance.cleanup();
    await sleep(20);
  }
});

test("compact home stays at the top and updates metadata and themes without a static repaint", async () => {
  const events = [launchEvent(1000)];
  const h = renderTranscript(events, { logoStyle: "minimal" });
  try {
    await h.instance.waitUntilRenderFlush();
    const initial = stripAnsi(h.getFrame());
    assert.equal(firstLineIndex(initial, "Ubume CLI v"), 0);
    assert.equal(firstLineIndex(initial, "Local"), 1);
    assert.equal(firstLineIndex(initial, "/workspace/ubume"), 2);
    assert.equal(countOccurrences(initial, "LIVE PROMPT"), 1);
    h.instance.rerender(
      transcriptNode({
        staticEvents: events,
        logoStyle: "minimal",
        theme: "mono",
        runtimeSummary: {
          ...TEST_RUNTIME_SUMMARY,
          providerLabel: "Updated",
          modelLabel: "New Model",
        },
      }),
    );
    await h.instance.waitUntilRenderFlush();
    const updated = stripAnsi(h.getFrame());
    assert.match(updated, /Updated/);
    assert.equal(countOccurrences(updated, "Ubume CLI v"), 1);
    assert.equal(countOccurrences(updated, "Launch mode"), 1);
    assert.equal(firstLineIndex(updated, "Ubume CLI v"), 0);
    assert.equal(updated.split("\n")[0]!.slice(0, 15), initial.split("\n")[0]!.slice(0, 15));
  } finally {
    h.instance.unmount();
    h.instance.cleanup();
  }
});

test("compact header stays live beside a short first turn without duplicating notices", async () => {
  const events = [launchEvent(1100), providerMigrationEvent(1101)];
  const h = renderTranscript(events, { logoStyle: "simple" });
  try {
    await h.instance.waitUntilRenderFlush();
    const before = h.getOutput().length;
    const activeEvents = [
      userPromptEvent(1110, "FIRST PROMPT"),
      runningRunEvent(1110, "FIRST PROMPT"),
    ];
    h.instance.rerender(
      transcriptNode({
        staticEvents: events,
        activeEvents,
        uiState: { kind: "THINKING", turnId: 1110 },
        logoStyle: "simple",
      }),
    );
    await h.instance.waitUntilRenderFlush();
    const committed = stripAnsi(h.getOutput().slice(before));
    assert.equal(countOccurrences(committed, "Ubume CLI v"), 1);
    assert.equal(countOccurrences(committed, "Launch mode"), 1);
    assert.equal(countOccurrences(committed, "Provider migrated"), 1);
    assert.ok(committed.indexOf("Ubume CLI v") < committed.indexOf("Launch mode"));
    assert.ok(committed.indexOf("Launch mode") < committed.indexOf("FIRST PROMPT"));
    const afterCommit = h.getOutput().length;
    h.instance.rerender(
      transcriptNode({
        staticEvents: events,
        activeEvents,
        uiState: { kind: "THINKING", turnId: 1110 },
        logoStyle: "simple",
        prompt: "TYPED WHILE RUNNING",
      }),
    );
    await h.instance.waitUntilRenderFlush();
    assert.ok(h.getOutput().length >= afterCommit);
    assert.equal(countOccurrences(stripAnsi(h.getFrame()), "Ubume CLI v"), 1);
    assert.match(stripAnsi(h.getFrame()), /TYPED WHILE RUNNING/);
  } finally {
    h.instance.unmount();
    h.instance.cleanup();
  }
});

test("compact home resize, overlays and clear keep one complete bounded header", async () => {
  const events = [launchEvent(1200)];
  const h = renderTranscript(events, { logoStyle: "minimal" });
  try {
    for (const [cols, rows] of [
      [120, 30],
      [43, 14],
      [24, 12],
      [80, 24],
    ]) {
      h.stdout.columns = cols!;
      h.stdout.rows = rows!;
      h.instance.rerender(
        transcriptNode({ staticEvents: events, logoStyle: "minimal", cols, rows }),
      );
      await h.instance.waitUntilRenderFlush();
      const frame = stripAnsi(h.getFrame());
      const lines = frame.split("\n");
      assert.ok(lines.length <= rows!, `${cols}x${rows} stays inside viewport`);
      assert.ok(
        lines.every((line) => getTextWidth(line) <= cols!),
        `width at ${cols}`,
      );
      assert.equal(firstLineIndex(frame, "Ubume CLI v"), 0);
      assert.equal(countOccurrences(frame, "LIVE PROMPT"), 1);
      if (cols! < 43) assert.doesNotMatch(lines.slice(0, 3).join("\n"), /[\u2801-\u28ff]/);
    }
    h.instance.rerender(
      transcriptNode({
        staticEvents: events,
        logoStyle: "minimal",
        visible: false,
        cols: 80,
        rows: 24,
      }),
    );
    await h.instance.waitUntilRenderFlush();
    assert.doesNotMatch(stripAnsi(h.getFrame()), /LIVE PROMPT/);
    h.instance.rerender(
      transcriptNode({
        staticEvents: events,
        logoStyle: "minimal",
        clearCount: 1,
        cols: 80,
        rows: 24,
      }),
    );
    await h.instance.waitUntilRenderFlush();
    const frame = stripAnsi(h.getFrame());
    assert.equal(countOccurrences(frame, "Ubume CLI v"), 1);
    assert.equal(countOccurrences(frame, "LIVE PROMPT"), 1);
    assert.match(frame.split("\n")[firstLineIndex(frame, "Ubume CLI v") + 1]!, /[█▀▄]/);
  } finally {
    h.instance.unmount();
    h.instance.cleanup();
  }
});

test("compact header hands off once and stays historical after a larger resize remount", async () => {
  const h = renderTranscript([], { logoStyle: "minimal", rows: 18 });
  const history = [
    userPromptEvent(1300, Array.from({ length: 30 }, (_, i) => `history line ${i}`).join("\n")),
  ];
  try {
    await h.instance.waitUntilRenderFlush();
    assert.match(stripAnsi(h.getFrame()), /Ubume CLI v/);
    h.instance.rerender(transcriptNode({ staticEvents: history, logoStyle: "minimal", rows: 18 }));
    await h.instance.waitUntilRenderFlush();
    assert.match(stripAnsi(h.getOutput()), /history line 29/);
    assert.doesNotMatch(stripAnsi(h.getFrame()), /Ubume CLI v/);
    h.stdout.rows = 100;
    h.instance.rerender(
      transcriptNode({
        staticEvents: history,
        logoStyle: "minimal",
        rows: 100,
        repaintGeneration: 1,
      }),
    );
    await h.instance.waitUntilRenderFlush();
    assert.doesNotMatch(stripAnsi(h.getFrame()), /Ubume CLI v/);
    assert.match(stripAnsi(h.getFrame()), /LIVE PROMPT/);
    h.instance.rerender(
      transcriptNode({
        staticEvents: [],
        logoStyle: "minimal",
        rows: 100,
        clearCount: 1,
        repaintGeneration: 1,
      }),
    );
    await h.instance.waitUntilRenderFlush();
    assert.equal(countOccurrences(stripAnsi(h.getFrame()), "Ubume CLI v"), 1);
  } finally {
    h.instance.unmount();
    h.instance.cleanup();
  }
});

/** Rows at the top of the frame drawn by the compact mark (solid half blocks). */
function logoRowCount(frame: string): number {
  const lines = stripAnsi(frame).split("\n");
  const end = lines.findIndex((line) => !/[█▀▄]/.test(line));
  return end === -1 ? lines.length : end;
}

test("compact home keeps the base mark through live resize sequences without corruption", async () => {
  const events = [launchEvent(1400)];
  const sizes: [number, number, number][] = [
    // cols, rows, expected logo rows (0 = metadata only)
    [60, 20, 3],
    [100, 30, 3],
    [120, 40, 3],
    [200, 60, 3],
    [60, 20, 3],
    [80, 24, 3],
    [240, 70, 3],
    [40, 12, 0],
    [300, 90, 3],
    [300, 24, 3],
    [60, 90, 3],
    [160, 45, 3],
    [20, 10, 0],
  ];
  const h = renderTranscript(events, { logoStyle: "simple", cols: 60, rows: 20 });
  try {
    for (const [cols, rows, expected] of sizes) {
      h.stdout.columns = cols;
      h.stdout.rows = rows;
      h.instance.rerender(
        transcriptNode({
          staticEvents: events,
          logoStyle: "simple",
          cols,
          rows,
          prompt: "KEEP ME",
        }),
      );
      await h.instance.waitUntilRenderFlush();
      const frame = stripAnsi(h.getFrame());
      const lines = frame.split("\n");
      const label = `${cols}x${rows}`;
      assert.ok(lines.length <= rows, `${label}: frame stays inside the viewport`);
      assert.ok(
        lines.every((line) => getTextWidth(line) <= cols),
        `${label}: no line wider than the terminal`,
      );
      assert.equal(countOccurrences(frame, "Ubume CLI v"), 1, `${label}: one header`);
      assert.equal(countOccurrences(frame, "KEEP ME"), 1, `${label}: prompt stays visible`);
      // Very short viewports window the notice to its tail (pre-existing behavior).
      if (rows >= 20) assert.equal(countOccurrences(frame, "Launch mode"), 1, `${label}: notice`);
      assert.equal(logoRowCount(frame), expected, `${label}: logo rows`);
      if (expected > 0)
        assert.equal(firstLineIndex(frame, "Ubume CLI v"), 0, `${label}: metadata is top-aligned`);
    }
  } finally {
    h.instance.unmount();
    h.instance.cleanup();
  }
});

test("rapid resizes during the startup animation settle on one complete header", async () => {
  const events = [launchEvent(1500)];
  const h = renderTranscript(events, {
    logoStyle: "minimal",
    cols: 120,
    rows: 40,
    startupAnimation: true,
  });
  try {
    // Twenty resize steps inside the 520ms animation, shrinking and growing.
    for (let step = 0; step < 20; step++) {
      const cols = 60 + ((step * 37) % 200);
      const rows = 16 + ((step * 13) % 60);
      h.stdout.columns = cols;
      h.stdout.rows = rows;
      h.instance.rerender(
        transcriptNode({
          staticEvents: events,
          logoStyle: "minimal",
          cols,
          rows,
          startupAnimation: true,
        }),
      );
      await sleep(10);
    }
    h.stdout.columns = 200;
    h.stdout.rows = 60;
    h.instance.rerender(
      transcriptNode({
        staticEvents: events,
        logoStyle: "minimal",
        cols: 200,
        rows: 60,
        startupAnimation: true,
      }),
    );
    await sleep(700);
    await h.instance.waitUntilRenderFlush();
    const frame = stripAnsi(h.getFrame());
    assert.equal(countOccurrences(frame, "Ubume CLI v"), 1);
    assert.equal(logoRowCount(frame), 3);
    const lines = frame.split("\n");
    // The animation finished: the final 12×3 mark, both brackets in place.
    assert.match(lines[0]!, /▄▀.*▄▀.*▀▄/);
    assert.ok(lines.every((line) => getTextWidth(line) <= 200));
  } finally {
    h.instance.unmount();
    h.instance.cleanup();
  }
});

test("a stale wider frame during a shrink truncates rows instead of wrapping them", async () => {
  const events = [launchEvent(1600)];
  const h = renderTranscript(events, { logoStyle: "simple", cols: 300, rows: 90 });
  try {
    await h.instance.waitUntilRenderFlush();
    const before = stripAnsi(h.getFrame()).split("\n").length;
    // The terminal shrank but the viewport hook has not committed the new layout yet.
    h.stdout.columns = 240;
    h.instance.rerender(
      transcriptNode({
        staticEvents: events,
        logoStyle: "simple",
        cols: 300,
        rows: 90,
        prompt: "P",
      }),
    );
    await h.instance.waitUntilRenderFlush();
    const lines = stripAnsi(h.getFrame()).split("\n");
    assert.equal(lines.length, before, "no wrapped continuation lines");
    assert.ok(lines.every((line) => getTextWidth(line) <= 240));
    assert.equal(logoRowCount(lines.join("\n")), 3);
  } finally {
    h.instance.unmount();
    h.instance.cleanup();
  }
});

test("a hidden transcript defers historical reflow during selector resizes", async () => {
  const events = Array.from({ length: 12 }, (_, index) => finalizedTurnEvents(index + 1)).flat();
  const h = renderTranscript(events);
  try {
    await h.instance.waitUntilRenderFlush();
    h.instance.rerender(transcriptNode({ staticEvents: events, visible: false }));
    await h.instance.waitUntilRenderFlush();
    __resetNativeTurnBuildCountForTests();
    h.instance.rerender(
      transcriptNode({ staticEvents: events, visible: false, cols: 60, rows: 20 }),
    );
    await h.instance.waitUntilRenderFlush();
    assert.equal(
      __getNativeTurnBuildCountForTests(),
      0,
      "hidden history must not delay overlay resize input",
    );
    h.instance.rerender(
      transcriptNode({ staticEvents: events, visible: true, cols: 60, rows: 20 }),
    );
    await h.instance.waitUntilRenderFlush();
    await waitFor(() => __getNativeTurnBuildCountForTests() > 0, {
      label: "showing the transcript prepares its new width cooperatively",
    });
  } finally {
    h.instance.cleanup();
  }
});
