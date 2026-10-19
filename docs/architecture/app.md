# `src/app/` — interactive app architecture

`src/app/` is the composition layer of the interactive TUI. It connects the
deterministic lower layers (`core/`, `session/`, `config/`, `commands/`) to the
Ink UI components in `ui/`. Lower layers never import from `app/`.

**Where to start reading**

1. `src/app/App.tsx`: its header lists the invariants, and its labelled
   sections show the order in which every hook is composed.
2. `state/useAppState.ts` and `state/useRunRefs.ts`: the shared state and refs
   every other hook receives.
3. The hook for the feature you are changing (see the map below). Every
   module opens with a header that states its responsibility, owned state and
   invariants.

## 1. Directory structure

| Folder | Responsibility |
| --- | --- |
| `App.tsx` | Root component. It composes the hooks, holds the terminal and clear-frame wiring inline, and renders `TranscriptShell` (main chat) or `AppShell` + `OverlayPanels` (overlays). |
| `state/` | Startup initialization and shared state: `useAppState` (state slots, startup snapshots read once) and `useRunRefs` (stable run-lifecycle refs). |
| `lifecycle/` | App-wide effects not tied to a feature: `useAppLifecycleEffects` (settings autosave, unmount cleanup), `useFocusRouting` (screen-to-focus routing), `useTerminalUiState`, `useAppDebugTracing` (debug-only), `useUpdateCheck`. |
| `settings/` | Preferences and runtime config: `useSettings` (UI and policy setters), `useRuntimeSettings` (session runtime overrides, **all** `providers.json` writes), `useThemeCommit`. |
| `providers/` | Provider navigation and routing: `useActiveProviderRoute` (which route a prompt uses, the provider registry), `useProviderRoute` (provider picker actions, Local probes, CLI launch/setup), `providerActions.ts` (pure decisions), `routeStatus.ts` (`/status`), `useProviderUsage` (`/usage`). |
| `models/` | Model inventories and selection: `useModelCatalog` (discovery, startup probes), `useModelSelection` (the single activation path), `selectionLogic.ts` and `catalogLogic.ts` (pure), `useModelPickerModel` (what the picker shows), `useActiveModelMetadata`, `useOpenAiModelReconcile`. |
| `run/` | Prompt and shell runs: `usePromptRun` (gates and turn bootstrap), `promptGates.ts` (pure pre-flight checks), `providerRunSession.ts` (one provider run, React-free), `useRunLifecycle` (finalize, cancel, quit), `runFinalize.ts`, `promptRunPrep.ts`, `usePlanFlow` (plan mode and queue draining), `usePromptExecution` (`!shell`, workspace relaunch), `shellLineBatcher.ts`. |
| `conversation/` | Conversation records: `useConversation` (composes the three hooks below), `useActiveConversation` (create, autosave, run messages), `useResumeFlows` (every conversation switch), `useStartupNotices`, `useClearConversation` (`/clear`), `conversationMetadata.ts` (pure), `conversationPersistence.ts`. |
| `input/` | Composer submission and keys: `useAppInput` (submission pipeline), `submitSteps.ts`, `commandDispatch.ts` (slash command effects), `useComposerEditing`, `useAppComposer` (composer element), `useWorkbenchActions` (queue, send-now, rewind, imports), `useInterruptKeys` (Ctrl+C, Ctrl+Q, Ctrl+L). |
| `overlays/` | `OverlayPanels.tsx` (renders the overlay for the current screen) and `useOverlayRouting` (opening overlays). |

Pure modules (`*Logic.ts`, `providerActions.ts`, `promptGates.ts`,
`runFinalize.ts`, `conversationMetadata.ts`, `promptRunPrep.ts`) have colocated
unit tests. Hooks are covered by the App-level fixtures under `src/test/fixtures/`
(`workbenchApp.tsx`, `modelRecoveryApp.tsx`), the hook harness in
`models/modelRecovery.test.tsx`, and the source guards in
`src/appRenderStability.test.ts`.

## 2. Dependencies between components

```
                     App.tsx
                        │ composes (in this order)
  state ─► lifecycle ─► providers/useActiveProviderRoute ─► models (metadata, picker)
                        │
  conversation ─► settings/useRuntimeSettings ─► models/useModelCatalog
                        │
  models/useModelSelection ─► settings/useSettings ─► providers/useProviderRoute
                        │
  overlays/useOverlayRouting ─► run/useRunLifecycle ─► input/useComposerEditing
                        │
  conversation/useClearConversation ─► run/usePromptExecution ─► run/usePromptRun
                        │
  input/useWorkbenchActions ─► run/usePlanFlow ─► providers/useProviderUsage ─► input/useAppInput
```

A hook receives the callbacks of hooks composed before it through its context
object. The few backwards references (for example a provider action
re-dispatching itself after an async preflight) go through refs owned by
`useAppState` (`providerActionRef`, `saveWorkbenchRef`, `captureFinalRef`).

## 3. Application startup lifecycle

1. `src/index.tsx` validates the terminal, sets terminal modes and renders `<App>`.
2. `useAppState` runs during the first render. It resolves the workspace root,
   loads project instructions, and reads settings, the update cache,
   `providers.json` and the layered TOML config **once**. It also seeds the
   transcript with the startup notices. If a startup update check is enabled,
   the first screen is `update-prompt`, which holds the composer until the
   check finishes.
3. `useActiveProviderRoute` resolves the active route: the restored
   conversation route, then a `--model` override, then the saved route.
4. Effects started on mount:
   - `useModelCatalog` subscribes to the catalog, probes Codex login and Claude
     Code, and probes the Local server when Local is active.
   - `useUpdateCheck` starts the update scheduler.
   - `useResumeFlows` handles `--resume` and `--import`.
   - `usePlanFlow` submits `--prompt` once the app is idle.

## 4. Provider selection lifecycle

The provider picker (`useProviderRoute.handleProviderAction`) is a dispatcher
over named handlers:

- `use-in-ubume`, `select-model` and `cancel` first take **navigation
  ownership** (`selectionCoordinator.navigate`) and cancel any in-flight
  validation, so a late result for the previous provider cannot commit, steal
  focus or clear busy state.
- **Use in Ubume** for a non-Local provider calls the pure
  `resolveProviderActivation`. The saved model is reused only when nothing
  says it is unusable: no session rejection, not marked unavailable by the
  catalog, and listed when the catalog is authoritative. Otherwise that
  provider's model picker opens with the provider as `pendingRouteProviderId`.
  This is what keeps a rejected Gemini model from locking the Google provider.
- **Use in Ubume** for Local saves the backend preference, probes the server,
  and activates the model it reports as loaded.
- Pressing **M** on a provider (`select-model`) always opens its model picker,
  independently of whether its saved model can initialize.
- Launch, refresh, diagnostics and setup never change the active route.

## 5. Model selection lifecycle

`models/useModelSelection.setModelAndReasoningWithNotice` is the **single
activation path** for the model picker, `/model`, provider activation and the
Local probe. It runs one transition owned by the session's
`SelectionCoordinator` (`core/models/selectionCoordinator.ts`):

```
begin(route, connection) ──► reasoning check ──► validate (abortable)
   │ aborts older transitions        │ fail             │ fail / connection changed
   ▼                                 ▼                  ▼
 pending + busy                 recover(message) ◄── reject(connection, model, failure)
                                     │
validate ok ──► persistActiveRoute ──┤ save fails ─► recover
                     │ ok
                     ▼
            commit ──► runtime model/reasoning updated ──► pending cleared (if picker closed)
```

- **Connection keys.** Evidence (validation, rejection, retry delays) is keyed
  by `providerConnectionKey(providerId, { cwd, config, routeLocalBackend })` in
  `core/models/modelCatalog.ts`. Every hook derives keys through it, and Local
  keys resolve the backend with `resolveLocalBackend` (route backend, then saved
  preference, then LM Studio).
- **Recovery** keeps the previous committed route and preferences. When the
  failing selection still owns navigation, recovery reopens that provider's
  picker. Only explicit model rejections are recorded as "unavailable"; auth,
  quota, network, rate-limit and setup failures are remembered as provider
  route errors instead.
- **Stale transitions** are ignored at every step (`isCurrent`), so an older
  validation cannot report errors or clear a newer selection's busy state.
- **Run evidence.** `usePromptRun` captures the connection and selection
  revision when a prompt is submitted. A completed run validates that model; a
  failed run rejects it only for that revision.

## 6. Prompt run lifecycle

1. `input/useAppInput.handleSubmit` routes the submission in order: direct
   commands, then `!shell`, then slash commands, then prompts (see `submitSteps.ts`).
2. `run/usePromptRun.startPromptRun` runs the gates in `promptGates.ts`: route
   readiness and model evidence, sanitizing, the workspace boundary, image
   support, backend availability, and Codex login. It then bootstraps the turn
   (user message, run refs, `SUBMIT_PROMPT_RUN`).
3. `run/providerRunSession.startProviderRunSession` starts the provider after
   the "starting" frame is visible. It takes the workspace lease, captures the
   rewind checkpoint, streams through the live render scheduler, finalizes on
   response or error, and installs `cleanupRef`.
4. `run/useRunLifecycle.finalizePromptRun` detaches the run, persists the
   assistant message, dispatches `FINALIZE_RUN`, and pauses the queue after
   failures, questions and plans. `usePlanFlow` drains the queue once the app
   is idle again.

## 7. Session and conversation management

- `useActiveConversation` creates a conversation on its first prompt and
  autosaves it: 300 ms after edits, every second while busy, when a run ends,
  and on exit. Finished runs save their assistant message, and their file
  checkpoint is completed after the provider process stops.
- `useResumeFlows` owns every switch: the resume picker, saved chats, imported
  native sessions, native CLI resume and workspace relaunch. Each switch
  refuses to start while an operation is active, holds `recoveryRef`, and
  aborts if the current chat could not be saved.
- `/clear` (`useClearConversation`) and resume both replace the transcript
  through `armTranscriptReplacement`. The clear-frame boundary clears the
  terminal in the same write as the new frame.

## 8. Configuration and persistence

| Data | Owner | Location |
| --- | --- | --- |
| Layered runtime config (TOML) | `config/layeredConfig.ts`; session overrides in `settings/useRuntimeSettings` | `~/.codex/config.toml`, trusted `.codex/config.toml` |
| UI preferences | `settings/useSettings`, saved by `lifecycle/useAppLifecycleEffects` and `settings/useThemeCommit` | `~/.ubume-settings.json` |
| Provider routes and preferences (`providers.json`) | **only** `settings/useRuntimeSettings.updateProviderWorkspaceConfig` | app-data dir (`core/workspace/appData.ts`) |
| Conversations, checkpoints, plans | `conversation/*`, `run/*` through `core/workspace/*` | app-data dir |

`updateProviderWorkspaceConfig` applies a transform to the **latest** saved
config (`configRef`), not to a closure snapshot. That stops a slow callback
from overwriting a preference saved after it was created.
`persistActiveRoute` saves before anything is published and returns `false`
when the save fails.

## 9. Error handling and recovery strategy

- **Classify at the boundary.** Provider failures are classified once
  (`core/providerRuntime/failures.ts`; `classifyValidationFailure` and
  `describeRunFailure` in `app/`). Only explicit model rejection becomes
  "model unavailable" evidence.
- **Never partially commit.** Selections persist before publishing, and
  conversation switches save first and abort on a save error.
- **Ignore stale async work.** Selection transitions, run IDs
  (`isCurrentRun`), the pipeline generation counter, navigation tokens and the
  unmount `discoveryLifetime` signal all make late results harmless.
- **Serialize disruptive operations.** `submissionRef` and `recoveryRef`
  prevent submissions, switches, `/clear` and rewinds from overlapping.
  `finishRecovery` runs a quit that was requested meanwhile.
- **Report, don't hide.** Best-effort probes (startup Local/Claude checks, the
  final workspace poll) swallow errors only where a later user action surfaces
  the same problem. Everything else posts an error event.

## 10. Invariants

- **Hook order.** Effects run in declaration order. Hooks split out of larger
  ones are called at exactly their original position: for example
  `useAppLifecycleEffects` directly before `useFocusRouting`, `useInterruptKeys`
  inside `useWorkbenchActions`, and `useConversation`'s three sub-hooks in order.
- **Inline terminal wiring.** Creating and disposing the clear-frame boundary
  controller, syncing it with session state, the alternate-screen fallback, and
  `armTranscriptReplacement` stay in `App.tsx` (see CLAUDE.md, "Terminal lifecycle").
- **Render-time refs.** `snapshotRef`, `inputValueRef`, `busyRef`, `screenRef`
  and friends are assigned during render, never in effects.
- **Discrete updates for commands.** Slash commands dispatch synchronously
  inside the key event. An `await` before dispatch lowers the update priority
  and lets Ink merge an overlay's first frame with later state. For example,
  the `/usage` loading frame would never render, which
  `session/workbenchApp.test.ts` checks. Only await once you know the
  submission needs async work.
- **Memoization.** `AppShell` is memoized with a custom comparator and
  `useAppComposer` memoizes the composer element for streaming performance;
  `OverlayPanels` is intentionally not memoized.

## 11. Adding functionality

**A slash command.** Parse it into a typed action in `commands/handler.ts` and
add discoverability in `ui/input/slashCommands.ts`. Then add a handler in
`input/commandDispatch.ts`, using `applyOrNotify` / `notifyOnly` / `run` for
the common shapes, and a case in `input/commandDispatch.test.ts`. Commands
that must bypass the parser belong in `submitSteps.matchDirectCommand`.

**An overlay.** Add the `Screen` value in `session/types.ts`, the panel
component under `ui/panels/`, an opener in `overlays/useOverlayRouting.ts`,
a focus target in `ui/input/focus.ts`, and a `screen === "…"` branch in
`OverlayPanels.tsx`. Put handlers in named functions above the JSX.

**A provider picker action.** Extend `ProviderPickerAction`, add a named
handler in `providers/useProviderRoute.ts` and a case in
`handleProviderAction`'s switch. Put decisions in `providerActions.ts` with tests.
Activate models only through `setModelAndReasoningWithNotice`.

**A run pre-flight rule.** Add a pure check to `run/promptGates.ts`, call it
from `usePromptRun`'s phase 1 in the right order, and test it in
`promptGates.test.ts`.

**A persisted provider preference.** Write it with
`updateProviderWorkspaceConfig((latest) => …)`; never call
`saveProviderWorkspaceConfig` from a hook directly.

**A new hook.** Put it in the folder that owns its responsibility and start it
with a header comment. Type its context with `Pick<AppState, …>` plus explicit
extras. If it contains effects, call it where those effects belonged in the
original order. Add the file to `docs/architecture/source-guide.md`.
