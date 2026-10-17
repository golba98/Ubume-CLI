import assert from "node:assert/strict";
import test from "node:test";
import { parseHeadlessExecArgs } from "./execArgs.js";

test("parses ubume exec positional prompt", () => {
  const parsed = parseHeadlessExecArgs(["Print", "the", "directory"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print the directory");
  assert.equal(parsed.value.promptPolicy, "raw");
  assert.equal(parsed.value.launchArgs.initialPrompt, "Print the directory");
});

test("parses ubume exec --prompt value", () => {
  const parsed = parseHeadlessExecArgs(["--prompt", "Print the directory"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print the directory");
});

test("parses ubume exec --prompt=value", () => {
  const parsed = parseHeadlessExecArgs(["--prompt=Print the directory"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print the directory");
});

test("rejects missing and empty prompts", () => {
  const missing = parseHeadlessExecArgs([]);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.error, /missing prompt/i);
  }

  const empty = parseHeadlessExecArgs(["--prompt", "   "]);
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.match(empty.error, /--prompt/i);
  }
});

test("parses ubume exec --reasoning value", () => {
  const parsed = parseHeadlessExecArgs(["--reasoning", "medium", "Print files"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print files");
  assert.deepEqual(parsed.value.launchArgs.configOverrides, ["model_reasoning_effort=medium"]);
  assert.deepEqual(parsed.value.launchArgs.passthroughArgs, ["--reasoning", "medium"]);
});

test("parses ubume exec --reasoning=value", () => {
  const parsed = parseHeadlessExecArgs(["--reasoning=high", "Print files"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Print files");
  assert.deepEqual(parsed.value.launchArgs.configOverrides, ["model_reasoning_effort=high"]);
  assert.deepEqual(parsed.value.launchArgs.passthroughArgs, ["--reasoning=high"]);
});

test("parses timing and prompt policy flags without forwarding them to Codex", () => {
  const parsed = parseHeadlessExecArgs([
    "--timing",
    "--ubume-prompt-policy",
    "wrapped",
    "Print files",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.timing, true);
  assert.equal(parsed.value.promptPolicy, "wrapped");
  assert.equal(parsed.value.prompt, "Print files");
  assert.deepEqual(parsed.value.launchArgs.passthroughArgs, []);
});

test("rejects invalid prompt policy values", () => {
  const parsed = parseHeadlessExecArgs(["--ubume-prompt-policy", "verbose", "Prompt"]);

  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.match(parsed.error, /ubume-prompt-policy/i);
  }
});

test("accepts the pre-rename --codexa-prompt-policy spelling", () => {
  for (const argv of [
    ["--codexa-prompt-policy", "wrapped", "Prompt"],
    ["--codexa-prompt-policy=wrapped", "Prompt"],
  ]) {
    const parsed = parseHeadlessExecArgs(argv);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.promptPolicy, "wrapped");
  }
});

test("parses ubume exec --model and --reasoning together", () => {
  const parsed = parseHeadlessExecArgs([
    "--model",
    "gpt-5.4-mini",
    "--reasoning",
    "medium",
    "Reply with exactly: UBUME_READY",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.prompt, "Reply with exactly: UBUME_READY");
  assert.deepEqual(parsed.value.launchArgs.configOverrides, [
    'model="gpt-5.4-mini"',
    "model_reasoning_effort=medium",
  ]);
});

test("preserves profile and repeated config overrides", () => {
  const parsed = parseHeadlessExecArgs([
    "--benchmark-diagnostics",
    "--skip-git-repo-check",
    "--profile",
    "bench",
    "--model",
    "gpt-5.4-mini",
    "-c",
    "model_reasoning_effort=medium",
    "--config",
    'sandbox_mode="workspace-write"',
    '--config=approval_policy="never"',
    "Print",
    "files",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.benchmarkDiagnostics, true);
  assert.equal(parsed.value.timing, true);
  assert.equal(parsed.value.prompt, "Print files");
  assert.equal(parsed.value.launchArgs.profile, "bench");
  assert.deepEqual(parsed.value.launchArgs.configOverrides, [
    'model="gpt-5.4-mini"',
    "model_reasoning_effort=medium",
    'sandbox_mode="workspace-write"',
    'approval_policy="never"',
  ]);
  assert.deepEqual(parsed.value.launchArgs.passthroughArgs, [
    "--skip-git-repo-check",
    "--profile",
    "bench",
    "--model",
    "gpt-5.4-mini",
    "-c",
    "model_reasoning_effort=medium",
    "--config",
    'sandbox_mode="workspace-write"',
    '--config=approval_policy="never"',
  ]);
});

test("missing option values do not consume following flags", () => {
  for (const flag of ["--model", "-m", "--reasoning", "--profile", "--prompt"]) {
    const parsed = parseHeadlessExecArgs([flag, "--json", "hello"]);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /Missing value/);
  }
  assert.equal(parseHeadlessExecArgs(["--prompt=--json"]).ok, true);
});

test("parse errors keep their exact wording", () => {
  const cases: [string[], string][] = [
    [["--prompt"], "Missing value for --prompt. Use --prompt=VALUE for an option-like value."],
    [
      ["--prompt", "  "],
      "Missing value for --prompt. Use --prompt=VALUE for an option-like value.",
    ],
    [["--prompt=  "], "Missing value for --prompt."],
    [["--profile"], "Missing value for --profile. Use --profile=VALUE for an option-like value."],
    [["--profile=", "hi"], "Missing value for --profile."],
    [["--model= ", "hi"], "Missing value for --model."],
    [["--reasoning=", "hi"], "Missing value for --reasoning."],
    [["-c", "ab", "hi"], "Missing key=value payload for -c."],
    [["--config", "=b", "hi"], "Missing key=value payload for --config."],
    [["-c=ab", "hi"], "Missing key=value payload for -c."],
    [["--config=a=", "hi"], "Missing key=value payload for --config."],
    [
      ["--ubume-prompt-policy", "bad", "hi"],
      "Missing or invalid value for --ubume-prompt-policy. Use raw or wrapped.",
    ],
    [
      ["--ubume-prompt-policy=bad", "hi"],
      "Invalid value for --ubume-prompt-policy. Use raw or wrapped.",
    ],
    [["--resume"], "Missing value for --resume."],
    [["--resume=", "hi"], "Missing value for --resume."],
    [["--cwd", "--json"], "Missing value for --cwd."],
    [["--file"], "Missing value for --file."],
    [["--provider=  ", "hi"], "Missing value for --provider."],
    [["--bogus"], "Unknown option for ubume exec: --bogus"],
    [[], 'Missing prompt. Use ubume exec "prompt" or ubume exec --prompt "prompt".'],
    [["a", "--prompt", "b"], "Provide a prompt either positionally or with --prompt, not both."],
    [["--prompt", "p", "--stdin"], "--stdin cannot be combined with another prompt source."],
    [["--resume", "chat_1", "--no-save", "hi"], "--no-save cannot be combined with --resume."],
  ];
  for (const [argv, error] of cases) {
    assert.deepEqual(parseHeadlessExecArgs(argv), { ok: false, error }, argv.join(" "));
  }
});

test("passthrough args keep the spelling the caller used", () => {
  const separate = parseHeadlessExecArgs([
    "--profile",
    "p",
    "-m",
    "m",
    "--reasoning",
    "high",
    "hi",
  ]);
  const inline = parseHeadlessExecArgs([
    "--profile=p",
    "--model=m",
    "--reasoning=high",
    "-c=a=b",
    "hi",
  ]);
  assert(separate.ok && inline.ok);
  assert.deepEqual(separate.value.launchArgs.passthroughArgs, [
    "--profile",
    "p",
    "-m",
    "m",
    "--reasoning",
    "high",
  ]);
  assert.deepEqual(inline.value.launchArgs.passthroughArgs, [
    "--profile=p",
    "--model=m",
    "--reasoning=high",
    "-c=a=b",
  ]);
  assert.deepEqual(inline.value.launchArgs.configOverrides, [
    'model="m"',
    "model_reasoning_effort=high",
    "a=b",
  ]);
  assert.equal(inline.value.launchArgs.modelOverride, "m");
  assert.equal(inline.value.launchArgs.initialPrompt, "hi");
});

test("ordering, terminator, repeated files, help and stdin edge cases", () => {
  const terminated = parseHeadlessExecArgs(["--json", "--", "--json", " x "]);
  assert(terminated.ok);
  assert.equal(terminated.value.json, true);
  assert.equal(terminated.value.prompt, "--json x");

  const files = parseHeadlessExecArgs(["--file=a", "--file", "b", "hi", "--provider", "local"]);
  assert(files.ok);
  assert.deepEqual(files.value.files, ["a", "b"]);
  assert.equal(files.value.providerId, "local");

  const help = parseHeadlessExecArgs(["--help"]);
  assert(help.ok);
  assert.equal(help.value.help, true);
  assert.equal(help.value.prompt, "");
  assert.equal(help.value.launchArgs.initialPrompt, null);

  const stdin = parseHeadlessExecArgs(["--stdin", "--no-save"]);
  assert(stdin.ok);
  assert.equal(stdin.value.stdin, true);
  assert.equal(stdin.value.noSave, true);
  assert.equal(stdin.value.prompt, "");

  // -c reads the next argument even when it looks like an option.
  const optionLike = parseHeadlessExecArgs(["-c", "--x=y", "hi"]);
  assert(optionLike.ok);
  assert.deepEqual(optionLike.value.launchArgs.configOverrides, ["--x=y"]);
});
