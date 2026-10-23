# Terminal workbench

The composer remains editable during provider and shell runs. Enter during a
provider run queues an instruction with its expanded text and image attachments.
Accepted instructions run once, in order, after the previous provider has stopped
and its file checkpoint has finished. Failure, cancellation, approval requests,
questions, and plan review pause automatic execution. `/queue` lets you edit,
delete, reorder, pause, or continue pending instructions.

| Action | Shortcut or command |
|---|---|
| Line start/end | Ctrl+A / Ctrl+E |
| Character movement | Ctrl+B / Ctrl+F |
| Word movement | Alt+B / Alt+F |
| Delete previous word | Ctrl+W |
| Delete to line start/end | Ctrl+U / Ctrl+K |
| Restore deleted text | Ctrl+Y |
| Search history | Ctrl+R; repeat to find the next match |
| Undo input | Ctrl+_ |
| Newline | Shift+Enter when supported, Alt+Enter, Ctrl+J, or backslash then Enter |
| External editor | Ctrl+G; uses VISUAL, then EDITOR |
| Stop active run | Ctrl+C or Esc; draft and session remain intact |
| Redraw viewport | Ctrl+L; conversation and scrollback remain intact |
| Model picker | Ctrl+O (or Alt+P) |
| Provider picker | Ctrl+Alt+P |
| Execution mode | Shift+Tab |
| Send queued instructions immediately | Ctrl+X then Ctrl+S, or `/send-now` |
| Inspect tool activity | Ctrl+T or `/transcript` |
| Review file changes | `/diff` |
| Preview recovery | `/rewind` |
| Resume | `/resume` picker (Ubume, Claude Code, Codex, Mistral Vibe), or `/resume <id>` |
| Clear conversation | `/clear` |
| Preferences | `/preferences` (Startup Logo, Color Theme) |
| Exit | Ctrl+Q or `/exit`; on an empty prompt, Ctrl+C shows "Press Ctrl+C again to exit" for 2 seconds and a second press exits |

Up/Down move through visual lines before entering prompt history. Leaving history
restores the original draft and cursor. Attachments behave as a single unit during
cursor movement and deletion. Typing `@` opens file suggestions; Up/Down choose a
file and Tab or Enter attaches it. Git ignore rules apply, with a recursive
`.gitignore` fallback outside Git. Symlinks, generated directories, and `.env`
files are excluded. Text attachments are limited to 1 MiB per file and 8 MiB per
prompt. Queued file content is fixed at submission; editing a queued instruction
places that expanded content into the draft and retains its image attachments.

Send-now uses provider steering when a runtime exposes it. Current runtime
adapters use interrupt-and-continue: cancel the current process, await cleanup,
and start one follow-up containing the pending instructions and current draft.
The queue remains paused after this explicit continuation. Late callbacks from a
canceled run cannot overwrite the new turn.

## Appearance and preferences

`/preferences` opens the centralized preferences panel. Today it holds the
appearance category; more categories will be added over time.

| Entry | Opens | Notes |
|---|---|---|
| Startup Logo | Startup Logo picker (Normal / Minimal / Simple) | Applies immediately and persists across restarts |
| Startup Animation | Enabled / Disabled picker | Plays the compact logo's assembly animation at interactive startup (Minimal and Simple) |
| Color Theme | The `/theme` picker | Same setting and same commit path as `/theme` |

Keyboard controls: Up/Down (or `k`/`j`) move, Enter opens the highlighted
entry, Esc closes the current screen and returns to the previous one. Inside
the Color Theme picker, moving the cursor previews the highlighted theme
immediately; Enter commits it and Escape restores the previously committed
theme.

A committed theme or logo style applies at once: the visible home screen is
repainted atomically (the startup banner included) without clearing your
terminal scrollback, and without touching the conversation, input buffer,
provider or model. Transcript content that has already scrolled into history
keeps the colors it was printed with; only the live region and future output
use the new palette. Changing a theme never triggers provider calls or model
requests.

Startup logo styles:

- **Normal** — the original large `UBUME` ASCII banner, with its existing layout
  and behavior (the default for new and older configurations).
- **Minimal / Simple** — the same developer mark on the left, sized to the terminal. The right
  column shows `Ubume CLI vX.Y.Z`, the provider by default, and the current directory.
  Metadata is truncated within its column; below 40 inner columns the logo is hidden.

**Responsive size.** The mark grows in whole rows, always four columns per row, from 12×3
cells up to 40×10: about one seventh of the terminal height or 18% of the header width,
whichever is smaller (80×24 → 12×3, 100×30 → 16×4, 120×40 → 20×5, 160×45 → 24×6,
200×60 → 32×8, 240×70 and larger → 40×10). The metadata column always keeps at least 24
cells, the header always leaves room for the startup notice and composer, and taller marks
center their metadata vertically. A small hysteresis band keeps the size steady while a
window edge is dragged across a boundary. Solid and graphical output share one cell
footprint, so the layout never shifts when an image replaces the solid fallback. Sizing
lives in `src/ui/render/startupLogoLayout.ts`; a terminal cannot change its font size, so
"larger" always means more cells, never a scaled font.

While the compact header is live, every resize (width or height) repaints with a
scrollback-inclusive clear once its replacement is ready. During a long transcript
reflow, the current live view first adapts with a viewport-only repaint. A shrinking
window pushes the top of the live frame (the header) into scrollback, and only that clear
removes those copies; otherwise each small → big cycle would leave another header behind.
Theme and logo changes, which do not change geometry, still redraw only the visible screen.

`Startup Header → Middle Line` selects **Provider**, **Model**, **Provider + Model**,
**Usage**, or **Hidden**. Hidden places the title and directory on adjacent rows.
Usage prefers estimated context utilization, clearly labeled as an estimate. If no
context window is known, it uses an already cached allowance for the current account
scope, or displays `Usage unavailable`. Rendering never requests provider usage.
The bottom provider/model/reasoning status bar is independent of this setting.

`Appearance → Logo Rendering` offers **Auto**, **Kitty Graphics**, **iTerm2 Images**,
**Sixel**, and **Solid Text**. The picker shows the effective backend and a live
preview; press `r` to replay. Short viewports open a separate preview screen.
Highlighting previews a renderer without persisting it; Enter saves the selection.

Auto prefers positively verified Kitty placeholder placements, then native iTerm2
images, then Sixel, and finally solid text. Native row-image placement requires a
recognized terminal profile (WezTerm or iTerm2) and measured pixel cell dimensions;
Sixel also requires a confirmed background color. Unknown or unsafe placements fall
back rather than forcing escape sequences. Native row protocols are disabled inside
multiplexers. Kitty through tmux requires successful end-to-end replies; Screen falls
back. SSH uses inline data and the same positive capability checks.

Sharp rasterizes the shared SVG to the measured cell region of the selected size while
preserving its aspect ratio (the vector is rendered at the target resolution, never a
scaled-up bitmap). The solid half-block fallback uses pixel-hinted versions
of the same paths, with no Braille or dotted artwork. Its edges are necessarily coarser
than graphical output. All protocols travel through Ink's existing frame writer.
Kitty image residency is refreshed across screen-buffer changes, and after a resize the
data-free placements are re-issued (≈350ms and 1.2s later) because Kitty can leave an image
placed while it is still settling an OS-window resize unpainted until the next redraw.
Native image tiles are placed and erased with their owning rows. If an image cannot be
prepared (for example Sharp is unavailable), the header falls back to solid text for the
session and Logo Rendering reports "Image rendering failed". Once the header enters scrollback it
uses solid text. Historical rows retain their original colors.

**Startup animation.** Minimal and Simple show the slash first, then inward-moving
brackets, a short theme highlight, and the completed mark. Fourteen sampled frames use eased movement over
520ms. Late frames are skipped rather than extending the animation. Input is available throughout. Theme, provider, model and usage changes do not
replay the animation. Disabling Startup Animation or setting
`UBUME_NO_STARTUP_ANIMATION=1` renders the completed mark immediately. Non-TTY and
small-terminal output never animates. No animation timer remains after completion.

Settings persist in `~/.ubume-settings.json`: `ui.theme`, `ui.startup_logo_style`,
`ui.startup_animation`, `ui.startup_logo_rendering`, and `ui.startup_header_middle_line`.
Missing or invalid new values default to Auto rendering and Provider middle line.
Changing a header preference leaves the bottom bar and provider session intact.

## Inspect and recover

The transcript shows timestamps, models, status, commands, errors, supplied tool
output, and detected file changes. Enter expands a selected entry, `/` searches,
and PgUp/PgDn scroll. Providers that do not supply detailed output are identified
in the viewer. Captured tool output is limited to 256 KiB per tool and 8 MiB per
turn, with a visible truncation marker.

Checkpoints are captured around provider turns. The diff viewer compares
supported text files across the session or a chosen
turn. Left/Right chooses the scope, Up/Down selects a file, and Enter opens its
patch. It includes supported tracked, untracked, created, and deleted files and
preserves the dirty workspace baseline before the first run.

The rewind picker offers conversation-only (`c`), files-only (`f`), or both (`b`).
Enter first displays a preview; a second Enter applies it. Conversation recovery
creates a branch and retains the original session. File recovery preserves exact
bytes, CRLF, and permissions. Later manual edits, missing blobs, symlinks, or
incomplete required checkpoints block restoration. A journal rolls back failed
or interrupted restorations; startup resume checks that journal before allowing
new work. Binary and oversized files are omitted. Each boundary is limited to
64 MiB, and stored checkpoint blobs to 256 MiB per conversation; exceeding these
limits disables file restoration for affected checkpoints. Checkpoints cover
workspace text files, not external processes or external state.

## Persistence and resume

One atomically replaced `snapshot.json` stores dialogue, exact submitted context,
transcript, draft/cursor, history, attachment registries, pending instructions,
plan review state, and file checkpoints. Older `messages.json`/`metadata.json`
sessions remain readable. Invalid auxiliary state falls back to dialogue-only
recovery. Saved active runs become interrupted turns; partial replies remain
visible and available to the next provider request. Resumed queues always start
paused. Missing image files or unresolved attachment chips produce a visible
error before submission.

A new conversation is saved from its first sent prompt. Starting Ubume and
quitting, or typing a draft without sending it, does not create a `/resume`
entry, and conversations with no messages are not listed.

Resume restores the complete saved transcript, including dialogue-only and legacy
answers, code blocks, interrupted runs, and recorded tool outcomes. Historical tool
operations are display data and never execute on restore. All restored turns are
written to native scrollback, including turns outside the 200-turn row cache.

The saved provider, model, reasoning and Local backend are restored. An unavailable
route blocks submission until you explicitly choose a working provider/model.
Owned Claude, Codex, Google/Antigravity, Mistral Vibe and Local sessions can retain
native continuation metadata. The next prompt validates the saved native context;
loading a transcript alone does not establish a provider connection. Codex resume
requires help-confirmed support for structured output, model selection and policy
configuration. Unsupported or incompatible native state uses saved dialogue with
a notice; explicit missing-session errors can retry once before any productive
activity. Authentication, quota and tool failures never trigger a replay.

Session selection prepares the target under a temporary lease before committing.
Escape cancels loading. Save or checkpoint-recovery failures retain the previous
conversation and its lease. `/clear` also retains the conversation if saving fails.
Background snapshot flushing does not change the recorded last conversation activity.

### Native CLI sessions

`/resume` starts on All, with provider sections for OpenAI, Anthropic, Google,
Mistral and Local. Left/Right or section numbers switch filters. It lists sessions
from the current folder by default; `a` toggles all projects. Ubume reads those CLIs' own session stores
read-only and never modifies them.

| Key | In the list | In the transcript viewer |
|---|---|---|
| Enter | Open the transcript viewer | Expand or collapse the selected entry |
| `o` | Resume natively (`claude --resume`, `codex resume`, `agy --conversation`, `vibe --resume`) in the session's folder; Ubume suspends until that CLI exits | Same |
| `c` | Continue inside Ubume: the history is imported once into an Ubume conversation on the matching provider | Same |
| `/` | Search | Search entries |
| `e` | — | Expand or collapse all tool calls |
| Esc | Close | Back to the list |

Native sessions linked to an owned conversation are deduplicated by provider, session ID and workspace. Standalone programmatic sessions remain visible. Imported
history is capped at about 200,000 characters, keeping the newest turns.

The picker starts on **All**, with sections for OpenAI, Anthropic, Google, Mistral and Local. In Local, `b` cycles all backends, LM Studio and Unsloth; `m` cycles recorded models. `a` switches between this folder and all projects. Search and filter choices survive transcript navigation.

Ubume saves chats under its user data folder: `chats/<workspace-key>/conversations/<id>/snapshot.json`, with the original folder in `workspace.json` and local agent journals under `local-harness/v-<version>/`. The default Linux root is `~/.local/share/ubume` (or `$XDG_DATA_HOME/ubume`); `UBUME_DATA_DIR` overrides it. Older histories are copied on their next save, leaving original files intact.

Resuming another project reopens Ubume in its displayed original folder. The old
application releases terminal input and completes cleanup before the replacement
starts; previous startup prompts and resume targets are not replayed. Chats with
missing folders remain available for viewing. Press `c` to locate their original
folder or select an existing destination for relocation. Relocation requires typing
`RELOCATE`; it creates a linked copy with a new ID and retains the original record.
Native sessions, file checkpoints, queued actions and attachment registries are not
carried into the relocated execution context. The destination's permissions apply.
Existing symlink aliases are compared by their filesystem identity while legacy
storage keys remain readable. An unavailable saved model or backend requires an explicit choice through `/provider` or `/model` before sending. Restarting does not silently switch providers. Local agent sessions flush before completed-turn persistence and recover into a fresh session when older state is missing or incompatible.

From a terminal, `ubume --resume chat_ID` opens a saved chat without sending a prompt. `ubume --import-session vibe:SESSION_ID` imports a native history in the current workspace. Supported native sources are `claude`, `codex`, `google` and `vibe`.

A deterministic [resume picker recording](recordings/provider-resume.cast) shows provider sections and Local backend/model filters; regenerate it with `bun scripts/maintenance/record-resume-picker.tsx`.

## Verification

`bun test src/session/workbenchApp.test.ts` runs actual Ink app instances in fresh
processes using a deterministic provider. It exercises abrupt restart, draft and
partial reply recovery, a paused resumed queue, FIFO dispatch, send-now, provider
cleanup, stale callbacks, and draft preservation during cancellation.

`python3 scripts/testing/smoke-workbench.py` creates a temporary workspace and data root,
uses a deterministic provider, and records the actual app through a PTY. It does
not invoke a paid provider. Play the included [recording](recordings/terminal-workbench.cast)
with `asciinema play docs/terminal/recordings/terminal-workbench.cast`. Live authenticated provider
behavior still depends on the installed provider CLI and terminal keyboard
protocol; the recording is a UI smoke test.

`bun run check:resume` drives the installed launcher through isolated real PTYs at
60×20, 80×24, 100×22, 120×30, 160×40 and 200×50. It checks selection, search,
cancellation, full long-history restoration, live resizing, native continuation,
and actual execution in another workspace using a deterministic provider.
`bun run bench:resume` measures metadata listing, hydration and transcript caching.
Both write generated evidence only under ignored development reports.

### Resize responsiveness

Terminal measurements commit on the leading event and coalesce subsequent events in
16 ms frames. Resize scheduling does not own provider execution or persistence.
Long finalized transcripts prepare their new wrapping in cooperative slices while
the prompt and newest output remain interactive. The existing clear-frame boundary
publishes the complete prepared history atomically and prevents old dimensions
from replacing a newer layout. Temporary historical tail rows may retain their
previous line breaks until this preparation completes.

Run `bun run check:resize` for offline executable-driven PTY scenarios and three
independent Claude/Mistral/Google adapter terminals. `bun run bench:resize --scenario
history --iterations 5 --cycles 3 --check-performance` additionally enforces the
100 ms P95 live-geometry target on the benchmark host. `UBUME_RESIZE_TRACE` enables
bounded monotonic phase records; it is disabled during normal execution.

Large historical TTY writes yield between complete lines and control strings.
Empty-write flush barriers retain their ordering for native CLI handoffs. A width
change discards obsolete queued frames; a height-only change preserves valid
same-width history unless an authoritative clear supersedes it. Hidden overlay
shells do not measure a second transcript.
