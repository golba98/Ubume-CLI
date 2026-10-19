#!/usr/bin/env python3
"""Offline interactive startup timeline: where time goes from `node bin/ubume.js` to input.

Each run launches the real launcher in a PTY with UBUME_STARTUP_TRACE, then waits for
genuine input readiness (a typed sentinel echoed by the composer). Stage offsets are
relative to the launcher process start (its performance.timeOrigin).

Usage: python3 scripts/bench/startup-timeline.py [--iterations N] [--out DIR]
"""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ptylib import REPO, Sandbox, Session, arg, metric, now_ms, write_report

STAGES = [
    "launcher-script-start", "launcher-spawn", "bun-process-start", "modules-loaded", "start-app",
    "settings-loaded", "render-start", "app-state-init", "app-config-loaded", "render-returned",
    "first-frame-write", "composer-focused", "auth-probe-start", "auth-probe-end",
]


def run_once():
    sandbox = Sandbox()
    try:
        trace = sandbox.root / "startup.jsonl"
        sandbox.env["UBUME_STARTUP_TRACE"] = str(trace)
        session = Session(sandbox)
        try:
            input_ready = session.wait_ready()
            first_byte = session.chunks[0][0] - session.started_ms if session.chunks else None
            session.pump(1.2)  # post-mount effects and the tracer's flush interval
        finally:
            session.close()
        marks = {}
        for line in trace.read_text().splitlines() if trace.exists() else []:
            record = json.loads(line)
            marks.setdefault(record["stage"], record["t"])
        origin = marks.get("launcher-process-start")
        offsets = {stage: marks[stage] - origin for stage in STAGES if origin and stage in marks}
        # PTY-observed milestones on the same clock (driver spawn ~= launcher start).
        offsets["pty-first-byte"] = first_byte
        offsets["pty-input-ready"] = input_ready
        return offsets
    finally:
        sandbox.dispose()


def main():
    iterations = int(arg("--iterations", "20"))
    run_once()  # warmup (disk cache, transpiler)
    runs = [run_once() for _ in range(iterations)]
    metrics = []
    for stage in STAGES + ["pty-first-byte", "pty-input-ready"]:
        samples = [run[stage] for run in runs if run.get(stage) is not None]
        if samples:
            metrics.append(metric(f"startup.offset.{stage}", "ms", samples))
    # Stage-to-stage durations along the critical path.
    path = ["launcher-script-start", "launcher-spawn", "bun-process-start", "modules-loaded",
            "settings-loaded", "render-start", "render-returned", "first-frame-write", "composer-focused"]
    for a, b in zip(path, path[1:]):
        samples = [run[b] - run[a] for run in runs if run.get(a) is not None and run.get(b) is not None]
        if samples:
            metrics.append(metric(f"startup.span.{a}..{b}", "ms", samples))
    write_report(
        arg("--out", str(REPO / "docs" / "_reports" / "performance" / "bench-results")), "startup-timeline",
        f"{iterations} PTY launches of node bin/ubume.js (one warmup), update checks off, isolated "
        "sandbox. Offsets from the launcher's process start (performance.timeOrigin) to each "
        "UBUME_STARTUP_TRACE mark; pty-* are observed by the driver on the same wall clock.",
        metrics,
    )


if __name__ == "__main__":
    main()
