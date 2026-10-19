/**
 * URL admission policy for the browser tools.
 *
 * Every URL a model wants to open passes through `browserUrl` before any
 * browser interaction happens. The rules are security invariants, not advice:
 *
 *   1. Only absolute HTTP(S) URLs are accepted — no other schemes, no relative
 *      references, no embedded credentials (user:pass@host).
 *   2. Without network access, only loopback destinations are allowed
 *      (localhost, [::1], 127.0.0.0/8). Everything else is denied with
 *      BROWSER_NETWORK_DENIED before a browser process is involved.
 *
 * `isLoopbackUrl` is also reused at runtime: the proxy, page routing and the
 * post-action redirect check all re-verify loopback on every request, because
 * a navigation can redirect anywhere.
 */

export class BrowserToolError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new BrowserToolError(code, message);
}

/** True only for localhost, [::1] and 127.x.x.x hostnames; false for anything unparsable. */
export function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Validates and normalizes an HTTP(S) URL the model wants to visit.
 * Returns the href string; throws BrowserToolError (BROWSER_INVALID_URL /
 * BROWSER_NETWORK_DENIED) when the URL is not admissible.
 */
export function browserUrl(value, networkAccess) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return fail("BROWSER_INVALID_URL", "Provide an absolute HTTP(S) URL, for example http://localhost:3000.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    fail("BROWSER_INVALID_URL", "Only HTTP(S) URLs without embedded credentials are accepted.");
  if (!networkAccess && !isLoopbackUrl(url.href))
    fail("BROWSER_NETWORK_DENIED", "External browser access is disabled. Enable Ubume network access; localhost remains available.");
  return url.href;
}
