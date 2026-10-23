import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error JavaScript utility module exports are exercised directly.
import { REPO_ROOT, repoPath } from "./repo-root.mjs";

test("REPO_ROOT is the checkout holding the ubume package.json, whatever the caller's cwd", () => {
  assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name, "ubume");
  assert.equal(repoPath("bin", "ubume.js"), join(REPO_ROOT, "bin", "ubume.js"));
  assert.ok(existsSync(repoPath("scripts", "lib", "repo-root.mjs")));
});
