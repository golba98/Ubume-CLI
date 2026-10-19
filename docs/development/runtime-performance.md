# Runtime and storage performance

Startup shows the composer while update checks run in the background. A background result
does not steal focus; explicit update checks still show their result. Local Harness SDK code
loads on the first Local run, and shutdown before that point does not load the SDK.

Shell output batches enter the session reducer together. Running shell events stay in the
live transcript until finalized, so Ink Static does not permanently print a stale running
status. Markdown caches promote hits within their entry and character budgets. Frame-lock
release restores the prior stream writer and drops retained frame/debug buffers.

Workspace display scans reuse content only when size, inode, mtime and ctime match. Scans
use bounded concurrency and yield to input/timers; polling backs off when scanning is slow.
Recovery checkpoints still hash exact bytes and apply capture limits in stable listing order.
Canonical conversation snapshots retain file and directory fsync. Only revision-validated,
rebuildable summary caches omit fsync; stale or missing caches fall back to the snapshot.

The optional instrumentation in `src/core/perf/benchTrace.ts` records startup, streaming,
frame and memory stages for controlled offline measurements. Instrumentation is opt-in.
Measurements must identify the source, fixture, environment, samples and uncertainty; these
changes alone do not establish a universal latency or memory improvement. Put generated
benchmark evidence under the ignored `docs/_reports/performance/` directory.
