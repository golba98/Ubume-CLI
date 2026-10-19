# UI subsystem

`src/ui/` is Ubume's terminal presentation layer, built with **Ink 7 and React 19**. It
renders the transcript, the composer, the header and every overlay panel, and it turns
keystrokes into callbacks. It owns *view* state only: highlighted rows, scroll offsets,
the composer's undo stack and similar. Application state (runs, sessions, provider
routes, settings, the draft text) belongs to `src/app`, which composes these components
and passes data and callbacks down.

Dependencies point one way: `src/app` → `src/ui` → `src/core`, `src/session` (types) and
`src/config`. Nothing in `src/ui` imports `src/app`, and `src/core`/`src/session` never
import `src/ui`. Side effects such as provider changes, persistence and update installs
are reached only through injected callbacks or runners.

Per-file details live in each module's header comment and in the `src/ui/` tables of
[docs/architecture/source-guide.md](../../docs/architecture/source-guide.md). App wiring is described in
[docs/architecture/app.md](../../docs/architecture/app.md).

## Directory map

| Path | What lives there |
| --- | --- |
| `theme.tsx` | Palettes, `ThemeProvider` / `useTheme()`, and the preview-without-persist theme selection reducers. |
| `layout.ts` | Terminal geometry: layout modes, shell/content widths, the header/transcript/composer row budget, `useTerminalViewport`, and the panel-size contexts. Also `resolvePickerPanelGeometry`. |
| `chrome/` | Persistent chrome: `AppShell` (overlay screen), `TopHeader`, `BottomComposer`, status indicators, update card. |
| `chrome/composer/` | Composer internals: `useComposerInput` (controller), `composerKeymap` (key → action), `composerEditing` (pure edits), `historySearch` (Ctrl+R), `pasteAssembler` (paste reassembly), `composerModel` (props, status text, measurement). |
| `input/` | Shared input plumbing: focus ids (`focus`), text-buffer maths (`inputBuffer`), pasted-content tokens (`pastedContent`), slash commands, raw arrow decoding, raw-stdin signals, and the raw-mode lease. |
| `panels/` | Overlay panels and pickers. The two complex pickers keep their logic in pure `*Model.ts` modules (`modelPickerModel`, `providerPickerModel`). |
| `render/` | Text pipeline: Markdown parsing and rendering, diff tones, terminal answer formatting, runtime labels, logo variants. |
| `timeline/` | Transcript: `TranscriptShell` (main screen), `Timeline` (overlay screen), viewport maths, the static transcript cache, and `measure/` (row builders). |

## Rendering architecture

```text
App.tsx ─┬─ screen === "main" ──▶ TranscriptShell ─┬─ <Static> finalized rows (native scrollback)
         │                                         ├─ live rows for the running turn (tail-windowed)
         │                                         └─ notice + BottomComposer
         └─ screen !== "main" ──▶ AppShell ────────┬─ TopHeader
                                                   ├─ panel stage (<OverlayPanels/> from src/app)
                                                   └─ BottomComposer
```

- **Measured rows.** Transcript content is converted to `TimelineRow[]` by the builders in
  `timeline/measure/`, and then rendered row by row (`TimelineRowView`). Every row is
  exactly one terminal line. The viewport, the live-window trimming and the composer
  placement are all row arithmetic that depends on this.
  `TurnGroup`/`AgentBlock`/`DashCard`/`ActionRequiredBlock` are a component-form
  transcript used only by tests; production never mounts them.
- **Static vs. live.** Finalized turns go into Ink's `<Static>` once and become terminal
  scrollback. Only the running turn re-renders per stream delta. Live output must stay
  shorter than the terminal, otherwise Ink clears screen and scrollback on every frame
  (see `timeline/liveViewportWindow.ts`).
- **Repaint ownership.** Clearing the screen, width-resize repaints and alternate-screen
  switching for overlays are owned by `src/core/terminal/clearFrameBoundary.ts`, together
  with the frame write. UI components must not clear the terminal or toggle the alternate
  screen from effects. See the terminal lifecycle section of the root `CLAUDE.md`.
- **Memoized chrome.** `AppShell` and `BottomComposer` are memoized with hand-written
  comparators (`areBottomComposerPropsEqual`, and `AppShell`'s comparator), so stream
  deltas do not re-render them. A new prop that affects their output must be added to the
  comparator.

## State and lifecycle

| State | Owner |
| --- | --- |
| Draft text and cursor, run state, sessions, provider route, settings, theme selection | `src/app` (passed as props) |
| Highlight, scroll offset and drill-in mode of a picker | The picker component |
| Model picker draft (row, identity, reasoning) | `modelPickerSelectionReducer` via `useReducer` |
| Composer undo stack, kill ring, suggestion index, history search, Ctrl+X chord, desired column | `useComposerInput` |
| Terminal viewport | `useTerminalViewport` (one instance, in `src/app`) |

Rules the components follow:
- **Pure where possible.** Selection rules, editing, windowing and key mapping are
  plain functions in `*Model.ts`, `composerEditing.ts` and similar modules, tested
  without rendering. Components handle effects and rendering.
- **Re-sync when inputs change under you.** For example, an open model picker
  re-synchronises its draft when discovery refreshes the list. The highlight follows
  the same model, otherwise keeps its clamped index, and Enter on an empty list cancels
  with `empty-selection`.
- **Clean up everything you start.** Every timer, stdin listener and debounce is
  released on unmount. Look for the `useEffect` cleanup next to each `setTimeout` or
  `stdin.on`.
- **Discard stale async results.** Async work such as the composer's workspace file
  listing ignores results that arrive after its effect was superseded.

## Input, keyboard and focus

- **Ink `useInput`** delivers parsed `(input, key)` events. Each focusable component
  registers with `useFocus({ id: FOCUS_IDS.x, autoFocus: true })` and gates its handler
  with `isActive: isFocused`, so only the focused surface receives keys.
  `src/app/lifecycle/useFocusRouting.ts` moves focus when the screen changes. Ink blurs
  every focusable when it flushes a bare Esc, so the router (or, for the plan prompt,
  the component itself) re-claims focus.
- **Raw stdin signals** (`input/rawStdinSignals.ts`) cover sequences that Ink mis-parses
  on some terminals: mouse reports (their fragments are swallowed), Ctrl+M sent as CSI-u,
  Ctrl+Alt+P, and Shift+Tab variants. The raw listener opens a short hold window that the
  `useInput` handler checks.
- **Composer key path:** raw signals → `composerKeymap` (the single source of composer
  bindings, evaluated in precedence order) → `useComposerInput` performs the action.
  Global shortcuts come first, then a pending Ctrl+X chord, then edits. Text edits never
  run while a modal state (history search, suggestion lists) claims the key.
- **Split escape sequences.** An arrow key split across two reads arrives as Esc followed
  by `[B`. Pickers that act on Esc delay it briefly (`PlanActionPicker`:
  `ESCAPE_SETTLE_MS`) and reassemble the arrow from raw bytes.
- **Raw-mode lease.** `useStdinRawModeLease` keeps one raw-mode reference for the
  app's lifetime, so Ink does not churn its stdin listener when the composer moves
  between shells.

Main composer bindings (see `composerKeymap.ts`):

| Keys | Action |
| --- | --- |
| Enter | Submit (completes a partial slash command; `\` + Enter inserts a newline) |
| Shift/Alt+Enter, Ctrl+J | Newline |
| ↑/↓, Ctrl+P/N | Move between lines, or through suggestions and history |
| Ctrl+A/E, Home/End | Line start/end |
| Ctrl+B/F, Alt+B/F | Character / word left/right |
| Ctrl+W/U/K, Ctrl+Y, Ctrl+_ | Kill word / to line start / to line end, yank, undo |
| Ctrl+R | Reverse history search |
| `@` | File mention (Tab/Enter accepts, Esc dismisses) |
| Shift+Tab | Cycle mode |
| Ctrl+O (Ctrl+M via CSI-u, Alt+P) | Model picker |
| Ctrl+Alt+P | Provider picker |
| Ctrl+X Ctrl+S, Ctrl+Enter | Send now |
| Ctrl+T / Ctrl+G / Ctrl+V | Transcript / external editor / paste image |
| Esc, Ctrl+C, Ctrl+L, Ctrl+Q | Cancel, interrupt, redraw, quit |

## Terminal size and resizing

`useTerminalViewport` reports dimensions on stdout `resize`. On the first event it marks
`isResizing` (and pauses animations) without committing intermediate sizes. It commits
the final size once events stop for `RESTORE_SETTLE_MS`. `computeAppLayoutBudget` splits
the height between header, transcript or panel stage, and composer. Panels read their
share through the layout contexts (`usePanelLayout()`, `useActivePanelLayout()`, …), and
the pickers use `usePickerPanelGeometry`. Below 20 × 10 the shell shows a "cramped"
placeholder.

Width handling: use `getTextWidth`, `clampVisualText` and the wrapping helpers in
`src/core/shared/text.ts` for anything that is measured. They account for wide (CJK,
emoji) and combining characters. Subprocess output is sanitised
(`sanitizeTerminalOutput`) before it is measured, so control sequences from providers
cannot corrupt the layout.

## Integration with core services

The UI reads core *types* and *pure helpers*, for example model capabilities, reasoning
controls (`core/models/reasoningControl.ts`), provider configs, text width and
sanitisation. It does not discover models, write `providers.json`, persist sessions or
spawn processes. Those happen in `src/app` through the callbacks it passes: `onSelect`,
`onAction`, `onSubmit`, `onChangeInput`, and so on. `UpdatePromptPanel` receives its
update runner as a prop for the same reason.

## Error handling

Expected failures (an unavailable model, an empty model list, a provider that cannot be
used) are data. `src/app` passes messages such as `emptyMessage`, `refreshMessage` and
`routeUnavailableReason`, and the panels render them. Components do not catch and hide
exceptions from callbacks; those propagate to the app. Async UI work that may fail, such
as the file-mention listing, falls back to an empty result.

## Themes and styling

Use `useTheme()` tokens (`theme.text`, `theme.textMuted`, `theme.accent`, `theme.prompt`, …)
rather than literal colours, so all built-in and custom themes work. Panels use a round
border with `paddingX={1}`; size calculations reserve those 4 columns.

## Adding a component or panel

1. Put it in the matching folder (`panels/` for overlays, `chrome/` for persistent
   chrome, `timeline/` for transcript rendering).
2. Take data and callbacks as props; keep app state and side effects in `src/app`.
   Extract non-trivial selection, layout or key logic into a pure function or reducer
   next to the component, and test it directly.
3. Focusable panels: add an id to `FOCUS_IDS` and the screen mapping in `focus.ts`, use
   `useFocus({ id, autoFocus: true })`, and gate `useInput` with `isActive: isFocused`.
4. Size the panel from the layout contexts. Anything that contributes rows to the shell
   must have a matching `measure…Rows` function.
5. Release timers and listeners in effect cleanups.
6. Add a module header comment and a row in `docs/architecture/source-guide.md`.

## Testing

```sh
bun test src/ui                      # all UI tests (~1 min)
bun test src/ui/panels/ProviderPicker.test.tsx
bun run typecheck
bunx biome ci src/ui
```

- **Pure modules** (`*Model.ts`, `composerEditing`, `historySearch`, `pasteAssembler`,
  measurement, layout) are tested directly. `pasteAssembler` takes injected timers.
- **Components** are rendered with Ink's `render()` into `PassThrough` stdin/stdout
  streams marked `isTTY`, using `debug: true` so that each write is a whole frame. Keys
  are written to stdin as raw bytes (`"\u001b[B"` for ↓, `"\r"` for Enter). See
  `panels/ModelPickerRecovery.test.tsx` or `chrome/BottomComposer.test.ts` for the
  pattern. Strip ANSI before asserting on text.
- Tests never use real providers, credentials or user configuration. Pass mock models
  and providers as props.

## Known constraints

- The memo comparators in `AppShell` and `BottomComposer`, and the terminal lifecycle in
  `core/terminal/`, are deliberate. Do not "simplify" them; see the root `CLAUDE.md`.
- `src/appRenderStability.test.ts` checks `AppShell.tsx`'s source to make sure it never
  uses Ink's static component.
- Row builders and their renderers must agree on "one row = one line". Measurement
  functions (`measureBottomComposerRows`, `measurePlanActionPickerRows`,
  `measureTopHeaderRows`, …) must match what the component renders.
- Raw escape-sequence handling (mouse, CSI-u, split arrows) depends on terminal
  behaviour. The hold and settle windows (32–120 ms) are tuned values; change them only
  with tests.
