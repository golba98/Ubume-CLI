import assert from "node:assert/strict";
import test from "node:test";
import { parseLaunchArgs } from "./launchArgs.js";

test("parses profile and repeated config overrides", () => {
  const parsed = parseLaunchArgs([
    "--profile",
    "review",
    "--config",
    'model="gpt-5.4"',
    "-c",
    'ubume.mode="suggest"',
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.help, false);
  assert.equal(parsed.value.version, false);
  assert.equal(parsed.value.initialPrompt, null);
  assert.equal(parsed.value.profile, "review");
  assert.deepEqual(parsed.value.configOverrides, ['model="gpt-5.4"', 'ubume.mode="suggest"']);
  assert.deepEqual(parsed.value.passthroughArgs, [
    "--profile",
    "review",
    "--config",
    'model="gpt-5.4"',
    "-c",
    'ubume.mode="suggest"',
  ]);
});

test("rejects missing profile values", () => {
  const parsed = parseLaunchArgs(["--profile"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /--profile/i);
});

test("rejects malformed config payloads", () => {
  const parsed = parseLaunchArgs(["--config", "model"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /key=value/i);
});

test("parses inline profile and config assignments", () => {
  const parsed = parseLaunchArgs([
    "--profile=review",
    '--config=model="gpt-5.4-mini"',
    '-c=ubume.mode="auto-edit"',
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.profile, "review");
  assert.deepEqual(parsed.value.configOverrides, [
    'model="gpt-5.4-mini"',
    'ubume.mode="auto-edit"',
  ]);
  assert.deepEqual(parsed.value.passthroughArgs, [
    "--profile=review",
    '--config=model="gpt-5.4-mini"',
    '-c=ubume.mode="auto-edit"',
  ]);
});

test("parses model flags as runtime config overrides", () => {
  const parsed = parseLaunchArgs([
    "--model",
    "gpt-5.3-codex",
    "-m",
    "gpt-5.4-mini",
    "Say",
    "READY",
    "only.",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.initialPrompt, "Say READY only.");
  assert.deepEqual(parsed.value.configOverrides, ['model="gpt-5.3-codex"', 'model="gpt-5.4-mini"']);
  assert.deepEqual(parsed.value.passthroughArgs, [
    "--model",
    "gpt-5.3-codex",
    "-m",
    "gpt-5.4-mini",
  ]);
  // Last --model flag wins (same order as layered config)
  assert.equal(parsed.value.modelOverride, "gpt-5.4-mini");
});

test("parses inline model flag assignment", () => {
  const parsed = parseLaunchArgs(["--model=gpt-5.5", "compare", "this"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.initialPrompt, "compare this");
  assert.deepEqual(parsed.value.configOverrides, ['model="gpt-5.5"']);
  assert.deepEqual(parsed.value.passthroughArgs, ["--model=gpt-5.5"]);
  assert.equal(parsed.value.modelOverride, "gpt-5.5");

  // Short -m= inline form
  const parsedShort = parseLaunchArgs(["-m=gpt-5.4", "task"]);
  assert.equal(parsedShort.ok, true);
  if (!parsedShort.ok) return;
  assert.equal(parsedShort.value.initialPrompt, "task");
  assert.deepEqual(parsedShort.value.configOverrides, ['model="gpt-5.4"']);
  assert.deepEqual(parsedShort.value.passthroughArgs, ["-m=gpt-5.4"]);
  assert.equal(parsedShort.value.modelOverride, "gpt-5.4");
});

test("modelOverride is null when no --model flag is given", () => {
  const parsed = parseLaunchArgs(["--profile", "review", "some", "prompt"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.modelOverride, null);
});

test("rejects missing model flag values", () => {
  const parsed = parseLaunchArgs(["--model"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.match(parsed.error, /--model/i);
  }

  const parsedShort = parseLaunchArgs(["-m"]);
  assert.equal(parsedShort.ok, false);
  if (!parsedShort.ok) {
    assert.match(parsedShort.error, /-m/i);
  }

  const parsedInlineEmpty = parseLaunchArgs(["-m="]);
  assert.equal(parsedInlineEmpty.ok, false);
  if (!parsedInlineEmpty.ok) {
    assert.match(parsedInlineEmpty.error, /-m/i);
  }
});

test("parses help and version flags without passthrough", () => {
  const parsed = parseLaunchArgs(["--help", "-v"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.help, true);
  assert.equal(parsed.value.version, true);
  assert.equal(parsed.value.initialPrompt, null);
  assert.deepEqual(parsed.value.passthroughArgs, []);
});

test("parses positional arguments as an initial prompt", () => {
  const parsed = parseLaunchArgs(["--profile", "review", "explain", "this", "repo"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.profile, "review");
  assert.equal(parsed.value.initialPrompt, "explain this repo");
  assert.deepEqual(parsed.value.passthroughArgs, ["--profile", "review"]);
});

test("parses arguments after -- as an initial prompt", () => {
  const parsed = parseLaunchArgs(["--", "--help", "as", "text"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.value.help, false);
  assert.equal(parsed.value.initialPrompt, "--help as text");
  assert.deepEqual(parsed.value.passthroughArgs, []);
});

test("--no-clear sets noClear to true", () => {
  const parsed = parseLaunchArgs(["--no-clear"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.noClear, true);
});

test("noClear defaults to false when --no-clear is absent", () => {
  const parsed = parseLaunchArgs(["--profile", "review"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.noClear, false);
});

test("--no-clear does not consume the next argument as a value", () => {
  const parsed = parseLaunchArgs(["--no-clear", "my prompt here"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.noClear, true);
  assert.equal(parsed.value.initialPrompt, "my prompt here");
});

test("--no-clear can be combined with other flags", () => {
  const parsed = parseLaunchArgs(["--no-clear", "--profile", "fast", "do something"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.noClear, true);
  assert.equal(parsed.value.profile, "fast");
  assert.equal(parsed.value.initialPrompt, "do something");
});

test("startup resume and import targets are exclusive and never replay as a prompt or relaunch argument", () => {
  for (const args of [["--resume", "chat_abc"], ["--import-session=vibe:native_1"]]) {
    const parsed = parseLaunchArgs(args);
    assert(parsed.ok);
    assert.equal(parsed.value.initialPrompt, null);
    assert.deepEqual(parsed.value.passthroughArgs, []);
  }
  assert.equal(
    parseLaunchArgs(["--resume", "chat_abc", "--import-session", "codex:native"]).ok,
    false,
  );
  assert.equal(parseLaunchArgs(["--resume=../escape"]).ok, false);
  assert.equal(parseLaunchArgs(["--import-session=gemini:native"]).ok, false);
  assert.equal(parseLaunchArgs(["--resume", "chat_abc", "execute this"]).ok, false);
});

test("interactive provider flag cannot become a prompt for the default backend", () => {
  const parsed = parseLaunchArgs(["--provider", "google", "--model", "gemini-3.8-flash-low"]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /ubume exec/);
});

test("handles empty argv and whitespace-only flags appropriately", () => {
  const empty = parseLaunchArgs([]);
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.value.help, false);
    assert.equal(empty.value.initialPrompt, null);
    assert.deepEqual(empty.value.configOverrides, []);
  }

  const whitespaceProfile = parseLaunchArgs(["--profile", "   "]);
  assert.equal(whitespaceProfile.ok, false);

  const whitespaceModel = parseLaunchArgs(["--model", "   "]);
  assert.equal(whitespaceModel.ok, false);

  const leadingEqualsConfig = parseLaunchArgs(["--config", "=value"]);
  assert.equal(leadingEqualsConfig.ok, false);

  const trailingEqualsConfig = parseLaunchArgs(["--config", "key="]);
  assert.equal(trailingEqualsConfig.ok, false);
});
