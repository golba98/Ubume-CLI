# Phase 1.1 offline measurements

These runners are independent of `bin/`, `scripts/`, package scripts, and lockfiles.
They require Linux, Bubblewrap, Bun, Node, Python 3, and the existing node_modules.
No additional dependencies are installed.

```sh
python3 perf/phase1_1/validate.py
python3 perf/phase1_1/run.py --case safety --runs 1 --label final
python3 perf/phase1_1/run.py --case startup --runs 5 --label final
python3 perf/phase1_1/run.py --case startup --runs 5 --label gated --gated-update
python3 perf/phase1_1/run.py --case stream --runs 3 --label final
python3 perf/phase1_1/run.py --case throughput --runs 7 --label final
python3 perf/phase1_1/run.py --case throughput --runs 7 --label legacy --legacy-sanitizer
python3 perf/phase1_1/run.py --case shell --runs 5 --label final
python3 perf/phase1_1/run.py --case shell --runs 5 --label legacy --legacy-sanitizer
python3 perf/phase1_1/run.py --case headless --runs 3 --label final
python3 perf/phase1_1/run.py --case headless --runs 3 --label legacy --legacy-sanitizer
python3 perf/phase1_1/run.py --case memory --runs 1 --label final
python3 perf/phase1_1/run.py --case app-switch --runs 3 --label final
python3 perf/phase1_1/run.py --case switch --runs 3 --label after
python3 perf/phase1_1/run.py --case imports --runs 1 --label after
python3 perf/phase1_1/run.py --case storage --runs 3 --label after
python3 perf/phase1_1/analyze.py
node_modules/.bin/tsc --noEmit -p perf/phase1_1/tsconfig.json
```

`--case all` is available, but repeats the minute-long memory profile for every
requested run. Run timing suites sequentially when comparing small differences.

## Safety

Every benchmark invocation snapshots source, fixture code, and package metadata
into a private directory on the repository's filesystem. It mounts those copies
read-only over the source tree. Concurrent checkout edits cannot change a running
sample. Temporary files, homes, configuration, fake executables, and output spools
are removed when the outer runner exits. Temporary snapshot directories exclude
themselves from copying.

The application and loopback mocks run in one new PID/network namespace. Host
homes are absent; inherited environment variables and credentials are absent;
PATH contains only selected runtime tools. The network namespace has no external
route, which is checked before running fixtures. Real local inference services on
the host are also unreachable. Bun is mounted at a fixed private runtime path.

The preload rejects unapproved child_process executables before spawning,
including absolute paths. Shell commands are fixed fixture strings; they only
use the controlled PATH. Source providers use child_process. Fake scripts log
their own real executable identity separately from the parent's spawn log. The
preflight checks denied bare/absolute executables, denied external fetch, missing
explicit executable rejection, and successful execution of the intended fake
through the real Codex adapter. It runs before every benchmark suite.

The mount namespace, credential isolation, executable checks, and network
namespace are independent protections. A missing isolation facility fails the
runner; it does not fall back to an online benchmark. `validate.py` runs only its
explicitly listed tests in a separate isolated namespace with the repository's
offline test preload. It does not execute the installed launcher or a full suite.

## Measurement definitions

- **startup:** direct Bun `startApp`, real Ink and PTY; composer visibility and
  successful `/help` execution are different measurements. Includes fixture setup
  and excludes the installed Node launcher. The gated control changes only the
  startup screen policy in its private source copy. A PTY recording is saved as
  `startup.cast`. Update-available notification timing is distinct from help.
- **stream:** fake emission → handler → normalization → scheduling → flush →
  reducer → React layout-effect commit observation / Ink output generation →
  terminal write → PTY read. The fake provider runs in-process; this measures the
  actual application/render/terminal path, without a provider transport delay.
  Ten pipe handshakes calibrate Bun/Python monotonic clock origins; the shortest
  round trip supplies the offset and an uncertainty bound. UTF-8 decoding is
  incremental. Observation continues after completion so tokens entering native
  scrollback are counted. All tokens must be accounted for in analysis; missing
  observations are reported, never assigned zero latency. `history` resumes 500
  synthetic turns. `slow-reader` delays PTY reads by 40 ms.
- **memory:** real App with a draining, latest-frame-only Ink test terminal. Normal
  RSS/PSS/heap samples occur before any explicit GC. Child PSS, resource types,
  listeners, and final catalog counts are recorded. Diagnostic GC/heap statistics
  happen separately at the end. This is a debug-renderer attribution profile,
  not a like-for-like installed-launcher comparison.
- **imports:** fresh processes measure empty/Ink/App/Harness-module graphs. Heap
  snapshot summaries report class counts and shallow sizes, not dominator retained
  sizes. No Harness inference is started.
- **app-switch:** 100 real App picker transitions per fresh process, with all
  execution/discovery methods mocked; execution itself throws if requested.
  Uses only the latest rendered frame, checks persisted provider/model pairs,
  and records retained heap at 25-switch intervals and after clear/unmount.
- **switch:** nine coordinator/catalog scenarios, 400 transitions each, with
  deterministic discovery failures, cancellations, invalidations, model failures,
  Local routing, and request failures. These isolate state ownership from UI
  history growth. Diagnostic GC is only in the benchmark.
- **throughput:** exact ASCII/Unicode output equality through runCommand. The
  private legacy control disables the streaming sanitizer fast path.
- **shell:** the real App runs a 10 MiB producer with full capture and final shell
  summary. Completion RSS is sampled, not represented as kernel peak RSS. These
  short runs are sensitive to JSC/native allocator timing.
- **storage:** isolated memory capture versus complete disk spool, including final
  text materialization and line conversion. Files live on btrfs, not tmpfs.
  Exact output, line counts, spool deletion, and read-only disk failure are checked.
  This is an experiment; production shell output is not spooled or truncated.
- **headless:** source CLI plus real Codex adapter with 20 MiB of separate fake
  assistant items. The current CLI also prints the final 64 KiB item when it differs
  from the aggregate stream, so the checked output is 21,037,056 `x` characters
  plus line separators. That existing behavior is preserved. This differs from
  the Phase 1 fixture and does not establish a 155 MB baseline comparison.

Results include source fingerprints, runtime/kernel versions, spawn logs, and
raw samples. The analyzer gives p95 for at least 20 observations and p99 for at
least 100. Token samples within a run are correlated; three runs do not provide a
strong population estimate of extreme tails. React commit and Ink output
observations can overlap because Ink generates output during the commit cycle.

## Generated evidence

Results, PTY recordings, validation logs and private source snapshots default to
`docs/_reports/performance/phase1_1/` at the repository root. That directory is Git-ignored.
Keep only the reusable runner, fixtures and documentation in this directory; never force-add
measurement output. Labels are simple names, and `--runs` must be positive.
