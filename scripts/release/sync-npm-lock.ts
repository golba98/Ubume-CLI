/**
 * Regenerates `package-lock.json` and `npm-shrinkwrap.json` from `bun.lock`.
 *
 * Why this exists: `npm-shrinkwrap.json` is what consumers install with, but
 * the dependency graph the package is actually exercised under comes from Bun.
 * npm's peer resolver would otherwise expand the Harness's cyclic plugin peers
 * differently than Bun did, so the lock is derived from the Bun graph and the
 * production dependency set is recomputed here.
 *
 * Run via `npm run sync:npm-lock` (also part of `prepublishOnly`). Reads and writes files in the
 * repository root regardless of the caller's directory; changes are meant to be committed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const bunLock = Bun.JSONC.parse(readFileSync(join(REPO_ROOT, "bun.lock"), "utf8")) as {
  packages: Record<string, LockEntry>;
};
type LockEntry = [spec: string, integrity: string, metadata: Record<string, unknown>, checksum: string];
const entries = bunLock.packages as Record<string, LockEntry>;

/** Splits a lock key ("pkg", "@scope/pkg", "parent/node_modules/pkg") into package names. */
function packageParts(key: string): string[] {
  const parts = key.split("/");
  const names: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    names.push(parts[index]!.startsWith("@") ? `${parts[index]}/${parts[++index]}` : parts[index]!);
  }
  return names;
}

/**
 * Resolves `name` as a dependency of `owner`: walks up the owner's
 * node_modules chain in the lock, then falls back to the top level. Returns the
 * lock key that provides it, or undefined when the lock has no such entry.
 */
function resolveDependency(owner: string, name: string): string | undefined {
  const parents = packageParts(owner);
  while (parents.length) {
    const key = [...parents, name].join("/");
    if (entries[key]) return key;
    parents.pop();
  }
  return entries[name] ? name : undefined;
}

/**
 * Walks the manifest's direct dependencies transitively and collects every lock
 * entry they (and their dependencies/optional/peer dependencies) resolve to.
 */
function collectProductionKeys(): Set<string> {
  const production = new Set<string>();
  const queue = Object.keys(manifest.dependencies);
  while (queue.length) {
    const key = queue.pop()!;
    if (production.has(key)) continue;
    const entry = entries[key];
    if (!entry) throw new Error(`Missing locked dependency: ${key}`);
    production.add(key);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys((entry[2][field] as object | undefined) ?? {})) {
        const resolved = resolveDependency(key, name);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return production;
}

/** Builds the npm `packages` map from the Bun lock entries. */
function buildPackagesMap(production: Set<string>): Record<string, unknown> {
  const packages: Record<string, unknown> = {
    "": {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
      bin: manifest.bin,
    },
  };

  for (const [key, [spec, , metadata, integrity]] of Object.entries(entries)) {
    const split = spec.lastIndexOf("@");
    const name = spec.slice(0, split);
    const version = spec.slice(split + 1);
    if (!integrity?.startsWith("sha")) throw new Error(`Unsupported lock entry: ${key}`);

    const { optionalPeers, ...rest } = metadata;
    packages[`node_modules/${packageParts(key).join("/node_modules/")}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
      integrity,
      ...rest,
      ...(metadata.os || metadata.cpu) ? { optional: true } : {},
      ...production.has(key) ? {} : { dev: true },
      ...Array.isArray(optionalPeers)
        ? { peerDependenciesMeta: Object.fromEntries(optionalPeers.map((peer: string) => [peer, { optional: true }])) }
        : {},
    };
  }

  return packages;
}

const productionKeys = collectProductionKeys();
const packages = buildPackagesMap(productionKeys);
const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };

for (const file of ["package-lock.json", "npm-shrinkwrap.json"]) {
  writeFileSync(join(REPO_ROOT, file), `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(`Synced ${Object.keys(entries).length} packages (${productionKeys.size} runtime dependencies)`);
