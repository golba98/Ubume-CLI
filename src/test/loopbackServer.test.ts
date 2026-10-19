import assert from "node:assert/strict";
import test from "node:test";
import { sendJson, startLoopbackServer } from "./loopbackServer.js";

test("loopback server binds 127.0.0.1 and closes stalled connections", async () => {
  const server = await startLoopbackServer((request, response) => {
    if (request.url === "/stall") return;
    sendJson(response, 201, { ok: true }, { "x-fixture": "1" });
  });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${server.url}/json`);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-fixture"), "1");
    assert.deepEqual(await response.json(), { ok: true });
    const stalled = fetch(`${server.url}/stall`).catch(() => "closed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.close();
    assert.equal(await stalled, "closed");
  } finally {
    await server.close().catch(() => undefined);
  }
});
