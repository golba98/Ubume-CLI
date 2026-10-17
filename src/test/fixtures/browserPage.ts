/**
 * Loopback-only HTML fixture for browser tools and Harness integration tests.
 * Each server owns an ephemeral port; consumers must await `close()` in `finally`.
 * The page deliberately includes private input values and ambiguous controls for
 * redaction and accessible-target regression scenarios.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

export const fixtureHtml = `<!doctype html><html><head><title>Ubume browser fixture</title></head><body>
<h1>Browser fixture</h1><a href="/second">Second page</a><button onclick="document.querySelector('#result').textContent='Clicked'">Click me</button>
<form onsubmit="event.preventDefault();document.querySelector('#result').textContent='Submitted '+document.querySelector('#email').value">
<label for="email">Email</label><input id="email" aria-label="Email"><label for="password">Password</label><input id="password" type="password" aria-label="Password">
<label for="notes">Notes</label><textarea id="notes">private initial text</textarea>
<label for="choice">Choice</label><select id="choice"><option value="one">One</option><option value="two">Two</option></select>
<label><input type="checkbox">Remember me</label><button type="submit">Submit</button></form>
<div contenteditable="true" role="textbox" aria-label="Editor">private editable text</div>
<button onclick="this.replaceWith(Object.assign(document.createElement('button'),{textContent:'Replacement'}))">Replace me</button>
<button>Duplicate</button><button>Duplicate</button><div role="dialog" aria-label="Dialog">Dialog text</div>
<p id="result">Ready</p><div style="display:none">Hidden secret</div><div style="height:1800px"></div><p>Bottom content</p>
</body></html>`;

/** Starts an independent fixture site. Rejects if the HTTP listener cannot start. */
export async function fixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/" });
      response.end();
      return;
    }
    if (request.url === "/external") {
      response.writeHead(302, { Location: "https://example.invalid/" });
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      request.url === "/second"
        ? "<html><head><title>Second</title></head><body><h1>Second page</h1></body></html>"
        : fixtureHtml,
    );
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      // Cache the promise so simultaneous cleanup paths await the same shutdown.
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
