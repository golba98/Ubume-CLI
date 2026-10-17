import { useMemo, useRef } from "react";
import type { GenerationMetadata, ProviderRunControl } from "../../core/providers/types.js";

import type { CheckpointStore, FileCheckpoint } from "../../core/workspace/checkpoints.js";

import type { PromptRunTiming } from "../../session/eventIds.js";
import type { PersistedFileActivity } from "../../session/persistedResponse.js";

import type { WorkbenchSnapshot } from "../../session/workbench.js";

import type { PromptRunLifecycle } from "../run/promptRunPrep.js";

export function useRunRefs() {
  const stoppingRef = useRef<Promise<void>>(Promise.resolve());
  const submissionRef = useRef(false);
  const recoveryRef = useRef(false);
  const pendingQuitRef = useRef<(() => void) | null>(null);
  const snapshotRef = useRef<(() => WorkbenchSnapshot) | null>(null);
  const lastSaveErrorRef = useRef<string | null>(null);
  const saveWorkbenchRef = useRef<(() => void) | null>(null);
  const captureFinalRef = useRef<((runId: number) => void) | null>(null);
  const activeCheckpointRef = useRef<{
    runId: number;
    checkpoint: FileCheckpoint;
    store: CheckpointStore;
  } | null>(null);
  const pendingCaptureRef = useRef<Promise<void>>(Promise.resolve());
  const deferredRouteCloseRef = useRef<string | undefined>(undefined);
  const runControlRef = useRef<ProviderRunControl | null>(null);
  const processStoppedRef = useRef<Promise<void>>(Promise.resolve());
  const pipelineGenerationRef = useRef(0);
  const finalFlushRef = useRef<{ runId: number; flush: () => void } | null>(null);
  const activeRunCaptureRef = useRef<{
    runId: number;
    text: string;
    tools: Map<string, string>;
    files: Map<string, PersistedFileActivity>;
    generationMetadata?: GenerationMetadata;
  } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const activeRunLifecycleRef = useRef<PromptRunLifecycle | null>(null);
  const activeRunTimingRef = useRef<(PromptRunTiming & { runId: number; turnId: number }) | null>(
    null,
  );
  const isMountedRef = useRef(true);
  const activeRunIdRef = useRef<number | null>(null);
  const activeTurnIdRef = useRef<number | null>(null);
  const clearEpochRef = useRef<number>(0);
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
