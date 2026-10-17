/**
 * Opt-in phase timing for `ubume exec` (`--timing`, `--benchmark-diagnostics`, or
 * `UBUME_EXEC_TIMING=1`).
 *
 * Each mark writes one `[ubume exec timing] phase=… elapsed_ms=… delta_ms=…` line to
 * stderr. The format matches the launcher's own marks in `bin/ubume.js`, so a single
 * benchmark log shows launcher and runner phases on one timeline when the launcher
 * passes `UBUME_EXEC_TIMING_EPOCH_MS`. Benchmark tooling parses these lines, so keep
 * the format stable.
 */

type HeadlessExecTimingValue = string | number | boolean | null | readonly string[];

/** A timing sink. When `enabled` is false, `mark` does nothing. */
export interface HeadlessExecTiming {
  enabled: boolean;
  /** Records a phase; string and array fields are JSON-quoted so values stay one token. */
  mark: (phase: string, fields?: Record<string, HeadlessExecTimingValue>) => void;
}

/**
 * Creates a timing sink.
 *
 * @param options.enabled - When false, `mark` is a no-op.
 * @param options.stderr - Destination; defaults to `process.stderr`.
 * @param options.startTimeMs - Epoch for `elapsed_ms`; defaults to now. The launcher's
 *   spawn time is passed in here so that elapsed times cover the whole process.
 */
export function createHeadlessExecTiming(options: {
  enabled: boolean;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  startTimeMs?: number;
}): HeadlessExecTiming {
  const startTimeMs = options.startTimeMs ?? Date.now();
  const stderr = options.stderr ?? process.stderr;
  let previousElapsedMs = 0;

  return {
    enabled: options.enabled,
    mark: (phase, fields = {}) => {
      if (!options.enabled) return;

      const elapsedMs = Date.now() - startTimeMs;
      const deltaMs = elapsedMs - previousElapsedMs;
      previousElapsedMs = elapsedMs;

      const formattedFields = Object.entries(fields)
        .map(([key, value]) => {
          const serialized =
            Array.isArray(value) || typeof value === "string"
              ? JSON.stringify(value)
              : String(value);
          return `${key}=${serialized}`;
        })
        .join(" ");
      const suffix = formattedFields ? ` ${formattedFields}` : "";
      stderr.write(
        `[ubume exec timing] phase=${phase} elapsed_ms=${elapsedMs} delta_ms=${deltaMs}${suffix}\n`,
      );
    },
  };
}
