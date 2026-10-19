/**
 * Loopback-only HTTP server for provider fixtures (fake Messages/models endpoints).
 * The parent test owns it and must `close()` it in `finally`; close also drops
 * deliberately stalled connections.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackServer {
  /** Base URL, e.g. `http://127.0.0.1:43123`. */
  url: string;
  close(): Promise<void>;
}

export async function startLoopbackServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LoopbackServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Writes a JSON response with optional extra headers. */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}
