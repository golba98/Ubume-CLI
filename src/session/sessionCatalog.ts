import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExternalSessionSource,
  ExternalSessionSummary,
  ExternalTranscript,
} from "../core/externalSessions/index.js";
import {
  EXTERNAL_SESSION_SOURCES,
  externalProviderId,
  externalTranscriptToConversationMessages,
  listExternalSessions,
} from "../core/externalSessions/index.js";
import { isCatalogModelUnavailable } from "../core/models/modelSelection.js";
import {
  LEGACY_GOOGLE_MESSAGE,
  resolveProviderIdentity,
} from "../core/providerLauncher/providerIdentity.js";
import { isKnownProviderId } from "../core/providerLauncher/registry.js";
import type { LocalBackendId, ProviderId } from "../core/providerLauncher/types.js";
import { getProviderRuntime, isProviderRoutableInUbume } from "../core/providerRuntime/registry.js";
import type { ProviderModelDiscoveryResult, ProviderRoute } from "../core/providerRuntime/types.js";
import { errorMessage } from "../core/shared/values.js";
import {
  resolveLegacyCodexaDataDir,
  resolveUbumeDataDir,
  workspaceStorageKey,
} from "../core/workspace/appData.js";
import type {
  ConversationListEntry,
  ConversationMetadata,
  ConversationRecord,
} from "../core/workspace/conversationStore.js";
import { ConversationStore } from "../core/workspace/conversationStore.js";
import type { LaunchContext } from "../core/workspace/launchContext.js";
import { createWorkspaceRelaunchPlan } from "../core/workspace/launchContext.js";
import { normalizeWorkspaceRoot, sameFolder } from "../core/workspace/workspaceRoot.js";
import { buildResumedProviderRoute } from "./conversation.js";

type SessionScope = "workspace" | "all";
export type SessionRef =
  | { kind: "ubume"; conversationId: string; workspaceRoot: string | null; workspaceKey: string }
  | {
      kind: "native";
      source: ExternalSessionSource;
      sessionId: string;
      workspaceRoot: string | null;
    };

export interface SessionSummary {
  key: string;
  ref: SessionRef;
  source: "ubume" | ExternalSessionSource;
  providerId: string | null;
  workspaceRoot: string | null;
  modelId: string | null;
  localBackend?: LocalBackendId;
  title: string;
  updatedAt: string;
  messageCount?: number;
  actions: readonly ("resume" | "view" | "native" | "continue")[];
  conversation?: ConversationListEntry;
  native?: ExternalSessionSummary;
}

export interface SessionCatalogResult {
  sessions: SessionSummary[];
  errors: string[];
}
interface SessionCatalogOptions {
  dataDir?: string;
  legacyDataDir?: string;
  loadExternal?: typeof listExternalSessions;
  sources?: readonly ExternalSessionSource[];
}

export function conversationSummary(
  entry: ConversationListEntry,
  workspace: string | null,
  key: string,
): SessionSummary {
  return {
    key: `ubume:${key}:${entry.id}`,
    ref: { kind: "ubume", conversationId: entry.id, workspaceRoot: workspace, workspaceKey: key },
    source: "ubume",
    providerId: entry.providerId === "antigravity" ? "google" : entry.providerId,
    workspaceRoot: workspace,
    modelId: entry.modelId,
    localBackend: entry.localBackend,
    title: entry.title,
    updatedAt: entry.updatedAt,
    messageCount: entry.messageCount,
    actions: workspace ? ["view", "resume"] : ["view"],
    conversation: entry,
  };
}

export function mergeSessionSummaries(
  conversations: readonly SessionSummary[],
  native: readonly ExternalSessionSummary[],
): SessionSummary[] {
  const linked = new Set<string>();
  const nativeKey = (source: string, id: string, folder: string | null) =>
    `${source === "antigravity" ? "google" : source}:${id}:${folder ? normalizeWorkspaceRoot(folder) : ""}`;
  for (const summary of conversations) {
    const entry = summary.conversation;
    for (const link of [
      ...(entry?.nativeSessions ?? []),
      ...(entry?.importedFrom ? [entry.importedFrom] : []),
    ]) {
      linked.add(nativeKey(link.source, link.sessionId, summary.workspaceRoot));
    }
  }
  const result = [...conversations];
  for (const entry of native) {
    const key = nativeKey(entry.source, entry.id, entry.cwd);
    if (linked.has(key)) continue;
    linked.add(key);
    result.push({
      key: `native:${entry.source}:${entry.id}:${entry.cwd ?? ""}`,
      ref: { kind: "native", source: entry.source, sessionId: entry.id, workspaceRoot: entry.cwd },
      source: entry.source,
      providerId: externalProviderId(entry.source),
      workspaceRoot: entry.cwd,
      modelId: entry.model ?? null,
      title: entry.title,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
      actions: entry.cwd ? ["view", "native", "continue"] : ["view"],
      native: entry,
    });
  }
  return result.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
  );
}

function directories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Provider discovery is isolated; a broken native store never hides owned chats. */
export async function listSessionCatalog(
  workspaceRoot: string,
  scope: SessionScope,
  options: SessionCatalogOptions = {},
): Promise<SessionCatalogResult> {
  const dataDir = options.dataDir ?? resolveUbumeDataDir();
  const legacyDataDir = options.legacyDataDir ?? resolveLegacyCodexaDataDir();
  const errors: string[] = [];
  const owned: SessionSummary[] = [];
  const keys = new Set<string>([workspaceStorageKey(workspaceRoot)]);
  if (scope === "all")
    for (const root of [
      join(dataDir, "chats"),
      join(dataDir, "workspaces"),
      join(legacyDataDir, "workspaces"),
    ]) {
      try {
        for (const key of directories(root)) keys.add(key);
      } catch (error) {
        errors.push(`Ubume: ${errorMessage(error, "Could not list chats")}`);
      }
    }
  for (const key of keys) {
    let folder: string | null = key === workspaceStorageKey(workspaceRoot) ? workspaceRoot : null;
    try {
      const manifest = JSON.parse(
        readFileSync(join(dataDir, "chats", key, "workspace.json"), "utf8"),
      );
      if (
        manifest.version === 1 &&
        typeof manifest.workspaceRoot === "string" &&
        workspaceStorageKey(manifest.workspaceRoot) === key
      )
        folder = manifest.workspaceRoot;
    } catch {
      /* Legacy manifests may not exist; the current workspace is still known. */
    }
    const rootDir = join(dataDir, "chats", key, "conversations");
    const legacyRootDirs = [dataDir, legacyDataDir].map((root) =>
      join(root, "workspaces", key, "conversations"),
    );
    const store = new ConversationStore(folder ?? "", {
      rootDir,
      legacyRootDirs,
      onDiagnostic: (message) => errors.push(`Ubume: ${message}`),
    });
    for (const entry of store.list()) {
      const savedFolder =
        folder ??
        (entry.workspaceRoot && workspaceStorageKey(entry.workspaceRoot) === key
          ? entry.workspaceRoot
          : null);
      owned.push(conversationSummary(entry, savedFolder, key));
    }
  }
  const sources = options.sources ?? EXTERNAL_SESSION_SOURCES;
  const discovered = await Promise.allSettled(
    sources.map((source) =>
      (options.loadExternal ?? listExternalSessions)(
        source,
        scope === "workspace" ? { kind: "workspace", root: workspaceRoot } : { kind: "all" },
      ),
    ),
  );
  const native: ExternalSessionSummary[] = [];
  discovered.forEach((result, index) => {
    if (result.status === "fulfilled") native.push(...result.value);
    else errors.push(`${sources[index]}: ${errorMessage(result.reason)}`);
  });
  return { sessions: mergeSessionSummaries(owned, native), errors: [...new Set(errors)] };
}

export function filterSessionCatalog(
  sessions: readonly SessionSummary[],
  options: {
    provider?: ProviderId | "all";
    backend?: LocalBackendId | "all";
    model?: string;
    query?: string;
  },
): SessionSummary[] {
  const needle = options.query?.toLowerCase() ?? "";
  return sessions.filter(
    (session) =>
      (!options.provider ||
        options.provider === "all" ||
        session.providerId === options.provider) &&
      (!options.backend || options.backend === "all" || session.localBackend === options.backend) &&
      (!options.model || session.modelId === options.model) &&
      (!needle ||
        [
          session.title,
          session.modelId,
          session.providerId,
          session.localBackend,
          session.workspaceRoot,
          session.key,
        ].some((field) => field?.toLowerCase().includes(needle))),
  );
}

export function sessionIsInWorkspace(session: SessionSummary, workspaceRoot: string): boolean {
  return session.workspaceRoot !== null && sameFolder(session.workspaceRoot, workspaceRoot);
}

export function readOwnedConversation(ref: Extract<SessionRef, { kind: "ubume" }>) {
  if (!/^[a-f0-9]{16}$/.test(ref.workspaceKey))
    throw new Error("Invalid saved workspace identity.");
  const dataDir = resolveUbumeDataDir();
  const legacyRootDirs = [dataDir, resolveLegacyCodexaDataDir()].map((root) =>
    join(root, "workspaces", ref.workspaceKey, "conversations"),
  );
  const store = new ConversationStore(ref.workspaceRoot ?? "", {
    rootDir: join(dataDir, "chats", ref.workspaceKey, "conversations"),
    legacyRootDirs,
  });
  const record = store.load(ref.conversationId);
  if (!record) throw new Error("Saved conversation could not be loaded.");
  return record;
}

type SavedRouteAssessment =
  | { status: "ready"; route: ProviderRoute }
  | { status: "unavailable"; message: string; route?: ProviderRoute };

export function assessSavedRoute(
  metadata: ConversationMetadata,
  discovery: ProviderModelDiscoveryResult | null,
  enabled = true,
): SavedRouteAssessment {
  const id = resolveProviderIdentity(metadata.providerId, metadata.backendKind);
  if (typeof id !== "string" || !isKnownProviderId(id) || !isProviderRoutableInUbume(id))
    return {
      status: "unavailable",
      message:
        metadata.providerId === "google"
          ? LEGACY_GOOGLE_MESSAGE
          : "The saved provider is unavailable. Select a provider and model explicitly before sending.",
    };
  const route = buildResumedProviderRoute(metadata, id, getProviderRuntime(id).backendKind);
  if (!enabled)
    return {
      status: "unavailable",
      route,
      message:
        "The saved provider is disabled in this workspace. Enable it or select a working provider explicitly before sending.",
    };
  if (id === "local" && !metadata.localBackend)
    return {
      status: "unavailable",
      route,
      message:
        "This older Local chat has no recorded backend. Select LM Studio or Unsloth and a model before sending.",
    };
  if (discovery?.status === "not-configured")
    return {
      status: "unavailable",
      route,
      message:
        discovery.message ??
        "The saved route is not configured. Select a working provider and model before sending.",
    };
  if (discovery?.status === "ready" && isCatalogModelUnavailable(discovery, route.modelId)) {
    return {
      status: "unavailable",
      route,
      message: `The saved model ${route.modelId} is unavailable. Select a model explicitly before sending.`,
    };
  }
  return { status: "ready", route };
}

/** Provenance is workspace-scoped; repeated imports reuse the owned conversation. */
export function importNativeConversation(
  store: ConversationStore,
  transcript: ExternalTranscript,
  modelId: string,
): ConversationRecord {
  const { summary } = transcript;
  const previous = store
    .list()
    .find(
      (entry) =>
        entry.importedFrom != null &&
        (entry.importedFrom.source === "antigravity" ? "google" : entry.importedFrom.source) ===
          (summary.source === "antigravity" ? "google" : summary.source) &&
        entry.importedFrom.sessionId === summary.id,
    );
  if (previous) {
    const loaded = store.load(previous.id);
    if (!loaded) throw new Error("The previously imported conversation could not be loaded.");
    return loaded;
  }
  const messages = externalTranscriptToConversationMessages(transcript);
  if (!messages.length) throw new Error("This session has no readable dialogue to import.");
  const providerId = externalProviderId(summary.source);
  const record = store.createConversation({
    providerId,
    modelId: summary.model ?? modelId,
    backendKind: getProviderRuntime(providerId).backendKind,
  });
  record.metadata.title = summary.title;
  record.metadata.importedFrom = { source: summary.source, sessionId: summary.id };
  record.messages = messages;
  store.save(record);
  return record;
}

/** Reuse the installed/dev launcher, while avoiding replay of startup arguments. */
export function createSessionWorkspaceRelaunch(
  target: string,
  context: LaunchContext,
  resume: { conversationId: string } | { source: string; sessionId: string },
) {
  const result = createWorkspaceRelaunchPlan(target, context);
  if (!result.ok) return result;
  const args = [
    ...result.plan.args,
    ...("conversationId" in resume
      ? ["--resume", resume.conversationId]
      : ["--import-session", `${resume.source}:${resume.sessionId}`]),
  ];
  return { ok: true as const, plan: { ...result.plan, args } };
}
