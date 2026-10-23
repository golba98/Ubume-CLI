import { expect, test } from "bun:test";
import type { RunToolActivity } from "../../session/types.js";
import { toolActivityLabel } from "./runActivityView.js";

test("authorization labels distinguish request, consent, execution, denial and cancellation", () => {
  const tool: RunToolActivity = {
    id: "a",
    command: "printf test",
    status: "running",
    startedAt: 0,
  };
  for (const [authorization, label] of [
    ["requested", "Tool requested"],
    ["pending", "Awaiting permission"],
    ["approved", "Approved; waiting for provider"],
    ["executing", "Executing tool"],
    ["denied", "Permission denied"],
    ["cancelled", "Cancelled"],
  ] as const) {
    expect(toolActivityLabel({ ...tool, authorization }, tool.command)).toContain(label);
  }
  expect(
    toolActivityLabel({ ...tool, authorization: "approved", status: "completed" }, tool.command),
  ).not.toContain("waiting");
});
