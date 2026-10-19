import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { Box, render, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { APP_VERSION } from "../../config/settings.js";
import {
  loadUpdateCheckCache,
  saveUpdateCheckCache,
  type UpdateCheckResult,
} from "../../core/version/updateCheck.js";
import type { UpdateCheckSchedulerDeps } from "../../core/version/updateScheduler.js";
import type { Screen } from "../../session/types.js";
import { createFakeClock, settle } from "../../test/fakeClock.js";
import { UpdateAvailableCard } from "../../ui/chrome/UpdateAvailableCard.js";
import { SelectionPanel } from "../../ui/panels/SelectionPanel.js";
import { UpdatePromptPanel } from "../../ui/panels/UpdatePromptPanel.js";
import { ThemeProvider } from "../../ui/theme.js";
import { useUpdateCheck } from "./useUpdateCheck.js";

const MINUTE = 60_000;
const ESC = String.fromCharCode(27);

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

const ANSI_CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI, "");
}

function available(latestVersion = "0.1.11"): UpdateCheckResult {
  return {
    status: "update-available",
    currentVersion: APP_VERSION,
    latestVersion,
    checkedAt: Date.now(),
    source: "npm",
  };
}

function upToDate(): UpdateCheckResult {
  return {
    status: "up-to-date",
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    checkedAt: Date.now(),
    source: "npm",
  };
}

function failed(errorMessage = "getaddrinfo ENOTFOUND registry.npmjs.org"): UpdateCheckResult {
  return {
    status: "error",
    currentVersion: APP_VERSION,
    latestVersion: null,
    errorMessage,
    checkedAt: Date.now(),
    source: "npm",
  };
}

let tempHome = "";
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ubume-update-hook-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  rmSync(tempHome, { recursive: true, force: true });
});

interface HarnessApi {
  setScreen: (screen: Screen) => void;
  requestUpdateCheck: () => Promise<UpdateCheckResult>;
}

interface HarnessProps {
  startupEnabled: boolean;
  initialResult: UpdateCheckResult | null;
  schedulerDeps: Partial<Omit<UpdateCheckSchedulerDeps, "onResult">>;
  onApi: (api: HarnessApi) => void;
  onRender: (state: { screen: Screen; result: UpdateCheckResult | null }) => void;
  onReturnFromOverlay: () => void;
}

/**
 * Mirrors App's wiring: the startup screen from useAppState, the
 * OverlayPanels update-prompt branch, and the header's updateAvailable
 * derivation — rendering the existing, unmodified update components.
 */
function Harness({
  startupEnabled,
  initialResult,
  schedulerDeps,
  onApi,
  onRender,
  onReturnFromOverlay,
}: HarnessProps) {
  const startupUpdateEnabled = useRef(startupEnabled);
  const [screen, setScreen] = useState<Screen>("main");
  const [updateCheckResult, setUpdateCheckResult] = useState(initialResult);
  const [typed, setTyped] = useState("");

  const returnFromUpdateOverlay = useCallback(() => {
    onReturnFromOverlay();
    setScreen("main");
  }, [onReturnFromOverlay]);

  const { requestUpdateCheck } = useUpdateCheck({
    startupUpdateEnabled,
    updateCheckResult,
    setUpdateCheckResult,
    schedulerDeps,
  });

  useInput(
    (input) => {
      setTyped((current) => current + input);
    },
    { isActive: screen === "main" },
  );

  useEffect(() => {
    onApi({ setScreen, requestUpdateCheck });
  }, [onApi, requestUpdateCheck]);
  onRender({ screen, result: updateCheckResult });

  const headerUpdate =
    screen !== "update-prompt" &&
    updateCheckResult?.status === "update-available" &&
    updateCheckResult.latestVersion
      ? {
          latestVersion: updateCheckResult.latestVersion,
          currentVersion: updateCheckResult.currentVersion,
        }
      : null;

  return (
    <Box flexDirection="column">
      <Text>{`screen:${screen}`}</Text>
      <Text>{`typed:${typed}`}</Text>
      {headerUpdate && (
        <UpdateAvailableCard
          latestVersion={headerUpdate.latestVersion}
          currentVersion={headerUpdate.currentVersion}
        />
      )}
      {screen === "update-prompt" &&
        updateCheckResult?.status === "update-available" &&
        updateCheckResult.latestVersion && (
          <UpdatePromptPanel
            focusId="update-prompt"
            currentVersion={updateCheckResult.currentVersion}
            latestVersion={updateCheckResult.latestVersion}
            packageManager="npm"
            onSkip={returnFromUpdateOverlay}
            onRestart={() => {}}
          />
        )}
      {screen === "update-prompt" && updateCheckResult?.status === "up-to-date" && (
        <SelectionPanel
          focusId="update-prompt"
          title="Ubume is up to date"
          subtitle=""
          items={[{ label: "Return to chat", value: "close" }]}
          onSelect={returnFromUpdateOverlay}
          onCancel={returnFromUpdateOverlay}
        />
      )}
      {screen === "update-prompt" && updateCheckResult === null && (
        <Text>Checking for Ubume updates...</Text>
      )}
    </Box>
  );
}

/** Ink waits briefly before treating a lone ESC byte as the Escape key. */
async function pressEscape(stdin: TestInput): Promise<void> {
  stdin.write(ESC);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await settle();
}

function scriptedCheck(results: UpdateCheckResult[]) {
  const signals: AbortSignal[] = [];
  return {
    signals,
    check: async (signal: AbortSignal) => {
      signals.push(signal);
      const next = results.shift();
      if (!next) throw new Error("unexpected extra update check");
      return next;
    },
  };
}

function deferredCheck() {
  const pending: Array<{ signal: AbortSignal; resolve: (r: UpdateCheckResult) => void }> = [];
  return {
    pending,
    check: (signal: AbortSignal) =>
      new Promise<UpdateCheckResult>((resolve) => {
        pending.push({ signal, resolve });
      }),
  };
}

function mountHarness(options: {
  startupEnabled?: boolean;
  initialResult?: UpdateCheckResult | null;
  check: UpdateCheckSchedulerDeps["check"];
}) {
  const clock = createFakeClock();
  const stdin = new TestInput();
  const stdout = new TestOutput();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  let api: HarnessApi | null = null;
  const renders: Array<{ screen: Screen; result: UpdateCheckResult | null }> = [];
  let overlayReturns = 0;

  const instance = render(
    <ThemeProvider theme="purple">
      <Harness
        startupEnabled={options.startupEnabled ?? true}
        initialResult={options.initialResult ?? null}
        schedulerDeps={{
          check: options.check,
          setTimer: clock.setTimer,
          clearTimer: clock.clearTimer,
          now: clock.now,
          random: () => 0,
          trace: () => {},
        }}
        onApi={(next) => {
          api = next;
        }}
        onRender={(state) => renders.push(state)}
        onReturnFromOverlay={() => {
          overlayReturns += 1;
        }}
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

  let mark = 0;
  return {
    clock,
    stdin,
    renders,
    api: () => {
      assert.ok(api, "harness API not ready");
      return api;
    },
    overlayReturns: () => overlayReturns,
    /** Output written since the previous call, so assertions see only new frames. */
    newOutput: () => {
      const fresh = stripAnsi(output.slice(mark));
      mark = output.length;
      return fresh;
    },
    lastFrame: () => {
      const all = stripAnsi(output);
      return all.slice(all.lastIndexOf("screen:"));
    },
    unmount: () => instance.unmount(),
    cleanup: () => instance.cleanup(),
  };
}

test("launching with an update available shows a header notice without taking focus", async () => {
  const { check } = scriptedCheck([available("0.1.11")]);
  const harness = mountHarness({ check });
  await settle();

  const frame = harness.lastFrame();
  assert.match(frame, /screen:main/);
  assert.match(frame, /Ubume v0\.1\.11/);
  assert.doesNotMatch(frame, /\[ Update now \]/);
  assert.equal(harness.overlayReturns(), 0);
  assert.equal(loadUpdateCheckCache()?.updateAvailable, true);
  assert.equal(loadUpdateCheckCache()?.latestVersion, "0.1.11");
  harness.cleanup();
});

test("launching while up to date returns to main without any update notice", async () => {
  const { check } = scriptedCheck([upToDate()]);
  const harness = mountHarness({ check });
  await settle();

  const frame = harness.lastFrame();
  assert.match(frame, /screen:main/);
  assert.doesNotMatch(frame, /Update available/);
  assert.equal(loadUpdateCheckCache()?.updateAvailable, false);
  harness.cleanup();
});

test("a failed startup check leaves Ubume usable and schedules a retry", async () => {
  const { check, signals } = scriptedCheck([failed(), upToDate()]);
  const harness = mountHarness({ check });
  await settle();

  assert.match(harness.lastFrame(), /screen:main/);
  assert.equal(harness.renders.at(-1)?.result, null, "a failure must not be stored as a result");
  harness.stdin.write("ok");
  await settle();
  assert.match(harness.lastFrame(), /typed:ok/);

  assert.deepEqual(
    harness.clock.pending().map((t) => t.ms),
    [30_000],
  );
  await harness.clock.advance(30_000);
  assert.equal(signals.length, 2);
  assert.equal(harness.renders.at(-1)?.result?.status, "up-to-date");
  harness.cleanup();
});

test("a failed startup check falls back to a cached update for the running version", async () => {
  saveUpdateCheckCache({
    lastChecked: Date.now() - MINUTE,
    currentVersion: APP_VERSION,
    latestVersion: "0.1.11",
    updateAvailable: true,
  });
  const { check } = scriptedCheck([failed("The operation timed out")]);
  const harness = mountHarness({ check });
  await settle();

  const frame = harness.lastFrame();
  assert.match(frame, /screen:main/);
  assert.match(frame, /Ubume v0\.1\.11/);
  assert.equal(harness.overlayReturns(), 0);
  harness.cleanup();
});

test("an update published mid-session updates the notice without interrupting input", async () => {
  const { check } = scriptedCheck([upToDate(), available("0.1.11")]);
  const harness = mountHarness({ check });
  await settle();
  assert.match(harness.lastFrame(), /screen:main/);

  harness.stdin.write("hel");
  await settle();
  harness.newOutput();
  await harness.clock.advance(15 * MINUTE);
  harness.stdin.write("lo");
  await settle();

  const frame = harness.lastFrame();
  assert.match(frame, /screen:main/, "background detection must never open the prompt");
  assert.match(frame, /typed:hello/);
  assert.match(frame, /Update available/);
  assert.match(frame, /Ubume v0\.1\.11/);
  harness.cleanup();
});

test("a detected update survives later network failures", async () => {
  const { check } = scriptedCheck([upToDate(), available("0.1.11"), failed(), failed()]);
  const harness = mountHarness({ check });
  await settle();
  await harness.clock.advance(15 * MINUTE);
  await harness.clock.advance(30_000);
  await harness.clock.advance(60_000);

  assert.equal(harness.renders.at(-1)?.result?.status, "update-available");
  assert.match(harness.lastFrame(), /Ubume v0\.1\.11/);
  harness.cleanup();
});

test("re-detecting the same version does not re-render or re-notify", async () => {
  const { check } = scriptedCheck([upToDate(), available("0.1.11"), available("0.1.11")]);
  const harness = mountHarness({ check });
  await settle();
  await harness.clock.advance(15 * MINUTE);
  const rendersAfterDetection = harness.renders.length;
  const detected = harness.renders.at(-1)?.result;

  await harness.clock.advance(15 * MINUTE);
  assert.equal(harness.renders.length, rendersAfterDetection);
  assert.equal(harness.renders.at(-1)?.result, detected);
  harness.cleanup();
});

test("a late startup result never closes an overlay opened after startup", async () => {
  const deferred = deferredCheck();
  const cached: UpdateCheckResult = { ...available("0.1.11"), source: "cache" };
  const harness = mountHarness({ check: deferred.check, initialResult: cached });
  await settle();
  assert.match(harness.lastFrame(), /Ubume v0\.1\.11/);

  // User opens another overlay before npm answers.
  assert.match(harness.lastFrame(), /screen:main/);
  harness.api().setScreen("model-picker");
  await settle();
  const returnsBefore = harness.overlayReturns();

  deferred.pending[0]?.resolve(upToDate());
  await settle();
  assert.match(harness.lastFrame(), /screen:model-picker/);
  assert.equal(harness.overlayReturns(), returnsBefore);
  harness.cleanup();
});

test("dismissal is preserved: background checks never reopen the prompt", async () => {
  const { check } = scriptedCheck([available("0.1.11"), available("0.1.11"), available("0.1.12")]);
  const harness = mountHarness({ check });
  await settle();
  harness.api().setScreen("update-prompt");
  await settle();
  await pressEscape(harness.stdin);
  assert.match(harness.lastFrame(), /screen:main/);

  await harness.clock.advance(15 * MINUTE);
  await harness.clock.advance(15 * MINUTE);
  const frame = harness.lastFrame();
  assert.match(frame, /screen:main/);
  assert.doesNotMatch(frame, /\[ Update now \]/);
  assert.match(frame, /Ubume v0\.1\.12/, "a newer release still reaches the existing header card");
  harness.cleanup();
});

test("manual checks join an in-flight background check", async () => {
  const deferred = deferredCheck();
  const harness = mountHarness({ check: deferred.check });
  await settle();

  const manual = harness.api().requestUpdateCheck();
  const again = harness.api().requestUpdateCheck();
  assert.equal(deferred.pending.length, 1);

  const result = available("0.1.11");
  deferred.pending[0]?.resolve(result);
  assert.equal(await manual, result);
  assert.equal(await again, result);
  harness.cleanup();
});

test("manual checks work without polling when startup checks are disabled", async () => {
  const { check, signals } = scriptedCheck([available("0.1.11")]);
  const harness = mountHarness({ check, startupEnabled: false });
  await settle();
  assert.equal(signals.length, 0, "no automatic request when update checks are disabled");

  const result = await harness.api().requestUpdateCheck();
  await settle();
  assert.equal(result.status, "update-available");
  assert.equal(harness.renders.at(-1)?.result?.status, "update-available");
  assert.equal(harness.clock.pending().length, 0, "a manual check must not start polling");
  harness.cleanup();
});

test("unmounting stops polling and aborts the in-flight request", async () => {
  const { check } = scriptedCheck([upToDate()]);
  const harness = mountHarness({ check });
  await settle();
  assert.equal(harness.clock.pending().length, 1);
  harness.unmount();
  assert.equal(harness.clock.pending().length, 0);

  const deferred = deferredCheck();
  const second = mountHarness({ check: deferred.check });
  await settle();
  second.unmount();
  assert.equal(deferred.pending[0]?.signal.aborted, true);
  deferred.pending[0]?.resolve(available());
  await settle();
  assert.equal(second.clock.pending().length, 0);
  harness.cleanup();
  second.cleanup();
});

test("a pending startup check accepts input and never closes an explicit update overlay", async () => {
  const deferred = deferredCheck();
  const harness = mountHarness({ check: deferred.check });
  await settle();
  harness.stdin.write("ready before npm");
  await settle();
  assert.match(harness.lastFrame(), /typed:ready before npm/);
  harness.api().setScreen("update-prompt");
  await settle();
  deferred.pending[0]?.resolve(upToDate());
  await settle();
  assert.match(harness.lastFrame(), /screen:update-prompt/);
  assert.equal(harness.overlayReturns(), 0);
  assert.match(harness.lastFrame(), /Ubume is up to date/);
  await pressEscape(harness.stdin);
  assert.match(harness.lastFrame(), /screen:main/);
  harness.cleanup();
});
