import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withEnvironment } from "../test/environment.js";
import { loadSettings } from "./persistence.js";
import { isProjectTrusted } from "./trustStore.js";

test("imports legacy settings and trust once while retaining originals and current state", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-settings-import-"));
  try {
    await withEnvironment({ HOME: root, USERPROFILE: root, CODEX_HOME: root }, () => {
      const legacy = join(root, ".codexa-settings.json");
      const current = join(root, ".ubume-settings.json");
      const original = JSON.stringify({ ui: { theme: "purple" }, unknown: "retained" });
      writeFileSync(legacy, original);
      assert.equal(loadSettings().ui.theme, "purple");
      assert.equal(readFileSync(legacy, "utf8"), original);
      assert.equal(JSON.parse(readFileSync(current, "utf8")).unknown, "retained");
      writeFileSync(current, JSON.stringify({ ui: { theme: "green" } }));
      assert.equal(loadSettings().ui.theme, "green");
      writeFileSync(
        join(root, "codexa-trust.json"),
        JSON.stringify({ trustedProjectRoots: ["/legacy"] }),
      );
      assert.equal(isProjectTrusted("/legacy"), true);
      writeFileSync(
        join(root, "ubume-trust.json"),
        JSON.stringify({ trustedProjectRoots: ["/current"] }),
      );
      assert.equal(isProjectTrusted("/legacy"), false);
      assert.equal(isProjectTrusted("/current"), true);
      assert.ok(existsSync(join(root, "codexa-trust.json")));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed legacy JSON never creates a settings destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "ubume-malformed-import-"));
  try {
    await withEnvironment({ HOME: root, USERPROFILE: root, CODEX_HOME: root }, () => {
      const legacy = join(root, ".codexa-settings.json");
      writeFileSync(legacy, "not json");
      loadSettings();
      assert.equal(existsSync(join(root, ".ubume-settings.json")), false);
      assert.equal(readFileSync(legacy, "utf8"), "not json");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
