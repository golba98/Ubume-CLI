#!/usr/bin/env python3
"""Offline startup-with-update-check benchmark against a local mock npm endpoint.

UBUME_UPDATE_DIST_TAGS_URL points the update check at a loopback server whose behavior is
chosen per scenario (immediate, delays, hang, HTTP failure, refused connection, update
available, fresh cache). Measures input-ready (a typed key is echoed), submit-ready
(`/help` renders its command list) and, for an available update, when it becomes visible.

Usage: python3 scripts/bench/update-startup.py [--iterations N] [--out DIR] [--scenario NAME]
"""
import json, pathlib, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ptylib import REPO, Sandbox, Session, arg, metric, write_report

VERSION = json.loads((REPO / "package.json").read_text())["version"]
# name: (delay seconds or None for hang, HTTP status, latest version, fresh cache)
SCENARIOS = {
    "immediate": (0.0, 200, VERSION, False),
    "cached": (2.0, 200, VERSION, True),
    "delay-500ms": (0.5, 200, VERSION, False),
    "delay-2s": (2.0, 200, VERSION, False),
    "delay-5s": (5.0, 200, VERSION, False),
    "timeout": (None, 200, VERSION, False),
    "http-failure": (0.0, 500, VERSION, False),
    "refused": ("refused", 0, VERSION, False),
    "available": (0.5, 200, "999.0.0", False),
}


class MockNpm(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.rsplit("/", 1)[-1]
        delay, status, latest, _ = SCENARIOS[name]
        if delay is None:
            time.sleep(60)
            return
        time.sleep(delay)
        body = json.dumps({"latest": latest}).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def run_once(name, server_port):
    delay, _status, latest, cached = SCENARIOS[name]
    url = f"http://127.0.0.1:{free_port() if delay == 'refused' else server_port}/dist-tags/{name}"
    sandbox = Sandbox(
        settings={"updateCheck": {"enabled": True}},
        extra_env={"UBUME_UPDATE_DIST_TAGS_URL": url},
        proxy=None,
    )
    try:
        if cached:
            (sandbox.root / "home" / ".ubume-update-check.json").write_text(json.dumps({
                "lastChecked": int(time.time() * 1000), "currentVersion": VERSION,
                "latestVersion": VERSION, "updateAvailable": False,
            }))
        session = Session(sandbox)
        result = {}
        try:
            result["input_ready_ms"] = session.wait_ready()
            if latest != VERSION:
                if session.wait_for(latest.encode(), 0, 15):
                    result["update_visible_ms"] = session.elapsed_ms()
            mark = session.command("/help", 0)
            if session.wait_for(b"Commands:", mark, 20):
                result["submit_ready_ms"] = session.elapsed_ms()
        finally:
            session.close()
        return result
    finally:
        sandbox.dispose()


def main():
    iterations = int(arg("--iterations", "3"))
    only = arg("--scenario")
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockNpm)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    metrics, details = [], {}
    try:
        for name in SCENARIOS:
            if only and name != only:
                continue
            runs = [run_once(name, server.server_address[1]) for _ in range(iterations)]
            details[name] = runs
            for key in ("input_ready_ms", "submit_ready_ms", "update_visible_ms"):
                samples = [run[key] for run in runs if key in run]
                if samples:
                    metrics.append(metric(f"update.{name}.{key[:-3]}", "ms", samples))
    finally:
        server.shutdown()
    write_report(
        arg("--out", str(REPO / "docs" / "_reports" / "performance" / "bench-results")), "update-startup",
        f"{iterations} PTY launches per scenario of node bin/ubume.js with update checks enabled and "
        "UBUME_UPDATE_DIST_TAGS_URL pointing at a loopback mock npm server (no proxy; nothing leaves "
        "the machine). input_ready = typed key echoed; submit_ready = '/help' typed after input-ready "
        "renders 'Commands:'; update_visible = the available version appears on screen.",
        metrics, details,
    )


if __name__ == "__main__":
    main()
