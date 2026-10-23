import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  selectedToolApprovalAction,
  toolApprovalActions,
  toolApprovalRequestId,
} from "../providers/toolApproval.js";
import type { ToolApprovalRequest, ToolApprovalResult } from "../providers/types.js";
import { createProviderApprovalQueue } from "./providerApprovalQueue.js";

const request: ToolApprovalRequest = {
  tool: "Bash",
  signature: "Bash:original",
  command: "printf original",
  paths: [],
};

for (const result of [
  "unknown",
  undefined,
  null,
  { requestId: "other", actionId: "allow-once" },
  { actionId: "allow-once" },
  "allow-for-run",
]) {
  test(`unsupported or mismatched decision fails closed: ${JSON.stringify(result)}`, async () => {
    const responses: string[] = [];
    const queue = createProviderApprovalQueue({
      toApproval: () => ({ ...request, allowForRun: false }),
      onToolApproval: async () => result as ToolApprovalResult,
      respond: (_item, outcome) => responses.push(outcome),
    });
    queue.enqueue("a", {});
    await sleep(0);
    expect(responses).toEqual(["deny"]);
    queue.dispose();
  });
}

test("stable native action IDs survive filtering and ambiguous semantic decisions deny", () => {
  const native = {
    ...request,
    requestId: "native",
    actions: [
      { id: "scoped-a", label: "Scope A", decision: "allow-once" as const },
      { id: "scoped-b", label: "Scope B", decision: "allow-once" as const },
    ],
  };
  expect(
    selectedToolApprovalAction(native, { requestId: "native", actionId: "scoped-b" })?.id,
  ).toBe("scoped-b");
  expect(selectedToolApprovalAction(native, "allow-once")).toBeNull();
  expect(toolApprovalActions({ ...request, allowForRun: false }).map((a) => a.id)).toEqual([
    "allow-once",
    "deny",
  ]);
});

test("invalid, duplicate and empty native menus never fabricate choices", async () => {
  for (const actions of [
    [],
    [
      { id: "x", label: "a", decision: "allow-once" as const },
      { id: "x", label: "b", decision: "deny" as const },
    ],
    null,
  ]) {
    let asked = 0;
    const responses: string[] = [];
    const queue = createProviderApprovalQueue({
      toApproval: () => ({ ...request, actions: actions as ToolApprovalRequest["actions"] }),
      onToolApproval: async () => {
        asked++;
        return "allow-once";
      },
      respond: (_item, outcome) => responses.push(outcome),
    });
    queue.enqueue("a", {});
    await sleep(0);
    expect(asked).toBe(0);
    expect(responses).toEqual(["unavailable"]);
    queue.dispose();
  }
});

test("run grants cache only exact signatures while allow-once always asks again", async () => {
  for (const decision of ["allow-once", "allow-for-run"] as const) {
    let asked = 0;
    const outcomes: string[] = [];
    const queue = createProviderApprovalQueue<ToolApprovalRequest>({
      toApproval: (item) => item,
      onToolApproval: async (r) => {
        asked++;
        return { requestId: toolApprovalRequestId(r), actionId: decision };
      },
      respond: (_item, outcome) => outcomes.push(outcome),
    });
    queue.enqueue("a", request);
    queue.enqueue("b", request);
    queue.enqueue("c", { ...request, signature: "changed", command: "printf changed" });
    await sleep(0);
    expect(asked).toBe(decision === "allow-once" ? 3 : 2);
    expect(outcomes).toEqual(["allow", "allow", "allow"]);
    queue.dispose();
  }
});

test("withdrawal, duplicate IDs and disposal never route late decisions to another request", async () => {
  const pending: ((result: ToolApprovalResult) => void)[] = [];
  const shown: ToolApprovalRequest[] = [];
  const responses: string[] = [];
  const queue = createProviderApprovalQueue({
    toApproval: () => request,
    onToolApproval: (r) => {
      shown.push(r);
      return new Promise((resolve) => pending.push(resolve));
    },
    respond: (_item, outcome) => responses.push(outcome),
  });
  queue.enqueue("a", {});
  queue.enqueue("a", {});
  queue.enqueue("b", {});
  expect(shown.length).toBe(1);
  queue.withdraw("a");
  await sleep(0);
  expect(shown.length).toBe(2);
  pending[0]!({ requestId: toolApprovalRequestId(shown[0]!), actionId: "allow-once" });
  await sleep(0);
  expect(responses).toEqual([]);
  queue.dispose();
  pending[1]!("allow-once");
  await sleep(0);
  expect(responses).toEqual([]);
  expect(queue.pending).toBe(0);
});

test("payload mutation cannot approve a different command than displayed", async () => {
  let settle!: (value: ToolApprovalResult) => void;
  let shown: ToolApprovalRequest | undefined;
  const responses: string[] = [];
  const queue = createProviderApprovalQueue<ToolApprovalRequest>({
    toApproval: (item) => item,
    onToolApproval: (r) => {
      shown = r;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    respond: (item) => responses.push(item.command!),
  });
  const input = { ...request };
  queue.enqueue("a", input);
  input.command = "printf different";
  expect(shown?.command).toBe("printf original");
  settle({ requestId: toolApprovalRequestId(shown!), actionId: "allow-once" });
  await sleep(0);
  expect(responses).toEqual(["printf original"]);
  queue.dispose();
});
