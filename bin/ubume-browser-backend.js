/**
 * Playwright-backed implementation of the Ubume browser tools.
 *
 * `BrowserManager` owns one browser session per conversation: a dedicated
 * Chromium `launchServer`, a dedicated browser context behind a loopback
 * proxy, and per-session element references, secrets and abort controllers.
 *
 * Security invariants (reviewable in this file; do not weaken any of them):
 *   - URL admission: every navigation goes through `browserUrl`, which admits
 *     only HTTP(S) without embedded credentials and, without network access,
 *     only loopback destinations.
 *   - Network enforcement is layered: the context-level proxy (see
 *     ubume-browser-proxy.js), per-request `context.route` interception, and a
 *     post-action check that re-verifies the *final* URL so a redirect to an
 *     external site cannot slip through (ERR_BLOCKED_BY_CLIENT and proxy
 *     failures are classified as BROWSER_NETWORK_DENIED).
 *   - Secrets typed into sensitive fields are captured and scrubbed
 *     (`[redacted]`) from all later text/URL observations; sensitive fields are
 *     marked and masked in screenshots.
 *   - Context isolation: downloads disabled, service workers blocked, no
 *     persisted state; `browser_close`/`closeSession` discard cookies and
 *     references.
 *   - Resource limits: bounded element/text/result sizes, bounded screenshot
 *     pixels, 30 s maximum deadlines, per-session action serialization
 *     (`session.tail`), and cancellation through AbortController at every
 *     await point.
 *   - Chromium always launches with its sandbox enabled; there is no
 *     `--no-sandbox` fallback.
 */

import { chromium } from "playwright";
import { saveImageFile, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_DIMENSION, DEFAULT_MAX_IMAGE_PIXELS, DEFAULT_MAX_IMAGES_PER_MESSAGE, DEFAULT_MAX_MESSAGE_IMAGE_BYTES } from "@deepseek-ai/dsh-attachment-local";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { browserDescription, safeBrowserUrl, validateBrowserArguments } from "./ubume-local-browser-tools.js";
import { BrowserToolError, browserUrl, isLoopbackUrl } from "./ubume-browser-url.js";
import { createBrowserProxy } from "./ubume-browser-proxy.js";

export { BrowserToolError, browserUrl, isLoopbackUrl } from "./ubume-browser-url.js";

const fail = (code, message) => { throw new BrowserToolError(code, message); };

// Inspection and result limits.
const MAX_ELEMENTS = 100;
const MAX_TEXT = 8000;
const MAX_RESULT_BYTES = 32768;

const NAVIGATION_TOOLS = ["browser_open", "browser_navigate", "browser_back", "browser_forward", "browser_reload"];

/** Whether the arguments select an element target (typing cannot use text). */
function hasTarget(args, typing = false) {
  return ["element", "role", "selector", ...typing ? [] : ["text"]].some((key) => args[key] !== undefined);
}

/**
 * Replaces every known secret with [redacted] and maps control characters to
 * spaces so nothing typed into a sensitive field can leak into observations.
 */
function scrub(value, session) {
  let result = value;
  for (const secret of session.secrets)
    if (secret)
      result = result.split(secret).join("[redacted]");
  return result.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
}

/** Closes a Playwright server, killing it after a 1.5 s grace period. */
async function closeServer(server) {
  if (!server)
    return;
  let timer;
  try {
    await Promise.race([server.close(), new Promise((resolve) => {
      timer = setTimeout(() => {
        server.kill().then(resolve, resolve);
      }, 1500);
    })]);
  } catch {
    await server.kill().catch(() => {
      return;
    });
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Maps an arbitrary Playwright/Harness failure to a stable code. Order is
 * deliberate: explicit tool errors and cancellation win, then Chromium's
 * network-error messages (policy denial is detected before generic navigation
 * failure), then lifecycle errors.
 */
function failureCode(error, controller, networkAccessAllowed) {
  if (error instanceof BrowserToolError) return error.code;
  if (controller.signal.aborted) return "ABORTED";
  if (error instanceof Error && error.name === "TimeoutError") return "BROWSER_TIMEOUT";
  const message = error instanceof Error ? error.message : "";
  if (!networkAccessAllowed && /ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) return "BROWSER_NETWORK_DENIED";
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED/.test(message)) return "BROWSER_NAVIGATION_FAILED";
  if (/ERR_CERT_|ERR_SSL_/.test(message)) return "BROWSER_TLS_FAILED";
  if (/closed|crash|disconnected/i.test(message)) return "BROWSER_CLOSED";
  return "BROWSER_FAILED";
}

/** Stable user-facing message for each failure code. */
const FAILURE_MESSAGES = {
  BROWSER_NETWORK_DENIED: "External browser requests are blocked. Enable network access; localhost remains available.",
  BROWSER_TLS_FAILED: "TLS validation failed. Check the site's certificate.",
  BROWSER_NAVIGATION_FAILED: "Navigation failed. Check the URL and whether the server is running.",
  BROWSER_CLOSED: "Browser/page closed or crashed. Open a browser again.",
  BROWSER_INVALID_ARGUMENTS: "Invalid browser arguments.",
};

function failureDetail(error, code) {
  if (error instanceof BrowserToolError) return error.message;
  if (code === "ABORTED") return "Browser action cancelled.";
  if (code === "BROWSER_TIMEOUT") return "Browser action timed out. Inspect the page and use a bounded wait before retrying.";
  if (FAILURE_MESSAGES[code]) return FAILURE_MESSAGES[code];
  return "Browser action failed. Inspect the page and check the target; no action was retried automatically.";
}

// ---------------------------------------------------------------------------
// Browser manager
// ---------------------------------------------------------------------------

export class BrowserManager {
  capability;
  sessions = new Map;

  constructor(capability, onProcess = () => {}) {
    this.capability = capability;
    this.onProcess = onProcess;
  }

  /** Returns the session record for a conversation id, creating it on demand. */
  session(id) {
    let session = this.sessions.get(id);
    if (!session) {
      session = { refs: new Map, nextRef: 1, epoch: 0, networkAccess: false, disposed: false, controllers: new Set, tail: Promise.resolve(), secrets: new Set };
      this.sessions.set(id, session);
    }
    return session;
  }

  /**
   * Runs one browser tool call. Calls on the same session are serialized
   * through `session.tail` (browser state is exclusive); the caller's abort
   * signal is bridged onto a fresh controller so one cancellation aborts only
   * this call. Always resolves to { ok, value } or { ok, error } — raw
   * exceptions never escape, and error text is scrubbed of session secrets.
   */
  async execute(request, policy) {
    const session = this.session(request.sessionId);
    const controller = new AbortController;
    const abort = () => controller.abort();
    policy.signal.addEventListener("abort", abort, { once: true });
    if (policy.signal.aborted)
      abort();
    session.controllers.add(controller);
    const work = session.tail.then(async () => {
      try {
        controller.signal.throwIfAborted();
        if (session.disposed)
          fail("BROWSER_CLOSED", "Browser session closed. Open a browser again.");
        validateBrowserArguments(request.tool, request.arguments);
        session.networkAccess = policy.networkAccess;
        const value = await this.perform(session, request, { ...policy, signal: controller.signal });
        controller.signal.throwIfAborted();
        return { ok: true, value };
      } catch (error) {
        let code = failureCode(error, controller, policy.networkAccess);
        if (error?.code === "BROWSER_INVALID_ARGUMENTS")
          code = "BROWSER_INVALID_ARGUMENTS";
        const detail = failureDetail(error, code);
        return { ok: false, error: { code, message: scrub(detail, session) } };
      } finally {
        session.controllers.delete(controller);
        policy.signal.removeEventListener("abort", abort);
      }
    });
    session.tail = work;
    return work;
  }

  // -- Session startup ----------------------------------------------------

  /**
   * Ensures the session has a live browser server, connection, context and
   * page. Reuses the existing server when possible; "auto" mode falls back to
   * headless when a headed launch fails on a machine without a usable display.
   */
  async open(session, args, signal) {
    const configured = args.mode ?? this.capability.mode;
    const mode = configured === "auto" ? this.capability.headedSupported ? "headed" : "headless" : configured;
    if (session.context && session.browser?.isConnected()) {
      if (args.mode && configured !== "auto" && mode !== session.mode)
        fail("BROWSER_MODE_CONFLICT", "Close the existing browser before changing its display mode.");
      if (!session.page || session.page.isClosed())
        session.page = await session.context.newPage();
      return;
    }
    if (this.capability.status !== "available")
      fail("BROWSER_UNAVAILABLE", this.capability.reason);
    await closeServer(session.server);
    await this.launchServer(session, mode, configured);
    await this.connectToServer(session, signal);
    await this.createContext(session);
    session.page = await session.context.newPage();
    signal.throwIfAborted();
  }

  /**
   * Launches the Chromium server, or fails. `auto` + headed gets one headless
   * retry; an explicit headed request does not (the user asked to see it).
   * Chromium's own sandbox stays on — no bypass is ever attempted.
   */
  async launchServer(session, mode, configured) {
    const launch = (headless) => chromium.launchServer({
      executablePath: this.capability.executablePath,
      host: "127.0.0.1",
      headless,
      chromiumSandbox: true,
      timeout: 30000,
      args: !headless && process.env.WAYLAND_DISPLAY && !process.env.DISPLAY ? ["--ozone-platform=wayland"] : [],
    });
    try {
      session.server = await launch(mode === "headless");
      session.mode = mode;
    } catch {
      if (configured !== "auto" || mode !== "headed")
        fail("BROWSER_LAUNCH_FAILED", "Chromium could not launch. Check browser installation, host libraries, desktop display, and Chromium sandbox support. No sandbox bypass is attempted.");
      try {
        session.server = await launch(true);
        session.mode = "headless";
        session.fallback = true;
      } catch {
        fail("BROWSER_LAUNCH_FAILED", "Chromium could not launch in headed or headless mode. Check host libraries and sandbox support; run ubume browser install.");
      }
    }
    const pid = session.server.process().pid;
    this.onProcess(pid);
    session.server.on("close", () => this.onProcess(pid, true));
  }

  /** Connects the driver to the server and rewires on unexpected disconnects. */
  async connectToServer(session, signal) {
    if (signal.aborted || session.disposed) {
      await closeServer(session.server);
      signal.throwIfAborted();
      fail("BROWSER_CLOSED", "Browser session closed during launch.");
    }
    session.browser = await chromium.connect(session.server.wsEndpoint(), { timeout: 1e4 });
    session.browser.on("disconnected", () => {
      session.refs.clear();
      session.epoch++;
    });
  }

  /**
   * Creates the isolated context and installs the layered network policy:
   * loopback proxy for every request (including redirected ones), route-level
   * admission, WebSocket policy, and per-page reference invalidation.
   */
  async createContext(session) {
    await session.proxy?.close();
    session.proxy = await createBrowserProxy((url) => session.networkAccess || isLoopbackUrl(url));
    session.context = await session.browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: false, serviceWorkers: "block", proxy: { server: session.proxy.url, bypass: "<-loopback>" } });
    await session.context.route("**/*", async (route) => {
      const url = route.request().url();
      const protocol = new URL(url).protocol;
      if (["http:", "https:"].includes(protocol) && (session.networkAccess || isLoopbackUrl(url)))
        await route.continue();
      else
        await route.abort("blockedbyclient");
    });
    await session.context.routeWebSocket(() => true, async (ws) => {
      if (session.networkAccess || isLoopbackUrl(ws.url()))
        await ws.connectToServer();
      else
        await ws.close();
    });
    session.context.on("page", (page) => this.trackPage(session, page));
  }

  /**
   * Keeps `session.page` pointing at the newest live page and invalidates all
   * element references on any navigation, crash or page switch. dialogs are
   * dismissed so a page cannot stall waiting for a user.
   */
  trackPage(session, page) {
    session.page = page;
    session.refs.clear();
    session.epoch++;
    page.on("framenavigated", () => {
      session.refs.clear();
      session.epoch++;
    });
    page.on("crash", () => {
      session.refs.clear();
      session.epoch++;
    });
    page.on("dialog", (dialog) => {
      dialog.dismiss().catch(() => {
        return;
      });
    });
    page.on("close", () => {
      session.refs.clear();
      session.epoch++;
      if (session.page === page)
        session.page = session.context?.pages().filter((candidate) => !candidate.isClosed()).at(-1);
    });
  }

  // -- Target resolution ----------------------------------------------------

  /** The live page, or a BROWSER_CLOSED failure when there is none. */
  current(session) {
    if (!session.browser?.isConnected() || !session.page || session.page.isClosed())
      fail("BROWSER_CLOSED", "No open browser page. Call browser_open first.");
    return session.page;
  }

  /**
   * Resolves the arguments to exactly one Playwright locator. Element
   * references must come from the current inspection epoch; ambiguous matches
   * are rejected so an action can never hit the wrong element.
   */
  async resolveTarget(session, args, signal) {
    const page = this.current(session);
    let locator;
    if (args.element) {
      const ref = session.refs.get(String(args.element));
      if (!ref || ref.epoch !== session.epoch || ref.frame.isDetached())
        fail("BROWSER_STALE_REFERENCE", `Element ${args.element} is no longer available. Inspect the page again.`);
      locator = ref.frame.locator(`aria-ref=${ref.native}`);
    } else if (args.role) {
      locator = page.getByRole(args.role, { name: String(args.name), exact: true });
    } else if (args.selector)
      locator = page.locator(`css=${args.selector}`);
    else
      locator = page.getByText(String(args.text), { exact: true });
    signal.throwIfAborted();
    const count = await locator.count();
    if (!count || args.index && Number(args.index) > count)
      fail(args.element ? "BROWSER_STALE_REFERENCE" : "BROWSER_ELEMENT_NOT_FOUND", args.element ? `Element ${args.element} is no longer available. Inspect the page again.` : "Element not found. Inspect the page and choose a current target.");
    if (count > 1 && !args.index)
      fail("BROWSER_AMBIGUOUS_TARGET", `${count} elements match. Inspect again and use an element reference or a one-based index.`);
    return args.index ? locator.nth(Number(args.index) - 1) : locator;
  }

  // -- Inspection ----------------------------------------------------------

  /**
   * Walks the page's accessibility snapshot and returns bounded semantic
   * elements plus visible text. Private/form fields never expose their value:
   * they are reported as textboxes with their label, and their typed content
   * never enters the result. References carry the inspection epoch, so stale
   * refs are detectable in resolveTarget. With `scope`, only that subtree is
   * inspected (used by browser_inspect on a target).
   */
  async inspect(session, signal, scope) {
    const page = this.current(session);
    const elements = [];
    const texts = [];
    let textSize = 0;
    let truncated = false;
    const old = session.refs;
    const refs = scope ? new Map([...old].slice(-MAX_ELEMENTS)) : new Map;
    const scopeFrame = scope ? await (await scope.elementHandle({ timeout: 10000 }))?.ownerFrame() : undefined;
    for (const frame of scope ? [scopeFrame ?? page.mainFrame()] : page.frames().slice(0, 16)) {
      if (frame.isDetached())
        continue;
      const root = scope ?? frame.locator("body");
      const snapshot = await root.ariaSnapshotJSON({ mode: "ai", depth: 8, timeout: 1e4, signal });
      const visit = async (node, depth) => {
        if (depth > 8 || elements.length >= MAX_ELEMENTS || textSize >= MAX_TEXT) {
          truncated = true;
          return;
        }
        if (typeof node === "string") {
          const text = scrub(node, session).slice(0, MAX_TEXT - textSize);
          texts.push(text);
          textSize += text.length;
          return;
        }
        if (!node || typeof node !== "object")
          return;
        const item = node;
        const native = typeof item.ref === "string" ? item.ref : undefined;
        let privateField = false;
        let fieldName = "";
        if (native) {
          const loc = frame.locator(`aria-ref=${native}`);
          privateField = await loc.evaluate((el) => el.matches("input,textarea,select,[contenteditable]"), undefined, { timeout: 1e4, signal }).catch(() => true);
          if (privateField) fieldName = await loc.evaluate((el) => el.getAttribute("aria-label") || [...(el.labels ?? [])].map((label) => label.textContent).join(" "), undefined, { timeout: 1e4, signal }).catch(() => "");
        }
        const role = privateField && item.role === "generic" ? "textbox" : String(item.role ?? "text");
        const name = fieldName || String(item.name ?? "");
        if ((role !== "generic" || item.cursor === "pointer") && role !== "text" && role !== "iframe") {
          const entry = { role, name: scrub(name, session).slice(0, 240) };
          if (native) {
            // Reuse a reference when this exact element was already seen this
            // epoch; otherwise allocate the next id.
            const known = [...old].find(([, ref]) => ref.frame === frame && ref.native === native && ref.epoch === session.epoch && ref.role === role && ref.name === name);
            const id = known?.[0] ?? `e${session.nextRef++}`;
            refs.set(id, { frame, native, epoch: session.epoch, role, name });
            entry.element = id;
          }
          for (const key of ["checked", "disabled", "expanded", "selected", "level"])
            if (item[key] !== undefined)
              Object.assign(entry, { [key]: item[key] });
          if (typeof item.url === "string") {
            try {
              entry.url = scrub(safeBrowserUrl(new URL(item.url, page.url()).href), session);
            } catch {}
          }
          if (!privateField && typeof item.text === "string")
            entry.text = scrub(item.text, session).slice(0, 500);
          elements.push(entry);
        }
        if (!privateField && role !== "iframe") {
          if (typeof item.text === "string")
            await visit(item.text, depth + 1);
          if (Array.isArray(item.children))
            for (const child of item.children)
              await visit(child, depth + 1);
        }
      };
      for (const node of snapshot)
        await visit(node, 0);
      if (scope || elements.length >= MAX_ELEMENTS || textSize >= MAX_TEXT)
        break;
    }
    session.refs = refs;
    const result = { summary: `Page inspected: ${elements.length} elements${truncated ? " (truncated; inspect a section for more)" : ""}.`, page: { url: scrub(safeBrowserUrl(page.url()), session), title: scrub(await page.title(), session).slice(0, 500), loadState: await page.evaluate(() => document.readyState) }, elements, visibleText: texts.join(`\n`), truncated };
    // Hard bound on the serialized size: drop elements until it fits.
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES && result.elements.length) {
      result.elements.pop();
      result.truncated = true;
    }
    return result;
  }

  // -- Approval identity ---------------------------------------------------

  /**
   * Describes the element a typing/click approval is about, plus a stable
   * identity: the inspection epoch, a per-element random token, and a hash of
   * the element's structural shape. The identity survives re-rendering of the
   * same element but changes when the underlying element does, so an approval
   * granted earlier cannot be replayed onto a different field.
   */
  async approvalState(sessionId, args, typing, signal) {
    const session = this.session(sessionId);
    const page = this.current(session);
    const focused = page.locator(":focus");
    const locator = hasTarget(args, typing) ? await this.resolveTarget(session, args, signal) : await focused.count() ? focused : page.locator("body");
    const token = await locator.evaluate((el) => {
      const node = el;
      return node.__ubumeApprovalIdentity ??= crypto.randomUUID();
    }, undefined, { timeout: 1e4, signal });
    const editable = await locator.evaluate((el) => el.matches("input,textarea,select,[contenteditable]"), undefined, { timeout: 1e4, signal });
    const label = await locator.getAttribute("aria-label", { timeout: 1e4, signal }) || (editable ? String(args.name ?? "form field") : await locator.innerText({ timeout: 1e4, signal }).catch(() => "")) || String(args.element ?? args.name ?? "focused element");
    const shape = await locator.evaluate((el) => [el.tagName, el.getAttribute("role"), el.getAttribute("aria-label"), el.getAttribute("href"), el.getAttribute("type"), el.textContent].join(`\n`), undefined, { timeout: 1e4, signal });
    return { description: `${scrub(label, session).slice(0, 120)} on ${scrub(safeBrowserUrl(page.url()), session)}`, identity: `${session.epoch}:${token}:${createHash("sha256").update(shape).digest("hex")}` };
  }

  // -- Tool execution ------------------------------------------------------

  /** Default deadline: navigation-class tools get 30 s, everything else 10 s. */
  actionTimeoutMs(tool, args) {
    return Number(args.timeoutMs ?? (NAVIGATION_TOOLS.includes(tool) ? 30000 : 1e4));
  }

  /**
   * Executes one validated tool call and returns the post-action inspection.
   * Every action is followed by a fresh inspect (refs must reflect the page as
   * it is now) and by the post-action network check (the final URL decides,
   * so redirects are covered).
   */
  async perform(session, request, policy) {
    const { tool, arguments: args } = request;
    const { signal } = policy;
    if (tool === "browser_close") {
      await closeServer(session.server);
      await session.proxy?.close(); session.proxy = undefined;
      session.server = undefined;
      session.browser = undefined;
      session.context = undefined;
      session.page = undefined;
      session.refs.clear();
      session.epoch++;
      session.secrets.clear();
      return { summary: "Browser closed; authentication and references discarded." };
    }
    if (tool === "browser_open") {
      if (args.url)
        browserUrl(args.url, policy.networkAccess);
      await this.open(session, args, signal);
      if (args.url)
        await this.current(session).goto(browserUrl(args.url, policy.networkAccess), { waitUntil: "domcontentloaded", timeout: Number(args.timeoutMs ?? 30000), signal });
    }
    const page = this.current(session);
    const opts = { timeout: this.actionTimeoutMs(tool, args), signal };
    if (tool !== "browser_open" && tool !== "browser_inspect")
      await this.inspect(session, signal);
    const loc = hasTarget(args, tool === "browser_type") && tool !== "browser_wait" ? await this.resolveTarget(session, args, signal) : undefined;
    switch (tool) {
      case "browser_navigate":
        await page.goto(browserUrl(args.url, policy.networkAccess), { ...opts, waitUntil: "domcontentloaded" });
        break;
      case "browser_click":
        await loc.click(opts);
        break;
      case "browser_type": {
        // Sensitive detection covers explicit `sensitive` flags, password and
        // card autocompletes, and token-named fields. The typed text becomes a
        // session secret: scrubbed from every later observation.
        const sensitive = args.sensitive === true || await loc.evaluate((el) => el.matches('input[type="password"],[autocomplete*="password"],[autocomplete^="cc-"],[name*="token" i]'), undefined, opts);
        if (sensitive) {
          session.secrets.add(String(args.text));
          await loc.evaluate((el) => el.setAttribute("data-ubume-sensitive", "true"), undefined, opts);
        }
        if (args.append) {
          await loc.press("End", opts);
          await loc.pressSequentially(String(args.text), opts);
        } else
          await loc.fill(String(args.text), opts);
        break;
      }
      case "browser_press":
        if (loc)
          await loc.press(String(args.key), opts);
        else
          await page.keyboard.press(String(args.key));
        break;
      case "browser_select":
        await loc.selectOption(args.values.map((value) => args.by === "label" ? { label: value } : { value }), opts);
        break;
      case "browser_scroll": {
        const scroll = { direction: String(args.direction), pixels: Number(args.pixels ?? 600) };
        await (loc ?? page.locator("html")).evaluate((el, { direction, pixels }) => {
          const target = el === document.documentElement ? document.scrollingElement ?? el : el;
          target.scrollTo({ top: direction === "top" ? 0 : direction === "bottom" ? target.scrollHeight : target.scrollTop + (direction === "up" ? -pixels : pixels), behavior: "instant" });
        }, scroll, opts);
        break;
      }
      case "browser_back":
        await page.goBack({ ...opts, waitUntil: "domcontentloaded" });
        break;
      case "browser_forward":
        await page.goForward({ ...opts, waitUntil: "domcontentloaded" });
        break;
      case "browser_reload":
        await page.reload({ ...opts, waitUntil: "domcontentloaded" });
        break;
      case "browser_wait":
        if (args.delayMs)
          await delay(Number(args.delayMs), undefined, { signal });
        else if (args.loadState)
          await page.waitForLoadState(args.loadState, opts);
        else {
          const pending = args.element ? await this.resolveTarget(session, args, signal) : args.selector ? page.locator(`css=${args.selector}`) : page.getByText(String(args.text), { exact: true });
          await pending.waitFor({ ...opts, state: "visible" });
        }
        break;
      case "browser_screenshot":
        return await this.captureScreenshot(session, page, loc, opts, policy);
    }
    const result = await this.inspect(session, signal, tool === "browser_inspect" ? loc : undefined);
    this.enforceNetworkPolicy(session, policy);
    if (tool !== "browser_inspect")
      result.summary = browserDescription(tool, args) + (session.fallback ? " (automatic headed launch unavailable; using headless)" : "");
    return result;
  }

  /**
   * Final network check: judged on the page's *current* URL, so an action that
   * landed on an external site via redirect or form post is still denied.
   */
  enforceNetworkPolicy(session, policy) {
    const url = this.current(session).url();
    if (!policy.networkAccess && !isLoopbackUrl(url) && url !== "about:blank")
      fail("BROWSER_NETWORK_DENIED", "External browser access is disabled. Redirects to external websites are blocked; enable Ubume network access to visit them.");
  }

  /** Captures a masked screenshot and persists it as a bounded attachment. */
  async captureScreenshot(session, page, loc, opts, policy) {
    // Mask password/card/one-time/token fields in every frame, plus fields
    // marked sensitive by earlier browser_type calls.
    const mask = page.frames().map((frame) => frame.locator('input[type="password"],[autocomplete*="password"],[autocomplete^="cc-"],[autocomplete="one-time-code"],[name*="token" i],[data-ubume-sensitive="true"]'));
    const buffer = await (loc ?? page).screenshot({ ...opts, type: "png", scale: "css", mask, animations: "disabled" });
    const image = await saveImageFile(join(policy.dshHome, "attachments", "v1"), { data: buffer, mediaType: "image/png", name: "browser-screenshot.png" }, { maxImageBytes: Math.min(DEFAULT_MAX_IMAGE_BYTES, 4 * 1024 * 1024), maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE, maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES, maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS, maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION, mediaTypes: ["image/png"] }, { maxPixels: 2048 * 2048, maxDimension: 2048, maxBytes: 4 * 1024 * 1024 });
    const hash = String(image.attachmentId).slice("sha256:".length);
    return { summary: `Screenshot saved (${image.width}×${image.height}); sensitive fields masked.`, image, artifactPath: join(policy.dshHome, "attachments", "v1", "objects", hash.slice(0, 2), hash) };
  }

  // -- Teardown ----------------------------------------------------------

  /**
   * Closes one conversation's browser: abort its calls, close the server, wait
   * for the serialized tail to drain, then discard refs, the proxy and the
   * secret set. The server is closed both before and after the drain because
   * an in-flight call may have reconnected.
   */
  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session)
      return;
    session.disposed = true;
    for (const controller of session.controllers)
      controller.abort();
    await closeServer(session.server);
    await session.tail;
    await closeServer(session.server);
    session.refs.clear();
    await session.proxy?.close();
    session.secrets.clear();
    if (this.sessions.get(sessionId) === session)
      this.sessions.delete(sessionId);
  }

  /** Graceful teardown of every session. */
  async shutdown() {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  /** Immediate teardown (worker shutdown): kill servers without waiting. */
  terminate() {
    for (const session of this.sessions.values()) {
      session.disposed = true;
      for (const controller of session.controllers)
        controller.abort();
      session.server?.kill().catch(() => {
        return;
      });
    }
    this.shutdown();
  }
}
