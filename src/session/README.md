# Session subsystem

The `src/session` modules own everything that makes an interactive Ubume
session a *session*: the transcript timeline and its reducer, the UI state
machine, streaming batching, the plan flow, the pending prompt queue, the
persisted workbench snapshot, and the /resume catalog that lists every
conversation Ubume can reopen.

The storage layer itself (reading and writing conversation files) lives in
[`src/core/workspace/conversationStore.ts`](../core/workspace/conversationStore.ts);
this directory owns the session-shaped data that layer persists.

## Module map

| Module | Responsibility |
| --- | --- |
| `types.ts` | The domain model: `TimelineEvent` variants, `UIState`, `Screen`, and their small helpers. The contract between session logic, the UI, and persistence. |
| `appSession.ts` | `SessionState`, `SessionAction` and the pure `reduceSessionState` reducer, plus the batching `useAppSessionState` hook. |
| `chatLifecycle.ts` | Pure `RunEvent` transformations (append deltas, tools, activity, plan text; finalize), the `UIState` reducer, and action-required/question detection on final responses. |
| `liveRenderScheduler.ts` | Coalesces high-frequency provider updates into timed flushes; schedules run starts after the first frame is visibly committed. |
| `planFlow.ts` | The `/plan` state machine: generating → awaiting action → (feedback) → executing. |
| `promptQueue.ts` | `QueuedPrompt` and the FIFO `PromptQueue` with its single-flight drain protocol. |
| `workbenchSnapshot.ts` | The persisted `WorkbenchSnapshot` format (version 1), its untrusted-JSON validation (`parseWorkbench`), and restore-time event normalization (`restoredEvents`). |
| `workbench.ts` | Stable import surface (re-exports the two modules above) plus the per-turn tool output budget and the transcript inspection view model. |
| `conversation.ts` | Conversions between persisted `ConversationMessage`s and timeline events; provider history building; saved-route reconstruction. |
| `persistedResponse.ts` | The assistant message saved for a finished run, including its compact activity summary. |
| `sessionCatalog.ts` | The /resume catalog: owned conversations across workspaces, merged with native external-CLI sessions; saved-route assessment; native imports; workspace relaunch plans. |
| `eventIds.ts` | Process-wide event/turn id counters, startup/migration system events, the initial auth status, and re-exported prompt-run timing. |
| `promptRunTiming.ts` | `PromptRunTiming`: the epoch + monotonic capture of a prompt submission. |
| `transcriptExport.ts` | Formats the transcript as clipboard text for `/copy`. |

## Session lifecycle

A session is created lazily: its first sent prompt creates the conversation
record (see `app/conversation/useActiveConversation`). From there:

1. **Submit.** The composer dispatches `SUBMIT_PROMPT_RUN`; the prompt, its
   run event and streamed assistant event enter `activeEvents` (the live
   region) and `UIState` leaves `IDLE`.
2. **Stream.** Provider updates flow through `createLiveRenderScheduler` into
   batched `RUN_*` actions. Inside the run event, a turn-global `streamSeq`
   keeps thinking blocks, tool calls, plan text and response segments ordered
   even when they interleave; response → tool → response gaps become separate
   response segments.
3. **Finalize.** `FINALIZE_RUN` reconciles the streamed text with the
   authoritative final response, commits the turn's events from
   `activeEvents` to `staticEvents`, and returns `UIState` to a terminal state
   (`IDLE`, `ERROR` or `AWAITING_USER_ACTION`). Plan presentations finalize
   into the run's plan block instead of an assistant reply.
4. **Persist.** Autosave runs 300 ms after composer/workbench changes, every
   second while busy, once at run end, and on process exit — always through
   `saveConversationRecord`, which serializes the workbench snapshot and
   writes atomically.
5. **Restore.** `/resume` (or startup resume) loads the conversation,
   validates its snapshot with `parseWorkbench`, normalizes interrupted
   events with `restoredEvents`, advances the id counters past every restored
   id (`advanceIdsPast`), and dispatches `RESTORE_SESSION`. The live region
   starts empty; the saved draft, history, registries, queue and checkpoints
   come back with it.
6. **Release.** On exit, the workspace lease and conversation lock are
   released once any in-flight provider process has stopped.

`clearEpoch` increments on every `/clear` or restore; late async results from
an abandoned epoch are dropped, so an old run can never finalize into a new
conversation.

## Storage architecture

Conversations live under the Ubume data directory, keyed by a 16-hex-character
workspace storage key:

```
<dataDir>/chats/<workspaceKey>/workspace.json      # workspace manifest
<dataDir>/chats/<workspaceKey>/conversations/     # current location
<dataDir>/workspaces/<workspaceKey>/conversations/ # legacy location
<legacyDataDir>/workspaces/<workspaceKey>/…        # pre-Ubume (Codexa) location
```

`ConversationStore` writes each conversation as an atomically replaced JSON
file (`atomicWriteJson`: temp file + `rename`), so a crash mid-write can
never truncate an existing conversation. The `session` field of a record is
the `WorkbenchSnapshot`.

## Serialization and validation

`parseWorkbench` is the trust boundary for the snapshot JSON read back from
disk:

- Every field family (events, draft/cursor, history, registries, queue,
  checkpoints, file boundaries) must validate, or the whole snapshot is
  rejected and the conversation restores without its workbench state rather
  than with corrupt state.
- `uiState` and `plan` are the deliberate exceptions: only an
  `AWAITING_USER_ACTION` state and the user-facing plan review states survive
  a restart; everything else falls back to `IDLE` / `idle`, because their run
  is gone.
- The parsed object is returned as-is, never reconstructed, so fields written
  by a newer Ubume survive a load/save round-trip on an older version.
- `restoredEvents` then normalizes anything that was live when the session
  ended: running runs become canceled, running tools failed, streamed chunks
  are committed, and segments/plan blocks are marked completed — nothing
  restores with a live cursor.

## Error handling and recovery

- Catalog listing never fails wholesale: unreadable sources contribute an
  error message; owned conversations and other providers still list
  (`listSessionCatalog`, `discoverNativeSessions`).
- Saved-route restoration is assessed, not assumed: `assessSavedRoute`
  refuses routes whose provider is gone, disabled, unconfigured, whose Local
  backend is unrecorded, or whose model disappeared from the catalog, always
  with an actionable message.
- Snapshot validation failure degrades to "conversation without workbench
  state" instead of blocking the resume.
- Queue drains that are rejected or throw pause the queue and rethrow; the
  dispatcher never swallows run failures.

## Compatibility

- The snapshot format is versioned (`version: 1`); parsers reject unknown
  versions rather than guessing.
- Conversation files are written by `ConversationStore` as `version: 2`
  records; legacy directories are read as fallbacks and are never rewritten
  in place by migration.
- Message ordering, roles, turn ids and provider/model references pass
  through untouched; `restoredEvents` only finishes states that were still
  live — completed history is never rewritten.

## Integration with the rest of Ubume

- `app/` hooks dispatch `SessionAction`s and read `SessionState`; they never
  mutate the transcript directly.
- `app/run/*` builds run events from provider streams via `chatLifecycle`
  helpers and live-update batching; `app/conversation/*` owns persistence
  and resume flows on top of `sessionCatalog` and `workbenchSnapshot`.
- `ui/` renders `TimelineEvent`s and consumes `inspectionEntries`;
  `headless/` reuses the same catalog and restore logic for `ubume sessions`.
- `commands/` stays stateless: it parses `/resume`-style input, and the app
  layer applies session effects.

## Testing

```bash
bun test src/session        # the whole subsystem
bun test src/session/appSession.test.ts   # one module
```

Tests are colocated (`<module>.test.ts`) and use isolated temp directories
for anything touching the filesystem — never the real Ubume data directory.
`workbenchSnapshot` validation and restore normalization are covered in
`workbench.test.ts`; reducer behavior in `appSession.test.ts` /
`chatLifecycle.test.ts`; the catalog in `sessionCatalog.test.ts`.

## Extending safely

- New timeline event fields: add them to `types.ts`, then extend the
  corresponding validator in `workbenchSnapshot.ts`. Never loosen validation
  to "make it parse" — reject instead, and keep returning the original object
  so unknown fields round-trip.
- New session state: extend `SessionState` through a new `SessionAction`, and
  keep the reducer pure; side effects belong in the app layer.
- Snapshot format changes: bump `version` and write a parser for the new
  version that still accepts the old one. Never rewrite stored conversations
  in place during a migration.
