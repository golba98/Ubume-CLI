#!/usr/bin/env node
/**
 * Compatibility entry point. Installed `ubume-dev` / `ubd` shims (from before scripts were grouped
 * by responsibility) exec this exact path, so it must keep working. All logic lives in
 * `development/run-local-dev.mjs`; reinstall the shims with `bun run install:dev-bin` to point
 * them there directly.
 */
import { main } from "./development/run-local-dev.mjs";

main();
