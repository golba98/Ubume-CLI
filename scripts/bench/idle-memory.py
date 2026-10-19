#!/usr/bin/env python3
"""Offline interactive memory profile with process-level attribution.

Drives the real launcher in a PTY through the Phase 1.1 states and records, per state:
- per-process RSS/PSS (anon vs file-backed) from /proc/<pid>/smaps_rollup, with the Node
  launcher, the Bun app and any children reported separately;
- a GC'd JSC heap report from the Bun app (UBUME_BENCH_MEMORY + SIGUSR2): live heap,
  capacity, extra (external) memory, object counts and the largest object types.
The provider is a fake Claude CLI (spawn-logged; verified afterwards); nothing leaves the
machine. A second session resumes a large synthetic saved conversation, then /clear.

Usage: python3 scripts/bench/idle-memory.py [--idle SECONDS] [--repeats N] [--out DIR]
"""
import json, os, pathlib, signal, subprocess, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ptylib import REPO, Sandbox, Session, arg, metric, write_report

FAKE_CLAUDE = r"""
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" || args[0] === "login") { console.log('{"loggedIn":true}'); process.exit(0); }
if (args[0] === "model") { console.log(JSON.stringify({ models: [{ value: "sonnet", canonicalId: "claude-sonnet-5-5", effortLevels: ["low","medium","high"], defaultEffort: "medium" }] })); process.exit(0); }
if (args.includes("-p")) {
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fake claude answer" }] } }));
  process.exit(0);
}
process.exit(0);
"""

SEED_CONVERSATION = r"""
import { ConversationStore } from "%s/src/core/workspace/conversationStore.ts";
const store = new ConversationStore(process.argv[2]);
const record = store.createConversation({ providerId: "anthropic", modelId: "sonnet", backendKind: "claude-code-auth" });
for (let i = 0; i < Number(process.argv[3]); i++) {
  record.messages.push({ role: "user", content: `Question ${i}: ` + "explain the module structure ".repeat(20), turnId: i + 1 });
  record.messages.push({ role: "assistant", content: `Answer ${i}:\n` + "- point with **markdown** and `code`\n".repeat(40), turnId: i + 1 });
}
store.save(record);
store.release();
console.log(record.metadata.id);
"""


def bun_pid(session):
    for pid, name in session.tree_pids():
        if name == "bun":
            return pid
    return None


def heap_report(session, report_file):
    pid = bun_pid(session)
    if not pid:
        return None
    before = report_file.read_text().count("\n") if report_file.exists() else 0
    os.kill(pid, signal.SIGUSR2)
    deadline = time.perf_counter() + 5
    while time.perf_counter() < deadline:
        session.pump(0.05)
        if report_file.exists() and report_file.read_text().count("\n") > before:
            return json.loads(report_file.read_text().splitlines()[-1])
    return None


def snapshot(session, report_file, state):
    processes = session.memory()
    heap = heap_report(session, report_file)
    bun = [p for p in processes if p["role"] == "bun"]
    return {
        "state": state,
        "processes": processes,
        "tree_pss": sum(p["pss"] for p in processes),
        "launcher_pss": sum(p["pss"] for p in processes if p["role"] == "launcher"),
        "bun_pss": sum(p["pss"] for p in bun),
        "bun_pss_anon": sum(p["pss_anon"] for p in bun),
        "bun_pss_file": sum(p["pss_file"] for p in bun),
        "bun_rss": sum(p["rss"] for p in bun),
        "children_pss": sum(p["pss"] for p in processes if p["role"] not in ("bun", "launcher")),
        "heap": heap,
    }


def configure(sandbox):
    from hashlib import sha256
    workspace = str(sandbox.root / "project")
    key = sha256(workspace.encode()).hexdigest()[:16]
    data = sandbox.root / "data" / "workspaces" / key
    data.mkdir(parents=True, exist_ok=True)
    (data / "providers.json").write_text(json.dumps({
        "activeRoute": {"providerId": "anthropic", "modelId": "sonnet", "backendKind": "claude-code-auth"},
        "providers": {"anthropic": {"claudeCommandPath": sandbox.fakes["claude"]}},
    }))
    report = sandbox.root / "memory.jsonl"
    sandbox.env.update({"UBUME_BENCH_MEMORY": str(report), "UBUME_BENCH_MEMORY_GC": "1", "ANTHROPIC_API_KEY": ""})
    return report


def main_session(idle_seconds):
    sandbox = Sandbox(fakes={"claude": FAKE_CLAUDE})
    report = configure(sandbox)
    states = []
    try:
        session = Session(sandbox)
        try:
            session.wait_for(b"\x1b", 0, 10)
            states.append(snapshot(session, report, "launch"))
            session.wait_ready()
            states.append(snapshot(session, report, "input-ready"))
            session.pump(10)
            states.append(snapshot(session, report, "idle-10s"))
            session.pump(max(0, idle_seconds - 10))
            states.append(snapshot(session, report, f"idle-{idle_seconds}s"))
            session.command("/model", 0.8)
            session.send(b"\x1b", 0.6)
            states.append(snapshot(session, report, "after-model-picker"))
            session.command("/providers", 0.8)
            session.send(b"\x1b", 0.6)
            states.append(snapshot(session, report, "after-provider-picker"))
            mark = session.command("hello from the memory benchmark", 0)
            ran = session.wait_for(b"fake claude answer", mark, 20)
            session.pump(1.0)
            states.append(snapshot(session, report, "after-fake-provider-run" if ran else "after-fake-provider-run-FAILED"))
            for index in range(20):
                session.command("/providers", 0.5)
                session.send(b"\x1b[H", 0.05)
                session.send(b"\x1b[B" * (1 if index % 2 == 0 else 0), 0.05)
                session.send(b"\r", 0.6)
                session.send(b"\x1b", 0.3)
            session.pump(1.0)
            states.append(snapshot(session, report, "after-20-provider-switches"))
        finally:
            session.close()
        sandbox.assert_spawned_only([sandbox.fakes["claude"]])
        return states
    finally:
        sandbox.dispose()


def conversation_session(turns):
    sandbox = Sandbox(fakes={"claude": FAKE_CLAUDE})
    report = configure(sandbox)
    states = []
    try:
        seed = sandbox.root / "seed.ts"
        seed.write_text(SEED_CONVERSATION % REPO)
        conversation_id = subprocess.run(
            ["bun", str(seed), str(sandbox.root / "project"), str(turns)],
            env=sandbox.env, cwd=sandbox.root / "project", capture_output=True, text=True, check=True,
        ).stdout.strip().splitlines()[-1]
        session = Session(sandbox, ["node", str(REPO / "bin/ubume.js"), "--resume", conversation_id])
        try:
            session.wait_ready(30)
            session.pump(2.0)
            states.append(snapshot(session, report, f"after-resume-{turns}-turns"))
            session.command("/clear", 1.5)
            session.pump(1.0)
            states.append(snapshot(session, report, "after-clear"))
        finally:
            session.close()
        return states
    finally:
        sandbox.dispose()


def module_baseline():
    """RSS of importing the App module graph without rendering, vs. an empty Bun process."""
    rows = {}
    for label, script in (
        ("bun-empty", "0"),
        ("import-ink-react", "await import('ink'); await import('react')"),
        ("import-app", f"await import('{REPO}/src/app/App.tsx')"),
    ):
        result = subprocess.run(["/usr/bin/time", "-f", "%M", "bun", "-e", script], capture_output=True, text=True, cwd=REPO)
        rows[label] = int(result.stderr.strip().splitlines()[-1])
    return rows


def main():
    idle = int(arg("--idle", "60"))
    repeats = int(arg("--repeats", "2"))
    turns = int(arg("--turns", "500"))
    runs = [main_session(idle) + conversation_session(turns) for _ in range(repeats)]
    metrics = []
    for state_index, state in enumerate(runs[0]):
        name = state["state"]
        for key in ("tree_pss", "launcher_pss", "bun_pss", "bun_pss_anon", "bun_pss_file", "bun_rss", "children_pss"):
            metrics.append(metric(f"memory.{name}.{key}", "KiB", [run[state_index][key] for run in runs]))
        heaps = [run[state_index]["heap"] for run in runs if run[state_index]["heap"]]
        if heaps:
            metrics.append(metric(f"memory.{name}.js_live_heap", "bytes", [h["heap"]["heapSize"] for h in heaps]))
            metrics.append(metric(f"memory.{name}.js_heap_capacity", "bytes", [h["heap"]["heapCapacity"] for h in heaps]))
            metrics.append(metric(f"memory.{name}.js_extra_memory", "bytes", [h["heap"]["extraMemorySize"] for h in heaps]))
            metrics.append(metric(f"memory.{name}.js_objects", "count", [h["heap"]["objectCount"] for h in heaps]))
    baseline = module_baseline()
    for label, kib in baseline.items():
        metrics.append(metric(f"memory.module.{label}.max_rss", "KiB", [kib]))
    write_report(
        arg("--out", str(REPO / "docs" / "_reports" / "performance" / "bench-results")), "idle-memory",
        f"{repeats} runs. Real launcher in a PTY, isolated sandbox, fake Claude CLI (spawn-logged). Per state: "
        "smaps_rollup per process (launcher = Node root pid, bun = app) and a JSC heap report after full GC "
        "(UBUME_BENCH_MEMORY_GC=1, benchmark only). Second session resumes a synthetic "
        f"{turns}-turn conversation then /clear. Module baseline: GNU time max RSS of bun importing graphs.",
        metrics,
        {"states": runs[0], "moduleBaselineKiB": baseline},
        definitions={
            "tree_pss": "sum of PSS (proportional set size) over the launcher, the Bun app and children",
            "bun_pss_anon": "anonymous (heap/JIT/malloc) PSS of the Bun process",
            "bun_pss_file": "file-backed PSS (binary, shared libraries, mapped files)",
            "js_live_heap": "JSC heapSize after a forced full GC (benchmark-only): live JS objects",
            "js_heap_capacity": "JSC heap capacity: committed heap including free cells",
            "js_extra_memory": "JSC extraMemorySize: external memory reported by objects (buffers, strings)",
        },
    )


if __name__ == "__main__":
    main()
