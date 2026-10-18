import assert from "node:assert/strict";
import test from "node:test";
import {
  containsDirectoryNavigationCommand,
  extractExplicitPathReferences,
  findOutsideWorkspacePaths,
  formatSkippedDependencyPath,
  getPromptWorkspaceGuardMessage,
  getShellWorkspaceGuardMessage,
  isDangerousShellCommand,
  isPathInsideAllowedRoots,
  isPathInsideWorkspace,
  isSkippedExternalDependencyPath,
  normalizeDiagnosticPath,
  resolveWorkspacePath,
} from "./workspaceGuard.js";
import { normalizeWorkspaceRoot } from "./workspaceRoot.js";

const workspaceRoot = normalizeWorkspaceRoot(
  "C:/Users/Example/OneDrive/Desktop/3-Python/Programs/2-Personal/20-Tester",
);

test("allows absolute paths inside the locked workspace", () => {
  const { violations } = findOutsideWorkspacePaths(
    "Please update C:\\Users\\Example\\OneDrive\\Desktop\\3-Python\\Programs\\2-Personal\\20-Tester\\src\\main.py",
    workspaceRoot,
  );

  assert.deepEqual(violations, []);
});

test("blocks absolute paths outside the locked workspace", () => {
  const { violations } = findOutsideWorkspacePaths(
    "Please edit C:\\Users\\Example\\Desktop\\Other\\notes.txt",
    workspaceRoot,
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.normalizedPath, "C:\\Users\\Example\\Desktop\\Other\\notes.txt");
});

test("parses quoted windows paths with spaces", () => {
  const { violations } = findOutsideWorkspacePaths(
    'Use "C:\\Users\\Example\\Desktop\\Other Folder\\notes file.txt" instead',
    workspaceRoot,
  );

  assert.equal(violations.length, 1);
  assert.equal(
    violations[0]?.normalizedPath,
    "C:\\Users\\Example\\Desktop\\Other Folder\\notes file.txt",
  );
});

test("resolves relative paths inside the workspace", () => {
  assert.equal(
    resolveWorkspacePath("src\\main.py", workspaceRoot),
    "C:\\Users\\Example\\OneDrive\\Desktop\\3-Python\\Programs\\2-Personal\\20-Tester\\src\\main.py",
  );
  assert.equal(isPathInsideWorkspace("src\\main.py", workspaceRoot), true);
});

test("blocks explicit relative paths that escape the workspace", () => {
  const { violations } = findOutsideWorkspacePaths("Edit ..\\outside.txt", workspaceRoot);

  assert.equal(violations.length, 1);
  assert.equal(
    violations[0]?.normalizedPath,
    "C:\\Users\\Example\\OneDrive\\Desktop\\3-Python\\Programs\\2-Personal\\outside.txt",
  );
});

test("treats same-path drive letter case differences as inside the workspace", () => {
  assert.equal(
    isPathInsideWorkspace(
      "c:\\users\\Example\\onedrive\\desktop\\3-python\\programs\\2-personal\\20-tester\\src\\main.py",
      workspaceRoot,
    ),
    true,
  );
});

test("allows configured writable roots outside the locked workspace", () => {
  const extraRoot = "C:\\Users\\Example\\Desktop\\Allowed Root";

  assert.equal(
    isPathInsideAllowedRoots(
      "C:\\Users\\Example\\Desktop\\Allowed Root\\notes.txt",
      workspaceRoot,
      [extraRoot],
    ),
    true,
  );

  const promptMessage = getPromptWorkspaceGuardMessage(
    'Edit "C:\\Users\\Example\\Desktop\\Allowed Root\\notes.txt"',
    workspaceRoot,
    [extraRoot],
  );
  assert.equal(promptMessage, null);

  const shellMessage = getShellWorkspaceGuardMessage(
    'type "C:\\Users\\Example\\Desktop\\Allowed Root\\notes.txt"',
    workspaceRoot,
    [extraRoot],
  );
  assert.equal(shellMessage, null);
});

test("still blocks paths outside the workspace and configured writable roots", () => {
  const extraRoot = "C:\\Users\\Example\\Desktop\\Allowed Root";
  const message = getPromptWorkspaceGuardMessage(
    "Edit C:\\Users\\Example\\Desktop\\Other\\notes.txt",
    workspaceRoot,
    [extraRoot],
  );

  assert(message);
  assert.match(message, /Allowed writable roots:/i);
  assert.match(message, /Allowed Root/i);
});

test("returns a prompt guard message before a run starts", () => {
  const message = getPromptWorkspaceGuardMessage(
    "Edit C:\\Users\\Example\\Desktop\\Other\\notes.txt",
    workspaceRoot,
  );

  assert(message);
  assert.match(message, /Run blocked/i);
  assert.match(message, /Locked workspace:/i);
});

test("blocks directory-changing shell commands", () => {
  assert.equal(containsDirectoryNavigationCommand("cd .."), true);
  assert.equal(containsDirectoryNavigationCommand("Set-Location .."), true);
  assert.equal(containsDirectoryNavigationCommand("pushd .."), true);

  const message = getShellWorkspaceGuardMessage("cd ..", workspaceRoot);
  assert(message);
  assert.match(message, /Directory-changing commands/i);
});

test("blocks shell commands that reference outside absolute paths", () => {
  const message = getShellWorkspaceGuardMessage(
    "type C:\\Users\\Example\\Desktop\\Other\\notes.txt",
    workspaceRoot,
  );

  assert(message);
  assert.match(message, /Outside path references:/i);
});

test("blocks shell commands that reference escaping relative paths", () => {
  const message = getShellWorkspaceGuardMessage("type ..\\outside.txt", workspaceRoot);

  assert(message);
  assert.match(message, /Outside path references:/i);
});

test("normalizes diagnostic file paths correctly", () => {
  assert.equal(
    normalizeDiagnosticPath("/home/user/project/src/main.rs:10:5"),
    "/home/user/project/src/main.rs",
  );
  assert.equal(
    normalizeDiagnosticPath("/home/user/project/src/main.rs:10"),
    "/home/user/project/src/main.rs",
  );
  assert.equal(
    normalizeDiagnosticPath("/home/user/project/src/main.rs"),
    "/home/user/project/src/main.rs",
  );
  assert.equal(normalizeDiagnosticPath("src/main.rs:22:9"), "src/main.rs");
  assert.equal(
    normalizeDiagnosticPath("C:\\Users\\me\\project\\src\\main.rs:12:5"),
    "C:\\Users\\me\\project\\src\\main.rs",
  );
});

test("accepts Rust relative diagnostic paths inside the workspace", () => {
  const rustWorkspace = normalizeWorkspaceRoot("/home/user/project");
  const { violations } = findOutsideWorkspacePaths(
    "error[E0308]\n  --> src/main.rs:49:22",
    rustWorkspace,
  );

  assert.equal(normalizeDiagnosticPath("src/main.rs:49:22"), "src/main.rs");
  assert.deepEqual(violations, []);
});

test("accepts Rust absolute diagnostic paths inside the workspace", () => {
  const rustWorkspace = normalizeWorkspaceRoot("/home/user/project");
  const { violations } = findOutsideWorkspacePaths(
    "error[E0308]\n  --> /home/user/project/src/main.rs:49:22",
    rustWorkspace,
  );

  assert.equal(
    normalizeDiagnosticPath("/home/user/project/src/main.rs:49:22"),
    "/home/user/project/src/main.rs",
  );
  assert.deepEqual(violations, []);
});

test("skips Cargo registry diagnostic paths", () => {
  const dependencyPath =
    "/home/user/.cargo/registry/src/index.crates.io-123/iced_widget/src/container.rs:109:12";

  assert.equal(
    normalizeDiagnosticPath(dependencyPath),
    "/home/user/.cargo/registry/src/index.crates.io-123/iced_widget/src/container.rs",
  );
  assert.equal(isSkippedExternalDependencyPath(dependencyPath), true);
  const { violations, skippedExternalPaths } = findOutsideWorkspacePaths(
    dependencyPath,
    "/home/user/project",
  );
  assert.deepEqual(violations, []);
  assert.equal(skippedExternalPaths.length, 1);
});

test("does not trust a similarly named Cargo registry directory", () => {
  const spoofedPath =
    "/home/user/.cargo/registry/src/not-index.crates.io-123/iced_widget/src/container.rs:109:12";

  assert.equal(formatSkippedDependencyPath(spoofedPath), "container.rs:109:12");
});

test("skips Cargo git checkout diagnostic paths", () => {
  const dependencyPath = "/home/user/.cargo/git/checkouts/example-123/src/lib.rs:10:5";

  assert.equal(
    normalizeDiagnosticPath(dependencyPath),
    "/home/user/.cargo/git/checkouts/example-123/src/lib.rs",
  );
  assert.equal(isSkippedExternalDependencyPath(dependencyPath), true);
  const { violations, skippedExternalPaths } = findOutsideWorkspacePaths(
    dependencyPath,
    "/home/user/project",
  );
  assert.deepEqual(violations, []);
  assert.equal(skippedExternalPaths.length, 1);
});

test("skips target generated diagnostic paths by default", () => {
  const generatedPath = "target/debug/build/example/out/generated.rs:10:5";

  assert.equal(isSkippedExternalDependencyPath(generatedPath), true);
  const { violations, skippedExternalPaths } = findOutsideWorkspacePaths(
    generatedPath,
    "/home/user/project",
  );
  assert.deepEqual(violations, []);
  assert.equal(skippedExternalPaths.length, 1);
});

test("skips common package manager and cache paths", () => {
  for (const externalPath of [
    "/home/user/project/node_modules/pkg/index.js:1:1",
    "/home/user/.pnpm-store/v3/files/pkg/index.js:1:1",
    "/home/user/.npm/_cacache/tmp/file.js:1:1",
    "/home/user/.cache/tool/generated.rs:1:1",
  ]) {
    assert.equal(isSkippedExternalDependencyPath(externalPath), true);
    const { violations, skippedExternalPaths } = findOutsideWorkspacePaths(
      externalPath,
      "/home/user/project",
    );
    assert.deepEqual(violations, []);
    assert.equal(skippedExternalPaths.length, 1);
  }
});

test("skips dependency paths while preserving project-local Rust diagnostics", () => {
  const rustWorkspace = normalizeWorkspaceRoot("/home/user/project");
  const diagnostic = [
    "/home/user/.cargo/registry/src/index.crates.io-123/iced_widget/src/container.rs:109:12",
    "  --> src/main.rs:49:22",
  ].join("\n");

  const { violations, skippedExternalPaths } = findOutsideWorkspacePaths(diagnostic, rustWorkspace);
  assert.deepEqual(violations, []);
  assert.equal(skippedExternalPaths.length, 1);
  assert.deepEqual(extractExplicitPathReferences(diagnostic), [
    "/home/user/.cargo/registry/src/index.crates.io-123/iced_widget/src/container.rs:109:12",
    "src/main.rs:49:22",
  ]);
});

test("formats skipped dependency paths cleanly", () => {
  assert.equal(
    formatSkippedDependencyPath(
      "/home/user/.cargo/registry/src/index.crates.io-123/iced_widget/src/container.rs",
    ),
    "iced_widget/src/container.rs",
  );
  assert.equal(
    formatSkippedDependencyPath("/home/user/.cargo/git/checkouts/example-123/src/lib.rs"),
    "example-123/src/lib.rs",
  );
  assert.equal(
    formatSkippedDependencyPath("/home/user/project/node_modules/pkg/index.js"),
    "index.js",
  );
});

test("isDangerousShellCommand flags destructive commands only", () => {
  for (const command of [
    "rm -rf build",
    "sudo apt install x",
    "dd if=a of=/dev/sda",
    "mkfs.ext4 /dev/sdb",
  ]) {
    assert.equal(isDangerousShellCommand(command), true, command);
  }
  for (const command of ["ls -la", "rm notes.txt", "git status", "chmod 644 file"]) {
    assert.equal(isDangerousShellCommand(command), false, command);
  }
});

// --- Prompt-text classification ---------------------------------------------

const linuxWorkspace = normalizeWorkspaceRoot("/home/user/insta_bot");

// Mirrors the Mistral Vibe plan that was rejected on approval: a historical Windows venv path
// in an explanation and a Graph API route template in documentation.
const instagramPlan = [
  "## Files",
  "- `bot.py` - main entry point",
  "- `requirements.txt`",
  "- `README.md` - setup docs",
  "",
  "## Steps",
  "1. Create a fresh virtual environment in `./venv` (`python3 -m venv venv`).",
  "2. Implement `fetch_media()` in `bot.py` calling `GET /{ig-user-id}/media?fields=id,media_type,timestamp`.",
  "3. Document the setup in `README.md`.",
  "",
  "## Assumptions",
  "- The existing `venv/` was created on Windows with the MSYS2 interpreter at C:\\msys2.org\\mingw64\\bin, so it cannot be reused on Linux.",
  "",
  "## Risks",
  "- Graph API rate limits.",
].join("\n");

test("reported Instagram plan passes the prompt guard on a Linux workspace", () => {
  assert.equal(getPromptWorkspaceGuardMessage(instagramPlan, linuxWorkspace), null);
  const { violations } = findOutsideWorkspacePaths(instagramPlan, linuxWorkspace, [], {
    context: "prompt",
  });
  assert.deepEqual(violations, []);
});

test("historical Windows environment paths in explanations are permitted", () => {
  assert.equal(getPromptWorkspaceGuardMessage(instagramPlan, workspaceRoot), null);
  assert.equal(
    getPromptWorkspaceGuardMessage(
      "The old venv was built against C:\\Python39\\Scripts\\python.exe; recreate it in ./venv.",
      workspaceRoot,
    ),
    null,
  );
});

test("HTTP endpoint templates are permitted in prompts", () => {
  for (const prompt of [
    "Call /{ig-user-id}/media?fields=id,media_type,timestamp to list posts.",
    "Add a handler for /users/:id/posts in api.py.",
    "The client hits /v1/accounts?limit=10 for paging.",
    "Document the GET /me/accounts endpoint in README.md.",
  ]) {
    assert.equal(getPromptWorkspaceGuardMessage(prompt, linuxWorkspace), null, prompt);
    assert.equal(getPromptWorkspaceGuardMessage(prompt, workspaceRoot), null, prompt);
  }
});

test("shell brace expansion is not mistaken for a route template", () => {
  assert(getPromptWorkspaceGuardMessage("Show /etc/{passwd,shadow}", linuxWorkspace));
});

test("absolute Windows and Linux paths inside the workspace are permitted", () => {
  assert.equal(
    getPromptWorkspaceGuardMessage("Edit /home/user/insta_bot/bot.py", linuxWorkspace),
    null,
  );
  assert.equal(
    getPromptWorkspaceGuardMessage(
      "Edit C:\\Users\\Example\\OneDrive\\Desktop\\3-Python\\Programs\\2-Personal\\20-Tester\\bot.py",
      workspaceRoot,
    ),
    null,
  );
});

test("explicit external file operations remain blocked in prompts", () => {
  for (const prompt of [
    "Create /etc/ubume.conf with the token.",
    "Read /home/other/secrets.txt and summarize it.",
    "Run `cp config.json /etc/insta_bot/config.json` after setup.",
    "DELETE /etc/passwd",
    "Previously we stored tokens elsewhere; now write them to /home/other/tokens.txt.",
    "/home/other/notes.txt",
  ]) {
    assert(getPromptWorkspaceGuardMessage(prompt, linuxWorkspace), prompt);
  }
  for (const prompt of [
    "Write C:\\Users\\Example\\Desktop\\Other\\x.txt",
    "Update /etc/hosts with the new host.",
  ]) {
    assert(getPromptWorkspaceGuardMessage(prompt, workspaceRoot), prompt);
  }
});

test("a path mentioned incidentally and targeted elsewhere is still blocked", () => {
  const prompt =
    "The old config was kept in /home/other/app.toml.\nCopy settings into /home/other/app.toml too.";
  const message = getPromptWorkspaceGuardMessage(prompt, linuxWorkspace);
  assert(message);
  assert.match(message, /\/home\/other\/app\.toml/);
});

test("parent-directory traversal stays blocked even in explanatory prompts", () => {
  assert(getPromptWorkspaceGuardMessage("The legacy file was ../outside.txt", linuxWorkspace));
  assert(getPromptWorkspaceGuardMessage("The legacy file was ..\\outside.txt", workspaceRoot));
});

test("shell commands keep strict path checking", () => {
  for (const command of [
    "cat /{ig-user-id}/media",
    "echo was legacy /home/other/notes.txt",
    "ls C:\\msys2.org\\mingw64\\bin",
  ]) {
    assert(getShellWorkspaceGuardMessage(command, linuxWorkspace), command);
  }
  assert.match(getShellWorkspaceGuardMessage("cd ..", linuxWorkspace) ?? "", /Directory-changing/);
  const { violations } = findOutsideWorkspacePaths(instagramPlan, linuxWorkspace);
  assert.equal(violations.length, 2);
});
