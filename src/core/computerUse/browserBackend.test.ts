import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { BrowserManager } from "../../../bin/ubume-browser-backend.js";

// Chromium-free coverage of the worker backend's launch sequence. The real-browser tests in
// browser.test.ts skip wherever Chromium is unavailable, which is how an unawaited launch slipped
// through once: the backend must not connect before the launched server exists.
test("browser_open connects only after the asynchronous server launch resolves", async () => {
  const calls: string[] = [];
  const page = {
    on: () => page,
    isClosed: () => false,
    url: () => "about:blank",
    evaluate: async () => {
      throw new Error("fake page has no DOM");
    },
  };
  const context = {
    on: () => context,
    route: async () => {},
    routeWebSocket: async () => {},
    newPage: async () => page,
    pages: () => [page],
    close: async () => {},
  };
  const server = {
    process: () => ({ pid: 2_147_483_000 }),
    on: () => server,
    wsEndpoint: () => "ws://127.0.0.1:9/fake-browser-server",
    close: async () => {
      calls.push("server:close");
    },
    kill: async () => {},
  };
  const browser = {
    on: () => browser,
    isConnected: () => true,
    newContext: async () => context,
    close: async () => {},
  };
  const original = { launchServer: chromium.launchServer, connect: chromium.connect };
  Object.assign(chromium, {
    launchServer: async () => {
      calls.push("launch:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      calls.push("launch:resolved");
      return server;
    },
    connect: async (endpoint: string) => {
      calls.push(`connect:${endpoint}`);
      return browser;
    },
  });
  const home = mkdtempSync(join(tmpdir(), "ubume-browser-backend-test-"));
  const manager = new BrowserManager({
    kind: "browser",
    status: "available",
    reason: "",
    mode: "headless",
    headedSupported: false,
  });
  try {
    await manager.execute(
      { sessionId: "launch-order", callId: "1", tool: "browser_open", arguments: {} },
      { dshHome: home, networkAccess: false, signal: new AbortController().signal },
    );
    assert.deepEqual(calls.slice(0, 3), [
      "launch:start",
      "launch:resolved",
      "connect:ws://127.0.0.1:9/fake-browser-server",
    ]);
  } finally {
    await manager.shutdown();
    Object.assign(chromium, original);
    rmSync(home, { recursive: true, force: true });
  }
});
