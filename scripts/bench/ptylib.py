"""Shared offline PTY harness for the interactive benchmark suites.

Every session runs in an isolated root: provider-free PATH (node, bun, git, python3, sh and
system dirs; refuses to start if a provider CLI resolves), temporary HOME/data directories,
provider secrets removed, and HTTP(S) proxies pointed at a refusing port. Optional fake
provider executables log every invocation to a spawn log that callers can assert on.
"""
import fcntl, json, os, pathlib, platform, pty, select, shutil, signal, statistics, struct
import subprocess, sys, tempfile, termios, time
from datetime import datetime, timezone

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
PROVIDER_COMMANDS = ("codex", "claude", "gemini", "agy", "antigravity", "vibe")
TRUSTED_TOOLS = ("node", "bun", "git", "python3", "sh")
REFUSING_PROXY = "http://127.0.0.1:9"
COMPOSER_MARKER = b"Ask Ubume, run !shell"


def now_ms():
    """Wall-clock epoch milliseconds; comparable with Bun's performance.timeOrigin + now()."""
    return time.time() * 1000.0


def safe_path(root):
    bin_dir = root / "bin"
    bin_dir.mkdir(exist_ok=True)
    for command in TRUSTED_TOOLS:
        found = shutil.which(command)
        if found and not (bin_dir / command).exists():
            (bin_dir / command).symlink_to(os.path.realpath(found))
    path = os.pathsep.join([str(bin_dir), "/usr/bin", "/bin"])
    for command in PROVIDER_COMMANDS:
        if shutil.which(command, path=path):
            raise RuntimeError(f"unsafe benchmark PATH: {command} is resolvable")
    return path


SPAWN_LOG_HEADER = """#!/usr/bin/env node
require("node:fs").appendFileSync(%s, JSON.stringify({provider: %s, executable: require("node:fs").realpathSync(process.argv[1]), argv: process.argv.slice(2), pid: process.pid}) + "\\n");
"""


class Sandbox:
    def __init__(self, settings=None, fakes=None, extra_env=None, proxy=REFUSING_PROXY):
        self.root = pathlib.Path(os.path.realpath(tempfile.mkdtemp(prefix="ubume-bench-pty-")))
        (self.root / "project").mkdir()
        (self.root / "data").mkdir()
        (self.root / "home").mkdir()
        self.spawn_log = self.root / "spawns.jsonl"
        self.spawn_log.write_text("")
        self.fakes = {}
        fake_dir = self.root / "fake-providers"
        fake_dir.mkdir()
        for name, body in (fakes or {}).items():
            path = fake_dir / name
            path.write_text(SPAWN_LOG_HEADER % (json.dumps(str(self.spawn_log)), json.dumps(name)) + body)
            path.chmod(0o700)
            self.fakes[name] = str(path)
        home = self.root / "home"
        (home / ".ubume-settings.json").write_text(json.dumps(settings or {"updateCheck": {"enabled": False}}))
        self.env = {
            "PATH": safe_path(self.root),
            "TERM": "xterm-256color",
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "HOME": str(home),
            "USERPROFILE": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local/share"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_STATE_HOME": str(home / ".local/state"),
            "UBUME_DATA_DIR": str(self.root / "data"),
            "CODEX_HOME": str(self.root / "codex"),
            "CLAUDE_CONFIG_DIR": str(self.root / "claude"),
            "GEMINI_CLI_HOME": str(self.root / "gemini"),
            "VIBE_HOME": str(self.root / "vibe"),
            "UBUME_DEV_MODE": "0",
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
            "NO_PROXY": "127.0.0.1,localhost,::1",
        }
        if proxy:
            for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"):
                self.env[name] = proxy
        for name, path in self.fakes.items():
            self.env[f"{name.upper()}_EXECUTABLE"] = path
        self.env.update(extra_env or {})

    def spawned(self):
        return [json.loads(line) for line in self.spawn_log.read_text().splitlines() if line]

    def assert_spawned_only(self, allowed):
        allowed = {os.path.realpath(path) for path in allowed}
        for record in self.spawned():
            if record["executable"] not in allowed:
                raise RuntimeError(f"unexpected provider executable spawned: {record['executable']}")

    def dispose(self):
        shutil.rmtree(self.root, ignore_errors=True)


class Session:
    """A real Ubume process tree in a PTY with kernel echo disabled."""

    def __init__(self, sandbox, argv=None, rows=30, columns=100):
        self.sandbox = sandbox
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        attributes = termios.tcgetattr(slave)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attributes)
        self.started_ms = now_ms()
        self.start = time.perf_counter()
        command = argv or ["node", str(REPO / "bin/ubume.js")]
        self.child = subprocess.Popen(
            command, cwd=sandbox.root / "project", env=sandbox.env,
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        os.close(slave)
        self.output = b""
        self.chunks = []  # (epoch ms, offset) per read
        self.monotonic_chunks = []  # (perf_counter_ns, offset), captured before VT parsing

    def elapsed_ms(self):
        return (time.perf_counter() - self.start) * 1000.0

    def pump(self, seconds, reader_delay=0.0):
        end = time.perf_counter() + seconds
        while time.perf_counter() < end:
            if select.select([self.master], [], [], 0.002)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                self.monotonic_chunks.append((time.perf_counter_ns(), len(self.output)))
                self.chunks.append((now_ms(), len(self.output)))
                self.output += chunk
                if reader_delay:
                    time.sleep(reader_delay)

    def wait_for(self, needle, since=0, timeout=15.0, reader_delay=0.0):
        end = time.perf_counter() + timeout
        while time.perf_counter() < end:
            if needle in self.output[since:]:
                return True
            self.pump(0.01, reader_delay)
        return False

    def send(self, keys, settle=0.0):
        mark = len(self.output)
        os.write(self.master, keys)
        if settle:
            self.pump(settle)
        return mark

    def command(self, text, settle=0.4):
        """Clears the composer, types a slash command, then submits it."""
        self.send(b"\x15", 0.05)
        self.send(text.encode(), 0.2)
        return self.send(b"\r", settle)

    def wait_ready(self, timeout=15.0):
        """Composer visible and a typed sentinel echoed: the input genuinely accepts keys."""
        if not self.wait_for(COMPOSER_MARKER, 0, timeout):
            raise RuntimeError("composer never became visible")
        sentinel = b"zq7x"
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            mark = self.send(sentinel)
            if self.wait_for(sentinel, max(0, mark - 16), 0.05):
                self.send(b"\x15", 0.05)
                return self.elapsed_ms()
        raise RuntimeError("input never became ready")

    def resize(self, rows, columns):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.killpg(self.child.pid, signal.SIGWINCH)

    def tree_pids(self):
        listing = subprocess.run(["ps", "-e", "-o", "pid=,ppid=,comm="], capture_output=True, text=True).stdout
        children, names = {}, {}
        for row in listing.splitlines():
            pid, ppid, name = row.split(None, 2)
            children.setdefault(int(ppid), []).append(int(pid))
            names[int(pid)] = name.strip()
        found, pending = [], [self.child.pid]
        while pending:
            pid = pending.pop()
            found.append((pid, names.get(pid, "?")))
            pending.extend(children.get(pid, []))
        return found

    def memory(self):
        """Per-process smaps_rollup (KiB) for the whole tree; the root pid is the launcher."""
        processes = []
        for pid, name in self.tree_pids():
            try:
                rollup = pathlib.Path(f"/proc/{pid}/smaps_rollup").read_text()
            except OSError:
                continue
            fields = {line.split(":")[0]: int(line.split()[1]) for line in rollup.splitlines()[1:] if line.split()[1:2]}
            role = "launcher" if pid == self.child.pid else ("bun" if name == "bun" else name)
            processes.append({
                "pid": pid, "role": role, "rss": fields.get("Rss", 0), "pss": fields.get("Pss", 0),
                "pss_anon": fields.get("Pss_Anon", 0), "pss_file": fields.get("Pss_File", 0),
                "anonymous": fields.get("Anonymous", 0), "swap": fields.get("Swap", 0),
            })
        return processes

    def close(self):
        if self.child.poll() is None:
            try:
                os.killpg(self.child.pid, signal.SIGTERM)
                self.child.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.child.wait()
        os.close(self.master)


def summarize(samples):
    ordered = sorted(samples)
    mean = statistics.fmean(ordered)
    stddev = statistics.stdev(ordered) if len(ordered) > 1 else 0.0
    at = lambda fraction: ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]
    return {k: round(v, 3) for k, v in {
        "n": len(ordered), "p50": at(0.5), "p95": at(0.95), "p99": at(0.99), "min": ordered[0],
        "max": ordered[-1], "mean": mean, "stddev": stddev, "cv": stddev / mean if mean else 0.0,
    }.items()}


def metric(metric_id, unit, samples, note=None, lower_is_better=True):
    entry = {"id": metric_id, "unit": unit, "lowerIsBetter": lower_is_better, "stats": summarize(samples)}
    if note:
        entry["note"] = note
    return entry


def git(*args):
    result = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def environment():
    node = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    bun = subprocess.run(["bun", "--version"], capture_output=True, text=True).stdout.strip()
    cpu = "unknown"
    try:
        cpu = next(line.split(":", 1)[1].strip() for line in open("/proc/cpuinfo") if line.startswith("model name"))
    except (OSError, StopIteration):
        pass
    return {
        "bun": bun, "node": node, "platform": sys.platform, "arch": platform.machine(),
        "kernel": platform.release(), "cpu": cpu, "logicalCores": os.cpu_count(),
        "commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain")),
        "fileCache": "warm/unspecified (not controlled)",
    }


def write_report(out_dir, suite, method, metrics, details=None, definitions=None):
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "suite": suite, "createdAt": datetime.now(timezone.utc).isoformat(),
        "environment": environment(), "method": method, "metrics": metrics,
    }
    if definitions:
        report["definitions"] = definitions
    if details is not None:
        report["details"] = details
    path = out_dir / f"{suite}.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    for entry in metrics:
        s = entry["stats"]
        print(f"{entry['id']:<62} p50 {s['p50']:>12} p95 {s['p95']:>12} max {s['max']:>12} {entry['unit']} n={s['n']}")
    print(f"wrote {path}")
    return path


def arg(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default
