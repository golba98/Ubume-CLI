/**
 * Stable refs describing the active run and the session's background work.
 *
 * These are refs rather than state because they are read and written by
 * async provider callbacks and must never trigger renders:
 * - which run/turn is current, its lifecycle options and timing;
 * - `stoppingRef` / `processStoppedRef`: promises that settle when the last
 *   provider or shell process has fully stopped (switches and queue drains
 *   wait on them);
 * - `submissionRef` / `recoveryRef` / `pipelineGenerationRef`: guards that
 *   serialize submissions, conversation switches and cancellation;
 * - checkpoint and capture refs used to save a finished run.
 *
 * The returned object is memoized once, so hooks may depend on it freely.
 */

import { useMemo, useRef } from "react";
import type { GenerationMetadata, ProviderRunControl } from "../../core/providers/types.js";

import type { CheckpointStore, FileCheckpoint } from "../../core/workspace/checkpoints.js";

import type { PromptRunTiming } from "../../session/eventIds.js";
import type { PersistedFileActivity } from "../../session/persistedResponse.js";

import type { WorkbenchSnapshot } from "../../session/workbench.js";

import type { PromptRunLifecycle } from "../run/promptRunPrep.js";

export function useRunRefs() {
  // Guards that serialize submissions, conversation switches and cancellation.
  const submissionRef = useRef(false);
  const recoveryRef = useRef(false);
  const pendingQuitRef = useRef<(() => void) | null>(null);
  const pipelineGenerationRef = useRef(0);

  // Promises that settle when the last provider or shell process has stopped.
  const stoppingRef = useRef<Promise<void>>(Promise.resolve());
  const processStoppedRef = useRef<Promise<void>>(Promise.resolve());

  // Which run/turn is current, with its lifecycle options and timing.
  const activeRunIdRef = useRef<number | null>(null);
  const activeTurnIdRef = useRef<number | null>(null);
  const activeRunLifecycleRef = useRef<PromptRunLifecycle | null>(null);
  const activeRunTimingRef = useRef<(PromptRunTiming & { runId: number; turnId: number }) | null>(
    null,
  );
  const runControlRef = useRef<ProviderRunControl | null>(null);
  const clearEpochRef = useRef<number>(0);
  const isMountedRef = useRef(true);

  // Checkpoint and capture refs used to save a finished run.
  const activeCheckpointRef = useRef<{
    runId: number;
    checkpoint: FileCheckpoint;
    store: CheckpointStore;
  } | null>(null);
  const pendingCaptureRef = useRef<Promise<void>>(Promise.resolve());
  const captureFinalRef = useRef<((runId: number) => void) | null>(null);
  const activeRunCaptureRef = useRef<{
    runId: number;
    text: string;
    tools: Map<string, string>;
    files: Map<string, PersistedFileActivity>;
    generationMetadata?: GenerationMetadata;
  } | null>(null);
  const finalFlushRef = useRef<{ runId: number; flush: () => void } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Workbench snapshot and save bookkeeping.
  const snapshotRef = useRef<(() => WorkbenchSnapshot) | null>(null);
  const saveWorkbenchRef = useRef<(() => void) | null>(null);
  const lastSaveErrorRef = useRef<string | null>(null);
  const deferredRouteCloseRef = useRef<string | undefined>(undefined);

  return useMemo(
    () => ({
      stoppingRef,
      submissionRef,
      recoveryRef,
      pendingQuitRef,
      snapshotRef,
      lastSaveErrorRef,
      saveWorkbenchRef,
      captureFinalRef,
      activeCheckpointRef,
      pendingCaptureRef,
      deferredRouteCloseRef,
      runControlRef,
      processStoppedRef,
      pipelineGenerationRef,
      finalFlushRef,
      activeRunCaptureRef,
      cleanupRef,
      activeRunLifecycleRef,
      activeRunTimingRef,
      isMountedRef,
      activeRunIdRef,
      activeTurnIdRef,
      clearEpochRef,
    }),
    [],
  );
}
