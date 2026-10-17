import assert from "node:assert/strict";
import test from "node:test";
import {
  getAuthStateLabel,
  getRunGateDecision,
  inferAuthStateFromProbe,
  isLikelyAuthFailure,
} from "./codexAuth.js";

test("infers authenticated from successful probe exit", () => {
  const state = inferAuthStateFromProbe(0, "", "");
  assert.equal(state, "authenticated");
});

test("infers unauthenticated from signed-out probe output", () => {
  const state = inferAuthStateFromProbe(1, "No active session. Please login.", "");
  assert.equal(state, "unauthenticated");
});

test("JSON signed-out status cannot match the authenticated substring", () => {
  for (const status of ["unauthenticated", "UNAUTHENTICATED", "signed_out"]) {
    const state = inferAuthStateFromProbe(1, JSON.stringify({ status }), "");
    assert.equal(state, "unauthenticated", status);
    assert.equal(getRunGateDecision(state).allowRun, false, status);
  }
  assert.equal(
    inferAuthStateFromProbe(1, JSON.stringify({ status: "authenticated" }), ""),
    "authenticated",
  );
});

test("infers unknown from ambiguous probe output", () => {
  const state = inferAuthStateFromProbe(
    2,
    "Usage: codex login status [OPTIONS]",
    "unexpected argument '--json'",
  );
  assert.equal(state, "unknown");
});

test("blocks runs when unauthenticated", () => {
  const decision = getRunGateDecision("unauthenticated");
  assert.equal(decision.allowRun, false);
  assert.match(decision.blockMessage ?? "", /codex login/i);
});

test("warns but allows runs when auth state is unknown", () => {
  const decision = getRunGateDecision("unknown");
  assert.equal(decision.allowRun, true);
  assert.match(decision.warningMessage ?? "", /unknown/i);
});

test("allows unchecked initial auth state without a warning", () => {
  const decision = getRunGateDecision("unknown", { warnOnUnknown: false });
  assert.equal(decision.allowRun, true);
  assert.equal(decision.warningMessage, undefined);
});

test("allows runs when authenticated", () => {
  const decision = getRunGateDecision("authenticated");
  assert.equal(decision.allowRun, true);
  assert.equal(decision.warningMessage, undefined);
});

test("detects runtime auth failure messages", () => {
  const detected = isLikelyAuthFailure("Unauthorized (401): token expired. Run codex login.");
  assert.equal(detected, true);
});

test("detects auth failures that carry HTTP context or explicit login phrases", () => {
  for (const message of [
    "HTTP 401 Unauthorized",
    "status: 403 Forbidden",
    "unexpected status 401 Unauthorized: Missing bearer",
    "Not logged in. Run codex login",
    "Your session expired",
  ]) {
    assert.equal(isLikelyAuthFailure(message), true, message);
  }
});

test("ignores 401/403 digits and generic denials in ordinary output", () => {
  for (const message of [
    "duration_ms: 1403",
    "src/world.js:401:  const h = noise(x, z);",
    "Process exited with code 1",
    "Permission denied",
    "access denied to /tmp/x",
    "stream disconnected before completion",
  ]) {
    assert.equal(isLikelyAuthFailure(message), false, message);
  }
});

test("getAuthStateLabel returns Checking for checking state", () => {
  assert.equal(getAuthStateLabel("checking"), "Checking");
});

test("getAuthStateLabel returns Unknown for unknown state", () => {
  assert.equal(getAuthStateLabel("unknown"), "Unknown");
});
