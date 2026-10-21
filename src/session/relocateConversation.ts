import { realpathSync, statSync } from "node:fs";
import { ConversationStore } from "../core/workspace/conversationStore.js";
import { createInitialPlanFlowState } from "./planFlow.js";
import { hydrateConversationEvents } from "./restoreConversation.js";
import { readOwnedConversation, type SessionRef } from "./sessionCatalog.js";

/** Explicit copy, never an in-place path migration. No execution grants survive relocation. */
export function relocateConversation(
  ref: Extract<SessionRef, { kind: "ubume" }>,
  destination: string,
) {
  const folder = realpathSync(destination);
  if (!statSync(folder).isDirectory()) throw new Error("Select an existing project directory.");
  const original = readOwnedConversation(ref);
  const store = new ConversationStore(folder, { ownership: true });
  try {
    const record = store.createConversation(original.metadata);
    record.metadata.title = original.metadata.title;
    record.metadata.originalWorkspaceRoot =
      original.metadata.originalWorkspaceRoot ??
      original.metadata.workspaceRoot ??
      ref.workspaceRoot ??
      undefined;
    record.metadata.relocatedFrom = {
      workspaceKey: ref.workspaceKey,
      conversationId: ref.conversationId,
    };
    record.messages = original.messages;
    if (original.session)
      record.session = {
        version: 1,
        events: hydrateConversationEvents(original),
        uiState: { kind: "IDLE" },
        plan: createInitialPlanFlowState(),
        draft: "",
        cursor: 0,
        history: original.session.history,
        pastes: [],
        images: [],
        files: [],
        queue: [],
        checkpoints: [],
      };
    store.save(record);
    return { folder, id: record.metadata.id };
  } finally {
    store.release();
  }
}
