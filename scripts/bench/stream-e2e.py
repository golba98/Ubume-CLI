#!/usr/bin/env python3
"""Offline end-to-end stream-to-screen latency through a real pseudo-terminal.

Runs scripts/bench/fixtures/streamApp.tsx (production startApp path with an in-process fake
provider) in a PTY. Every provider event carries tokens ⟦n⟧. The app's UBUME_BENCH_TRACE
records emit / handler / flush / reduce / frame-write times per token; this driver records
when each token first appears in the PTY output. All clocks are epoch milliseconds on the
same machine.

Usage: python3 scripts/bench/stream-e2e.py [--iterations N] [--out DIR] [--workload NAME]
"""
import json, pathlib, re, statistics, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ptylib import REPO, Sandbox, Session, arg, metric, now_ms, write_report
from stream_validation import validate_canonical, validate_delivery

TOKEN = re.compile(rb"\xe2\x9f\xa6(\d+)\xe2\x9f\xa7")  # ⟦n⟧ in UTF-8
WORKLOADS = {
    # name: (token count, extra options)
    "short": (20, {}), "large": (600, {}), "rapid": (400, {}), "slow": (30, {}),
    "table": (150, {}), "code": (300, {}), "tools": (40, {}), "mixed": (120, {}),
    "history": (60, {"history_turns": 20}),
    "resize": (600, {"workload": "large", "resize": True}),
    "slow-reader": (400, {"workload": "rapid", "reader_delay": 0.004}),
}


def observe(session, total, reader_delay, resize, timeout=60.0):
    seen = {}
    scanned = 0
    resized = False
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline and len(seen) < total:
        session.pump(0.01, reader_delay)
        start = max(0, scanned - 16)
        observed_at = session.chunks[-1][0] if session.chunks else now_ms()
        for match in TOKEN.finditer(session.output, start):
            seq = int(match.group(1))
            if seq not in seen:
                # Attribute the token to the read that delivered its end byte.
                offset = match.end()
                at = observed_at
                for chunk_time, chunk_offset in reversed(session.chunks):
                    if chunk_offset < offset:
                        at = chunk_time
                        break
                seen[seq] = at
        scanned = len(session.output)
        if resize and not resized and len(seen) >= total // 2:
            session.resize(30, 70)
            resized = True
    return seen


def run_once(name, total, options):
    trace = None
    sandbox = Sandbox()
    try:
        trace = sandbox.root / "trace.jsonl"
        summary = sandbox.root / "summary.json"
        sandbox.env.update({
            "UBUME_BENCH_TRACE": str(trace),
            "BENCH_WORKLOAD": options.get("workload", name),
            "BENCH_SUMMARY_FILE": str(summary),
        })
        session = Session(sandbox, ["bun", str(REPO / "scripts/bench/fixtures/streamApp.tsx")])
        try:
            session.wait_ready()
            for turn in range(options.get("history_turns", 0)):
                mark = session.command(f"history {turn}", 0.1)
                session.wait_for(b"History line 199", mark, 10)
                session.pump(0.1)
            session.command("go", 0)
            sent = now_ms()
            seen = observe(session, total, options.get("reader_delay", 0.0), options.get("resize", False))
            deadline = time.perf_counter() + 10
            while not summary.exists() and time.perf_counter() < deadline:
                session.pump(0.05)
            session.pump(0.4)  # let the tracer flush (250 ms cadence)
        finally:
            session.close()
        records = [json.loads(line) for line in trace.read_text().splitlines() if line] if trace.exists() else []
        stage = {}
        frames = 0
        for record in records:
            if record.get("stage") == "frame":
                frames += 1
                for seq in record.get("fresh", []):
                    stage.setdefault(seq, {}).setdefault("frame", record["t"])
            elif "seq" in record:
                stage.setdefault(record["seq"], {}).setdefault(record["stage"], record["t"])
        info = json.loads(summary.read_text()) if summary.exists() else {}
        rows = []
        for seq in range(1, total + 1):
            marks = stage.get(seq, {})
            rows.append({"seq": seq, **marks, "observed": seen.get(seq)})
        snapshots = list((sandbox.root / "data").rglob("snapshot.json"))
        if len(snapshots) != 1:
            raise RuntimeError(f"Expected one canonical conversation snapshot, found {len(snapshots)}")
        if "emittedTextTokens" not in info or "emittedToolTokens" not in info:
            raise RuntimeError("Fixture did not finish writing its emission manifest")
        canonical_errors = validate_canonical(json.loads(snapshots[0].read_text()),
            info["emittedTextTokens"], info["emittedToolTokens"], total)
        canonical_errors.extend(validate_delivery(records, total))
        missing = [row["seq"] for row in rows if row["observed"] is None]
        order_violations = sum(
            1 for a, b in zip(rows, rows[1:])
            if a["observed"] is not None and b["observed"] is not None and b["observed"] + 0.5 < a["observed"]
        )
        return {"rows": rows, "frames": frames, "summary": info, "missing": missing,
                "firstObservationInversions": order_violations, "canonicalErrors": canonical_errors, "sentAt": sent}
    finally:
        sandbox.dispose()


def main():
    iterations = int(arg("--iterations", "3"))
    only = arg("--workload")
    metrics, details = [], {}
    for name, (total, options) in WORKLOADS.items():
        if only and name != only:
            continue
        latency = {"emit_to_handler": [], "handler_to_flush": [], "flush_to_frame": [],
                   "frame_to_observed": [], "provider_to_screen": []}
        first_visible, final_visible, frames, missing, violations, inversions, canonical_errors, lag, cpu, rss = [], [], [], 0, 0, 0, [], [], [], []
        for _ in range(iterations):
            result = run_once(name, total, options)
            rows = [row for row in result["rows"] if row.get("emit") is not None]
            for row in rows:
                pairs = (("emit_to_handler", "emit", "handler"), ("handler_to_flush", "handler", "flush"),
                         ("flush_to_frame", "flush", "frame"), ("frame_to_observed", "frame", "observed"),
                         ("provider_to_screen", "emit", "observed"))
                for key, a, b in pairs:
                    if row.get(a) is not None and row.get(b) is not None:
                        latency[key].append(max(0.0, row[b] - row[a]))
            observed = [row["observed"] for row in rows if row["observed"] is not None]
            emits = [row["emit"] for row in rows]
            if observed and emits:
                first_visible.append(min(observed) - min(emits))
                final_visible.append(max(observed) - min(emits))
            frames.append(result["frames"])
            missing += len(result["missing"])
            violations += len(result["canonicalErrors"])
            inversions += result["firstObservationInversions"]
            canonical_errors.extend(result["canonicalErrors"])
            summary = result["summary"]
            lag.extend(summary.get("lagMs", []))
            if summary:
                cpu.append(summary["cpuMs"])
                rss.append(summary["peakRss"])
        prefix = f"e2e.{name}"
        for key, samples in latency.items():
            if samples:
                metrics.append(metric(f"{prefix}.{key}", "ms", samples))
        if first_visible:
            metrics.append(metric(f"{prefix}.first_visible", "ms", first_visible))
            metrics.append(metric(f"{prefix}.final_visible", "ms", final_visible))
        metrics.append(metric(f"{prefix}.frames_written", "count", frames))
        if lag:
            metrics.append(metric(f"{prefix}.event_loop_delay", "ms", lag))
        if cpu:
            metrics.append(metric(f"{prefix}.cpu", "ms", cpu))
            metrics.append(metric(f"{prefix}.peak_rss", "bytes", rss))
        details[name] = {
            "tokens": total, "iterations": iterations, "missingTokens": missing,
            "streamValidationFailures": violations, "validationErrors": canonical_errors, "firstObservationInversions": inversions,
            "framesCoalescedPerToken": round(total / statistics.fmean(frames), 2) if frames and statistics.fmean(frames) else None,
        }
    write_report(
        arg("--out", str(REPO / "docs" / "_reports" / "performance" / "bench-results")), "stream-e2e",
        "Production startApp path (frame lock, Ink 30 fps throttle, clear-frame boundary) in a 100x30 "
        "PTY with an in-process fake provider. Latency stages per token: emit (fake provider) -> handler "
        "(providerRunSession) -> flush (live scheduler) -> frame (first frameLock write containing it) -> "
        "observed (first PTY read containing it). Epoch ms clocks on one machine. Correctness: every token "
        "must eventually be observed; emission, handler, normalization, scheduling and saved assistant/workbench/tool sequences must match emission order. "
        "A bounded live viewport may reveal skipped older tokens only during final history replay, "
        "so first-observation inversions are recorded separately and are not content-order evidence.",
        metrics, details,
        definitions={"peak_rss": "app-process RSS sampled at each provider event (fixture)",
                     "event_loop_delay": "lateness of a 5 ms timer inside the app process during the turn"},
    )
    if any(entry["missingTokens"] or entry["streamValidationFailures"] for entry in details.values()):
        print("FAILED: missing visible tokens or invalid canonical content", {k: (v["missingTokens"], v["streamValidationFailures"]) for k, v in details.items()})
        sys.exit(1)


if __name__ == "__main__":
    main()
