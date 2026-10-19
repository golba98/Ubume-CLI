# Local browser computer use

Ubume's Local provider uses the DeepSeek Harness as its generic agent runtime for compatible OpenAI endpoints, including LM Studio, Ollama and Unsloth. Browser support uses that same tool registry, agent loop, permission decisions, tool-result messages, reasoning transitions and session persistence. It does not depend on a DeepSeek model name or a search service.

## Setup

Install Ubume's dependencies, then run:

```sh
ubume browser install
# From a source checkout:
node bin/ubume.js browser install
```

This installs Playwright Chromium. Node 18+ is required for the supervised browser execution worker; Bun runs the application. Linux may also need the system packages listed by Playwright's installer (`bunx playwright install-deps chromium`). Chromium runs with its sandbox enabled; Ubume does not silently disable the sandbox. Missing executables disable browser tool registration; missing host libraries or sandbox support produce a recoverable launch error. Local diagnostics report browser availability separately from model tool/vision support.

Environment controls:

| Variable | Meaning |
| --- | --- |
| `UBUME_BROWSER_ENABLED=0` | Disable browser tools. |
| `UBUME_BROWSER_MODE=auto` | Default: headed on a graphical desktop, headless under SSH/CI. Wayland and X11 are detected. |
| `UBUME_BROWSER_MODE=headed` or `headless` | Explicit display mode. `browser_open` can also request a mode. Close before changing modes. |
| `UBUME_BROWSER_EXECUTABLE_PATH` | Use an explicit compatible Chromium executable. |
| `UBUME_NODE_PATH` | Explicit Node executable for the browser worker. |

Auto mode can fall back to headless when a display is unusable. Explicit headed mode reports a launch error instead.

## Tools

The Local model receives `browser_open`, `browser_navigate`, `browser_inspect`, `browser_click`, `browser_type`, `browser_press`, `browser_select`, `browser_scroll`, `browser_back`, `browser_forward`, `browser_reload`, `browser_screenshot`, `browser_wait` and `browser_close`.

Inspection returns a compact semantic snapshot with title, URL, visible text, roles, accessible names and references such as `e7`. Click/type/select/press can target references; role plus name, exact text or CSS are alternatives where applicable. `index` selects a numbered match. Type uses `text` as its payload, with `append` and `sensitive` options. Inspection and screenshots can target a section. Refresh inspection after navigation or a stale-reference error; references are session-local and never reusable after close/resume.

For example, ask: “Open http://localhost:5173, click Login, enter the test credentials, submit, and check whether the dashboard loads.” A tool-capable text-only model can do this using semantic inspection. A vision-capable model also receives screenshot images through the existing Harness attachment pipeline. Screenshots are stored as local attachment artifacts; no image bytes or DOM trees appear in normal TUI tool output.

## Permissions and privacy

Under `on-request`, each click, type, key press and selection requires approval, including actions that might submit a form or send a message. Browser approvals apply to one action and its inspected target; changed targets require fresh approval. Plan/read-only policies block these interactions. An explicit `never` approval policy allows them without prompts. Navigation, inspection, scrolling, waiting and screenshot capture do not prompt. The TUI shows concise browser descriptions and excludes typed payloads.

With network access disabled, loopback HTTP(S) development URLs remain usable. External requests, including redirected HTTP(S) requests and WebSockets, are blocked by a browser-specific proxy and routing policy. Downloads and service workers are disabled. This is browser network enforcement, not a desktop or operating-system isolation boundary.

No cookies, storage dumps, authentication headers or editable field values are returned by inspection. Password/card/token fields and explicitly sensitive targets are masked in screenshots; values typed into such fields are redacted from subsequent results. Pages can still reveal secrets outside form fields, so screenshot masking cannot guarantee removal of every secret. Normal authenticated browsing works within the live session. Browser profiles/cookies are not saved to Ubume sessions.

## Lifecycle and limits

One browser/context is reused across actions and normal conversation turns. New chats, `/clear`, session destruction, provider/model changes and application shutdown close it through existing Local session cleanup. Interrupted generation closes that session's browser. Durable `/resume` restores conversation/tool history but starts a fresh browser: login state and references are gone. Crashes return ordinary tool errors; `browser_open` can recreate the browser. The supervisor tracks owned browser processes and forcibly reaps them if its worker fails or shutdown stalls. Worker-owned temporary profiles are removed during cleanup, including after a worker crash.

Inspection is capped at 100 elements, 8 levels, 16 frames, 8,000 visible-text characters and 32 KiB serialized output. Screenshots capture the viewport or a targeted element, normalize dimensions to at most 2048 pixels and cap stored image size at 4 MiB. Actions have bounded deadlines (10 seconds normally, 30 seconds for navigation); explicit delays are limited to 5 seconds. Errors are sanitized and actionable; actions are not automatically retried.

This first backend supports Chromium browser interaction, not desktop control, persisted browser profiles, arbitrary Playwright execution, or public-web search. Hosted DeepSeek search/fetch plugins remain disabled for Local because their hosted credentials/profile are separate from interactive browsing.

## Troubleshooting and verification

If tools are absent, check Local diagnostics, `UBUME_BROWSER_ENABLED`, and the Chromium install path. For launch failures, verify host dependencies, sandbox support and display mode. For ambiguous targets use inspection references or `index`; for stale references inspect again. For localhost failures check that the development server is running and listening in the same machine/container namespace as Ubume.

`bun test --max-concurrency=1 src/core/computerUse/browser.test.ts src/core/providerRuntime/localHarness/browserIntegration.test.ts` runs real Chromium against a deterministic localhost fixture and mock compatible model endpoints. Browser tests skip when Chromium is absent; set `UBUME_REQUIRE_BROWSER_TESTS=1` to require it. The integration test uses the actual Local route and packaged Harness, fragmented streamed calls, multiple tools, approvals, multi-turn browser reuse, and both vision/text-only models.

For a separate live smoke flow run `UBUME_BROWSER_MODE=headless bun scripts/smoke-local-browser.ts`, or use `headed` on a desktop. It opens the fixture, inspects/clicks/types/submits, reads the result, masks a password in a screenshot, and closes the browser. It leaves the screenshot attachment under the printed temporary directory for visual review.
