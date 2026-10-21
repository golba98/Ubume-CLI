import type { ConversationRecord } from "../core/workspace/conversationStore.js";
import { conversationMessagesToTimeline } from "./conversation.js";
import { advanceIdsPast, createEventId, createTurnId } from "./eventIds.js";
import type { TimelineEvent } from "./types.js";
import { restoredEvents } from "./workbench.js";

/** Hydration is data-only: no provider, shell, approval or file-operation callbacks. */
export function hydrateConversationEvents(record: ConversationRecord): TimelineEvent[] {
  const saved = record.session?.events;
  if (!saved?.some((event) => event.type === "user"))
    return conversationMessagesToTimeline(record.messages, createEventId, createTurnId);
  const events = restoredEvents(
    saved.filter(
      (event) =>
        event.type !== "system" ||
        !["Conversation resumed", "Opening saved workspace", "Continuing in Ubume"].includes(
          event.title,
        ),
    ),
  );
  advanceIdsPast(events);
  // Repair snapshots saved after an older renderer restored only the prompt.
  const users = events.filter((event) => event.type === "user");
  if (users.length !== record.messages.filter((message) => message.role === "user").length)
    return events;
  const messages = record.messages;
  let userIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "user") {
      userIndex++;
      continue;
    }
    const user = users[userIndex];
    if (!user || events.some((event) => event.type === "assistant" && event.turnId === user.turnId))
      continue;
    const nextUser = users[userIndex + 1];
    const insertion = nextUser ? events.indexOf(nextUser) : events.length;
    events.splice(insertion, 0, {
      id: createEventId(),
      type: "assistant",
      turnId: user.turnId,
      createdAt: message.createdAt ?? user.createdAt,
      content: message.content,
      contentChunks: [],
    });
  }
  return events;
}
