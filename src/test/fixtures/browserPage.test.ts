import { describe, expect, spyOn, test } from "bun:test";
import { Server } from "node:http";
import { fixtureHtml, fixtureServer } from "./browserPage.js";

describe("browser fixture server", () => {
  test("rejects asynchronous listener errors instead of leaving startup pending", async () => {
    const failure = new Error("fixture listener unavailable");
    const listen = spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
      queueMicrotask(() => this.emit("error", failure));
      return this;
    });
    try {
      await expect(fixtureServer()).rejects.toBe(failure);
    } finally {
      listen.mockRestore();
    }
  });

  test("serves fixture pages and exposes redirects without following external hosts", async () => {
    const server = await fixtureServer();
    try {
      const home = await fetch(server.url);
      expect(home.headers.get("content-type")).toBe("text/html");
      expect(await home.text()).toBe(fixtureHtml);
      const second = await fetch(`${server.url}/second`);
      expect(await second.text()).toContain("<title>Second</title>");
      for (const [path, location] of [
        ["/redirect", "/"],
        ["/external", "https://example.invalid/"],
      ]) {
        const redirect = await fetch(`${server.url}${path}`, { redirect: "manual" });
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("location")).toBe(location);
        await redirect.text();
      }
    } finally {
      await server.close();
    }
  });

  test("owns independent loopback ports and awaits repeated concurrent cleanup", async () => {
    const first = await fixtureServer();
    let second: Awaited<ReturnType<typeof fixtureServer>> | undefined;
    try {
      second = await fixtureServer();
      expect(new URL(first.url).hostname).toBe("127.0.0.1");
      expect(first.url).not.toBe(second.url);
      const closing = first.close();
      expect(first.close()).toBe(closing);
      await closing;
      await first.close();
      await expect(fetch(first.url)).rejects.toThrow();
      expect((await fetch(second.url)).status).toBe(200);
    } finally {
      await first.close();
      await second?.close();
    }
  });
});
