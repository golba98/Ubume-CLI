/**
 * Conversation metadata, canonical messages and workbench snapshots in app data. Atomic snapshot
 * writes and optional ownership leases are separate responsibilities; callers acquire/release
 * leases around mutations.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseWorkbench, type WorkbenchSnapshot } from "../../session/workbench.js";
import type { ExternalSessionSource } from "../externalSessions/types.js";
import type { LocalBackendId, ProviderId } from "../providerLauncher/types.js";
import type { ProviderBackendKind } from "../providerRuntime/types.js";
import type { GenerationMetadata } from "../providers/types.js";
import { titleFromText } from "../shared/text.js";
import { errorMessage, isRecord } from "../shared/values.js";
import {
  resolveLegacyCodexaDataDir,
  resolveLegacyConversationDir,
  resolveUbumeConversationDir,
  workspaceStorageKey,
} from "./appData.js";
import { acquireOwnership, type OwnershipLease } from "./ownership.js";

export type ConversationMessageRole = "user" | "assistant";

export interface ConversationMessage {
  generationMetadata?: GenerationMetadata;
  role: ConversationMessageRole;
  content: string;
  /** Files changed / commands run during the run that produced this reply. */
  activitySummary?: string;
  submittedContent?: string;
  turnId?: number;
  createdAt?: number;
}

export interface ConversationContextCheckpoint {
  version: 1;
  modelId: string;
  contextLength: number | null;
  throughMessageCount: number;
  transcriptHash: string;
  summary: string;
  activeWindowChars?: number;
  responseCharsCovered?: number;
  updatedAt: string;
}

export interface LocalHarnessSessionMetadata {
  version: 1;
  sessionId: string;
  harnessVersion: string;
  routeFingerprint: string;
  throughMessageCount: number;
  transcriptHash: string;
  updatedAt: string;
}

export interface NativeSessionReference {
  source: ExternalSessionSource;
  sessionId: string;
  modelId?: string;
  throughMessageCount?: number;
  transcriptHash?: string;
}

/** Native CLI session a conversation was imported from via /resume. */
export interface ConversationImportSource {
  source: string;
  sessionId: string;
}

export interface ConversationMetadata {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerId: ProviderId | string | null;
  modelId: string;
  backendKind: ProviderBackendKind | string | null;
  reasoning?: string;
  localBackend?: LocalBackendId;
  localContextCheckpoint?: ConversationContextCheckpoint;
  localHarnessSession?: LocalHarnessSessionMetadata;
  messageCount: number;
  parentConversationId?: string;
  parentCheckpointId?: string;
  importedFrom?: ConversationImportSource;
  workspaceRoot?: string;
  nativeSessions?: NativeSessionReference[];
}

export interface ConversationRecord {
  metadata: ConversationMetadata;
  messages: ConversationMessage[];
  session?: WorkbenchSnapshot;
}

export interface ConversationListEntry extends ConversationMetadata {
  /** Storage key remains available when legacy history has no recorded folder. */
  storageWorkspaceKey?: string;
}

interface ConversationStoreOptions {
  rootDir?: string;
  legacyRootDir?: string;
  legacyRootDirs?: readonly string[];
  ownership?: boolean;
  now?: () => Date;
  idFactory?: () => string;
  onDiagnostic?: (message: string) => void;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseContextCheckpoint(value: unknown): ConversationContextCheckpoint | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const modelId = safeString(value.modelId);
  const transcriptHash = safeString(value.transcriptHash);
  const summary = safeString(value.summary);
  const updatedAt = safeString(value.updatedAt);
  const contextLength =
    value.contextLength === null
      ? null
      : isNonNegativeInteger(value.contextLength) && value.contextLength > 0
        ? value.contextLength
        : undefined;
  if (
    !modelId ||
    contextLength === undefined ||
    !isNonNegativeInteger(value.throughMessageCount) ||
    !transcriptHash ||
    !summary ||
    !updatedAt ||
    (value.activeWindowChars !== undefined && !isNonNegativeInteger(value.activeWindowChars)) ||
    (value.responseCharsCovered !== undefined && !isNonNegativeInteger(value.responseCharsCovered))
  )
    return null;

  return {
    version: 1,
    modelId,
    contextLength,
    throughMessageCount: value.throughMessageCount,
    transcriptHash,
    summary,
    ...(value.activeWindowChars === undefined
      ? {}
      : { activeWindowChars: value.activeWindowChars }),
    ...(value.responseCharsCovered === undefined
      ? {}
      : { responseCharsCovered: value.responseCharsCovered }),
    updatedAt,
  };
}

function parseLocalHarnessSession(value: unknown): LocalHarnessSessionMetadata | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const sessionId = safeString(value.sessionId);
  const harnessVersion = safeString(value.harnessVersion);
  const routeFingerprint = safeString(value.routeFingerprint);
  const transcriptHash = safeString(value.transcriptHash);
  const updatedAt = safeString(value.updatedAt);
  if (!sessionId || !harnessVersion || !routeFingerprint || !transcriptHash || !updatedAt)
    return null;
  if (!isNonNegativeInteger(value.throughMessageCount)) return null;
  return {
    version: 1,
    sessionId,
    harnessVersion,
    routeFingerprint,
    throughMessageCount: value.throughMessageCount,
    transcriptHash,
    updatedAt,
  };
}

function parseImportSource(value: unknown): ConversationImportSource | null {
  if (!isRecord(value)) return null;
  const source = safeString(value.source);
  const sessionId = safeString(value.sessionId);
  return source && sessionId ? { source, sessionId } : null;
}

function parseMessages(value: unknown): ConversationMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: ConversationMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const role = item.role;
    const content = item.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    const activitySummary =
      typeof item.activitySummary === "string" && item.activitySummary.trim()
        ? item.activitySummary
        : null;
    messages.push({
      role,
      content,
      ...(activitySummary ? { activitySummary } : {}),
      ...(isRecord(item.generationMetadata) &&
      typeof item.generationMetadata.modelId === "string" &&
      typeof item.generationMetadata.rawOutput === "string"
        ? { generationMetadata: item.generationMetadata as unknown as GenerationMetadata }
        : {}),
      ...(typeof item.submittedContent === "string"
        ? { submittedContent: item.submittedContent }
        : {}),
      ...(Number.isInteger(item.turnId) ? { turnId: item.turnId as number } : {}),
      ...(typeof item.createdAt === "number" ? { createdAt: item.createdAt } : {}),
    });
  }
  return messages;
}

function parseMetadata(value: unknown, fallbackId: string): ConversationMetadata | null {
  if (!isRecord(value)) return null;
  const id = safeString(value.id) ?? fallbackId;
  const title = safeString(value.title) ?? "Untitled conversation";
  const createdAt = safeString(value.createdAt) ?? new Date(0).toISOString();
  const updatedAt = safeString(value.updatedAt) ?? createdAt;
  const modelId = safeString(value.modelId) ?? "unknown";
  const messageCount =
    typeof value.messageCount === "number" && Number.isInteger(value.messageCount)
      ? Math.max(0, value.messageCount)
      : 0;
  const localContextCheckpoint = parseContextCheckpoint(value.localContextCheckpoint);
  const localHarnessSession = parseLocalHarnessSession(value.localHarnessSession);
  const importedFrom = parseImportSource(value.importedFrom);
  return {
    version: 1,
    id,
    title,
    createdAt,
    updatedAt,
    providerId: typeof value.providerId === "string" ? value.providerId : null,
    modelId,
    backendKind: typeof value.backendKind === "string" ? value.backendKind : null,
    ...(typeof value.reasoning === "string" && value.reasoning.trim()
      ? { reasoning: value.reasoning }
      : {}),
    ...(value.localBackend === "lm-studio" || value.localBackend === "unsloth"
      ? { localBackend: value.localBackend }
      : {}),
    ...(localContextCheckpoint ? { localContextCheckpoint } : {}),
    ...(localHarnessSession ? { localHarnessSession } : {}),
    messageCount,
    ...(safeString(value.workspaceRoot) ? { workspaceRoot: value.workspaceRoot as string } : {}),
    ...(Array.isArray(value.nativeSessions)
      ? { nativeSessions: value.nativeSessions.filter(isNativeSessionReference) }
      : {}),
    ...(typeof value.parentConversationId === "string" &&
    isSafeConversationId(value.parentConversationId)
      ? { parentConversationId: value.parentConversationId }
      : {}),
    ...(typeof value.parentCheckpointId === "string"
      ? { parentCheckpointId: value.parentCheckpointId }
      : {}),
    ...(importedFrom ? { importedFrom } : {}),
  };
}

function titleFromMessages(messages: ConversationMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  if (!firstUser) return "Untitled conversation";
  return titleFromText(firstUser.content);
}

function isNativeSessionReference(value: unknown): value is NativeSessionReference {
  return (
    isRecord(value) &&
    ["claude", "codex", "vibe"].includes(String(value.source)) &&
    !!safeString(value.sessionId) &&
    (value.throughMessageCount === undefined || isNonNegativeInteger(value.throughMessageCount)) &&
    (value.transcriptHash === undefined || !!safeString(value.transcriptHash))
  );
}

/**
 * Replaces `filePath` atomically (readers see the old or the new file, never a partial one).
 * `durable` (default) also fsyncs the file and its directory so the new content survives a
 * crash; rebuildable caches pass `durable: false`, because losing their latest write only
 * makes readers fall back to the canonical file.
 */
function atomicWriteJson(filePath: string, value: unknown, { durable = true } = {}): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      if (durable) fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporaryPath, filePath);
    if (durable && process.platform !== "win32") {
      const directory = openSync(dirname(filePath), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function snapshotRevision(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function isSafeConversationId(id: string): boolean {
  return /^chat_[A-Za-z0-9-]+$/.test(id);
}

/** Workspace-scoped canonical dialogue storage with optional caller-released ownership leases. */
export class ConversationStore {
  private readonly rootDir: string;
  private readonly legacyRootDirs: readonly string[];
  private readonly managedRoot: boolean;
  private lease?: { id: string; value: OwnershipLease };
  private readonly ownership: boolean;
  private readonly workspace: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly onDiagnostic: (message: string) => void;

  constructor(workspaceRoot: string, options: ConversationStoreOptions = {}) {
    this.workspace = workspaceRoot;
    this.ownership = options.ownership ?? false;
    this.rootDir = options.rootDir ?? resolveUbumeConversationDir(workspaceRoot);
    this.managedRoot = options.rootDir === undefined;
    this.legacyRootDirs =
      options.legacyRootDirs ??
      (options.legacyRootDir
        ? [options.legacyRootDir]
        : this.managedRoot
          ? [
              resolveLegacyConversationDir(workspaceRoot),
              join(
                resolveLegacyCodexaDataDir(),
                "workspaces",
                workspaceStorageKey(workspaceRoot),
                "conversations",
              ),
            ]
          : []);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  /**
   * Acquires the conversation lease when ownership is enabled, retaining it until release or
   * another conversation is acquired.
   */
  acquire(id: string): void {
    if (!this.ownership || this.lease?.id === id) return;
    this.conversationDir(id);
    const value = acquireOwnership(this.workspace, id);
    this.release();
    this.lease = { id, value };
  }
  /**
   * Releases this store's current token-checked conversation lease; repeated calls are
   * harmless.
   */
  release(): void {
    this.lease?.value.release();
    this.lease = undefined;
  }

  private conversationDir(id: string): string {
    if (!isSafeConversationId(id)) throw new Error("Invalid conversation id.");
    return join(this.rootDir, id);
  }

  private ensureRoot(): void {
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    if (this.managedRoot && !existsSync(join(dirname(this.rootDir), "workspace.json")))
      atomicWriteJson(join(dirname(this.rootDir), "workspace.json"), {
        version: 1,
        workspaceRoot: this.workspace,
      });
  }

  /**
   * Creates an unsaved record and ensures its app-data root; no conversation snapshot is
   * written until save.
   */
  createConversation(route: {
    providerId: ProviderId | string | null;
    modelId: string;
    backendKind: ProviderBackendKind | string | null;
    reasoning?: string;
    localBackend?: LocalBackendId;
  }): ConversationRecord {
    this.ensureRoot();
    const id = `chat_${this.idFactory()}`;
    const timestamp = this.now().toISOString();
    const metadata: ConversationMetadata = {
      version: 1,
      id,
      title: "Untitled conversation",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerId: route.providerId,
      modelId: route.modelId,
      backendKind: route.backendKind,
      ...(route.reasoning ? { reasoning: route.reasoning } : {}),
      ...(route.providerId === "local" ? { localBackend: route.localBackend ?? "lm-studio" } : {}),
      messageCount: 0,
      workspaceRoot: this.workspace,
    };
    return { metadata, messages: [] };
  }

  /**
   * Acquires optional ownership and atomically writes the canonical snapshot. Canonical I/O
   * failures throw; summary-cache failures only report diagnostics.
   */
  save(record: ConversationRecord): void {
    this.acquire(record.metadata.id);
    this.ensureRoot();
    const dir = this.conversationDir(record.metadata.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const messages = record.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.activitySummary ? { activitySummary: message.activitySummary } : {}),
      ...(message.generationMetadata ? { generationMetadata: message.generationMetadata } : {}),
      ...(message.submittedContent === undefined
        ? {}
        : { submittedContent: message.submittedContent }),
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
    }));
    const metadata: ConversationMetadata = {
      ...record.metadata,
      title:
        record.metadata.title === "Untitled conversation"
          ? titleFromMessages(record.messages)
          : record.metadata.title,
      updatedAt: this.now().toISOString(),
      messageCount: messages.length,
      workspaceRoot: this.workspace,
    };
    // One authoritative generation; legacy files are read-only migration inputs.
    const snapshotPath = join(dir, "snapshot.json");
    atomicWriteJson(snapshotPath, { version: 2, metadata, messages, session: record.session });
    // A cache failure must not turn a successful canonical save into a failure. The cache is
    // validated against the snapshot's revision on read, so it needs no fsync: a lost or stale
    // summary after a crash only makes list() read the snapshot itself.
    try {
      atomicWriteJson(
        join(dir, "summary.json"),
        { version: 1, revision: snapshotRevision(snapshotPath), metadata },
        { durable: false },
      );
    } catch (error) {
      this.onDiagnostic(`Summary cache unavailable: ${errorMessage(error, "filesystem error")}`);
    }
  }

  /**
   * Reads current or legacy dialogue without migration writes; invalid/unreadable records
   * report diagnostics and return null.
   */
  load(id: string): ConversationRecord | null {
    try {
      const dir = this.readDirectory(id);
      const snapshotPath = join(dir, "snapshot.json");
      const snapshot = existsSync(snapshotPath)
        ? JSON.parse(readFileSync(snapshotPath, "utf8"))
        : null;
      if (snapshot && snapshot.version !== 2)
        throw new Error("Unsupported conversation snapshot version");
      const messages = parseMessages(
        snapshot ? snapshot.messages : JSON.parse(readFileSync(join(dir, "messages.json"), "utf8")),
      );
      if (!messages) throw new Error("messages.json is not a valid conversation message array");
      let metadata: ConversationMetadata | null = snapshot
        ? parseMetadata(snapshot.metadata, id)
        : null;
      if (snapshot && !metadata) throw new Error("Invalid authoritative conversation metadata");
      const metadataPath = join(dir, "metadata.json");
      if (!snapshot && existsSync(metadataPath)) {
        metadata = parseMetadata(JSON.parse(readFileSync(metadataPath, "utf8")), id);
      }
      const timestamp = this.now().toISOString();
      metadata ??= {
        version: 1,
        id,
        title: titleFromMessages(messages),
        createdAt: timestamp,
        updatedAt: timestamp,
        providerId: null,
        modelId: "unknown",
        backendKind: null,
        messageCount: messages.length,
      };
      if (metadata.id !== id) throw new Error("Conversation identity does not match its directory");
      metadata = {
        ...metadata,
        messageCount: messages.length,
        ...(this.managedRoot ? { workspaceRoot: this.workspace } : {}),
      };
      const session = snapshot ? parseWorkbench(snapshot.session) : undefined;
      if (snapshot?.session && !session)
        this.onDiagnostic(
          `Conversation ${id}: auxiliary session data is invalid; restored dialogue only.`,
        );
      return { metadata, messages, ...(session ? { session } : {}) };
    } catch (error) {
      this.onDiagnostic(`Skipped conversation ${id}: ${errorMessage(error, "invalid data")}`);
      return null;
    }
  }

  private readDirectory(id: string): string {
    const current = this.conversationDir(id);
    return (
      [current, ...this.legacyRootDirs.map((root) => join(root, id))].find(
        (dir) => existsSync(join(dir, "snapshot.json")) || existsSync(join(dir, "messages.json")),
      ) ?? current
    );
  }

  /** Absolute location of the authoritative generation, including legacy reads. */
  location(id: string): string {
    const dir = this.readDirectory(id);
    return join(dir, existsSync(join(dir, "snapshot.json")) ? "snapshot.json" : "messages.json");
  }

  /**
   * Lists nonempty current/legacy conversations newest-first, using valid summary caches and
   * skipping malformed records.
   */
  list(): ConversationListEntry[] {
    const ids = new Set<string>();
    for (const root of [this.rootDir, ...this.legacyRootDirs]) {
      if (!root || !existsSync(root)) continue;
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory() && isSafeConversationId(entry.name)) ids.add(entry.name);
        }
      } catch (error) {
        this.onDiagnostic(
          `Unable to list conversations: ${errorMessage(error, "filesystem error")}`,
        );
      }
    }
    const entries: ConversationListEntry[] = [];
    for (const id of ids) {
      const dir = this.readDirectory(id);
      let metadata: ConversationMetadata | null = null;
      try {
        const snapshotPath = join(dir, "snapshot.json");
        if (existsSync(snapshotPath)) {
          try {
            const cached = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
            if (cached.version === 1 && cached.revision === snapshotRevision(snapshotPath))
              metadata = parseMetadata(cached.metadata, id);
          } catch {
            /* Missing or stale cache: use the authoritative snapshot. */
          }
        }
        metadata ??= this.load(id)?.metadata ?? null;
        if (metadata?.id === id && metadata.messageCount > 0)
          entries.push({
            ...metadata,
            ...(this.managedRoot ? { workspaceRoot: this.workspace } : {}),
          });
      } catch (error) {
        this.onDiagnostic(`Skipped conversation ${id}: ${errorMessage(error, "invalid metadata")}`);
      }
    }
    return entries.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    );
  }
}
