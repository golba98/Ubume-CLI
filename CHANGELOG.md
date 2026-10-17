# Changelog

## Unreleased

---

## [0.1.18] — 2026-10-17 (prepared)

### Added

- Experimental Codexa Native integration for five local 934M checkpoint variants, with managed worker streaming, generation settings, cancellation, unload and replay commands. Native inference requires separately configured Python, tokenizer and checkpoint files; see `docs/CODEXA_NATIVE.md`.
- Preserve raw generation output and provenance in saved conversations, with explicit context trimming and empty-response notices.

### Fixed

- Recover from unavailable provider models without locking provider or model navigation. Keep failed selections scoped to their provider connection, preserve previous preferences when validation or saving fails, and prevent stale validations from replacing newer selections.
- Submit exact `/model` commands and preserve picker focus when a request finishes.
- Restore `/status`, `/runtime`, `/workspace` and `/help` output through command dispatch.

### Changed

- Organize interactive app hooks by domain and split provider actions, model activation, prompt runs, conversation lifecycle and input routing into focused modules. See `docs/architecture/app.md`.

### Verification

- Release checks and package contents are recorded in `docs/RELEASE_0.1.18_VERIFICATION.md`.
- Prepared for review; this preparation does not publish to npm or create a release tag.

---

## [0.1.17] — 2026-10-09 (prepared)

### Added

- `/usage` shows account usage for the active provider in an overlay panel: Codex 5-hour/weekly windows and credits (via `codex app-server`), Claude Code session/weekly/model limits (via Claude Code's experimental `get_usage` control request), and Google Antigravity per-model-group quotas and G1 credits (via `agy -p /usage` and `/credits`). It never sends a prompt or uses model tokens. Mistral Vibe is reported as unsupported because Vibe exposes no usage interface. Local routes show context and token usage, with account quota marked N/A on loopback. The Anthropic API-key route shows rate limits observed on earlier responses. Press R to refresh (30 s cooldown, `UBUME_USAGE_COOLDOWN_SECONDS`) and Esc to close. Cached and stale data are labelled as such.

### Fixed

- Selecting Mistral in the provider picker switches to it directly when its saved model is Vibe's "Default" entry, instead of reopening the model picker every time.
- Match the Mistral picker to the installed Vibe effective model list, including GLM-5.3 (Mistral Hosted), local models and the current Default entry. Preserve native labels, selector aliases and thinking levels.
- Stop adding API-only model candidates to the Vibe picker and filter stale API-only cache rows without deleting stored data. Read Vibe configuration and cached routing assignments without running configuration migrations.
- Discover effective Vibe models before headless execution so routed models such as `glm-5-3` work on a fresh process.
- Keep checking for Ubume updates while the interactive app runs: every 15 minutes after a successful check, and with bounded, jittered backoff (30 s up to 15 min) after failures, so a release published mid-session or a failed startup check no longer goes unnoticed until restart. Background results update the existing update state without opening the prompt or moving focus.
- Never let a failed update check hide an already-detected update or count as "up to date." `/update check` shares the background checker's single in-flight request, and a late startup result no longer closes an overlay opened afterwards.
- Read the npm `latest` dist-tag from the small, uncached dist-tags endpoint instead of the CDN-cached full package document, and order prerelease versions by SemVer precedence (`rc.10` after `rc.9`).

### Verification

- Release preparation passed 2,137 tests across 193 files (0 failures), build, TypeScript, Biome, capability audit (17/17), version consistency, CLI `--version` and package dry run. See `docs/RELEASE_0.1.17_VERIFICATION.md`.

---

## [0.1.16] — 2026-10-09 — Provider Routing

### Fixed

- Restore Google through the original Antigravity (`agy`) backend, removing the legacy Gemini CLI integration. Restore native session access, live model discovery, exact model dispatch, cancellation and historical conversation handling.
- Preserve saved Antigravity preferences and sessions through compatibility aliases. Archive conflicting legacy Google settings without interpreting them as Antigravity credentials; require explicit provider/model selection for ambiguous legacy routes.
- Keep configured Mistral Vibe routes usable when API discovery fails or credentials are unavailable. Match API metadata against configured request names, preserving selector aliases and avoiding metadata from unrelated colliding IDs.
- Preserve exact API model IDs across picker refresh and confirmation, and forward that ID to Vibe instead of substituting a configured model's request name. Preserve configured model settings and local or third-party provider configuration.

### Changed

- Separate native/configured Vibe models from API-discovered custom routes. Collapse only API-declared aliases; API custom routes require a verified catalogue and are labelled "Custom via Vibe (request unverified)." Reasoning controls appear only when the API reports reasoning capability, with Vibe's none/high mapping.
- Always offer "Vibe current/default." This follows Vibe's saved active/default selection and inherited environment overrides; it does not unpin the native selection.

### Verification

- Final release verification passed: 1,986 tests across 177 files (0 failures), TypeScript, Biome, build, capability audit (17/17), whitespace checks, version consistency and CLI `--version` (0.1.16). The package dry run includes 228 files (601,516 packed bytes); required runtime files are present and tests, fixtures, credentials and legacy Gemini runtime files are excluded.
- Focused routing/picker checks passed 93 tests. Sanitized synthetic 60/120-column terminal captures and the full verification details are in `docs/recordings/mistral-vibe-picker.txt` and `docs/RELEASE_0.1.16_VERIFICATION.md`.
- Local parsing confirms the injected model list is accepted by Vibe 2.26.0. No live Mistral completion was sent; successful Large 4 inference and the model reported by a completed request remain unverified.
- This version is prepared for review and has not been published to npm or tagged as a release.

---

## [0.1.15] — 2026-10-09 — Terminal Markdown Rendering

### Changed

- Assistant Markdown uses one shared terminal renderer across providers. Tables align and wrap within available width, with stacked header/value layouts on narrow terminals. Unicode, escaped pipes, inline formatting and alignment directives are supported. (#294)
- Headings, nested and task lists, quotes, links, inline code and fenced blocks use consistent theme-aware styling. Code indentation, blank lines and filename-like first lines remain intact; long lines have marked visual continuations. Raw responses remain available to copy/export. (#294)
- Streaming reuses stable parsed blocks and bounded layout caches. Complete responses are no longer silently truncated by the presentation layer. (#294)

### Security

- Includes the DeepSeek Harness upgrade to `0.1.2-rc.1` for GHSA-8m2g-8cgm-3vcp, merged after the 0.1.14 preparation. (#293)

### Verification

- Rendering PR verification: 401 focused tests passed, TypeScript and Biome passed. Its broader suite passed 1,954 tests; the capability-audit failure was corrected, while the unrelated dependency-symlink path-scan failure remains documented in `docs/TERMINAL_RENDERING_REPORT.md`.
- Release preparation: 78 version/CLI/package-metadata tests passed; TypeScript, Biome, version consistency, CLI `--version` (0.1.15), and `npm pack --dry-run` passed. The dry run includes 227 files (596,893 bytes).
- Public npm registry verification on 2026-10-09 confirms that 0.1.15 is published.

---

## [0.1.14] — 2026-10-09 — Model Catalog and Antigravity Removal (prepared)

### Added

- Reasoning controls follow what each model supports: advertised levels, a bounded thinking budget with its own picker, and auto or off modes. A model whose reasoning is fixed or unknown says so instead of offering a setting that does nothing. The choice is saved per model, and unsupported values are rejected before a run starts. (#290)
- Native Gemini is back in provider config and saved sessions. Models are discovered through the Gemini API or the CLI's OAuth login, and thinking controls are supported. (#290)

### Changed

- Every provider's model list comes from one shared catalog. The catalog:
  - caches and refreshes the list, with separate entries per account and endpoint;
  - keeps showing the last good list (marked unverified) when a refresh fails;
  - keeps exact model IDs separate from display names. (#290)
- Mistral models come from the authenticated Mistral API instead of Vibe config aliases. (#290)
- If a saved model disappears, Ubume asks you to pick a model instead of silently switching to another one. Legacy Vibe aliases that collide with a native model ID also have to be picked again. (#290)
- Cloud runtimes no longer show context usage in the footer. (#290)

### Removed

- The Antigravity (`agy`) provider:
  - its runtime and model discovery;
  - its `/resume` section, native session browsing, and `agy --conversation` handoff;
  - the `antigravity` source for `--import-session`;
  - its diagnostics entry and `antigravity_command_path` config.
- What happens to existing data:
  - Saved Antigravity routes and workspace defaults, including the legacy `agy` backend alias, fall back to the default provider.
  - Saved Antigravity chats open as "provider unavailable" and ask for an explicit provider and model before sending.

(#291, re-landed in this release)

### Security

- Ubume still pins DeepSeek Harness `0.1.1-rc.2`. GHSA-8m2g-8cgm-3vcp (CVE-2026-82533, critical) covers an authentication bypass in that version's local HTTP control-plane API.
  - Ubume runs the harness over stdio and never starts that HTTP server. In a real harness run, the harness process opened no listening socket, so Ubume isn't exposed.
  - `npm audit` doesn't flag the advisory because the affected range is a prerelease range; Dependabot does.
  - Upgrading the harness is tracked separately.

### Internal

- #291 was merged into #290's branch after #290 had already landed, so it never reached `main`. This release carries it as its first commit.
- `docs/RELEASING.md` explains the `ENOENT … src/config/package.json` error from running `npm publish` in `src/config`. (#290)

### Verification

- `npm run prepublishOnly` passed: 1,920 tests, TypeScript, and Biome. The full suite also passed under a real PTY. npm audit: zero vulnerabilities.
- The release branch's tree is identical to the reviewed #290 + #291 result.
- The packed tarball (225 files, 587 kB) was installed in an isolated prefix, and these checks passed:
  - `--version` reported 0.1.14;
  - `doctor --json` returned `ok: true`;
  - packaged Harness inference ran against a local mock endpoint;
  - in a real PTY, Ctrl+O opened the model picker, Ctrl+T opened the transcript, and `/provider` listed OpenAI, Anthropic, Google, Mistral, and Local with no Antigravity. Ctrl+Q exited cleanly.
- npm publication is pending; the version is prepared for review.

---

## [0.1.13] — 2026-10-08 — Ctrl+O Model Picker

### Changed

- Ctrl+O opens the model picker again. 0.1.3 had moved it to Alt+P and used Ctrl+O for the transcript inspector. Alt+P still opens the model picker too.
- The transcript inspector moves to Ctrl+T. `/transcript` is unchanged.
- `/help` and `docs/TERMINAL_WORKBENCH.md` list the new shortcuts.

### Verification

- `npm run prepublishOnly` passed: 1,851 tests, TypeScript, and Biome. The full suite also passed under a real PTY. npm audit: zero vulnerabilities.
- New regression tests: keymap unit tests, plus Ink end-to-end tests for raw (`\x0f`) and Kitty CSI-u (`ESC[111;5u`) Ctrl+O, and for Ctrl+T. They fail against the 0.1.12 keymap.
- The real-App workbench test now opens the transcript with Ctrl+T.
- The packed tarball (218 files, 581 kB) was installed in an isolated prefix. `--version` reported 0.1.13. In a real PTY, Ctrl+O opened the model picker, Ctrl+T opened the transcript, and Ctrl+Q exited cleanly.

---

## [0.1.12] — 2026-10-08 — Local Browser Use and Ctrl+C Exit (prepared)

### Added

- Local models can drive a browser through 14 structured Local Harness tools: open, inspect, click, type, press keys, select, navigate, and take screenshots, reusing one browser across turns. Run `ubume browser install` to install Chromium (requires Node 18+). Under `on-request`, click, type, press, and select need a one-use approval. Sensitive fields are masked, and browser traffic stays on loopback when network access is disabled. See `docs/LOCAL_BROWSER.md`. (#274)

### Removed

- The `openai-native` backend, which was a stub that could never run, along with the backend picker and the `/backend` and `/backends` commands. Config that still names it falls back to the default backend and is reported as an ignored entry. (#278)
- The `UBUME_STABLE_RENDER=0` legacy timeline render path. (#278)

### Fixed

- Ctrl+C behaves like Claude Code and Codex.
  - In 0.1.11 the first press exited immediately.
  - Ctrl+C now stops an active run or clears the draft first.
  - On an empty prompt it shows `Press Ctrl+C again to exit` under the input for 2 seconds, and a second press while the hint is visible exits.
  - The hint no longer lands in the transcript, and pressing again after it expires shows it again instead of appearing to do nothing. (#283, #285)
- Provider setup errors name the provider being set up instead of always reporting "Mistral Vibe setup failed". (#278)
- Plan storage honors `UBUME_DATA_DIR` on Windows, the Codex model cache seed honors `CODEX_HOME`, and the pre-rename update-check cache is read again. (#278)
- `ubume-dev --headless-benchmark` keeps the benchmark flag. (#278)
- External-session discovery honors injected Windows home directories (`USERPROFILE`). (#279)
- The composer's Ctrl+Alt+P detection timer is cleared on unmount. (#278)

### Security

- hono 4.13.12 (#275) now ships in the package. The dependabot bump had not reached `bun.lock`, from which the published shrinkwrap is generated.
- Patched transitive dependencies for advisories published since 0.1.11:
  - `@modelcontextprotocol/sdk` 1.32.1 (GHSA-6qxp-vccf-f47h)
  - `proxy-addr` 2.0.8 (GHSA-jqcg-44mw-7w3h)
  - `sharp` 0.35.5 (GHSA-wq5f-xc86-pv6w)

### Internal

- Source cleanup across #276–#282 and #284:
  - Dead code removed, with `noUnusedLocals`, `noUnusedParameters`, and `noExplicitAny` enforced.
  - Shared helpers consolidated.
  - Timeline, composer, and Local Harness modules split.
  - `app.tsx` split into typed hooks under `src/app/`, taking App from 7,669 to 1,467 lines.

### Verification

- `npm run prepublishOnly` passed: 1,843 tests, TypeScript, and Biome. Capability audit: 17/17. npm audit: zero vulnerabilities.
- Added a real-App regression test. The exit hint appears, clears when the window expires, re-arms on the next press, and a second press exits. This test failed on 0.1.11's main before the fix.
- Real-PTY checks through `bin/ubume.js` covered:
  - presses 0.3 s and 1.5 s apart, which exit;
  - a 2.5 s gap, which re-arms with a visible hint;
  - clearing a draft;
  - the Kitty keyboard protocol.
- Terminal recording: `docs/recordings/ctrl-c-double-press.cast`.
- The packed tarball (218 files, 581 kB) was installed in an isolated prefix, and these checks passed:
  - `--version` reported 0.1.12;
  - `doctor --json`;
  - fixture-provider headless execution;
  - packaged Harness inference against a local mock endpoint;
  - the Ctrl+C PTY sequence (hint, then exit at 1.5 s; re-arm after 2.5 s).
- The consumer install resolves a single copy each of hono 4.13.12, `@modelcontextprotocol/sdk` 1.32.1, proxy-addr 2.0.8, and sharp 0.35.5.
- npm publication is pending; the version is prepared for review.

---

## [0.1.11] — 2026-10-01 — Provider Resume and Durable Local Chats (prepared)

### Added

- Unified `/resume` sections for all providers, including Mistral Vibe and Local backend/model filters for LM Studio and Unsloth.
- User-level `chats/` storage with original workspace manifests, authoritative snapshots and derived summary caches. Legacy histories migrate on save without deleting their originals.
- Durable Local Harness checkpoints and recovery across process restarts. Missing or incompatible state recovers saved dialogue; storage errors remain visible.
- Original-workspace handoff, idempotent native imports, per-conversation Vibe session references, and interactive `--resume` / `--import-session` startup flags.

### Fixed

- Saved routes stay pinned and require an explicit choice when a provider, backend or model is unavailable or disabled.
- Antigravity CLI (`agy`) configuration and executable paths are retained instead of being treated as deprecated.
- Native history discovery isolates provider failures and deduplicates explicitly linked histories.

### Verification

- 1,893 tests and TypeScript checks passed, including complete process-restart and missing-state recovery tests for LM Studio and Unsloth.
- Terminal recording: `docs/recordings/provider-resume.cast`.
- The release hook passed all 1,893 full-suite tests; the additional Antigravity diagnostics regression passed separately. Capability audit: 17/17; npm audit: zero vulnerabilities.
- The verified tarball installed in an isolated prefix and passed version, doctor, fixture-provider headless execution and packaged Harness inference. The isolated terminal benchmark passed. npm accepted the verified `0.1.11` tarball; public registry processing is pending.

---

## [0.1.10] — 2026-09-30 — Input Viewport Fix (prepared)

### Fixed

- Typing after a pasted-content label stays inside the input box, and the cursor remains visible at the right edge. Measurement and rendering now share the actual container width, border, padding, and prompt dimensions.
- Full rows scroll horizontally when needed to show the cursor. Existing multiline wrapping, navigation, shortcuts, paste handling, focus, and submission are preserved.
- Invisible pasted-content and attachment IDs no longer reach Ink's output writer, where they consumed cells and shifted subsequent text. IDs remain intact in the draft and submitted prompt.
- Terminal display widths now follow complete graphemes, including combining accents and emoji sequences. Narrow layouts and terminal resizing recalculate the viewport without moving the border into editable text.

### Verification

- All 1,880 tests, TypeScript checks, the 17-check capability audit, npm audit (zero vulnerabilities), and the isolated fixture-provider PTY smoke passed.
- Added rendered-row and live input regressions for pasted labels, cursor positions and full-row boundaries, Unicode, token deletion, narrow widths, resizing, and submission with intact token IDs.
- Terminal recording: `docs/recordings/input-viewport-fix.cast`.
- `npm run prepublishOnly` passed. The clean tarball installation passed version, `doctor --json`, fixture-provider headless execution, and packaged Harness inference against a local mock endpoint. Package contents and SHA-512 integrity were verified.
- The terminal bench passed with the fixture provider in an isolated workspace; no paid provider request was made.
- npm publication is pending; the version is prepared for review.

---

## [0.1.9] — 2026-09-30 — Resume Border Fix

### Fixed

- `/resume` keeps its side border aligned when a conversation title contains a pasted-content or attachment label. Invisible composer attachment IDs are removed from display titles before terminal rendering; saved conversations and the existing panel design are preserved.

### Verification

- 1,870 Bun tests pass, including regression coverage for attachment IDs, visible Unicode, and border alignment at 60, 80, 100, and 120 columns. TypeScript checks pass.
- The terminal fixture verifies selection, section switching, and resizing; recording: `docs/recordings/resume-border-fix.cast`.
- Release validation includes the capability audit, npm audit, isolated terminal smoke, clean tarball installation, headless CLI checks, and packaged Harness inference against a local fixture endpoint.

---

## [0.1.8] — 2026-09-30 — Local Server Stall Handling

### Fixed

- A Local server that stops streaming no longer causes a ~35-minute silent hang. Previously, when context compaction timed out, the Harness re-sent the next request five more times, each waiting out the 300-second stream-idle timeout. The Local Harness profile now keeps that timeout explicit and removes `TIMEOUT` from the Local provider's retryable codes. `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER` and `TRANSPORT` still retry. The worst case is now about 10 minutes (compaction, then one request) before a clear error.
- A failed compaction is reported as failed ("could not compact the conversation (…); continuing with the full context") instead of "compacted the conversation", and no longer marks the context meter as compacted.
- Harness model retries are visible in the transcript as "Local model request failed (…); retrying N/5…" instead of running silently.
- A stream-idle timeout explains the likely cause: the server is overloaded because RAM is exhausted and model weights page from disk, or a very large uncached prompt is still being processed. It names llama.cpp's `--cache-ram` and `--parallel 1`. It no longer suggests checking tool-calling and chat-template support, which misdiagnosed this case.
- The Harness bridge now forwards the `compaction/end` error, the `turn/end` error code and `llm/retry` events that it previously dropped.

### Background

The failure was diagnosed on a llama.cpp server (via Unsloth Studio) running a 21.9 GB `qwen35moe` model on a 16 GB GPU with 31 GB RAM. llama.cpp's default 8 GiB host prompt cache filled RAM and swap, so memory-mapped expert weights were read back from disk and generation stalled. Compaction triggered it because its summary request cannot reuse the server's prompt cache and forces a large uncached prefill. This is server configuration; Ubume now fails fast and says so.

### Validation

- All 1,868 tests, TypeScript, the 17-check capability audit, and `npm audit` (zero findings) passed.
- New tests cover the profile retry policy, bridge projection, compaction failure reporting, retry progress, and the stall message.
- Against a mock server through the real Harness: a server that never responds fails once after 301 seconds with no timeout retries and shows the stall message. A server returning HTTP 500 once is retried with visible progress and completes.
- The packed tarball installed into a clean prefix and passed version, `doctor --json`, and packaged Harness mock inference on 3 consecutive runs.

---

## [0.1.7] — 2026-09-30 — Native Sessions in /resume

### Added

- `/resume` has Ubume, Claude Code, Codex, and Antigravity sections. Left/Right or 1–4 switch sections. Native sections list sessions started in the current folder, and `a` toggles all projects.
- A read-only transcript viewer shows prompts and replies, with tool calls folded until expanded. Keys: Enter or `e` expand, PgUp/PgDn scroll, `/` searches.
- From the list or the viewer:
  - `o` resumes the session in its own CLI (`claude --resume`, `codex resume`, `agy --conversation`) in the session's folder. Ubume suspends until that CLI exits.
  - `c` imports the history once into an Ubume conversation on the matching provider and continues it there. Imported history keeps the newest turns within about 200,000 characters.
- Sessions are read from each CLI's own store without modifying it:
  - Claude Code: `~/.claude/projects`, or `CLAUDE_CONFIG_DIR`.
  - Codex: the `state_*.sqlite` thread index (or `CODEX_HOME`), with a rollout-file fallback.
  - Antigravity CLI: `conversation_summaries.db` and per-conversation step databases.
- Antigravity transcripts are a labeled best-effort extraction from its binary format; older conversations show prompts only.
- Ubume's own headless runs (`codex exec`, `claude -p`), subagent conversations, and sessions without a prompt are not listed.

### Fixed

- Starting Ubume no longer creates an empty "Untitled conversation" in `/resume`. A conversation is saved from its first sent prompt, so typing a draft or a command without sending it no longer persists anything.
- Conversations with no messages are hidden from `/resume` and `ubume sessions list`; existing ones stay on disk and still load by id.

### Validation

- All 1,862 tests, TypeScript, the 17-check capability audit, the terminal PTY smoke, and `npm audit` (zero findings) passed.
- The packed tarball installed into a clean prefix and passed version, `doctor --json`, and fixture-provider headless execution.
- Packaged Harness mock inference passed on 3 consecutive runs. The very first run after installation timed out at the script's 25-second limit while Bun compiled the freshly installed sources.
- The listing and transcript readers were checked against real local stores:
  - Claude Code: 84 sessions.
  - Codex: 491 threads.
  - Antigravity: 292 conversations.
- The live TUI was driven through all sections and viewers. The provider-backed `smoke:terminal-bench` was not run.

---

## [0.1.6] — 2026-09-30 — Fresh Install Harness Compatibility

### Fixed

- Pinned the compatible Cordis/HMR dependency family used by the Harness. Fresh installs otherwise resolved newer transitive versions whose HMR service lacks the API expected by Harness 0.1.1-rc.2, causing session startup to close its JSON-RPC input. The clean installed package now completes mock inference.
- Avoided wrapping an already detailed session-open error as a second prompt-disconnect error.
- Made the Harness’s required peer service providers explicit dependencies so legacy peer mode does not omit modules needed at startup.
- Shipped a consumer shrinkwrap aligned with the tested Bun graph. The updater and displayed npm upgrade command use `--legacy-peer-deps` to avoid npm repeatedly expanding the Harness’s cyclic plugin peers; fresh global npm installation passes Harness inference with this flag.
- Updated vulnerable `fast-uri` and `ip-address` transitive versions within their compatible release lines; the locked npm runtime audit reports zero findings.
- Updated npm and Bun lockfiles, package version, generated version metadata, and release notes together. Added `sync:npm-lock` and a fresh-install Harness smoke script to make release checks repeatable.

### Validation

- All 1,823 tests, TypeScript, the capability audit, terminal PTY smoke, locked `npm ci`, and fresh global npm installation passed. The globally installed package passed version, diagnostics, headless execution, and mock Harness inference. The locked runtime npm audit reports zero findings. Live Ornith inference was unavailable.

### Release correction

- 0.1.5 was published before the fresh-install Harness result was checked. Its source integration passed but its clean installation failed. Use 0.1.6, which includes the terminal/runtime changes below and the dependency correction.

---

## [0.1.5] — 2026-09-30 — Local Runtime and Terminal Controls

### Fixed

- Local backend selection shares concurrent validation and reuses successful checks for five seconds. Picker checks have a three-second deadline; timeouts are shown separately from stopped servers, and previous models remain visible while checking.
- Unsloth key validation returns the model metadata, removing the duplicate model-list request. Inference still checks the active model before starting a turn.
- Harness initialization and session opening support cancellation and a ten-second deadline. Session disconnects report their phase and redacted stderr, invalidate failed transports, and do not automatically resend a failed turn. Shutdown escalates to SIGKILL and waits for the owned child.
- Ctrl+C has one App handler across screens, including plan actions. It preserves active drafts, shows cleanup status, and a second interrupt during cleanup requests exit.
- Completed and resumed plans show **Implement in Auto** and **Redo plan**. Implementation turns off plan mode and uses Auto; redo starts immediately with the original task, current plan, and constraints. Repeated actions cannot launch overlapping runs.
- Active providers show **is working** instead of **ready**, including while a command draft is being typed. A fixed-width highlight flows through the status text every 120 ms, without rerendering the timeline. Disabled loaders, static debug mode, and no-color terminals remain supported.

### Validation

- Added shared-discovery, timeout, canceled Harness startup/session-open, redacted disconnect, actual packaged Harness inference, and actual App plan-action regression tests.
- All **1,823 tests** and TypeScript checks passed, along with the 17-check capability audit and terminal PTY smoke test. Its fresh tarball installation passed version, diagnostics, and headless execution, but Harness inference failed; see the 0.1.6 correction.
- The packaged Harness was checked against a mock Unsloth inference server. A live Unsloth server was unavailable on this machine.

---

## [0.1.4] — 2026-09-30 — Reliable npm Updates

### Fixed

- **Updates refresh npm registry metadata** — the updater and displayed npm
  command now use `--prefer-online`. After publication, npm could read a new
  `latest` tag from one cached response and an older full manifest from another,
  then fail with `ETARGET` because that manifest did not list the new version.
- **Tests**: updated command-generation and subprocess argument assertions;
  all 1,814 tests and TypeScript checks passed. The packed installation was
  checked for the refresh flag, diagnostics, and non-interactive execution.

---

## [0.1.3] — 2026-09-30 — Terminal Workbench and Headless Commands

### Added

- **Compose during runs** — type the next instruction while the agent works;
  queue instructions and edit, remove, reorder, pause, or continue them with
  `/queue`. `/send-now` interrupts and continues after provider cleanup.
- **Terminal editing controls** — conventional line and word navigation,
  deletion, history search, input undo, multiline navigation, and an external
  editor shortcut. Ctrl+C stops the active run while preserving the draft;
  Ctrl+L redraws and `/clear` explicitly clears the conversation.
- **Inspect and review work** — `/transcript` expands tool commands, output,
  errors, and activity; `@` attaches workspace text files with ignore rules;
  `/diff` shows recorded file changes.
- **Previewed recovery** — `/rewind` branches conversation history or restores
  supported text-file checkpoints, with previews, conflict checks, bounded
  snapshots, and crash-recovery journals.
- **Commands without opening the TUI** — `exec`, `doctor`, `status`, `config`,
  `providers`, `models`, and `sessions` support explicit workspaces and JSON
  output. Exec accepts stdin and file attachments, saves by default, and can
  continue a saved conversation with `--resume`.

### Fixed

- **Resume preserves the workbench** — saved history, partial replies,
  drafts/cursors, attachments, plan state, and queued instructions survive
  restart and TUI/CLI continuation. Resumed queues remain paused.
- **Provider and model routing** — shared execution honors saved provider/model
  routes, explicit overrides, and configured executable paths. Headless runs
  report unavailable providers rather than silently selecting another one.
- **Run and recovery races** — queue dispatch waits for shutdown and checkpoints;
  session/workspace ownership prevents concurrent writes; stale callbacks from
  canceled runs cannot replace the next turn's output.
- **Input and output bounds** — attachment expansion counts repeated content;
  tool output is bounded; final answer suffixes are retained; subprocess
  cancellation waits for stubborn descendants. Missing option values no longer
  consume following flags, and custom stdin streams can be canceled while idle.

### Maintenance

- Added fresh-process App resume tests, CLI integration coverage, checkpoint and
  editing regressions, and a recorded PTY workbench smoke test. All 1,814 tests,
  typecheck, the 17-check capability audit, and terminal smoke checks passed.
- Live-provider authentication/inference and Windows/macOS terminal behavior
  were not verified by the fixture-based release checks.

---

## [0.1.2] — 2026-09-29 — Honest Status and Error Reporting

### Fixed

- **Composer no longer says "Still waiting for <CLI>" while the provider is
  working** — `MemoizedBottomComposer` compared only a collapsed "busy" persona
  key and ignored `externalCliStatus`, so once a run started it kept rendering
  the stale THINKING/"starting" label with a running timer. The comparator
  (`areBottomComposerPropsEqual` in `src/ui/chrome/BottomComposer.tsx`) now
  re-renders on `uiState.kind` and provider-readiness changes, and
  `src/app.tsx` marks the provider ready on its first tool call or reasoning
  update as well as assistant text. Applies to every provider route.
- **Arrow keys work again after attaching an image** — atomic `[Image: …]` and
  `[Pasted Content …]` tokens end in an invisible `U+2063`/`U+FE0x` ID.
  `getTextUnits` measured those characters as one column while
  `getTextWidth` measured zero, so the drawn cursor lagged three characters
  behind the real one and disappeared for three presses after a token. The
  markers now measure zero width (`src/ui/render/textLayout.ts`).
- **Failed runs are no longer misreported as authentication errors** —
  `isLikelyAuthFailure` matched bare `401`/`403` substrings and was fed the
  whole Codex stdout stream, so tool output such as `duration_ms: 1403` or a
  `:401:` grep hit turned any failure into "Ubume reported an
  authentication/session error" and marked Codex signed out, blocking later
  runs. Status codes now need HTTP context, generic "forbidden"/"access
  denied" no longer match, only Codex stderr is classified
  (`src/core/providers/codexSubprocess.ts`), the login hint is limited to the
  Codex route, and Ubume re-probes `codex login status` instead of forcing the
  signed-out state.
- **Tests**: added composer memo/status-line coverage, cursor-highlight
  regression coverage across image tokens, and auth-classifier true/false
  positive cases.

---

## [0.1.1] — 2026-09-13 — No Unrequested Workspace Files

### Fixed

- **Local agent no longer litters the project with `.ubume/scratch`** — every
  writable Local Harness turn eagerly created `.ubume/scratch/<session>/` and a
  `.gitignore` inside the workspace, even when the agent never wrote a
  throwaway file, so an empty `.ubume` folder showed up next to the user's
  files. The session scratch path is now only described in the prompt; the
  folder and its `.gitignore` are created when a mutating tool call's path or
  command actually targets `.ubume/scratch`
  (`src/core/providerRuntime/localHarness/runtime.ts`), and when the run
  completes or fails an empty session folder is removed along with any
  `.ubume/scratch` and `.ubume` folders it leaves empty
  (`removeUnusedSessionScratchDir` in `src/core/workspace/scratchDir.ts`).
  Scratch still lives in the workspace because Harness's bwrap sandbox mounts a
  fresh tmpfs over `/tmp` per command.
- **Tests**: added `scratchDir.test.ts` coverage for side-effect-free
  description, scratch-target detection, and unused-folder removal; updated the
  Local Harness runtime tests to assert nothing is created at session open and
  that the folder appears only when a tool targets it.

---

## [0.1.0] — 2026-09-13 — Project Rename to Ubume CLI

### Changed

- **Project rebranding to Ubume CLI** (`ubume`): Renamed package to `ubume`, executable to `ubume`, and repo/tool identity to Ubume CLI with pre-1.0 initial version `0.1.0`.
- **Launchers & Bridge**: Added primary `bin/ubume.js` launcher with legacy `bin/codexa.js` backward-compatibility deprecation wrapper. Added `bin/ubume-local-harness-bridge.js` with `codexa-local-harness-bridge.js` alias.
- **Config & State Migration**: Moved active configuration, plans, model cache, trust store, and scratch directories to `.ubume/` (`~/.local/share/ubume`, `~/.ubume-settings.json`, `.ubume/scratch`) with automatic non-destructive migration of existing `.codexa` user files.
- **TUI & Wordmark**: Rebranded ANSI block logos, ASCII art, status messages ("✧ Ubume is thinking"), and headers.
- **Update Checks**: Configured update checking against `ubume` npm registry.
- **Remaining Codexa references**: Finished renaming user-facing text, identifiers, debug log prefixes, dev shims (`ubume-dev` / `ubd`), home-dir caches and logs (`.ubume-update-check.json`, `.ubume-perf.jsonl`, `.ubume-input-debug.log`), and local-harness profile and env names (`ubume-local`, `UBUME_DSH_*`).
- **Legacy compatibility**: Every `CODEXA_*` environment variable still works. The launcher and both entry points copy it into its unset `UBUME_*` name (`src/config/legacyEnv.ts`). `--codexa-prompt-policy`, the `codexa.mode` / `codexa.backend` config keys, the `codexa` / `codexa-dev` / `cxd` commands, and `scripts/audit-codexa-capabilities.mjs` are all still accepted.
- **Codexa model family unchanged**: The native PyTorch / CuPy / NumPy models keep the Codexa name, including the provider IDs `codexa-native` / `codexa-cupy`, the model IDs, checkpoint paths, bridge scripts, the "Codexa Native" label, and `CODEXA_NATIVE_*` / `CODEXA_CUPY_*` / `CODEXA_NUMPY_*`.

---

## [1.0.28] — 2026-09-12 — Resume Reliability

### Fixed

- **Resumed conversations keep every reply** — the assistant message was saved
  only when a run completed, so canceled or failed runs, and quitting mid-run,
  dropped everything the model had streamed. Resuming a Local conversation
  after an approved plan showed only the plan. Every run outcome is now saved:
  interrupted replies keep their partial text plus a `[Run canceled before
  finishing]` / `[Run failed: …]` note.
- **Replies record what the run did** — each saved reply carries a compact
  `Files changed` / `Commands run` summary that `/resume` shows under the
  reply. Completed replies keep their exact content (the summary is stored
  separately) so Local Harness session reuse still matches.
- **`/resume` no longer prints the Codexa logo twice** — resume remounted the
  transcript without arming the clear-frame boundary that `/clear` uses, so
  the pre-resume screen was restored and a second logo stacked beneath it.
- **Resumed Local conversations use their saved backend** — the restored route
  dropped `localBackend` and fell back to LM Studio's default endpoint, so an
  Unsloth-served model failed with `Connection error` even while loaded.
  Model availability on resume is also checked against the saved backend.
- **New prompts no longer merge into restored turns** — restored turns were
  numbered from 1 while live turns use a separate counter, so a new prompt
  could replace a restored prompt and attach its run to that old turn,
  duplicating or misplacing blocks. Restored turns now share the live counter.
- **The context meter no longer resets to 0 after a failed turn** — zero
  usage reports are ignored.

### Maintenance

- `/clear` and `/resume` share one clear-boundary arming helper.
- New coverage for persisted reply building, conversation store round-trips,
  resumed routes and turn ids, and a clear armed while an overlay is open.

---

## [1.0.27] — 2026-09-12 — Plan Approval Cleanup

### Fixed

- **The approved plan is no longer printed twice** — pressing `Implement
  changes` seeded the execution run with the approved plan, which re-rendered
  the entire `Plan` card directly under the `Plan approved. Plan mode off` line.
  The plan is already finalized in the transcript whenever that picker is shown,
  so the echo was always a duplicate. The provider still receives the plan
  through the execution prompt.
- **A live card taller than the viewport keeps its frame** — the live-row
  window sliced the running turn from the end without regard for card
  boundaries, leaving a borderless box that began mid-sentence. When a cut lands
  inside a bordered card, the card is now re-capped with its own top border plus
  an `⋯ N rows hidden` notice, still within the row budget that keeps Ink from
  wiping the scrollback.

### Maintenance

- Timeline rows carry optional frame metadata (`top`/`content`/`bottom`) set by
  the two box builders and preserved through row wrapping, with coverage for
  card-aware windowing, padded-card alignment, and the narrow-terminal label
  fallback.

---

## [1.0.26] — 2026-09-03 — Image Paste and Copy-Ready Commands

### Added

- **Clipboard images can be attached to supported models** — press `Ctrl+V` or
  use `/paste-image` to add an attachment chip. Codexa forwards images through
  Codex CLI and vision-enabled Local Harness models, and preserves the draft
  with an actionable error when the selected route cannot accept images.

### Fixed

- **Shell commands are copy-ready** — shell fences now use a small comment-style
  language label followed by raw, unnumbered commands, without a decorative box
  or a misleading `Copy Code` title becoming part of the terminal selection.

### Maintenance

- Added coverage for clipboard capture, atomic image chips, Codex image
  arguments, Local Harness image content blocks, and `/paste-image` routing.

---

## [1.0.25] — 2026-09-03 — Automatic Local Output Continuation

### Fixed

- **Long Local Harness responses now continue automatically across output
  windows** — reaching a model's per-request output-token limit sends a focused
  continuation prompt through the existing Harness session instead of
  finalizing a truncated answer. Assistant text, tool state, approvals, context
  compaction, and workspace tracking remain part of one logical Codexa run.
- **Continued responses persist as one complete assistant message** — streamed
  display content and the final conversation payload are tracked separately so
  the saved history contains the entire answer without duplicate rendering.
- **Stalled continuations fail safely** — productive text and tool activity may
  roll over without a fixed limit, while two consecutive windows with no
  visible progress return an actionable error. Cancellation prevents further
  continuation prompts or final callbacks.

### Maintenance

- Added Local Harness regression coverage for multi-window output, reasoning-only
  exhaustion, tool progress, cancellation, stable progress updates, final
  session metadata, and single-response finalization.

---

## [1.0.24] — 2026-09-03 — Long-Session Performance and Local Reasoning Recovery

### Fixed

- **Long sessions no longer get slower with every turn** — the frame boundary
  hashed and scanned Ink's whole accumulated transcript on every frame for
  trace payloads that were discarded when tracing was off, and the transcript
  shell rebuilt the row model for every finalized turn on each keystroke and
  streaming tick. Trace work now runs only while tracing is enabled, finalized
  turns are built once and cached by event identity, and a keystroke rebuilds
  nothing.
- **Old history is bounded** — only the newest 200 turns keep rendered rows in
  memory. Older turns stay in the terminal's scrollback; after a width resize
  only the retained window is redrawn. `/clear` and conversation resume also
  drop the row caches.
- **Local reasoning models that exhaust their output budget while thinking are
  recovered instead of failing with "no visible output"** — Codexa now reads
  the harness stop reason, sends one "continue and act" prompt in the same
  session, and otherwise reports the real cause with token counts. The default
  output budget scales with the context window (8K–32K), and a Local model can
  opt in to `supports_reasoning_effort` so the active reasoning level is
  forwarded to the model.

---

## [1.0.23] — 2026-09-03 — Plan Mode and Streaming Scroll Fixes

### Fixed

- **Plan mode no longer shows the model's exploration chatter inside the plan
  box, or above the tool calls it ran to build the plan** — text streamed
  before a tool call is now rendered as ordinary prose in place, and the plan
  panel only ever contains the section generated after the last tool call, at
  the end of the transcript. The planning prompt also now asks for a final
  message that is only the plan.
- **Scrolling up while a response streams no longer snaps back to the
  bottom** — the live transcript region is tail-windowed to the terminal
  height so Ink never has to clear the scrollback mid-stream; the complete
  turn is still committed to scrollback once it finishes.
- **Pressing "Implement" on an approved plan now actually writes files
  instead of producing text and staying in plan mode** — approving a plan
  upgrades a read-only execution mode to a writable one and turns plan mode
  off for the session, so the local provider's sandbox can perform the
  approved changes and the footer reflects the new mode.

---

## [1.0.22] — 2026-09-02 — Startup Input Reliability

### Fixed

- **Keyboard input survives the startup update check** — the App root now holds
  Ink's raw-mode lease for the process lifetime, so moving the composer between
  the overlay and transcript shells no longer detaches stdin input handling
  (typing and Ctrl+C were dead after "Checking for Codexa updates...").

---

## [1.0.21] — 2026-09-01 — Reliable Updater Rendering

### Fixed

- **Installation replaces the available-update card** — the updater now uses
  mutually exclusive available, installing, success, and failure states instead
  of stacking installation progress beneath the original prompt.
- **Canceling an installation preserves the complete TUI** — Escape cancels the
  active updater process, restores the available-update state, retains keyboard
  focus, and ignores stale output or completion from the canceled attempt.
- **Startup update checks no longer hide the Codexa header** — the normal
  transcript buffer receives a fresh static logo, workspace, and provider frame
  before it is exposed, preventing the composer-only blank-screen state.
- **Local API-key fingerprints are no longer reusable offline digests** —
  Harness credential-change detection now uses process-salted scrypt instead
  of hashing the configured secret directly.

### Maintenance

- Added updater lifecycle, immediate and repeated cancellation, full-shell,
  initial alternate-buffer, and credential-fingerprint regression coverage.

---

## [1.0.19] — 2026-08-30 — Reliable Local Workflows

### Added

- **Local conversations roll over context without losing task continuity** —
  long-running sessions create a persisted semantic checkpoint before moving
  older transcript content out of the active request window.
- **Local streaming diagnostics are available on demand** — privacy-aware,
  environment-gated traces help diagnose LM Studio, Unsloth, and Codexa Native
  response streams without recording response text by default.

### Fixed

- **Local agents can finish workflows longer than ten tool calls** — progress
  is bounded by completion, cancellation, or repeated unchanged results instead
  of an arbitrary total-call limit, so explicitly requested commits, pushes,
  and pull requests are not handed back as unfinished user commands.
- **Restored Local models show their discovered context size** — startup model
  discovery now refreshes the active route metadata even when the persisted
  model ID did not change, replacing the temporary `Unknown` context label.
- **Failed context rollovers cannot affect later token accounting** — transient
  response coverage resets at each run boundary and stored checkpoints receive
  strict validation when conversations are reopened.
- **Runtime mode persistence is failure-tolerant** — filesystem errors no longer
  escape into the terminal UI.

### Maintenance

- Simplified transcript rendering around native terminal scrollback and removed
  obsolete mouse-capture, plan-review, and timeline-navigation code.
- Added focused Local streaming, context rollover, agent-loop, persistence, and
  terminal-render regression coverage.

---

## [1.0.18] — 2026-08-28 — Unsloth Local Backend

### Added

- **Unsloth Studio is available as a Local backend** — Codexa can discover
  loaded Unsloth models, select the Unsloth route, and use its OpenAI-compatible
  inference endpoint alongside LM Studio.
- **Local backend selection is persistent** — workspace routes retain whether
  Local should use LM Studio or Unsloth, with independent status checks in the
  provider picker.

### Fixed

- **Local backend diagnostics are explicit** — unavailable servers, missing
  models, and authentication requirements are reported per backend without
  changing the stable Local provider identity.

### Maintenance

- Added Unsloth routing, discovery, workspace configuration, provider-picker,
  and regression coverage for the new backend.

---

## [1.0.17] — 2026-08-24 — Native Local Tools and Provider Clarity

### Added

- **Local models can use native OpenAI-compatible tools** — verified model profiles receive structured tool definitions, assistant tool-call IDs are preserved, and matching tool results are returned across multi-step agent turns.
- **DeepSeek-family Local models receive compatibility defaults** — family detection fills missing reasoning, system-prompt, streaming, and tool-call capabilities without inventing context or output-token limits.
- **Codexa Native models have a focused child picker** — PyTorch and CuPy routes appear under one Codexa Native provider entry while retaining their distinct model identities.

### Fixed

- **Fragmented Local tool calls are reconstructed safely** — streamed IDs, function names, JSON arguments, reasoning content, malformed calls, and finish reasons are normalized before execution.
- **Local agent loops preserve native protocol state** — multiple tool calls, duplicate-call protection, approval decisions, malformed-call feedback, and final-answer recovery now retain the correct call IDs and roles.
- **Header rendering tests are stable across terminal redraw timing** — assertions inspect individual Ink writes instead of treating accumulated redraw history as one frame.

### Maintenance

- Added repository-level deterministic Bun test concurrency for reliable local and prepublish validation.
- Configured the scoped npm package for publication to GitHub Packages.
- Updated package, lockfile, generated build metadata, release documentation, architecture notes, and regression coverage for `1.0.17`.

---

## [1.0.16] — 2026-08-16 — Resumable Conversations and Compact Imports

### Added

- **Workspace-scoped conversation history** — Codexa stores durable conversation metadata and messages outside the project, restores previous chats through `/resume`, and carries bounded history into supported provider routes.
- **Responsive resume picker** — previous conversations can be selected from a keyboard-driven panel that adapts to the available terminal rows.

### Fixed

- **Local import confirmation no longer clips its primary action** — long attachment paths are shortened below the home directory, file details are compacted, and the horizontal Import/Cancel choices now use matching Left/Right navigation.
- **Restored conversations render complete assistant turns** — resumed timeline events retain both user and assistant content before the next prompt.

### Maintenance

- Removed unused conversation-route state and an unconsumed conversation-title export found during the release audit.
- Updated architecture and source documentation for conversation persistence and resume flow.
- Removed the duplicate root documentation file; `docs/DOCUMENTATION.md` is now the single technical documentation guide.
- Updated package metadata for the `1.0.16` patch release.

---

## [1.0.15] — 2026-08-15 — Reliable Long Local Responses

### Fixed

- **Long Local-model generations no longer fail at the HTTP header timeout** — Codexa requests streaming completions by default, allowing LM Studio to establish the response immediately while large models continue reasoning.
- **Streaming remains compatible with the Local agent loop** — fragmented assistant text, reasoning-only output, and OpenAI-style tool-call names and arguments are reconstructed before execution without exposing tool protocol markup in chat.
- **Explicit non-streaming models keep their supported path** — models reporting `supports_streaming: false` continue using ordinary JSON completions.

### Tests

- Added Local-provider regression coverage for default streaming, SSE text reconstruction, fragmented tool calls, and the non-streaming capability fallback.

---

## [1.0.14] — 2026-08-15 — Repository Cleanup

### Changed

- **The project landing page is easier to scan** — installation, providers, core controls, and development links are presented without duplicated operational detail.
- **Release documentation identifies the current package correctly** — stale current-version wording was removed and the publishing guide now targets `1.0.14`.

---

## [1.0.13] — 2026-08-15 — One-Key Update Restart

### Added

- **Successful updates can close Codexa immediately** — the completion panel now provides a focused `Restart now` button; pressing Enter exits the current process cleanly so the newly installed version can be launched.

### Tests

- Added update-completion keyboard coverage for the restart action and its visible instructions.

---

## [1.0.12] — 2026-08-15 — Update Overlay Stability

### Fixed

- **Returning from the update prompt restores the full home screen** — the overlay exit now resets the Ink frame cache and repaints the static Codexa header instead of leaving a large blank area above the composer.
- **Horizontal update selection is visible and terminal-compatible** — the selected action has an explicit `❯` marker, with raw VTE, application-cursor, xterm, and Kitty arrow sequences supported.

### Tests

- Added raw arrow-protocol and overlay-exit repaint ownership coverage.

---

## [1.0.11] — 2026-08-15 — Update Menu Navigation

### Changed

- **Update actions follow their visual layout** — the horizontal Update now and Later choices use Left/Right navigation and show the matching keyboard hint.
- **Startup updates appear before chat input** — Codexa opens a cached update immediately or briefly checks npm before enabling the composer, preventing a delayed prompt from interrupting typing.

### Tests

- Updated update-prompt navigation and startup-render coverage for horizontal selection and pre-composer checks.

---

## [1.0.10] — 2026-08-15 — Local Planning and Permission Controls

### Added

- **Plan mode works across every supported provider** — Codex, Claude, Mistral, Antigravity, and Local use the shared plan-review workflow with an explicit read-only planning turn.
- **Safety modes rotate without an overlay** — Shift+Tab cycles Plan, Read-only, Auto, and Full Access while the active mode stays visible in the footer.
- **Local model mutations require real approval** — On request and Untrusted policies pause before writes, patches, and shell commands with Allow once, Allow for run, and Deny choices.

### Changed

- **Large pastes stay compact** — bracketed pastes of 1,000 or more characters render as `[Pasted Content … chars]` while the complete content is retained for the provider.
- **Outside-file imports explain their scope** — the confirmation panel now provides keyboard-navigable Import once and Cancel actions and makes clear that no folder access is granted.

### Fixed

- **Overlay focus is unambiguous** — the composer caret is hidden while another panel owns keyboard focus.
- **Shift+Tab works across terminal protocols** — VTE, xterm, Kitty CSI-u, and modifyOtherKeys backtab encodings are recognized without adding mode-change notices to chat.

### Tests

- Added paste-boundary, raw-payload, atomic-navigation, import-navigation, provider planning, safety-mode rotation, terminal backtab, local approval, and read-only Plan-mode coverage.

---

## [1.0.9] — 2026-08-14 — Responsive UI and Security Maintenance

### Changed

- **Codexa Native is restricted to the local-development channel** — the native runtime remains available for local development while published routing continues to use supported external providers.
- **Dependency maintenance is consolidated** — Ink, React, TypeScript, and Node type definitions were updated to the validated release set.

### Security

- **Process and workspace validation is hardened** — shell execution keeps argument boundaries explicit, Windows batch arguments are validated, and workspace/Cargo path checks use bounded, anchored matching.

### Fixed

- **Provider and model pickers now consume the terminal space available to them** — fixed three/five-row-style windowing has been replaced by a shared responsive capacity and continuous scroll offset. Short lists render in full; overflowing lists show the selected position rather than artificial page ranges.
- **Picker resize and compact behavior is stable** — selection remains visible while navigating or resizing, offsets and invalid dimensions are clamped, and 80×20 panel screens use the existing compact header so list rows take priority. At 100×22 all current provider rows fit alongside the composer and runtime status.
- **Narrow and wide picker rows remain bounded** — secondary metadata yields to names at narrow widths, display-width-aware ellipses prevent border wrapping, and wider layouts retain aligned provider capability metadata.
- **All short-terminal overlay panels expose their options** — Theme (`Ctrl+T`), Mode (`Ctrl+P`), Settings, Auth, provider, and model screens use the compact one-line Codexa header at 24 rows or fewer and no longer lose rows to a redundant close-panel hint.
- **Dense Auth and Settings panels remain readable** — Auth collapses secondary guidance before hiding its three preferences, while Settings keeps each option group on one clipped row so neighboring labels cannot overlap.
- **Theme and generic selection lists no longer drop options** — the fixed `ink-select-input` viewport and stacked padded cards were replaced with the shared continuous responsive list. All nine themes fit at 100×22, the current item owns the cursor, and arrow-key theme previews apply immediately.
- **Development startup is cleaner** — `codexa-dev` no longer prints the `Launch mode` readiness/tip transcript block on startup or after `/clear`; the relaunch command itself remains available.

### Tests

- Added shared viewport tests for complete-list fit, continuous scrolling, larger-terminal capacity, data/resize clamping, and invalid dimensions; updated provider, model, and shell integration coverage for responsive indicators and row use.
- Manually verified the live provider and model panels at 80×20, 100×22, 120×30, and 160×40, including resizing an open 20-model list with its selected item retained.

---

## [1.0.8] — 2026-07-14 — Packaging Maintenance

### Changed

- **Published executable metadata is normalized** — the package now records the `codexa` binary as `bin/codexa.js`, matching npm's canonical package format and avoiding publish-time normalization warnings.
- **Runtime behavior is unchanged** — this maintenance release contains no CLI, configuration, provider, or UI behavior changes.

---

## [1.0.7] — 2026-07-14 — Clean Workspaces

### Changed

- **Codexa no longer creates `.codexa` directories in projects** — provider preferences, imported attachments, and default diagnostic logs now use platform user-data storage instead of the active workspace.
- **Provider settings remain workspace-specific without becoming project files** — Codexa stores each workspace's route, model, and reasoning preferences under a hashed user-data directory.

### Migration

- Existing `.codexa/providers.json` files remain untouched and load as a legacy fallback. When you next save provider settings, Codexa writes the migrated configuration to user data only.
- Existing `.codexa` directories are never deleted automatically.

---

## [1.0.6] — 2026-07-14 — Startup Update Notice

### Fixed

- **New releases are checked on every interactive startup** — Codexa now fetches npm's `latest` tag each time the TUI opens, so a release published after a previous launch is detected on the next run instead of waiting for a cached check to expire.
- **Update prompts are delivered safely** — if Codexa is busy or another panel is open when npm responds, the update prompt waits until the user returns to the idle main screen. Choosing “Later” dismisses it only for that session.
- **Package-manager guidance matches the install** — passive update notices now show the detected npm, pnpm, Yarn, or Bun update command.

### Notes

- Automatic checks remain disabled for local development launches. Headless `codexa exec` output is unchanged.

---

## [1.0.4] — 2026-05-30 — Update Notice Reliability

### Fixed

- **Update notices now use the npm `latest` tag reliably** — Codexa compares the running version against `dist-tags.latest` for `@golba98/codexa` and shows a clear prompt when the installed version is older.
- **Manual `/update check` bypasses stale cache** — explicit checks fetch fresh npm metadata and report update available, already up to date, or a short failure reason.
- **Failed update checks are not cached as success** — startup still fails silently on network or malformed-registry errors, but those failures no longer hide future updates.

### Notes

- Published npm versions are immutable. v1.0.2 contains update-check code, but any runtime prompt defects in that published package cannot be patched retroactively. Users on older versions should run `npm install -g @golba98/codexa@latest`.

---

## [1.0.3] — 2026-05-30 — Package-Ready Release

**This is the package-ready release.** The installed/downloaded Codexa package now includes the full startup UI and matches the working dev/local version.

### Fixed

- **Installed package now shows full Codexa UI** — the large ASCII logo/header, version line, workspace, provider, and footer are all present after `npm install -g @golba98/codexa`. Previously, the published tarball predated the UI overhaul and produced a stripped-down startup screen.
- **`gen-build-info` now runs as part of `prepublishOnly`** — the `APP_VERSION` constant embedded in the package (`src/config/buildInfo.ts`) is guaranteed to match `package.json` at publish time. Previously, publishing without running `npm run build` first could leave a stale version constant in the tarball, causing the header brand line and `codexa --version` to disagree.

### Changed

- **Semantic color-token system** — theme tokens are now lowercase (`logoPrimary`, `text`, `textMuted`, etc.) rather than the legacy uppercase API. This was a ground-up refactor of `src/ui/theme.tsx` and all consuming components.
- **Responsive ASCII logo** — `src/ui/logoVariants.ts` introduces three logo variants (full block-art wordmark, 4-row ASCII fallback, compact single-line) selected by viewport size. Minimum column/row thresholds ensure the logo degrades gracefully on small terminals.
- **Package exclusions corrected** — test files (`*.test.ts`, `*.test.tsx`) and dev-only scripts are excluded from the published tarball. Runtime source is included in full.
- **Linux and Windows package paths verified** — `bin/codexa.js` uses `import.meta.url`-relative `packageRoot` resolution and `join()` throughout; Windows selects `bun.exe`, Linux/macOS selects `bun`.

### Notes

- Dev and production share the same UI renderer. The installed `codexa` command shows `Codexa v1.0.3`; the dev launchers (`codexa-dev` / `cxd`) show `Codexa v1.0.3-dev local`.
- This release does not include new features. It is a package correctness and release-process fix.

### Update checker behavior (for users on v1.0.2)

v1.0.2 contains update-check code, but any prompt defects in the published v1.0.2 package cannot be patched retroactively. If the notice does not appear, run `npm install -g @golba98/codexa@latest`.

The update checker fetches `dist-tags.latest` from `https://registry.npmjs.org/@golba98%2Fcodexa` and compares it against the running version. Update checks are disabled for local dev builds.

---

## [1.0.2] — internal

Color system and package cleanup pass. Not re-released as a standalone version; improvements folded into v1.0.3.

## [1.0.1] — initial release

Initial published release of Codexa.
