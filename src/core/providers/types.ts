/**
 * Shared execution/callback contracts for interactive and headless callers. Response delivery is
 * distinct from stopped-resource completion; adapters must preserve that distinction during
 * cancellation and retries.
 */

import type { ResolvedRuntimeConfig } from "../../config/runtimeConfig.js";
import type { AvailableBackend } from "../../config/settings.js";
import type { RunProgressSource, RunToolActivity } from "../../session/types.js";
import type { ProviderFailure } from "../providerRuntime/failures.js";
import type { ProviderImageAttachment } from "../providerRuntime/types.js";
import type {
  ConversationContextCheckpoint,
  ConversationMessage,
  LocalHarnessSessionMetadata,
  NativeSessionReference,
} from "../workspace/conversationStore.js";
import type { ProjectInstructions } from "../workspace/projectInstructions.js";

export interface ProviderContextUsage {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  contextWindow: number | null;
  exact: boolean;
  compacted?: boolean;
}

export interface BackendProgressUpdate {
  id: string;
  source: RunProgressSource;
  text: string;
}

export type ToolApprovalDecision = "allow-once" | "allow-for-run" | "deny";

export interface ToolApprovalRequest {
  tool: string;
  signature: string;
  command?: string;
  paths: string[];
  description?: string;
  allowForRun?: boolean;
}

export type BackendAuthState = "delegated" | "api-key-required" | "coming-soon";

/** Cleanup ownership for one logical run, including any compatibility retry attempts. */
export interface ProviderRunControl {
  /** Await before releasing workspace ownership; response delivery alone does not imply teardown. */
  stopped: Promise<void>;
  /** Optional live steering; false means the provider did not accept the prompt. */
  steer?: (prompt: string) => Promise<boolean>;
}

/** Normalized provider events; application orchestration owns session state and ignores stale runs. */
export interface BackendRunHandlers {
  onGenerationMetadata?: (metadata: GenerationMetadata) => void;
  onRunControl?: (control: ProviderRunControl) => void;
  /** Delivers the completed response; callers separately await run-control cleanup. */
  onResponse: (response: string) => void;
  /** Reports failure with optional adapter diagnostics and structured recovery evidence. */
  onError: (message: string, rawOutput?: string, failure?: ProviderFailure) => void;
  /** Called with each new structured thinking/progress update while the process is still running. */
  onProgress?: (update: BackendProgressUpdate) => void;
  /** Called with each new assistant content delta while the process is still running. */
  onAssistantDelta?: (chunk: string) => void;
  /** Called when the backend indicates the final assistant answer is complete and visible. */
  onFinalAnswerObserved?: (response: string) => void;
  /** Called when the backend starts or finishes a tool/shell action during a run. */
  onToolActivity?: (activity: RunToolActivity) => void;
  /** Requests consent before a local model performs a mutating action. */
  onToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
  /** Persists invisible rolling memory used only by Local context-window rollover. */
  onLocalContextCheckpoint?: (checkpoint: ConversationContextCheckpoint) => void;
  /** Reports a native CLI session reference for future resume. */
  onNativeSession?: (session: NativeSessionReference) => void;
  /** Updates opaque Local Harness resume metadata; null invalidates the named session. */
  onLocalHarnessSession?: (session: LocalHarnessSessionMetadata | null, sessionId: string) => void;
  /** Reports authoritative provider token usage when available. */
  onContextUsage?: (usage: ProviderContextUsage) => void;
  /** Called around backend child-process lifecycle boundaries. */
  onProcessLifecycle?: (event: "before-spawn" | "spawned" | "exit" | "error" | "cleanup") => void;
  /** Lightweight hooks used only by headless benchmark diagnostics. */
  benchmarkHooks?: {
    onProviderPromptPrepared?: (context: {
      policy: "raw" | "wrapped";
      characterCount: number;
    }) => void;
    onProviderPrepStart?: () => void;
    onProviderPrepComplete?: () => void;
    onCodexProcessSpawned?: (context: { executable: string; argv: string[] }) => void;
    onFirstStdout?: (observed?: boolean) => void;
    onFirstStderr?: (observed?: boolean) => void;
    onCodexProcessExit?: (exitCode: number | null) => void;
    onCleanupStart?: () => void;
    onCleanupComplete?: (context: { skipped: boolean }) => void;
  };
}

export interface GenerationMetadata {
  providerId: string;
  modelId: string;
  checkpointSha256: string;
  preset: string;
  finishReason: string;
  terminationCause: string;
  generatedTokens: number;
  elapsedSeconds: number;
  firstTokenSeconds: number | null;
  tokensPerSecond: number;
  rawOutput: string;
  generation: Record<string, unknown>;
  loadingSeconds?: number;
  gpuPeakAllocatedBytes?: number;
  gpuPeakReservedBytes?: number;
  hostPeakBytes?: number;
}

/** Backend adapter shared by both entry paths; authentication remains with its provider. */
export interface BackendProvider {
  id: AvailableBackend;
  label: string;
  description: string;
  authState: BackendAuthState;
  authLabel: string;
  statusMessage: string;
  supportsModels: (model: string) => boolean;
  /** Starts a logical run and returns cancellation; completion/cleanup are reported through handlers. */
  run?: (
    prompt: string,
    options: {
      runtime: ResolvedRuntimeConfig;
      workspaceRoot: string;
      projectInstructions?: ProjectInstructions | null;
      promptPolicy?: "raw" | "wrapped";
      runIntent?: "normal" | "plan" | "approved-execution";
      conversationHistory?: readonly ConversationMessage[];
      localContextCheckpoint?: ConversationContextCheckpoint;
      imageAttachments?: readonly ProviderImageAttachment[];
    },
    handlers: BackendRunHandlers,
  ) => () => void;
}
