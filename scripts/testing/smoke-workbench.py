#!/usr/bin/env python3
"""Record the actual Ink app in a PTY, using a deterministic provider and temp data.

Drives scripts/testing/fixtures/workbench-app.tsx (the real App with a fixture
provider that only touches its temporary workspace) through a scripted
timeline: prompt, queued follow-up, unsent draft, interrupt, clear, transcript,
queue and diff views, then quit. The recording is written as an asciinema v2
cast; the script asserts the expected evidence appears in the PTY output and
that the app exits cleanly.

Offline by construction: the fixture provider writes demo.ts inside the
temporary workspace and never contacts a real model or network.

Usage: python3 scripts/testing/smoke-workbench.py [recording.cast] [width]
"""
import codecs
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

REPOSITORY = pathlib.Path(__file__).resolve().parents[2]
RUN_LIMIT_SECONDS = 15.0

# (seconds after the previous action / after app-ready, input text)
ACTIONS = [
    (0.6, "Inspect demo"), (0.75, "\r"), (1.1, "Queued follow-up"), (1.25, "\r"),
    (1.6, "Unsent draft while working"), (2.9, "\x03"), (3.2, "\x0c"), (3.5, "\x15"),
    (3.7, "/transcript"), (3.85, "\r"), (4.1, "\x1b[B"), (4.3, "\r"), (4.6, "\x1b"),
    (4.9, "/queue"), (5.05, "\r"), (5.4, "\x1b"), (5.7, "/diff"), (5.85, "\r"),
    (6.1, "\r"), (6.2, "\x1b[6~"), (6.3, "\x1b[6~"), (6.4, "\x1b[6~"), (6.6, "\x1b"),
    (6.8, "\x1b"), (7.1, "\x11"),
]

# Evidence that each expected UI phase actually rendered in the PTY.
EXPECTED_MARKERS = [
    "Unsent draft while working", "TRANSCRIPT", "QUEUE", "DIFF", "+export const result = 1;",
]


def prepare_workspace(directory):
    """Temporary workspace with one file the fixture provider will edit."""
    workspace = pathlib.Path(directory) / "project"
    workspace.mkdir()
    (workspace / "demo.ts").write_text("export const result = 0;\n")
    return workspace


def spawn_pty_app(workspace, directory, width):
    """Runs the smoke fixture app in a 30-row PTY, echo disabled."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, width, 0, 0))
    environment = {
        **os.environ,
        "TERM": "xterm-256color",
        "UBUME_SMOKE_WORKSPACE": str(workspace),
        "UBUME_DATA_DIR": directory + "/data",
    }
    child = subprocess.Popen(
        [shutil.which("bun"), str(REPOSITORY / "scripts/testing/fixtures/workbench-app.tsx")],
        cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    return master, child


def record(master, child, stream, ready):
    """Feeds the action timeline once the composer is ready, recording all PTY I/O.

    The interrupt action is deferred until the fixture provider has produced its
    "Updated demo.ts" output, so the interrupt always lands mid-run.
    """
    start = time.monotonic()
    output = ""
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    actions = list(ACTIONS)

    while time.monotonic() - start < RUN_LIMIT_SECONDS:
        elapsed = time.monotonic() - start
        while ready is not None and actions and elapsed - ready >= actions[0][0]:
            if actions[0][1] == "\x03" and "Updated demo.ts" not in output:
                # Provider has not answered yet: wait for it before interrupting.
                ready = elapsed - actions[0][0]
                break
            _, text = actions.pop(0)
            os.write(master, text.encode())
            stream.write(json.dumps([round(elapsed, 3), "i", text]) + "\n")
        if select.select([master], [], [], 0.03)[0]:
            try:
                data = decoder.decode(os.read(master, 65536))
            except OSError:
                break
            output += data
            if ready is None and "Ask Ubume" in output:
                ready = time.monotonic() - start
            stream.write(json.dumps([round(time.monotonic() - start, 3), "o", data], ensure_ascii=False) + "\n")
        if child.poll() is not None:
            break
    return output


def main():
    recording = pathlib.Path(os.sys.argv[1]) if len(os.sys.argv) > 1 else REPOSITORY / "docs/terminal/recordings/terminal-workbench.cast"
    width = int(os.sys.argv[2]) if len(os.sys.argv) > 2 else 100
    assert 40 <= width <= 240

    with tempfile.TemporaryDirectory(prefix="ubume-terminal-smoke-") as directory:
        workspace = prepare_workspace(directory)
        master, child = spawn_pty_app(workspace, directory, width)
        recording.parent.mkdir(parents=True, exist_ok=True)
        with recording.open("w") as stream:
            stream.write(json.dumps({
                "version": 2, "width": width, "height": 30,
                "title": "Ubume workbench: live composer, queue, transcript and diff",
            }) + "\n")
            output = record(master, child, stream, ready=None)
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=5)
        os.close(master)
        assert child.returncode == 0, f"PTY app exited with {child.returncode}"
        for marker in EXPECTED_MARKERS:
            assert marker in output, f"Missing terminal evidence: {marker}"
        print(f"PTY smoke passed; recording: {recording}")


if __name__ == "__main__":
    main()
