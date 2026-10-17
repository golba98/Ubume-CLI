import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "../config/runtimeConfig.js";
import { createTestRuntime, TEST_RUNTIME } from "./runtimeTestUtils.js";

test("runtime fixtures resolve partial policies through production defaults", () => {
  const runtime = createTestRuntime({ mode: "suggest", policy: { networkAccess: "enabled" } });
  expect(runtime.policy.networkAccess).toBe(true);
  expect(runtime.policy.sandboxMode).toBe("read-only");
  expect(runtime.policy.approvalPolicy).toBe("on-request");
  expect(runtime.model).toBe(DEFAULT_RUNTIME_CONFIG.model);
  expect(TEST_RUNTIME).toEqual(createTestRuntime());
});

test("runtime fixtures own their policy and writable roots without mutating overrides", () => {
  const roots = ["/fixture-workspace"];
  const first = createTestRuntime({ policy: { writableRoots: roots } });
  const second = createTestRuntime({ policy: { writableRoots: roots } });
  first.policy.writableRoots.push("/first-only");
  first.policy.attachmentDir = "first-attachments";
  expect(second.policy.writableRoots).toEqual(["/fixture-workspace"]);
  expect(roots).toEqual(["/fixture-workspace"]);
  expect(second.policy.attachmentDir).toBe(DEFAULT_RUNTIME_CONFIG.policy.attachmentDir);
  expect(TEST_RUNTIME.policy.writableRoots).toEqual([]);
  expect(DEFAULT_RUNTIME_CONFIG.policy.writableRoots).toEqual([]);
});
