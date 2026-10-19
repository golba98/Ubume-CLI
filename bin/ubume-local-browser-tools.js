/**
 * Local Harness browser tool definitions.
 *
 * Three responsibilities live here:
 *   1. `browserSpecs` — the JSON-schema parameters for each of the 14 browser
 *      tools, shared by tool registration and argument validation.
 *   2. `validateBrowserArguments` — the strict admission check every browser
 *      call passes before it reaches a browser process (schema, unknown keys,
 *      size limits, target cardinality).
 *   3. `registerBrowserTools` — registers the tools on one agent's cordis
 *      context, wiring execution and cancellation to the JSON-RPC transport.
 *
 * Security-relevant rules (do not weaken):
 *   - `browser_type.text` is never copied into display arguments (it may
 *     contain secrets); `sensitive: true` fields are masked at screenshot time.
 *   - Tool execution is exclusive to the agent that owns the browser session;
 *     another agent's request fails with BROWSER_PERMISSION_DENIED.
 *   - Every value is bounded (string lengths, index/pixel ranges, option
 *     counts, deadlines) before it can reach Playwright.
 */

import { defineTool, validateArgs } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";

const string = (description, required = false) => ({ type: "string", description, ...(required ? { required: true } : {}) });

const target = {
  element: string("Element reference from the latest browser inspection, for example e7."),
  role: string("Accessible role. Supply name with role."),
  name: string("Exact accessible name, used with role."),
  text: string("Exact visible text."),
  selector: string("CSS selector; advanced fallback only."),
  index: { type: "integer", description: "One-based match index, only when selecting among duplicate targets." },
};
const deadline = { timeoutMs: { type: "integer", description: "Positive bounded deadline, at most 30000 milliseconds." } };

export const browserSpecs = {
  browser_open: { url: string("Absolute HTTP(S) URL, or omit to open a blank page."), mode: { type: "string", enum: ["auto", "headed", "headless"] }, ...deadline },
  browser_navigate: { url: string("Absolute HTTP(S) URL. Localhost development is supported.", true), ...deadline },
  browser_inspect: { ...target, ...deadline },
  browser_click: { ...target, ...deadline },
  browser_type: { ...target, text: string("Text to enter. This value is excluded from Ubume display logs.", true), append: { type: "boolean" }, sensitive: { type: "boolean", description: "Mask this field and redact its value from observations." }, ...deadline },
  browser_press: { ...target, key: string("Key/chord, for example Enter, Escape, Tab, ArrowDown, Control+A.", true), ...deadline },
  browser_select: { ...target, values: { type: "array", items: { type: "string" }, required: true }, by: { type: "string", enum: ["value", "label"] }, ...deadline },
  browser_scroll: { ...target, direction: { type: "string", enum: ["up", "down", "top", "bottom"], required: true }, pixels: { type: "integer" }, ...deadline },
  browser_back: { ...deadline },
  browser_forward: { ...deadline },
  browser_reload: { ...deadline },
  browser_screenshot: { ...target, ...deadline },
  browser_wait: { element: target.element, selector: target.selector, text: target.text, loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] }, delayMs: { type: "integer" }, ...deadline },
  browser_close: {},
};

// Typing uses text as its payload, so its target must be a ref, role/name, or CSS.
const descriptions = {
  browser_open: "Open a reusable browser for this conversation. Use browser_inspect to obtain element references. Browser state is live-session-only.",
  browser_navigate: "Navigate the active browser page to an HTTP(S) URL, including localhost. Does not require a search API.",
  browser_inspect: "Inspect the page or a target section. Returns bounded semantic content and references, without raw HTML or form values. Reinspect after stale-reference errors.",
  browser_click: "Click one browser element. Requires interaction permission. Use element references rather than brittle selectors.",
  browser_type: "Replace (default) or append text in an input, textarea, or contenteditable target. Does not submit; use browser_press or browser_click.",
  browser_press: "Press a key or chord on a target or on the currently focused element. Requires interaction permission, including Enter submissions.",
  browser_select: "Select native select options by value (default) or label. Requires interaction permission.",
  browser_scroll: "Scroll the page or an element in a direction, optionally by a pixel amount.",
  browser_back: "Go back in browser history.", browser_forward: "Go forward in browser history.", browser_reload: "Reload the active page.",
  browser_screenshot: "Capture the viewport or a target, masking sensitive fields. Vision models receive the image; text-only models receive artifact information.",
  browser_wait: "Bounded wait: supply exactly one of element, selector, text, loadState, or delayMs. Network idle is explicit and may time out on live applications.",
  browser_close: "Close the conversation browser and discard its cookies and element references.",
};

export const browserInteractions = new Set(["browser_click", "browser_type", "browser_press", "browser_select"]);

export function isBrowserTool(name) {
  return Object.hasOwn(browserSpecs, name);
}

const invalid = (message) => {
  throw new HarnessError(message, "BROWSER_INVALID_ARGUMENTS");
};

/**
 * Full argument validation for one browser tool call. Order matters:
 *   1. the tool must exist and the arguments must match its schema;
 *   2. no unknown keys may be present (schema validators often tolerate them;
 *      the browser tool surface must not grow silently);
 *   3. every string is non-empty and within its size limit (typing text gets a
 *      larger budget because it is the actual payload);
 *   4. numeric ranges are enforced;
 *   5. target cardinality: exactly one target key, exactly one wait condition,
 *      `index` only with a non-ref target.
 * Throws HarnessError("BROWSER_INVALID_ARGUMENTS" | "BROWSER_UNSUPPORTED").
 */
export function validateBrowserArguments(tool, args) {
  if (!isBrowserTool(tool)) throw new HarnessError("Unsupported browser operation.", "BROWSER_UNSUPPORTED");
  const errors = validateArgs(browserSpecs[tool], args);
  if (errors.length) throw new HarnessError("Invalid browser arguments: " + errors.join("; "), "BROWSER_INVALID_ARGUMENTS");
  if (Object.keys(args).some((key) => !Object.hasOwn(browserSpecs[tool], key))) throw new HarnessError("Unknown browser argument.", "BROWSER_INVALID_ARGUMENTS");

  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const isTypingPayload = tool === "browser_type" && key === "text";
    const maxLength = isTypingPayload ? 16384 : 2048;
    if (value.length > maxLength || (!value.trim() && !isTypingPayload)) invalid("Browser strings must be non-empty and within their size limits.");
  }
  if (args.timeoutMs !== undefined && (args.timeoutMs < 1 || args.timeoutMs > 30000)) invalid("timeoutMs must be between 1 and 30000.");
  if (args.index !== undefined && (args.index < 1 || args.index > 100)) invalid("index must be between 1 and 100.");
  if (args.pixels !== undefined && (args.pixels < 1 || args.pixels > 10000)) invalid("pixels must be between 1 and 10000.");
  if (args.values && (args.values.length < 1 || args.values.length > 100 || args.values.some((v) => v.length > 2048))) invalid("Provide between 1 and 100 bounded select options.");

  if (tool === "browser_wait") {
    if (["element", "selector", "text", "loadState", "delayMs"].filter((key) => args[key] !== undefined).length !== 1) invalid("Provide exactly one wait condition.");
    if (args.delayMs !== undefined && (args.delayMs < 1 || args.delayMs > 5000)) invalid("delayMs must be between 1 and 5000.");
  } else if (Object.hasOwn(browserSpecs[tool], "element")) {
    const count = ["element", "role", "selector", ...(tool === "browser_type" ? [] : ["text"])].filter((key) => args[key] !== undefined).length;
    if ((args.role !== undefined) !== (args.name !== undefined)) invalid("role and name must be supplied together.");
    if (count > 1 || (count === 0 && ["browser_click", "browser_type", "browser_select"].includes(tool))) invalid("Provide exactly one target for this action.");
    if (args.index !== undefined && (count === 0 || args.element !== undefined)) invalid("index requires a role, text, or selector target.");
  }
  if (args.element !== undefined && !/^e[1-9]\d*$/.test(args.element)) invalid("element must be an inspection reference such as e7.");
  if (args.selector !== undefined && !args.selector.trim()) invalid("selector must be non-empty.");
  if (tool === "browser_press" && !/^(?:(?:Control|ControlOrMeta|Meta|Alt|Shift)\+)*(?:[A-Za-z0-9]|Enter|Escape|Tab|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Insert|F(?:[1-9]|1[0-2]))$/.test(args.key)) invalid("Unsupported key/chord.");
  return args;
}

/**
 * Neutralized URL for display: credentials, query and fragment are stripped so
 * tokens embedded in links never reach the transcript. Returns "invalid URL"
 * for unparsable input (display only; execution goes through browserUrl).
 */
export function safeBrowserUrl(value) {
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
  catch { return "invalid URL"; }
}

/** One-line human-readable description of a browser call for display events. */
export function browserDescription(tool, args = {}) {
  const action = tool.slice(8).replace(/^./, (c) => c.toUpperCase());
  const label = args.element || (args.role ? `${args.role} "${args.name}"` : tool !== "browser_type" && args.text ? `"${args.text}"` : args.selector ? "selected element" : "");
  return `Browser  ${action}${args.url ? " " + safeBrowserUrl(args.url) : label ? " " + label : ["browser_inspect", "browser_screenshot"].includes(tool) ? " page" : ""}${args.key ? " " + args.key : ""}`.slice(0, 240).replace(/[\x00-\x1f\x7f]/g, " ");
}

/**
 * Registers all browser tools on one agent context. Each tool executes by
 * forwarding to the browser worker over the JSON-RPC transport:
 *   - arguments are validated locally before the RPC;
 *   - the call is exclusive to this agent's session;
 *   - abort notifications are forwarded as browser.cancel, but the RPC itself
 *     is still awaited to completion (Ubume drains cancelled actions rather
 *     than abandoning them mid-protocol).
 * Returns the disposer array (one per tool) for the bridge to unregister.
 */
export function registerBrowserTools(ctx, transport, sessionId, supportsVision) {
  return Object.entries(browserSpecs).map(([name, parameters]) => ctx.tools.register(defineTool({
    name, description: descriptions[name], parameters,
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [
        { type: "text", text: JSON.stringify(value) },
        ...(supportsVision && value.image ? [{ type: "image", attachment: value.image }] : []),
      ],
      presentationMeta: (_args, value) => ({ browserSummary: value.summary }),
    },
    // Browser operations share session state and must remain exclusive.
    async execute(args, exec) {
      validateBrowserArguments(name, args);
      if (String(exec.agent?.id) !== sessionId) throw new HarnessError("This browser belongs to another agent.", "BROWSER_PERMISSION_DENIED");
      const abort = () => transport.notify("browser.cancel", { sessionId, callId: String(exec.callId) });
      exec.signal.addEventListener("abort", abort, { once: true });
      try {
        if (exec.signal.aborted) throw new HarnessError("Browser action cancelled.", "ABORTED");
        // Do not abandon the RPC on abort: wait until Ubume has drained the action.
        const result = await transport.request("browser/execute", { sessionId, callId: String(exec.callId), tool: name, arguments: args });
        if (!result?.ok) throw new HarnessError(result?.error?.message || "Browser action failed.", result?.error?.code || "BROWSER_FAILED");
        return result.value;
      } finally { exec.signal.removeEventListener("abort", abort); }
    },
  })));
}
