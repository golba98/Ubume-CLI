/**
 * Loopback-only HTTP proxy that sits between Chromium and the network.
 *
 * Why a proxy at all: Chromium routes *every* HTTP(S)/WebSocket request through
 * this server, including requests reached by redirects. Playwright's page
 * routing alone skips some redirect hops, which would leave holes in the
 * network policy.
 *
 * Security invariants (do not weaken):
 *   - The proxy listens on 127.0.0.1 only and Chromium's proxy bypass list is
 *     `<-loopback>`, so loopback sites stay direct and everything else must
 *     come through here.
 *   - Every forwarded URL is checked with the caller-supplied `allowed`
 *     predicate (network access OR loopback). Denials are 403 for both plain
 *     requests and CONNECT/upgrade tunnels.
 *   - Proxy-authorization/proxy-connection headers are stripped; tunnel
 *     requests with embedded credentials are refused.
 *   - Every socket is tracked and destroyed on close so `close()` cannot leak
 *     an open connection.
 */

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const UPSTREAM_TIMEOUT_MS = 30_000;

/** Strips hop-by-hop proxy headers before forwarding an upstream request. */
function sanitizedRequestHeaders(request) {
  const headers = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  return headers;
}

/**
 * Handles one plain HTTP request: admit it, forward it upstream with the
 * sanitized headers, and destroy the upstream socket as soon as either side
 * closes so nothing lingers behind the 30 s timeout.
 */
function handleHttpRequest(request, response, allowed) {
  let url;
  try { url = new URL(request.url); } catch { response.writeHead(400); response.end(); return; }
  if (url.protocol !== "http:" || !allowed(url.href)) {
    response.writeHead(403);
    response.end("Browser network access denied.");
    return;
  }
  const headers = sanitizedRequestHeaders(request);
  const upstream = httpRequest(url, { method: request.method, headers, agent: false }, (result) => {
    response.writeHead(result.statusCode ?? 502, result.headers);
    result.pipe(response);
  });
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy());
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("Local browser server unavailable.");
  });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
}

/**
 * Handles one tunnel: an HTTPS CONNECT or a WebSocket upgrade. Admits only
 * URLs the policy allows and without embedded credentials; otherwise the
 * client socket is answered with 403 and closed. On success the sockets are
 * piped together until either side errors or closes.
 */
function handleTunnel(request, client, head, websocket, allowed, sockets) {
  let url;
  try { url = new URL(websocket ? request.url : `http://${request.url}`); } catch { client.destroy(); return; }
  if (!allowed(url.href) || url.username || url.password) {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = connect(
    Number(url.port || (websocket ? 80 : 443)),
    url.hostname.replace(/^\[|\]$/g, ""),
  );
  sockets.add(upstream);
  upstream.on("close", () => sockets.delete(upstream));
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.once("connect", () => {
    if (websocket) {
      const headers = Object.entries(request.headers)
        .filter(([key]) => !key.startsWith("proxy-"))
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");
      upstream.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
    } else {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    }
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

/**
 * Starts the proxy on an ephemeral loopback port. Returns `{ url, close }`;
 * `close()` destroys every tracked socket (open tunnels included) and then
 * closes the server.
 */
export async function createBrowserProxy(allowed) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    handleHttpRequest(request, response, allowed);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => handleTunnel(request, socket, head, false, allowed, sockets));
  server.on("upgrade", (request, socket, head) => handleTunnel(request, socket, head, true, allowed, sockets));
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
