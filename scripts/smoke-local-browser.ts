/**
 * Interactive smoke for the structured browser backend against a loopback
 * fixture page (requires installed Chromium; screenshots land in a temporary
 * directory that is printed). Localhost only: no model, no external site.
 * Run: UBUME_BROWSER_MODE=headless bun scripts/smoke-local-browser.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager } from "../src/core/computerUse/browser.js";
import { resolveBrowserCapability } from "../src/core/computerUse/capability.js";
import type { ComputerUseValue } from "../src/core/computerUse/types.js";
import type { BrowserToolName } from "../bin/ubume-local-browser-tools.js";
import { fixtureServer } from "../src/test/fixtures/browserPage.js";

const capability = resolveBrowserCapability();
assert.equal(capability.status, "available", capability.reason);
const site = await fixtureServer();
const home = mkdtempSync(join(tmpdir(), "ubume-browser-smoke-"));
const manager = new BrowserManager(capability);
let id = 0;
async function run(tool: BrowserToolName, args: Record<string, unknown> = {}): Promise<ComputerUseValue> {
  const result = await manager.execute({ sessionId: "smoke", callId: String(++id), tool, arguments: args }, { dshHome: home, networkAccess: false, signal: new AbortController().signal });
  if (!result.ok) throw new Error(result.error.message);
  console.log(`${tool}: ${result.value.summary}`);
  return result.value;
}
try {
  await run("browser_open", { url: site.url });
  const page = await run("browser_inspect");
  const ref = (name: string) => {
    const element = page.elements?.find((item) => item.name === name)?.element;
    assert(element);
    return element;
  };
  await run("browser_click", { element: ref("Click me") });
  await run("browser_type", { element: ref("Email"), text: "browser-smoke" });
  await run("browser_press", { key: "Enter" });
  assert.match((await run("browser_inspect")).visibleText!, /Submitted browser-smoke/);
  await run("browser_type", { element: ref("Password"), text: "smoke-secret" });
  const shot = await run("browser_screenshot");
  console.log(`Screenshot artifact: ${shot.artifactPath}`);
  await run("browser_close");
} finally { await manager.shutdown(); await site.close(); }
