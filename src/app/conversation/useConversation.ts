/**
 * Conversation lifecycle for the interactive app: the active conversation
 * record and its autosave, switching conversations (/resume, imports,
 * relaunches), and one-time startup notices.
 *
 * This hook only composes three focused hooks, in this order so their
 * effects keep their original declaration order:
 * 1. `useActiveConversation` — create, append, autosave, final checkpoints.
 * 2. `useResumeFlows` — resume picker and every conversation switch.
 * 3. `useStartupNotices` — migration and project-instruction notices.
 */

import type { UseConversationContext } from "./conversationContext.js";
import { useActiveConversation } from "./useActiveConversation.js";
import { useResumeFlows } from "./useResumeFlows.js";
import { useStartupNotices } from "./useStartupNotices.js";

export function useConversation(context: UseConversationContext) {
  const activeConversation = useActiveConversation(context);
  const resumeFlows = useResumeFlows({
    ...context,
    saveActiveConversation: activeConversation.saveActiveConversation,
  });
  useStartupNotices(context);
  return { ...activeConversation, ...resumeFlows };
}
