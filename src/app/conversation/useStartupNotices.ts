/**
 * One-time notices shown after startup: a provider migration notice from the
 * workspace config, and the result of loading project instructions
 * (AGENTS.md and friends).
 */

import { useEffect } from "react";
import { traceInputDebug } from "../../core/perf/debugLog.js";
import { findProvider } from "../../core/providerLauncher/registry.js";
import { createProviderMigrationNoticeEvent } from "../../session/eventIds.js";
import type { UseConversationContext } from "./useConversation.js";

type StartupNoticesContext = Pick<
  UseConversationContext,
  | "providerWorkspaceConfig"
  | "providerMigrationNoticeShownRef"
  | "providerRegistry"
  | "appendStaticEvent"
  | "projectInstructionsLoad"
  | "appendEvent"
>;

export function useStartupNotices(context: StartupNoticesContext) {
  const {
    providerWorkspaceConfig,
    providerMigrationNoticeShownRef,
    providerRegistry,
    appendStaticEvent,
    projectInstructionsLoad,
    appendEvent,
  } = context;

  // Usually already seeded into the first frame by useAppState; this covers a
  // migration detected after startup.
  useEffect(() => {
    const notice = providerWorkspaceConfig.migrationNotice;
    if (!notice || providerMigrationNoticeShownRef.current) {
      return;
    }
    const providerLabel =
      findProvider(providerRegistry, notice.revertedProviderId)?.displayName ?? "OpenAI";
    const event = createProviderMigrationNoticeEvent(notice, providerLabel);
    if (!event) {
      return;
    }
    providerMigrationNoticeShownRef.current = true;
    appendStaticEvent(event);
  }, [appendStaticEvent, providerRegistry, providerWorkspaceConfig.migrationNotice]);

  useEffect(() => {
    if (projectInstructionsLoad.status === "loaded") {
      traceInputDebug("project_instructions_loaded", {
        path: projectInstructionsLoad.instructions.path,
        content: projectInstructionsLoad.instructions.content,
      });
      return;
    }
    if (projectInstructionsLoad.status === "error") {
      appendEvent(
        "error",
        "Project instructions",
        `Could not read ${projectInstructionsLoad.path}: ${projectInstructionsLoad.message}`,
      );
    }
  }, [appendEvent, projectInstructionsLoad]);
}
