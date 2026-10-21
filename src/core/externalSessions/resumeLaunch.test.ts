import assert from "node:assert/strict";
import test from "node:test";
import { buildExternalResumeLaunch } from "./index.js";
import type { ExternalSessionSummary } from "./types.js";

const summary = (
  source: ExternalSessionSummary["source"],
  cwd: string | null,
): ExternalSessionSummary => ({
  source,
  id: "abc-123",
  title: "Title",
  cwd,
  updatedAt: "2026-09-30T10:00:00.000Z",
});
const options = {
  fallbackCwd: "/current",
  resolveExecutable: async (source: string) => `/bin/${source}-cli`,
  folderExists: (path: string) => path !== "/gone",
};

test("buildExternalResumeLaunch resumes each CLI by session id in the session's folder", async () => {
  assert.deepEqual(await buildExternalResumeLaunch(summary("claude", "/work"), options), {
    ok: true,
    launch: {
      displayName: "Claude Code",
      executable: "/bin/claude-cli",
      args: ["--resume", "abc-123"],
      cwd: "/work",
    },
  });
  assert.deepEqual(await buildExternalResumeLaunch(summary("codex", "/work"), options), {
    ok: true,
    launch: {
      displayName: "Codex",
      executable: "/bin/codex-cli",
      args: ["resume", "abc-123"],
      cwd: "/work",
    },
  });
  assert.deepEqual(await buildExternalResumeLaunch(summary("vibe", "/work"), options), {
    ok: true,
    launch: {
      displayName: "Mistral Vibe",
      executable: "/bin/vibe-cli",
      args: ["--resume", "abc-123"],
      cwd: "/work",
    },
  });
  assert.deepEqual(await buildExternalResumeLaunch(summary("google", "/work"), options), {
    ok: true,
    launch: {
      displayName: "Google",
      executable: "/bin/google-cli",
      args: ["--conversation", "abc-123"],
      cwd: "/work",
    },
  });
  assert.deepEqual(await buildExternalResumeLaunch(summary("antigravity", "/work"), options), {
    ok: true,
    launch: {
      displayName: "Google",
      executable: "/bin/antigravity-cli",
      args: ["--conversation", "abc-123"],
      cwd: "/work",
    },
  });
});

test("buildExternalResumeLaunch refuses when the session folder is gone or unknown for every CLI", async () => {
  const gone = await buildExternalResumeLaunch(summary("codex", "/gone"), options);
  assert.equal(gone.ok, false);
  assert.match(gone.ok ? "" : gone.message, /no longer exists: \/gone/);
  for (const source of ["claude", "codex", "vibe", "google", "antigravity"] as const) {
    const unknown = await buildExternalResumeLaunch(summary(source, null), options);
    assert.equal(unknown.ok, false);
    assert.match(unknown.ok ? "" : unknown.message, /original folder/);
  }
});

test("native resume refuses option-like and control-character identifiers before executable resolution", async () => {
  for (const id of ["--dangerously-skip-permissions", "bad\nidentity", "bad identity"]) {
    const result = await buildExternalResumeLaunch(
      {
        source: "claude",
        id,
        title: "invalid",
        cwd: "/fixture",
        updatedAt: "2026-10-21T00:00:00Z",
      },
      {
        fallbackCwd: "/fixture",
        folderExists: () => true,
        resolveExecutable: async () => {
          throw new Error("must not resolve invalid native IDs");
        },
      },
    );
    assert.equal(result.ok, false);
  }
});

test("native resume never guesses the base of a relative saved working directory", async () => {
  assert.equal(
    (await buildExternalResumeLaunch(summary("codex", "relative/project"), options)).ok,
    false,
  );
});
