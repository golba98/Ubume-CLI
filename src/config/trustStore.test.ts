import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("persists trusted project roots", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-trust-store-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    const module = await import(`./trustStore.js?trust=${Date.now()}`);
    const projectRoot = "C:/Workspace/Repo";

    assert.equal(module.isProjectTrusted(projectRoot), false);
    module.setProjectTrust(projectRoot, true);
    assert.equal(module.isProjectTrusted(projectRoot), true);
    module.setProjectTrust(projectRoot, false);
    assert.equal(module.isProjectTrusted(projectRoot), false);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("migrates legacy codexa-trust.json to ubume-trust.json non-destructively", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-trust-migration-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    const legacyTrustFile = join(tempHome, "codexa-trust.json");
    writeFileSync(
      legacyTrustFile,
      JSON.stringify({ trustedProjectRoots: ["/migrated/project"] }),
      "utf-8",
    );

    const module = await import(`./trustStore.js?trustMigrate=${Date.now()}`);
    assert.equal(module.isProjectTrusted("/migrated/project"), true);

    const ubumeTrustFile = join(tempHome, "ubume-trust.json");
    assert.ok(existsSync(ubumeTrustFile), "ubume-trust.json should be created");
    assert.ok(existsSync(legacyTrustFile), "codexa-trust.json should remain intact");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("recovers gracefully from corrupt JSON in trust store", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-trust-corrupt-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    const ubumeTrustFile = join(tempHome, "ubume-trust.json");
    writeFileSync(ubumeTrustFile, "NOT_VALID_JSON{{{", "utf-8");

    const module = await import(`./trustStore.js?trustCorrupt=${Date.now()}`);
    assert.equal(module.isProjectTrusted("/any/project"), false);

    // Can still set trust without throwing
    module.setProjectTrust("/any/project", true);
    assert.equal(module.isProjectTrusted("/any/project"), true);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("deduplicates and normalizes project roots in trust store", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-trust-dedupe-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    const module = await import(`./trustStore.js?trustDedupe=${Date.now()}`);
    module.setProjectTrust("/path/to/project/", true);
    module.setProjectTrust("/path/to/project", true);

    const ubumeTrustFile = join(tempHome, "ubume-trust.json");
    const data = JSON.parse(readFileSync(ubumeTrustFile, "utf-8"));
    assert.equal(data.trustedProjectRoots.length, 1);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("empty and whitespace paths are never considered trusted", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "ubume-trust-empty-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;

  try {
    const module = await import(`./trustStore.js?trustEmpty=${Date.now()}`);
    // Even if current working directory is explicitly trusted:
    module.setProjectTrust(process.cwd(), true);
    assert.equal(module.isProjectTrusted(process.cwd()), true);

    // Empty or whitespace paths must never be trusted
    assert.equal(module.isProjectTrusted(""), false);
    assert.equal(module.isProjectTrusted("   "), false);

    // Setting trust on empty path is a no-op
    module.setProjectTrust("", true);
    module.setProjectTrust("  ", true);

    const ubumeTrustFile = join(tempHome, "ubume-trust.json");
    const data = JSON.parse(readFileSync(ubumeTrustFile, "utf-8"));
    assert.equal(data.trustedProjectRoots.length, 1);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});
