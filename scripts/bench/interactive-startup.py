#!/usr/bin/env python3
"""Offline interactive startup benchmark: the real launcher in a PTY.

Measures, per fresh process: first output byte, first frame showing the composer,
and input-ready (time until a typed sentinel is echoed in the composer).

Scenarios:
  updates-disabled        update checking off in isolated settings
  slow-network            update check on; HTTPS goes through a local proxy that
                          accepts and never answers (stands in for a stalled network)
  slow-network-fresh-cache  as above, with a fresh "up to date" cache for the running version

No provider is reachable: HOME/data roots are temporary and provider executables
point at missing paths. The npm registry is never contacted because all HTTP(S)
traffic is routed to the local black-hole proxy (or update checking is off).

Usage: python3 scripts/bench/interactive-startup.py [--iterations N] [--out DIR] [--scenario NAME]
"""
import fcntl, json, os, pathlib, platform, pty, select, shutil, signal, socket, statistics
import struct, subprocess, sys, tempfile, termios, threading, time
from datetime import datetime, timezone

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
MARKER = b"Ask Ubume, run !shell"
SENTINEL = b"zq7x"
HELP_MARKER = b"Commands:"
TIMEOUT_S = 20.0
PROBE_INTERVAL_S = 0.05
IDLE_SETTLE_S = 1.5


def arg(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def black_hole_proxy():
    """Accepts proxy connections and never replies, so fetches hit their own deadline."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(64)
    held = []

    def serve():
        while True:
            try:
                connection, _ = server.accept()
                held.append(connection)
            except OSError:
                return

    threading.Thread(target=serve, daemon=True).start()
    return server, held


def package_version():
    return json.loads((REPO / "package.json").read_text())["version"]


PROVIDER_COMMANDS = ("codex", "claude", "gemini", "agy", "antigravity", "vibe")


def safe_path(root):
    """PATH with only node, bun and system dirs: the user's PATH may hold real provider CLIs."""
    bin_dir = root / "bin"
    bin_dir.mkdir()
    for command in ("node", "bun"):
        (bin_dir / command).symlink_to(shutil.which(command))
    path = os.pathsep.join([str(bin_dir), "/usr/bin", "/bin"])
    for command in PROVIDER_COMMANDS:
        if shutil.which(command, path=path):
            raise RuntimeError(f"unsafe benchmark PATH: {command} is resolvable")
    return path


def isolated_env(root, proxy_port):
    env = {
        "PATH": safe_path(root),
        "TERM": "xterm-256color",
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "HOME": str(root),
        "USERPROFILE": str(root),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_DATA_HOME": str(root / "share"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_STATE_HOME": str(root / "state"),
        "UBUME_DATA_DIR": str(root / "data"),
        "CODEX_HOME": str(root / "codex"),
        "CLAUDE_CONFIG_DIR": str(root / "claude"),
        "GEMINI_CLI_HOME": str(root / "gemini"),
        "VIBE_HOME": str(root / "vibe"),
        "UBUME_DEV_MODE": "0",
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
    }
    for provider in ("CODEX", "CLAUDE", "AGY", "GEMINI", "VIBE"):
        env[f"{provider}_EXECUTABLE"] = str(root / f"missing-{provider.lower()}")
    if proxy_port is not None:
        proxy = f"http://127.0.0.1:{proxy_port}"
        for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
            env[name] = proxy
        env["NO_PROXY"] = ""
    return env


def prepare_root(scenario):
    root = pathlib.Path(tempfile.mkdtemp(prefix="ubume-bench-interactive-"))
    (root / "project").mkdir()
    (root / "data").mkdir()
    settings = {"updateCheck": {"enabled": scenario != "updates-disabled"}}
    (root / ".ubume-settings.json").write_text(json.dumps(settings))
    if scenario == "slow-network-fresh-cache":
        version = package_version()
        (root / ".ubume-update-check.json").write_text(json.dumps({
            "lastChecked": int(time.time() * 1000),
            "currentVersion": version,
            "latestVersion": version,
            "updateAvailable": False,
        }))
    return root


def tree_memory(root_pid):
    """PSS/RSS (KiB) of the launcher (root pid), the Bun app, and the whole tree."""
    listing = subprocess.run(["ps", "-e", "-o", "pid=,ppid=,comm="], capture_output=True, text=True).stdout
    children, names = {}, {}
    for row in listing.splitlines():
        pid, ppid, name = row.split(None, 2)
        children.setdefault(int(ppid), []).append(int(pid))
        names[int(pid)] = name.strip()
    totals = {"pss_total_kib": 0, "pss_launcher_kib": 0, "pss_bun_kib": 0, "rss_bun_kib": 0}
    pending = [root_pid]
    while pending:
        pid = pending.pop()
        pending.extend(children.get(pid, []))
        try:
            rollup = pathlib.Path(f"/proc/{pid}/smaps_rollup").read_text()
        except OSError:
            continue
        fields = {line.split(":")[0]: int(line.split()[1]) for line in rollup.splitlines()[1:]}
        totals["pss_total_kib"] += fields.get("Pss", 0)
        if pid == root_pid:
            totals["pss_launcher_kib"] += fields.get("Pss", 0)
        if names.get(pid) == "bun":
            totals["pss_bun_kib"] += fields.get("Pss", 0)
            totals["rss_bun_kib"] += fields.get("Rss", 0)
    return totals


def run_once(scenario, proxy_port):
    root = prepare_root(scenario)
    env = isolated_env(root, None if scenario == "updates-disabled" else proxy_port)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    # Without kernel echo, the sentinel can only appear once the app renders it.
    attributes = termios.tcgetattr(slave)
    attributes[3] &= ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, attributes)
    start = time.perf_counter()
    child = subprocess.Popen(
        ["node", str(REPO / "bin/ubume.js")], cwd=root / "project", env=env,
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    output = b""
    first_byte = composer = ready = submitted = None
    help_from = 0
    sent_at = None
    echo_from = 0
    probes = 0
    try:
        while time.perf_counter() - start < TIMEOUT_S:
            # Keys typed while a startup overlay owns focus are dropped, so probe
            # until the composer echoes one (the sentinel binds no panel action).
            if ready is None and sent_at is not None and time.perf_counter() - sent_at >= PROBE_INTERVAL_S:
                sent_at = time.perf_counter()
                os.write(master, SENTINEL)
                probes += 1
            readable, _, _ = select.select([master], [], [], 0.002)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                now = time.perf_counter()
                if first_byte is None:
                    first_byte = now
                output += chunk
                if composer is None and MARKER in output:
                    composer = now
                    sent_at = now
                    os.write(master, SENTINEL)
                    echo_from = len(output)
                    probes = 1
                if ready is None and sent_at is not None and SENTINEL in output[max(0, echo_from - 16):]:
                    ready = now
                    # Clear the probes, then submit /help: a queued submit only runs
                    # once the startup gate has released the main screen.
                    for keys, pause in ((b"\x15", 0.05), (b"/help", 0.2), (b"\r", 0)):
                        os.write(master, keys)
                        time.sleep(pause)
                    help_from = len(output)
                if ready is not None and HELP_MARKER in output[max(0, help_from - 16):]:
                    submitted = now
                    break
        # Idle memory: let the help overlay settle, then sample the whole tree.
        settle_until = time.perf_counter() + IDLE_SETTLE_S
        while submitted is not None and time.perf_counter() < settle_until:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    os.read(master, 65536)
                except OSError:
                    break
        memory = tree_memory(child.pid) if submitted is not None else {}
    finally:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(master)
        shutil.rmtree(root, ignore_errors=True)
    if submitted is None:
        raise RuntimeError(f"{scenario}: composer/input not ready within {TIMEOUT_S}s")
    return {
        "first_byte_ms": (first_byte - start) * 1000,
        "composer_visible_ms": (composer - start) * 1000,
        "input_ready_ms": (ready - start) * 1000,
        "echo_latency_ms": (ready - sent_at) * 1000,
        "submit_ready_ms": (submitted - start) * 1000,
        "probes": probes,
        **memory,
    }


def summarize(samples):
    ordered = sorted(samples)
    mean = statistics.fmean(ordered)
    stddev = statistics.stdev(ordered) if len(ordered) > 1 else 0.0
    at = lambda fraction: ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]
    return {k: round(v, 3) for k, v in {
        "n": len(ordered), "p50": at(0.5), "p95": at(0.95), "min": ordered[0], "max": ordered[-1],
        "mean": mean, "stddev": stddev, "cv": stddev / mean if mean else 0.0,
    }.items()}


def git(*args):
    result = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def main():
    iterations = int(arg("--iterations", "20"))
    out_dir = pathlib.Path(arg("--out", str(REPO / "docs" / "_reports" / "performance" / "bench-results")))
    only = arg("--scenario")
    scenarios = {
        "updates-disabled": iterations,
        "slow-network": max(3, iterations // 4),
        "slow-network-fresh-cache": max(3, iterations // 4),
    }
    proxy, held = black_hole_proxy()
    metrics = []
    try:
        for scenario, count in scenarios.items():
            if only and scenario != only:
                continue
            run_once(scenario, proxy.getsockname()[1])  # warmup
            runs = [run_once(scenario, proxy.getsockname()[1]) for _ in range(count)]
            for key in ("first_byte_ms", "composer_visible_ms", "input_ready_ms", "echo_latency_ms", "submit_ready_ms"):
                metrics.append({
                    "id": f"interactive.{scenario}.{key[:-3]}", "unit": "ms", "lowerIsBetter": True,
                    "stats": summarize([run[key] for run in runs]),
                })
            if scenario == "updates-disabled":
                for key in ("pss_total_kib", "pss_launcher_kib", "pss_bun_kib", "rss_bun_kib"):
                    metrics.append({
                        "id": f"interactive.idle.{key[:-4]}", "unit": "KiB", "lowerIsBetter": True,
                        "stats": summarize([run[key] for run in runs]),
                    })
    finally:
        proxy.close()
        for connection in held:
            connection.close()
    node = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    bun = subprocess.run(["bun", "--version"], capture_output=True, text=True).stdout.strip()
    report = {
        "suite": "interactive",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "environment": {
            "bun": bun, "node": node, "platform": sys.platform, "arch": platform.machine(),
            "kernel": platform.release(), "cpu": platform.processor() or "unknown",
            "logicalCores": os.cpu_count(), "commit": git("rev-parse", "HEAD"),
            "dirty": bool(git("status", "--porcelain")), "fileCache": "warm/unspecified (not controlled)",
        },
        "method": (
            "Real launcher (node bin/ubume.js) in a 100x30 PTY with isolated HOME/data roots; one "
            "warmup per scenario. composer_visible = first output containing the composer "
            "placeholder; input_ready = sentinel typed at composer_visible is echoed back. "
            "slow-network routes HTTP(S) to a local proxy that never answers."
        ),
        "metrics": metrics,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "interactive.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    for entry in metrics:
        s = entry["stats"]
        print(f"{entry['id']:<58} p50 {s['p50']:>10} p95 {s['p95']:>10} min {s['min']:>10} max {s['max']:>10} n={s['n']}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
