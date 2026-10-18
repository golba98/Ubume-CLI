import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type React from "react";
import { useState } from "react";
import { parseLaunchArgs } from "../../config/launchArgs.js";
import { normalizeRuntimeConfig } from "../../config/runtimeConfig.js";
import { createInitialSessionState } from "../../session/appSession.js";
import { type PlanFlowState, resetPlanFlow, startPlanGeneration } from "../../session/planFlow.js";
import { PromptQueue } from "../../session/workbench.js";
import { settle, waitFor } from "../../test/async.js";
import { withEnvironment } from "../../test/environment.js";
import { createTestTerminal } from "../../test/terminal.js";
import type { PromptRunLifecycle } from "./promptRunPrep.js";
import { usePlanFlow } from "./usePlanFlow.js";

const ref = <T,>(current: T) => ({ current });
const noop = () => {};

async function planHarness(savePath: string | null = "plan.md") {
  const parsed = parseLaunchArgs([]);
  assert(parsed.ok);
  const launchArgs = parsed.value;
  const initial = startPlanGeneration("Fix the bug", "suggest");
  const runs: PromptRunLifecycle[] = [];
  const saved: PlanFlowState[] = [];
  const notices: string[] = [];
  let acceptStart = true;
  let state: PlanFlowState = initial;
  let actions!: ReturnType<typeof usePlanFlow>;
  let setState!: React.Dispatch<React.SetStateAction<PlanFlowState>>;
  const saveRef = ref<(() => void) | null>(null);
  const context = {
    initialPromptSubmittedRef: ref(true),
    recoveryRef: ref(false),
    pipelineGenerationRef: ref(0),
    submissionRef: ref(false),
    activeRunIdRef: ref<number | null>(null),
    stoppingRef: ref(Promise.resolve()),
    screenRef: ref<"main">("main"),
    promptQueue: new PromptQueue(),
    saveWorkbenchRef: saveRef,
  };
  function Harness() {
    const [plan, updatePlan] = useState<PlanFlowState>(initial);
    const [, updateRuntime] = useState(normalizeRuntimeConfig({}));
    state = plan;
    setState = updatePlan;
    saveRef.current = () => saved.push(plan);
    actions = usePlanFlow({
      ...context,
      planFlow: plan,
      setPlanFlow: updatePlan,
      launchArgs,
      startPromptRun: (_display, _prompt, lifecycle) => {
        if (!acceptStart) return false;
        runs.push(lifecycle!);
        return true;
      },
      savePlanFile: () => savePath,
      updateRuntimeConfig: updateRuntime,
      mode: "suggest",
      planMode: true,
      workspaceRoot: "/tmp/plan-flow-test",
      allowedWritableRoots: [],
      screen: "main",
      uiState: { kind: "IDLE" },
      dispatchSession: noop,
      appendEvent: (_type, title, content) => notices.push(`${title}: ${content}`),
      getSessionState: createInitialSessionState,
      busy: false,
      bumpWorkbench: noop,
      workbenchVersion: 0,
    });
    return null;
  }
  const terminal = createTestTerminal(<Harness />);
  await settle();
  return {
    terminal,
    initial,
    runs,
    saved,
    notices,
    actions: () => actions,
    state: () => state,
    reset: () => setState(resetPlanFlow()),
    accept: (value: boolean) => {
      acceptStart = value;
    },
  };
}

for (const path of ["plan.md", null]) {
  test(`completed plan enters and persists review even with plan file ${path}`, async () => {
    const h = await planHarness(path);
    try {
      h.actions().runPlanGeneration(h.initial, "Task");
      h.runs[0]!.onCompleted!({ response: "  1. Fix and test.  ", turnId: 1, runId: 1 });
      await waitFor(() => h.saved.some((state) => state.kind === "awaiting_action"), {
        label: "committed review saved",
        timeoutMs: 200,
      });
      const state = h.state();
      assert.equal(state.kind, "awaiting_action");
      if (state.kind !== "awaiting_action") return;
      assert.equal(state.currentPlan, "1. Fix and test.");
      assert.equal(state.planFilePath, path);
      await settle();
      assert.equal(h.state().kind, "awaiting_action");
    } finally {
      await h.terminal.dispose();
    }
  });
}

for (const outcome of ["empty", "failed", "canceled", "late-completion"] as const) {
  test(`plan ${outcome} never presents approval`, async () => {
    const h = await planHarness();
    try {
      h.actions().runPlanGeneration(h.initial, "Task");
      const lifecycle = h.runs[0]!;
      if (outcome === "failed") lifecycle.onFailed!({ message: "Failed", turnId: 1, runId: 1 });
      else if (outcome === "canceled") lifecycle.onCanceled!({ turnId: 1, runId: 1 });
      else {
        if (outcome === "late-completion") {
          h.reset();
          await settle();
        }
        lifecycle.onCompleted!({
          response: outcome === "empty" ? " \n " : "Old plan",
          turnId: 1,
          runId: 1,
        });
      }
      await settle();
      assert.equal(h.state().kind, "idle");
      assert(!h.saved.some((state) => state.kind === "awaiting_action"));
    } finally {
      await h.terminal.dispose();
    }
  });
}

test("a rejected approval start keeps review actionable and a duplicate approval starts once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-plan-retry-"));
  try {
    await withEnvironment({ CODEX_HOME: root }, async () => {
      const h = await planHarness();
      try {
        h.actions().runPlanGeneration(h.initial, "Task");
        h.runs[0]!.onCompleted!({ response: "The plan", turnId: 1, runId: 1 });
        await waitFor(() => h.state().kind === "awaiting_action", { label: "review ready" });
        h.accept(false);
        h.actions().handlePlanAction("implement");
        await settle();
        assert.equal(h.state().kind, "awaiting_action");
        h.accept(true);
        h.actions().handlePlanAction("implement");
        h.actions().handlePlanAction("implement");
        await settle();
        assert.equal(h.runs.length, 2);
        assert.equal(h.state().kind, "executing");
        assert.equal(h.runs[1]?.runtimeOverride?.planMode, false);
        assert.equal(h.runs[1]?.runtimeOverride?.mode, "auto-edit");
      } finally {
        await h.terminal.dispose();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
