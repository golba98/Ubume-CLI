import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { APP_VERSION as BUILD_INFO_VERSION } from "../../config/buildInfo.js";
import { getAppVersion, resolveAppVersion } from "./channel.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ubume-app-version-"));
}

function writePackageJson(dir: string, contents: string): void {
  writeFileSync(join(dir, "package.json"), contents, "utf8");
}

test("resolveAppVersion prefers UBUME_PACKAGE_ROOT package.json version", () => {
  const dir = makeTempDir();
  try {
    writePackageJson(dir, JSON.stringify({ name: "ubume", version: "9.9.9" }));
    const version = resolveAppVersion({ UBUME_PACKAGE_ROOT: dir }, dir);
    assert.equal(version, "9.9.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion ignores the removed CODEXA_PACKAGE_ROOT variable", () => {
  const legacyRoot = makeTempDir();
  const dir = makeTempDir();
  try {
    writePackageJson(legacyRoot, JSON.stringify({ name: "ubume", version: "9.9.9" }));
    writePackageJson(dir, JSON.stringify({ name: "ubume", version: "1.2.3" }));
    assert.equal(resolveAppVersion({ CODEXA_PACKAGE_ROOT: legacyRoot }, dir), "1.2.3");
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion does not accept the pre-rename @golba98/codexa package name", () => {
  const dir = makeTempDir();
  try {
    writePackageJson(dir, JSON.stringify({ name: "@golba98/codexa", version: "7.7.7" }));
    assert.notEqual(resolveAppVersion({}, dir), "7.7.7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion returns the version from a newly installed package", () => {
  const dir = makeTempDir();
  try {
    writePackageJson(dir, JSON.stringify({ name: "ubume", version: "0.1.0" }));
    assert.equal(resolveAppVersion({ UBUME_PACKAGE_ROOT: dir }, dir), "0.1.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion falls back to buildInfo when UBUME_PACKAGE_ROOT package.json is corrupt", () => {
  const dir = makeTempDir();
  try {
    writePackageJson(dir, "{ not valid json");
    const version = resolveAppVersion({ UBUME_PACKAGE_ROOT: dir }, dir);
    assert.equal(version, BUILD_INFO_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion falls back to buildInfo when UBUME_PACKAGE_ROOT package.json is missing", () => {
  const dir = makeTempDir();
  try {
    const version = resolveAppVersion({ UBUME_PACKAGE_ROOT: dir }, dir);
    assert.equal(version, BUILD_INFO_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion rejects invalid semver from UBUME_PACKAGE_ROOT", () => {
  const dir = makeTempDir();
  try {
    writePackageJson(dir, JSON.stringify({ name: "ubume", version: "not-a-version" }));
    const version = resolveAppVersion({ UBUME_PACKAGE_ROOT: dir }, dir);
    assert.equal(version, BUILD_INFO_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion walks up to a package.json named ubume", () => {
  const dir = makeTempDir();
  try {
    writePackageJson(dir, JSON.stringify({ name: "ubume", version: "8.7.6" }));
    const nested = join(dir, "src", "config");
    mkdirSync(nested, { recursive: true });
    const version = resolveAppVersion({}, nested);
    assert.equal(version, "8.7.6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppVersion ignores walk-up package.json with a different name", () => {
  const dir = makeTempDir();
  try {
    writePackageJson(dir, JSON.stringify({ name: "some-other-package", version: "8.7.6" }));
    const nested = join(dir, "src", "config");
    mkdirSync(nested, { recursive: true });
    const version = resolveAppVersion({}, nested);
    assert.equal(version, BUILD_INFO_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getAppVersion returns a valid semver string", () => {
  const version = getAppVersion();
  assert.match(version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
});

test("drift guard: buildInfo APP_VERSION matches repo package.json version", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  assert.equal(BUILD_INFO_VERSION, pkg.version);
});
