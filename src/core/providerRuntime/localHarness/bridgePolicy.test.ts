import { expect, test } from "bun:test";
import { TEST_RUNTIME } from "../../../test/runtimeTestUtils.js";
import { canonicalJson } from "../providerApprovalQueue.js";
import type { ProviderChatRequest } from "../types.js";
import { decideToolPolicy } from "./bridgePolicy.js";

test("Local exact-action grants never authorize different content at the same path", () => {
  const request: ProviderChatRequest = {
    prompt: "test",
    workspaceRoot: process.cwd(),
    runtime: {
      ...TEST_RUNTIME,
      policy: {
        ...TEST_RUNTIME.policy,
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      },
    },
    route: { providerId: "local", modelId: "test", backendKind: "local-openai-compatible" },
  };
  const original = { path: "example.txt", content: "approved" };
  const approvals = new Set([`write:${canonicalJson(original)}`]);
  expect(decideToolPolicy("write", original, request, approvals).decision.kind).toBe("allow");
  expect(
    decideToolPolicy("write", { ...original, content: "different" }, request, approvals).decision
      .kind,
  ).toBe("ask");
});
