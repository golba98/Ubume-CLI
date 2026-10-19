# Release guide

This guide documents how to publish the npm package `ubume` to the
public npm registry.

## Choose the package directory

`npm publish` must target the repository root, where `package.json` lives.
If your terminal is in `src/config`, run:

```bash
cd ../..
npm publish --dry-run --access public
npm publish --access public
```

You can also stay in `src/config` and target the root explicitly:

```bash
npm publish ../.. --access public
```

An `ENOENT` error mentioning `src/config/package.json` means npm was run
from the source directory without a package path. Use the commands above;
the source directory does not need its own `package.json`.

## Prepare an unpublished version

Run these commands from the repository root. NPM versions are immutable, so
never reuse a version that has already been published.

```bash
read -r -p "Unpublished release version: " release_version
npm version "$release_version" --no-git-tag-version --ignore-scripts
npm run gen-build-info
npm pkg get name version
```

Continue only after the printed version matches `$release_version`. Update
`CHANGELOG.md` and `VERSIONS.md` with the release date, user-visible changes,
fixes, and verification results before publishing. Keep `package.json`,
`package-lock.json`, and generated `src/config/buildInfo.ts` in sync.

## Validate the release

```bash
npm whoami --registry=https://registry.npmjs.org
npm view ubume version --registry=https://registry.npmjs.org
bun install
npm run prepublishOnly
npm run audit:ubume-gap
npm run smoke:terminal-bench
npm audit --audit-level=low
git diff --check
npm pack --dry-run --json
```

Inspect the dry-run output to confirm that only the intended package files are
included.

## Pre-release checks

Run `bun install` after dependency changes, then `npm run prepublishOnly`. The hook synchronizes package-lock.json and npm-shrinkwrap.json from the tested Bun lock before checking types and running all tests. Keep required Harness peer providers explicit in package.json; npm installs use legacy peer mode because automatic resolution repeatedly expands the plugin peer graph.

Pack with `npm pack --ignore-scripts --pack-destination /tmp`. Install that tarball in an isolated prefix using `npm install --global --prefix <temporary-directory> <tarball> --legacy-peer-deps`. Verify the installed version, `doctor --json`, and headless execution with a fixture provider. Run `bun scripts/smoke-packaged-harness.ts <temporary-directory>/lib/node_modules/ubume`; a failed inference must block publication even when checkout tests pass. The smoke script uses a local mock endpoint and makes no paid model calls.

Run the capability audit and terminal smoke script, and include a terminal recording for visible changes. Check the packed files and integrity, update CHANGELOG.md and VERSIONS.md, and push every release commit before merging the PR. Publish only the verified tarball. Confirm both full and abbreviated npm registry metadata list the version with matching integrity before reporting it available.

## Authenticate and publish to npm

Authenticate to npmjs.com if needed:

```bash
npm login --registry=https://registry.npmjs.org
```

The package `publishConfig` selects the public npm registry:

```bash
npm publish --access public
```

The `prepublishOnly` lifecycle script automatically regenerates build metadata,
runs the TypeScript typecheck, and runs the full Bun test suite.

## Verify the published package

```bash
npm view "ubume@$release_version" version --registry=https://registry.npmjs.org
npm install -g "ubume@$release_version" --registry=https://registry.npmjs.org --prefer-online
ubume --version
```

After npm's `latest` tag has propagated, verify the tagged package:

```bash
npm view ubume dist-tags --json --registry=https://registry.npmjs.org --prefer-online
npm install -g ubume@latest --registry=https://registry.npmjs.org --prefer-online
ubume --version
```

Wait for npm processing to finish and verify that the published version is
listed and `latest` points to it. A successful upload can precede registry
availability.

## Commit and tag the release

```bash
git add package.json package-lock.json bun.lock src/config/buildInfo.ts CHANGELOG.md VERSIONS.md
git commit -m "release: prepare Ubume v$release_version"
git tag -a "v$release_version" -m "Ubume v$release_version"
git push -u origin HEAD --follow-tags
```

Ensure the release commit is included in the merged PR; merge alone does not
include commits pushed to a branch after its PR was already merged.
