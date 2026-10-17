import assert from "node:assert/strict";
import test from "node:test";
import { getFriendlyActionLabel, normalizeCommand } from "./runActivityView.js";

// ─── normalizeCommand ─────────────────────────────────────────────────────────

test("normalizeCommand: strips full PowerShell path with single-quoted command", () => {
  const raw = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'Get-ChildItem -Force | Select-Object Name,Mode,Length'`;
  assert.equal(normalizeCommand(raw), "Get-ChildItem -Force | Select-Object Name,Mode,Length");
});

test("normalizeCommand: strips full PowerShell path with double-quoted command", () => {
  const raw = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content package.json"`;
  assert.equal(normalizeCommand(raw), "Get-Content package.json");
});

test("normalizeCommand: strips bare pwsh.exe -Command", () => {
  assert.equal(normalizeCommand(`pwsh.exe -Command 'git status'`), "git status");
  assert.equal(normalizeCommand(`pwsh -Command "npm install"`), "npm install");
});

test("normalizeCommand: strips bare powershell.exe -Command", () => {
  assert.equal(normalizeCommand(`powershell.exe -Command 'dir'`), "dir");
  assert.equal(
    normalizeCommand(`powershell -Command "Get-Content readme.md"`),
    "Get-Content readme.md",
  );
});

test("normalizeCommand: strips cmd.exe /c wrapper", () => {
  assert.equal(normalizeCommand(`cmd.exe /c "dir /b"`), "dir /b");
  assert.equal(normalizeCommand(`cmd /C "npm test"`), "npm test");
});

test("normalizeCommand: strips bash -lc wrapper", () => {
  assert.equal(normalizeCommand(`bash -lc 'bun install'`), "bun install");
  assert.equal(normalizeCommand(`bash -lc "git diff"`), "git diff");
});

test("normalizeCommand: returns command unchanged when no wrapper is detected", () => {
  assert.equal(normalizeCommand("git status"), "git status");
  assert.equal(normalizeCommand("bun test"), "bun test");
  assert.equal(normalizeCommand("python -m pytest"), "python -m pytest");
  assert.equal(normalizeCommand("tsc --noEmit"), "tsc --noEmit");
});

test("normalizeCommand: collapses local file paths inside commands", () => {
  assert.equal(
    normalizeCommand(`pwsh.exe -Command 'Get-Content C:\\Users\\Example\\Project\\README.md'`),
    "Get-Content README.md",
  );
  assert.equal(
    normalizeCommand(`Get-Content C:/Users/Example/Project/src/App.tsx`),
    "Get-Content src/App.tsx",
  );
});

test("normalizeCommand: is case-insensitive for -Command flag", () => {
  assert.equal(normalizeCommand(`pwsh.exe -command 'ls'`), "ls");
  assert.equal(normalizeCommand(`pwsh.exe -COMMAND 'ls'`), "ls");
});

// ─── getFriendlyActionLabel ───────────────────────────────────────────────────

test("getFriendlyActionLabel: Get-ChildItem → List files", () => {
  assert.equal(
    getFriendlyActionLabel("Get-ChildItem -Force | Select-Object Name,Mode,Length"),
    "List files",
  );
  assert.equal(getFriendlyActionLabel("Get-ChildItem"), "List files");
  assert.equal(getFriendlyActionLabel("dir /b"), "List files");
  assert.equal(getFriendlyActionLabel("ls -la"), "List files");
  assert.equal(getFriendlyActionLabel("rg --files"), "List files");
});

test("getFriendlyActionLabel: Get-Content / cat → Read file", () => {
  assert.equal(getFriendlyActionLabel("Get-Content package.json"), "Read file");
  assert.equal(getFriendlyActionLabel("cat src/index.ts"), "Read file");
});

test("getFriendlyActionLabel: git status → Check git status", () => {
  assert.equal(getFriendlyActionLabel("git status"), "Check git status");
  assert.equal(getFriendlyActionLabel("git status --short"), "Check git status");
});

test("getFriendlyActionLabel: git diff → Inspect changes", () => {
  assert.equal(getFriendlyActionLabel("git diff"), "Inspect changes");
  assert.equal(getFriendlyActionLabel("git diff HEAD~1"), "Inspect changes");
});

test("getFriendlyActionLabel: install commands → Install dependencies", () => {
  assert.equal(getFriendlyActionLabel("bun install"), "Install dependencies");
  assert.equal(getFriendlyActionLabel("npm install"), "Install dependencies");
  assert.equal(getFriendlyActionLabel("npm install --save-dev"), "Install dependencies");
});

test("getFriendlyActionLabel: test commands → Run tests", () => {
  assert.equal(getFriendlyActionLabel("bun test"), "Run tests");
  assert.equal(getFriendlyActionLabel("npm test"), "Run tests");
});

test("getFriendlyActionLabel: typecheck commands → Run typecheck", () => {
  assert.equal(getFriendlyActionLabel("tsc --noEmit"), "Run typecheck");
  assert.equal(getFriendlyActionLabel("bun run typecheck"), "Run typecheck");
});

test("getFriendlyActionLabel: returns null for unrecognized commands", () => {
  assert.equal(getFriendlyActionLabel("python -m pytest"), null);
  assert.equal(getFriendlyActionLabel("echo hello"), null);
  assert.equal(getFriendlyActionLabel("node scripts/build.js"), null);
});

test("normalizeCommand: decodes JSON-escaped quotes in PowerShell commands", () => {
  const raw = `pwsh.exe -Command 'Get-ChildItem | Where-Object { $_.Name -match \\"requirements\\" }'`;
  assert.equal(
    normalizeCommand(raw),
    'Get-ChildItem | Where-Object { $_.Name -match "requirements" }',
  );
});

test("normalizeCommand: decodes escaped quotes in bare commands", () => {
  assert.equal(normalizeCommand(`grep -r \\"TODO\\" ./src`), 'grep -r "TODO" ./src');
});

test("normalizeCommand: decodes escaped quotes in cmd.exe wrapper", () => {
  assert.equal(normalizeCommand(`cmd.exe /c "grep \\"error\\" log.txt"`), 'grep "error" log.txt');
});

test("normalizeCommand: passes through MCP tool call format unchanged", () => {
  assert.equal(normalizeCommand("filesystem:read_file"), "filesystem:read_file");
  assert.equal(normalizeCommand("github:create_issue"), "github:create_issue");
});

test("normalizeCommand: passes through web search format unchanged", () => {
  assert.equal(
    normalizeCommand("web search: TypeScript union types"),
    "web search: TypeScript union types",
  );
});

test("getFriendlyActionLabel: returns null for MCP tool call format", () => {
  assert.equal(getFriendlyActionLabel("filesystem:read_file"), null);
  assert.equal(getFriendlyActionLabel("github:list_issues"), null);
});

test("getFriendlyActionLabel: returns null for web search commands", () => {
  assert.equal(getFriendlyActionLabel("web search: TypeScript generics tutorial"), null);
});
